#!/usr/bin/env node
/**
 * 离线自测（缺陷 G）。只用 Node 内置模块，不需要宿主在线，不装测试框架。
 *
 * 跑法：
 *   node test/selftest.mjs
 *
 * 覆盖范围（全部用假投影 / 假正文 / 假 webServer 上下文）：
 *   - deriveState 的三态与 unknown：在跑（openStep / 边界未闭合 / 普通工具在飞）、
 *     在等人（ask_user_question / 审批未决）、空闲、判不出（正文缺失 / 正文没有该 callId /
 *     投影没有 workingDirectory）；
 *   - 正文切帧读法：自己造一个多帧 zstd 文件，每个帧放多条记录，确认不是只解第一帧；
 *   - /pointer 的任务号绑定与 400/409 分支；
 *   - activePeers 的分组与跳过规则（含状态未知计入占用、needsHuman 的给法）；
 *   - 缺陷 H：报告扫描窗口逐级放大（8 -> 64 -> 512 -> 整份）、命中即停、扫描帧数与
 *     字节数回出、三类 stateReason 字节级不同（定位不到 / 解压失败 / 读不满整份）、
 *     `unreported` 只在整份正文读完且无锚点时出现、以及 unknown 不进缓存（修好正文
 *     后下一次调用就给出正确读数，不需要重启）；
 *   - CLI 的参数校验与退出码（走子进程，输出经临时文件采集）。
 *
 * 待重启后实调（本文件不覆盖、也不伪造通过）：
 *   - 真实宿主上的写派单 409 实调（同目录占用 / 目标自己等待 / 目标自己 unknown）；
 *   - /health 的 pointer、status、sessions 三项真实探针（依赖宿主存储与 controller.list）；
 *   - 投递排队：挂卡期间写派单进 inbox.next-turn、只读放行；
 *   - 单写者检查失败 503（projection-store-unavailable）。
 *
 * 已知限制（不属本自测，也不判占用）：投影文件存在但解析不出来（corrupt）的会话，
 * 既进不了 activePeers（连它在哪个工作目录都不知道），也拦不住写派单；它没有
 * pendingCalls 这种正面证据，判它占用是猜。README 的失败矩阵后有说明。
 *
 * 夹具建在系统临时目录、跑完删除；结果只打到 stdout，不写仓库。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import * as zlib from 'node:zlib'

const repoRoot = join(import.meta.dirname, '..')
const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-selftest-'))
process.env.DSH_HOME = home
const projDir = join(home, 'storages', 'session_projcache', 'sessions')
// CLI 用独立的 DSH_HOME：它自己会读 bridge.json，不能和进程内的假宿主混在一起。
const cliHome = join(home, 'cli-home')
mkdirSync(projDir, { recursive: true })
mkdirSync(cliHome, { recursive: true })

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log('PASS ' + name)
    return
  }
  fail += 1
  console.log('FAIL ' + name + ' :: ' + safeJson(detail))
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function section(title) {
  console.log('\n# ' + title)
}

/** 与 lib 的 workspaceBucketName 同一套编码；对不上时正文定位会失败，测试会报出来。 */
function bucket(cwd) {
  const segments = cwd.split(/[\\/:]+/).filter(segment => segment.length > 0)
  const encoded = segments.map(segment => Array.from(segment, (char) => {
    if (/[A-Za-z0-9._-]/.test(char)) return char
    return '~' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  }).join('')).join('-')
  return '--' + encoded + '--'
}

const PENDING = {
  idle: {},
  running: { 'call-run': 1 },
  'boundary-running': {},
  'waiting-question': { 'call-ask': 1 },
  'waiting-approval': { 'call-pw': 1 },
  'pending-ordinary': { 'call-pwsh': 1 },
  'pending-missing': { 'call-missing': 1 },
}

function writeProjection(sessionId, cwd, mode, extraRows = {}) {
  const open = mode !== 'idle'
  const rows = {
    ...(cwd === null ? {} : { workingDirectory: { val: cwd } }),
    sessionStats: {
      val: {
        turns: 1,
        steps: 3,
        openStep: mode === 'running' ? { turn: 1, step: 7, startTime: 1, firstTokenTime: null } : null,
        pendingCalls: PENDING[mode] ?? {},
      },
    },
    turnBoundary: { val: { openTurnStartSeq: open ? 3 : null, lastStepBoundary: { kind: open ? 'start' : 'end' } } },
    sessionListMetadata: { val: { blank: false, lastPromptAt: 1 } },
    permissions: { val: { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' } },
    agentPreset: { val: 'standard' },
    ...extraRows,
  }
  writeFileSync(join(projDir, sessionId + '.json'), JSON.stringify({ record: { rows } }))
}

/** 写一具多帧正文；每一帧解压后是一段文本，按换行拆成多条记录。 */
function writeBody(cwd, sessionId, frames) {
  const dir = join(home, 'sessions', bucket(cwd), sessionId)
  mkdirSync(dir, { recursive: true })
  const encoded = frames.map(lines => zlib.zstdCompressSync(
    Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'),
  ))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(encoded))
}

/** 写一具体量大的正文：同一帧重复 `count` 次，用来撞扫描字节上限。 */
function writeRawBody(cwd, sessionId, frame, count) {
  const dir = join(home, 'sessions', bucket(cwd), sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(Array.from({ length: count }, () => frame)))
}

/** 正文文件路径（夹具与断言共用一套推导）。 */
function bodyPath(cwd, sessionId) {
  return join(home, 'sessions', bucket(cwd), sessionId, 'session.v4.jsonl.zstd')
}

/** 扫描上限，与 lib/index.js 的 REPORT_SCAN_BYTE_LIMIT 同一口径（16 MiB）。 */
const SCAN_BYTE_LIMIT = 16 * 1024 * 1024

function countZstdFrames(file) {
  const buffer = readFileSync(file)
  let count = 0
  for (let at = 0; at + 4 <= buffer.length; at += 1) {
    if (buffer[at] === 0x28 && buffer[at + 1] === 0xb5 && buffer[at + 2] === 0x2f && buffer[at + 3] === 0xfd) count += 1
  }
  return count
}

const toolCall = (seq, callId, name) => ({
  type: 'tool/call',
  seq,
  time: 1,
  data: { turn: 1, step: 1, callId, name, arguments: '{}' },
})
const approvalAsked = (seq, id, callId, toolName) => ({
  type: 'approval/asked',
  seq,
  time: 1,
  data: { id, toolName, callId, reason: 'selftest' },
})
const message = (seq) => ({ type: 'message', seq, time: 1, data: { role: 'assistant', text: 'selftest' } })
const assistantMessage = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: 1,
  data: {
    turn: 1,
    step: 1,
    stream: false,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  },
})
/** 五行汇报块（缺陷 I：第二行写任务号）。 */
const reportText = (word, taskId, extra = {}) => [
  '汇报状态: ' + word,
  '任务: ' + taskId,
  '结论: ' + (extra.conclusion ?? 'selftest conclusion'),
  '凭据: ' + (extra.evidence ?? 'selftest evidence'),
  ...(extra.prerequisite === undefined ? [] : ['前置: ' + extra.prerequisite]),
].join('\n')

/** The cost fixture's seven expected values, in the projection's own shape. */
const COST_ROWS = {
  tokenUsage: {
    val: {
      totals: {
        uncachedInputTokens: 135174,
        outputTokens: 61213,
        cacheReadTokens: 6315520,
        cacheWriteTokens: 7,
      },
    },
  },
  contextPressure: {
    val: { surfaceTokens: 146268, contextWindow: 1000000, pressureTokens: 200481 },
  },
}
const COST_EXPECTED = {
  uncachedInputTokens: 135174,
  outputTokens: 61213,
  cacheReadTokens: 6315520,
  cacheWriteTokens: 7,
  surfaceTokens: 146268,
  contextWindow: 1000000,
  pressureTokens: 200481,
}

const DIR = {
  x: 'D:\\fixture\\selftest-x',
  y: 'D:\\fixture\\selftest-y',
  z: 'D:\\fixture\\selftest-z',
  t: 'D:\\fixture\\selftest-t',
  w: 'D:\\fixture\\selftest-w',
  v: 'D:\\fixture\\selftest-v',
  u: 'D:\\fixture\\selftest-u',
  p: 'D:\\fixture\\selftest-p',
  m: 'D:\\fixture\\selftest-m',
  s: 'D:\\fixture\\selftest-s',
  r1: 'D:\\fixture\\selftest-r1',
  r2: 'D:\\fixture\\selftest-r2',
  r3: 'D:\\fixture\\selftest-r3',
  r4: 'D:\\fixture\\selftest-r4',
  r5: 'D:\\fixture\\selftest-r5',
  r6: 'D:\\fixture\\selftest-r6',
  r7: 'D:\\fixture\\selftest-r7',
  r8: 'D:\\fixture\\selftest-r8',
  r9: 'D:\\fixture\\selftest-r9',
  r10: 'D:\\fixture\\selftest-r10',
  r11: 'D:\\fixture\\selftest-r11',
  r12: 'D:\\fixture\\selftest-r12',
  r13: 'D:\\fixture\\selftest-r13',
  r14: 'D:\\fixture\\selftest-r14',
  r15: 'D:\\fixture\\selftest-r15',
  r16: 'D:\\fixture\\selftest-r16',
  r17: 'D:\\fixture\\selftest-r17',
}

const ID = {
  run: 'session-selftest-run-a',
  idleX: 'session-selftest-target-x',
  idleY: 'session-selftest-target-y',
  waitQ: 'session-selftest-wait-question',
  idleZ: 'session-selftest-target-z',
  boundary: 'session-selftest-boundary-run',
  waitApproval: 'session-selftest-wait-approval',
  pendingTool: 'session-selftest-pending-tool',
  idleV: 'session-selftest-target-v',
  unknownMissing: 'session-selftest-unknown-missing',
  idleU: 'session-selftest-target-u',
  unknownTarget: 'session-selftest-unknown-target',
  noDir: 'session-selftest-no-directory',
  waitMixed: 'session-selftest-wait-mixed',
  unknownMixed: 'session-selftest-unknown-mixed',
  idleM: 'session-selftest-target-m',
  selfRunning: 'session-selftest-self-running',
  noProjection: 'session-selftest-no-projection',
  pointerA: 'session-selftest-pointer-a',
  pointerB: 'session-selftest-pointer-b',
  reportGood: 'session-selftest-report-good',
  reportMissing: 'session-selftest-report-missing',
  reportBadWord: 'session-selftest-report-bad-word',
  reportUnreported: 'session-selftest-report-unreported',
  reportDeep: 'session-selftest-report-deep',
  reportFailed: 'session-selftest-report-failed',
  reportDropped: 'session-selftest-report-dropped',
  reportEscalate: 'session-selftest-report-escalate',
  reportNoAnchor: 'session-selftest-report-no-anchor',
  reportLocate: 'session-selftest-report-locate-gone',
  reportNewerBroken: 'session-selftest-report-newer-broken',
  reportOversize: 'session-selftest-report-oversize',
  reportPair: 'session-selftest-report-pair',
  reportMissingTask: 'session-selftest-report-missing-task',
  reportLineAnchor: 'session-selftest-report-line-anchor',
  reportAnchorNoise: 'session-selftest-report-anchor-noise',
  reportNewestNoTask: 'session-selftest-report-newest-no-task',
}

// 运行时生成，避免把任何 token 字面量写进仓库；D8 断言 --dry-run 不打印它。
const FAKE_TOKEN = 'selftest-' + randomUUID()

function writeFixtures() {
  // X：running 的邻居 + 空闲目标；Y：只有空闲目标；Z：挂选项提问卡 + 空闲目标。
  writeProjection(ID.run, DIR.x, 'running')
  writeProjection(ID.idleX, DIR.x, 'idle')
  writeProjection(ID.idleY, DIR.y, 'idle')
  writeProjection(ID.waitQ, DIR.z, 'waiting-question')
  writeProjection(ID.idleZ, DIR.z, 'idle')
  // T：只有边界未闭合，openStep 为 null、pendingCalls 为空。
  writeProjection(ID.boundary, DIR.t, 'boundary-running')
  // W：权限审批未决；V：普通工具在飞；U：正文缺失；P：正文里没有该 callId。
  writeProjection(ID.waitApproval, DIR.w, 'waiting-approval')
  writeProjection(ID.pendingTool, DIR.v, 'pending-ordinary')
  writeProjection(ID.idleV, DIR.v, 'idle')
  writeProjection(ID.unknownMissing, DIR.u, 'pending-missing')
  writeProjection(ID.idleU, DIR.u, 'idle')
  writeProjection(ID.unknownTarget, DIR.p, 'pending-missing')
  // M：同目录既有确定在等人、又有判不出的会话。
  writeProjection(ID.waitMixed, DIR.m, 'waiting-question')
  writeProjection(ID.unknownMixed, DIR.m, 'pending-missing')
  writeProjection(ID.idleM, DIR.m, 'idle')
  // S：目标自己在跑（自追加豁免）。
  writeProjection(ID.selfRunning, DIR.s, 'running')
  // 投影存在但没有 workingDirectory：正文路径推导不出来，状态必须是 unknown 而不是空闲。
  writeProjection(ID.noDir, null, 'pending-missing')

  // 多帧正文：3 帧，前两帧各 2 条记录；ask 的 tool/call 在第二帧的第二条，
  // 只解第一帧或只看每帧第一条都会漏掉它。
  writeBody(DIR.z, ID.waitQ, [
    [toolCall(1, 'call-other-1', 'read_file'), toolCall(2, 'call-other-2', 'grep')],
    [message(3), toolCall(4, 'call-ask', 'ask_user_question')],
    [message(5), message(6)],
  ])
  writeBody(DIR.m, ID.waitMixed, [[toolCall(7, 'call-ask', 'ask_user_question')]])
  writeBody(DIR.w, ID.waitApproval, [
    [toolCall(8, 'call-pw', 'pwsh'), approvalAsked(9, 'approval-1', 'call-pw', 'pwsh')],
  ])
  writeBody(DIR.v, ID.pendingTool, [[toolCall(10, 'call-pwsh', 'pwsh')]])
  // 正文存在但没有 call-missing 的 tool/call：这是 unknown 的第二种来源。
  writeBody(DIR.p, ID.unknownTarget, [[message(11), message(12)]])

  // 第二轮：汇报协议、票的阶段、成本读数。
  writeProjection(ID.reportGood, DIR.r1, 'idle', COST_ROWS)
  writeProjection(ID.reportMissing, DIR.r2, 'idle')
  writeProjection(ID.reportBadWord, DIR.r3, 'idle')
  writeProjection(ID.reportUnreported, DIR.r4, 'idle')
  writeProjection(ID.reportDeep, DIR.r5, 'idle')
  // 同一具正文里两条汇报：5000 是 blocked、5002 是 ready。解析取最近的 ready；
  // 按 seq 复核时两条都能对上各自的词。
  writeBody(DIR.r1, ID.reportGood, [[
    assistantMessage(5000, reportText('blocked', 'selftest-report-good', { prerequisite: 'need a human decision' })),
    assistantMessage(5002, reportText('ready', 'selftest-report-good')),
  ]])
  // 缺凭据行（任务行在）：valid 锚点但必填行缺失 -> invalid 并点名。
  writeBody(DIR.r2, ID.reportMissing, [[assistantMessage(5100, '汇报状态: ready\n任务: selftest-report-missing\n结论: only a conclusion')]])
  // 状态词不在四个之内 -> invalid，不猜。
  writeBody(DIR.r3, ID.reportBadWord, [[assistantMessage(5200, '汇报状态: done\n任务: selftest-report-bad\n结论: x\n凭据: y')]])
  // 没有锚点 -> unreported。
  writeBody(DIR.r4, ID.reportUnreported, [[message(5300), toolCall(5301, 'call-other', 'grep')]])
  // 10 帧，锚点在最老的第 1 帧：末向 8 帧的窗口取不到它 -> 放大后取到。
  writeBody(DIR.r5, ID.reportDeep, [
    [assistantMessage(5400, reportText('ready', 'selftest-report-deep'))],
    ...Array.from({ length: 9 }, (_, index) => [message(5401 + index)]),
  ])
  // run 的投影 openStep 有值（在跑）；正文里有一条 ready 汇报，供 conflict 用。
  writeBody(DIR.x, ID.run, [[assistantMessage(6000, reportText('ready', 'selftest-conflict'))]])

  // 缺陷 H：窗口放大与三类 stateReason 的夹具。
  writeProjection(ID.reportEscalate, DIR.r8, 'idle')
  writeProjection(ID.reportNoAnchor, DIR.r9, 'idle')
  writeProjection(ID.reportLocate, DIR.r10, 'idle') // 正文故意不写：定位不到
  writeProjection(ID.reportNewerBroken, DIR.r11, 'idle')
  writeProjection(ID.reportOversize, DIR.r12, 'idle')
  // 60 帧，锚点在第 11 帧（距尾部 49 帧）：末向 8 帧取不到，放大后取到，命中即停。
  writeBody(DIR.r8, ID.reportEscalate, [
    ...Array.from({ length: 10 }, (_, index) => [message(7000 + index)]),
    [assistantMessage(7100, reportText('ready', 'selftest-report-escalate', { conclusion: 'escalated conclusion', evidence: 'escalated evidence' }))],
    ...Array.from({ length: 49 }, (_, index) => [message(7200 + index)]),
  ])
  // 12 帧、整份正文没有锚点：这才是 unreported 的事实。
  writeBody(DIR.r9, ID.reportNoAnchor, Array.from({ length: 12 }, (_, index) => [message(7300 + index)]))
  // 更老的一帧有合法汇报，最近一帧会被截断：不得把旧的当最新答案。
  writeBody(DIR.r11, ID.reportNewerBroken, [
    [assistantMessage(7400, reportText('ready', 'selftest-report-newer-broken'))],
    [message(7401)],
    [message(7402)],
  ])
  // 约 17 MB 的正文（4200 帧、每帧 4 KiB 随机载荷）：超过 16 MiB 扫描上限。
  writeRawBody(DIR.r12, ID.reportOversize, zlib.zstdCompressSync(randomBytes(4096)), 4200)

  // 缺陷 I / J：票级认领与行首锚点。
  writeProjection(ID.reportPair, DIR.r13, 'idle')
  writeProjection(ID.reportMissingTask, DIR.r14, 'idle')
  writeProjection(ID.reportLineAnchor, DIR.r15, 'idle')
  writeProjection(ID.reportAnchorNoise, DIR.r16, 'idle')
  writeProjection(ID.reportNewestNoTask, DIR.r17, 'idle')
  // 同一会话两条块，各认领一张票：A 是 5002 ready，B 是 5004 blocked。
  writeBody(DIR.r13, ID.reportPair, [[
    assistantMessage(5002, reportText('ready', 'selftest-report-pair-a')),
    assistantMessage(5004, reportText('blocked', 'selftest-report-pair-b', { prerequisite: 'needs a decision' })),
  ]])
  // 缺任务行：锚点 + 结论 + 凭据都在，但没有 `任务:`。
  writeBody(DIR.r14, ID.reportMissingTask, [[assistantMessage(5200, '汇报状态: ready\n结论: c\n凭据: e')]])
  // 凭据行里引用一句“汇报状态: ready」…”，真锚点在前一行（blocked）。
  writeBody(DIR.r15, ID.reportLineAnchor, [[assistantMessage(5300, [
    '汇报状态: blocked',
    '任务: selftest-line-anchor',
    '结论: real anchor',
    '凭据: 引用了 汇报状态: ready」；这一句在行中间，不是锚点',
    '前置: none',
  ].join('\n'))]])
  // 锚点行冒号后还有别的话：不是状态词，判 invalid。
  writeBody(DIR.r16, ID.reportAnchorNoise, [[assistantMessage(5400, [
    '汇报状态: ready」；同一数据换旧代码实调为另一条读数',
    '任务: selftest-anchor-noise',
    '结论: c',
    '凭据: e',
  ].join('\n'))]])
  // 最新块没有任务行，更老的一块认领本票：最新块不可归属 -> invalid，不回退到旧块。
  writeBody(DIR.r17, ID.reportNewestNoTask, [
    [assistantMessage(6000, reportText('ready', 'selftest-report-newest'))],
    [assistantMessage(6100, '汇报状态: ready\n结论: c\n凭据: e')],
  ])
}

async function runAll() {
  writeFixtures()

  // ---- 假宿主上下文：只挂路由，不监听任何端口 ----
  const calls = []
  const handlers = new Map()
  const { apply } = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href)
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      port: 4000,
      protocol: 'http:',
      getOrigin: () => 'http://127.0.0.1:4000',
      register: ({ path, handler }) => {
        handlers.set(path, handler)
        return () => handlers.delete(path)
      },
    },
    logger: { info: () => {}, warn: () => {} },
    sessionController: {
      prompt: async (args) => {
        calls.push(args)
        return { accepted: true }
      },
    },
  }
  apply(ctx, {})

  const token = readFileSync(join(home, 'plugin-data', 'dsh-session-bridge', 'token'), 'utf8').trim()
  const pointerPath = join(home, 'plugin-data', 'dsh-session-bridge', 'pointers.json')

  async function post(route, body) {
    const handler = handlers.get('/x-session-bridge/' + route)
    if (handler === undefined) throw new Error('route not registered: ' + route)
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'
    req.headers = {
      host: '127.0.0.1:4000',
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(payload) { this.body = payload },
    }
    await handler(req, res)
    return { status: res.status, json: JSON.parse(res.body) }
  }

  const pointerRecords = () => JSON.parse(readFileSync(pointerPath, 'utf8')).pointers

  // ================= /pointer：任务号绑定与 400/409 分支 =================
  section('/pointer：任务号唯一键与 400/409 分支')
  let r = await post('pointer', { taskId: 'selftest-task-1', sessionId: ID.pointerA })
  check('B1 新记录缺 mode -> 400', r.status === 400 && /mode is required/i.test(String(r.json.error)), r)

  r = await post('pointer', { taskId: 'bad task!', sessionId: ID.pointerA, mode: 'read' })
  check('B2 非法 taskId -> 400', r.status === 400 && /taskId/.test(String(r.json.error)), r)

  r = await post('pointer', { taskId: 'selftest-task-1', sessionId: ID.pointerA, mode: 'read', cwd: DIR.x })
  check('B3 首次绑定 -> 200', r.status === 200 && r.json.pointer?.sessionId === ID.pointerA, r)
  check('B4 指针不落 cwd（请求里的 cwd 被忽略）', r.json.pointer !== undefined && !('cwd' in r.json.pointer), r.json.pointer)

  r = await post('pointer', { taskId: 'selftest-task-1', sessionId: ID.pointerB, mode: 'read' })
  check('B5 同任务号换会话 -> 409 task-bound', r.status === 409 && r.json.code === 'task-bound', r)
  check('B6 409 给出已绑定会话 id', r.json.boundSessionId === ID.pointerA, r.json)
  check('B7 409 未新增记录', pointerRecords().length === 1, pointerRecords())

  r = await post('pointer', { taskId: 'selftest-task-1', sessionId: ID.pointerA, mode: 'read', requestId: 'selftest-req-1' })
  check('B8 同任务号同会话幂等 -> 200 且仍一条', r.status === 200 && r.json.count === 1, r)

  r = await post('pointer', { taskId: 'selftest-task-1', sessionId: ID.pointerA, acceptance: 'accepted' })
  check('B9 acceptance 不再是可写字段 -> 400 且指向 stage', r.status === 400 && /derived from stage/.test(String(r.json.error)), r)

  r = await post('pointer', { taskId: 'selftest-task-2', sessionId: ID.pointerA, mode: 'rw' })
  check('B10 非法 mode -> 400', r.status === 400 && /mode must/.test(String(r.json.error)), r)

  // ================= deriveState：三态与 unknown =================
  section('deriveState：三态与 unknown（经 /status，假投影 + 假正文）')
  const stateFixtures = [
    [ID.run, 'selftest-state-run'],
    [ID.idleY, 'selftest-state-idle'],
    [ID.waitQ, 'selftest-state-wait-question'],
    [ID.boundary, 'selftest-state-boundary'],
    [ID.waitApproval, 'selftest-state-wait-approval'],
    [ID.pendingTool, 'selftest-state-pending-tool'],
    [ID.unknownMissing, 'selftest-state-unknown-missing'],
    [ID.unknownTarget, 'selftest-state-unknown-target'],
    [ID.noDir, 'selftest-state-no-dir'],
    [ID.waitMixed, 'selftest-state-wait-mixed'],
    [ID.unknownMixed, 'selftest-state-unknown-mixed'],
    [ID.selfRunning, 'selftest-state-self-running'],
  ]
  for (const [sessionId, taskId] of stateFixtures) {
    const bound = await post('pointer', { taskId, sessionId, mode: 'read' })
    if (bound.status !== 200) throw new Error('fixture pointer failed: ' + taskId + ' ' + safeJson(bound.json))
  }
  const status = await post('status', {})
  const bySession = new Map(status.json.pointers.map(pointer => [pointer.sessionId, pointer]))
  const facts = (sessionId) => bySession.get(sessionId)

  check('A1 正文是多帧的（夹具本身 3 帧）', countZstdFrames(join(home, 'sessions', bucket(DIR.z), ID.waitQ, 'session.v4.jsonl.zstd')) === 3,
    countZstdFrames(join(home, 'sessions', bucket(DIR.z), ID.waitQ, 'session.v4.jsonl.zstd')))

  const waitQ = facts(ID.waitQ)
  check('A2 挂卡会话判 waiting', waitQ?.state === 'waiting', waitQ)
  check('A3 等待类别 question', waitQ?.waitingKind === 'question', waitQ?.waitingKind)
  check('A4 从第二帧的第二条记录取到 callId 与工具名', Array.isArray(waitQ?.pendingCallIds)
    && waitQ.pendingCallIds.some(item => item.callId === 'call-ask' && item.name === 'ask_user_question'), waitQ?.pendingCallIds)
  check('A5 waiting 压过边界未闭合的 running', waitQ?.openTurnStartSeq !== null && waitQ?.state === 'waiting',
    { openTurnStartSeq: waitQ?.openTurnStartSeq, state: waitQ?.state })

  const approval = facts(ID.waitApproval)
  check('A6 审批未决判 waiting', approval?.state === 'waiting', approval)
  check('A7 等待类别 approval 且取到工具名', approval?.waitingKind === 'approval'
    && approval.pendingCallIds?.some(item => item.callId === 'call-pw' && item.name === 'pwsh'), approval)

  const pendingTool = facts(ID.pendingTool)
  check('A8 普通工具在飞判 running 而非 waiting', pendingTool?.state === 'running' && pendingTool?.waiting === false, pendingTool)
  check('A9 普通工具也回报 callId 与工具名', pendingTool?.pendingCallIds?.some(item => item.name === 'pwsh'), pendingTool?.pendingCallIds)

  check('A10 openStep 有值判 running', facts(ID.run)?.state === 'running' && facts(ID.run)?.openStep !== null, facts(ID.run))
  check('A11 仅边界未闭合也判 running', facts(ID.boundary)?.state === 'running' && facts(ID.boundary)?.openStep === null, facts(ID.boundary))
  check('A12 三者都不成立判 idle', facts(ID.idleY)?.state === 'idle', facts(ID.idleY))

  const unknownMissing = facts(ID.unknownMissing)
  check('A13 正文缺失判 unknown', unknownMissing?.state === 'unknown', unknownMissing)
  check('A14 unknown 附原因', typeof unknownMissing?.stateReason === 'string' && unknownMissing.stateReason.length > 0, unknownMissing?.stateReason)

  const unknownTarget = facts(ID.unknownTarget)
  check('A15 正文里没有该 callId 判 unknown', unknownTarget?.state === 'unknown', unknownTarget)
  check('A16 原因点名缺的 callId', /call-missing/.test(String(unknownTarget?.stateReason)), unknownTarget?.stateReason)

  const noDir = facts(ID.noDir)
  check('A17 投影没有 workingDirectory + 有待返回调用 -> unknown', noDir?.state === 'unknown', noDir)
  check('A18 原因说明没有 workingDirectory', /workingDirectory/.test(String(noDir?.stateReason)), noDir?.stateReason)

  check('A19 同目录未知会话在 /status 也报 unknown', facts(ID.unknownMixed)?.state === 'unknown', facts(ID.unknownMixed))

  // ================= activePeers：分组与跳过 =================
  section('activePeers：分组与跳过规则（经 /prompt，假 controller）')
  let before = calls.length
  r = await post('prompt', { sessionId: ID.idleX, text: 'x', access: 'write' })
  check('C1 同目录在跑 -> 409 directory-busy', r.status === 409 && r.json.code === 'directory-busy', r)
  check('C2 占用者 id 与状态正确', r.json.occupant?.sessionId === ID.run && r.json.occupant?.state === 'running', r.json.occupant)
  check('C3 被拦时未投递', calls.length === before && !calls.some(call => call.sessionId === ID.idleX), calls.map(call => call.sessionId))

  r = await post('prompt', { sessionId: ID.idleY, text: 'x', access: 'write' })
  check('C4 另一个目录没有占用 -> 200 且投递一次', r.status === 200 && calls.some(call => call.sessionId === ID.idleY), r)

  r = await post('prompt', { sessionId: ID.idleZ, text: 'x', access: 'write' })
  check('C5 同目录有会话在等人 -> 409', r.status === 409, r)
  check('C6 在等人的 409 带 needsHuman 与答卡提示', r.json.needsHuman === true
    && /GUI/.test(String(r.json.hint)) && /answer/i.test(String(r.json.hint)), r.json)

  r = await post('prompt', { sessionId: ID.idleV, text: 'x', access: 'write' })
  check('C7 普通工具在飞的邻居算 running（不是 waiting）', r.status === 409 && r.json.occupant?.sessionId === ID.pendingTool
    && r.json.occupant?.state === 'running', r.json.occupant)
  check('C8 普通工具在飞不写 needsHuman', !('needsHuman' in r.json), r.json)

  r = await post('prompt', { sessionId: ID.idleU, text: 'x', access: 'write' })
  check('C9 同目录状态未知的会话计入占用 -> 409', r.status === 409, r)
  check('C10 未知占用者带 stateReason 且不写 needsHuman', r.json.occupant?.state === 'unknown'
    && typeof r.json.occupant?.stateReason === 'string' && !('needsHuman' in r.json), r.json.occupant)

  r = await post('prompt', { sessionId: ID.waitQ, text: 'x', access: 'write' })
  check('C11 目标自己在等人 -> 409 session-waiting + needsHuman', r.status === 409
    && r.json.code === 'session-waiting' && r.json.needsHuman === true, r)

  r = await post('prompt', { sessionId: ID.unknownTarget, text: 'x', access: 'write' })
  check('C12 目标自己状态未知 -> 409 session-unknown', r.status === 409 && r.json.code === 'session-unknown', r)
  check('C13 目标未知不写 needsHuman 且带原因', !('needsHuman' in r.json)
    && typeof r.json.occupant?.stateReason === 'string', r.json)

  r = await post('prompt', { sessionId: ID.noProjection, text: 'x', access: 'write' })
  check('C14 没有投影的新会话仍放行 -> 200', r.status === 200, r)

  r = await post('prompt', { sessionId: ID.idleX, text: 'x', access: 'read' })
  check('C15 只读派单不受占用影响 -> 200', r.status === 200, r)

  r = await post('prompt', { sessionId: ID.selfRunning, text: 'x', access: 'write' })
  check('C16 对在跑的自己追加 -> 200', r.status === 200, r)

  r = await post('prompt', { sessionId: ID.idleM, text: 'x', access: 'write' })
  const mixedStates = (r.json.occupants ?? []).map(peer => peer.state).sort()
  check('C17 waiting 与 unknown 同时占用 -> 409', r.status === 409 && mixedStates.join(',') === 'unknown,waiting',
    { states: mixedStates, code: r.json.code })
  check('C18 有确定在等人时仍给 needsHuman', r.json.needsHuman === true, r.json)
  check('C19 提示同时说明答卡与修正文路径', /answer/i.test(String(r.json.hint))
    && /session body path/i.test(String(r.json.hint)), r.json.hint)
  check('C20 被拦的目标都没有被投递', !calls.some(call => [ID.idleZ, ID.idleV, ID.idleU, ID.waitQ, ID.unknownTarget, ID.idleM].includes(call.sessionId)),
    calls.map(call => call.sessionId))

  // ================= 第二轮：汇报协议、票的阶段、成本 =================
  section('第二轮：report 三态、正文有界与缓存')
  const bindReport = async (taskId, sessionId) => {
    const bound = await post('pointer', { taskId, sessionId, mode: 'read' })
    if (bound.status !== 200) throw new Error('report fixture pointer failed: ' + taskId + ' ' + safeJson(bound.json))
  }
  for (const [taskId, sessionId] of [
    ['selftest-report-good', ID.reportGood],
    ['selftest-report-missing', ID.reportMissing],
    ['selftest-report-bad', ID.reportBadWord],
    ['selftest-report-none', ID.reportUnreported],
    ['selftest-report-deep', ID.reportDeep],
    ['selftest-report-escalate', ID.reportEscalate],
    ['selftest-report-no-anchor', ID.reportNoAnchor],
    ['selftest-report-locate', ID.reportLocate],
    ['selftest-report-newer-broken', ID.reportNewerBroken],
    ['selftest-report-oversize', ID.reportOversize],
    ['selftest-report-pair-a', ID.reportPair],
    ['selftest-report-pair-b', ID.reportPair],
    ['selftest-report-none-owner', ID.reportPair],
    ['selftest-report-missing-task', ID.reportMissingTask],
    ['selftest-line-anchor', ID.reportLineAnchor],
    ['selftest-anchor-noise', ID.reportAnchorNoise],
    ['selftest-report-newest', ID.reportNewestNoTask],
    ['selftest-conflict', ID.run],
  ]) await bindReport(taskId, sessionId)

  let single = await post('status', { taskId: 'selftest-report-good' })
  let entry = single.json.pointers[0]
  check('F1 真实格式的汇报块解析为 ready', entry?.report?.state === 'ready', entry?.report)
  check('F2 report 带锚点所在 seq', entry?.report?.seq === 5002, entry?.report?.seq)
  check('F3 report 解析出结论与凭据', entry?.report?.lines?.conclusion === 'selftest conclusion'
    && entry?.report?.lines?.evidence === 'selftest evidence', entry?.report?.lines)
  check('F4 首次解析未命中缓存', entry?.report?.fromCache === false, entry?.report?.fromCache)
  check('F4b 读数带回块里的任务号（缺陷 I）', entry?.report?.taskId === 'selftest-report-good', entry?.report?.taskId)
  check('F5 stage 与 liveState 并列返回', entry?.stage === 'delivered' && entry?.liveState === entry?.state,
    { stage: entry?.stage, liveState: entry?.liveState, state: entry?.state })

  single = await post('status', { taskId: 'selftest-report-good' })
  entry = single.json.pointers[0]
  check('F6 同一正文未变时命中缓存', entry?.report?.fromCache === true, entry?.report?.fromCache)

  entry = (await post('status', { taskId: 'selftest-report-missing' })).json.pointers[0]
  check('F7 缺凭据行 -> invalid', entry?.report?.state === 'invalid', entry?.report)
  check('F8 invalid 点名缺的行', Array.isArray(entry?.report?.missing) && entry.report.missing.includes('凭据'), entry?.report?.missing)

  entry = (await post('status', { taskId: 'selftest-report-bad' })).json.pointers[0]
  check('F9 状态词不在四个之内 -> invalid 且不猜', entry?.report?.state === 'invalid'
    && /done/.test(String(entry?.report?.reason)), entry?.report)

  entry = (await post('status', { taskId: 'selftest-report-none' })).json.pointers[0]
  check('F10 没有锚点 -> unreported 且 seq 为 null', entry?.report?.state === 'unreported' && entry?.report?.seq === null, entry?.report)
  check('F11 unreported 不携带推测状态', entry?.report?.lines === null, entry?.report)

  entry = (await post('status', { taskId: 'selftest-report-deep' })).json.pointers[0]
  check('F12 锚点在末向 8 帧之外 -> 放大窗口后取到（缺陷 H）', entry?.report?.state === 'ready'
    && entry?.report?.seq === 5400, entry?.report)
  check('F12b 放大后命中即停：10 帧正文扫满 10 帧', entry?.report?.scannedFrames === 10
    && entry?.report?.bodyFrames === 10, entry?.report)

  const pointerTextAfterReport = readFileSync(pointerPath, 'utf8')
  check('F13 汇报原文不进指针文件', !pointerTextAfterReport.includes('汇报状态')
    && !pointerTextAfterReport.includes('selftest conclusion'), pointerTextAfterReport.includes('汇报状态'))

  // ================= 缺陷 H：窗口放大、三类 stateReason、缓存不固化 =================
  section('缺陷 H：报告扫描逐级放大、三类 stateReason、缓存不固化')
  const hStatus = async (taskId) => (await post('status', { taskId })).json.pointers[0].report

  let hRead = await hStatus('selftest-report-escalate')
  check('I1 锚点距尾部 49 帧：放大后取到 ready', hRead?.state === 'ready' && hRead?.seq === 7100, hRead)
  check('I2 命中即停：只扫了尾部 50 帧而不是整份 60 帧', hRead?.scannedFrames === 50
    && hRead?.bodyFrames === 60, { scannedFrames: hRead?.scannedFrames, bodyFrames: hRead?.bodyFrames })
  check('I3 首次调用未命中缓存且给出扫描字节数', hRead?.fromCache === false
    && typeof hRead?.scannedBytes === 'number' && hRead.scannedBytes > 0, hRead)

  hRead = await hStatus('selftest-report-escalate')
  check('I4 正文未变时命中缓存且本次不扫帧', hRead?.fromCache === true && hRead?.state === 'ready'
    && hRead?.scannedFrames === 0 && hRead?.scannedBytes === 0, hRead)

  hRead = await hStatus('selftest-report-no-anchor')
  check('I5 整份读完无锚点才叫 unreported', hRead?.state === 'unreported' && hRead?.seq === null, hRead)
  check('I6 unreported 带上整份正文的帧数与字节数', hRead?.scannedFrames === 12
    && hRead?.bodyFrames === 12 && hRead?.scannedBytes === hRead?.bodyBytes
    && hRead?.stateReason === null, hRead)

  // 正文定位不到：unknown + 原因，且不得叫 unreported。
  const escalatePath = bodyPath(DIR.r8, ID.reportEscalate)
  const savedEscalateBody = readFileSync(escalatePath)
  const hiddenEscalateBody = escalatePath + '.hidden'
  renameSync(escalatePath, hiddenEscalateBody)
  const locateRead = await hStatus('selftest-report-escalate')
  check('I7 正文定位不到 -> unknown 且原因说明定位失败', locateRead?.state === 'unknown'
    && /could not be located/.test(String(locateRead?.stateReason)), locateRead)
  check('I8 定位不到时本次没有命中缓存', locateRead?.fromCache === false, locateRead)
  const locateAgain = await hStatus('selftest-report-escalate')
  check('I9 取不到的原因不进缓存（两次读数一致且都没命中缓存）',
    JSON.stringify(locateAgain) === JSON.stringify(locateRead) && locateAgain?.fromCache === false,
    { first: locateRead?.stateReason, second: locateAgain?.stateReason, fromCache: locateAgain?.fromCache })

  // 还原：内容逐字节一致，写入让 mtime 变化，缓存键因此失效 -> 立刻重新扫描。
  writeFileSync(escalatePath, savedEscalateBody)
  rmSync(hiddenEscalateBody, { force: true })
  hRead = await hStatus('selftest-report-escalate')
  check('I10 正文还原后立刻回到 ready（不需要重启宿主）', hRead?.state === 'ready' && hRead?.seq === 7100, hRead)
  check('I11 还原后是重新扫描，不是沿用失败读数', hRead?.fromCache === false
    && hRead?.scannedFrames > 0, hRead)
  check('I12 还原内容逐字节一致', readFileSync(escalatePath).equals(savedEscalateBody), readFileSync(escalatePath).length)

  // 最近一帧解压失败：更老的汇报不能当最新答案。追加一个“魔数 + 非 zstd 载荷”的假帧，
  // 这时 zstdDecompressSync 会抛 Unknown frame descriptor（截断帧不会抛，见 I13b 注释）。
  const newerPath = bodyPath(DIR.r11, ID.reportNewerBroken)
  const newerBytes = readFileSync(newerPath)
  const fakeFrame = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not a zstd frame')])
  writeFileSync(newerPath, Buffer.concat([newerBytes, fakeFrame]))
  const decompressRead = await hStatus('selftest-report-newer-broken')
  check('I13 最近一帧解压失败 -> unknown，不把更老的汇报当最新', decompressRead?.state === 'unknown'
    && /could not be decompressed/.test(String(decompressRead?.stateReason)), decompressRead)

  // 正文整份都不是 zstd（例如被写坏成纯文本）：一个字都读不出来，不能叫 unreported。
  writeFileSync(newerPath, Buffer.from('{"type":"message","seq":1}\n'))
  const noFrameRead = await hStatus('selftest-report-newer-broken')
  check('I13b 非空正文没有任何 zstd 帧 -> unknown 而不是 unreported', noFrameRead?.state === 'unknown'
    && /holds no zstd frame/.test(String(noFrameRead?.stateReason)), noFrameRead)
  writeFileSync(newerPath, newerBytes)

  // 超过扫描上限：没读满整份正文，也只能 unknown。
  const oversizeRead = await hStatus('selftest-report-oversize')
  check('I14 超过扫描上限 -> unknown 且说明没有读满整份', oversizeRead?.state === 'unknown'
    && /not read in full/.test(String(oversizeRead?.stateReason)) && oversizeRead?.bodyFrames === 4200,
    { state: oversizeRead?.state, reason: oversizeRead?.stateReason, bodyFrames: oversizeRead?.bodyFrames })
  check('I15 上限以内停下：扫描字节不超过 16 MiB 且未覆盖整份',
    oversizeRead?.scannedBytes <= SCAN_BYTE_LIMIT && oversizeRead?.scannedFrames < oversizeRead?.bodyFrames,
    { frames: oversizeRead?.scannedFrames, bytes: oversizeRead?.scannedBytes })
  const hReasons = [locateRead?.stateReason, decompressRead?.stateReason, oversizeRead?.stateReason]
  check('I16 三类取不到的原因字节级不同', new Set(hReasons).size === 3
    && hReasons.every(reason => typeof reason === 'string' && reason.length > 0), hReasons)

  // ================= 缺陷 I / J：票级认领与行首锚点 =================
  section('缺陷 I/J：汇报按任务号认领、锚点与标签必须行首')
  const pairA = (await post('status', { taskId: 'selftest-report-pair-a' })).json.pointers[0].report
  const pairB = (await post('status', { taskId: 'selftest-report-pair-b' })).json.pointers[0].report
  check('J1 同一会话两条块：A 取自己那条 5002', pairA?.state === 'ready' && pairA?.seq === 5002
    && pairA?.taskId === 'selftest-report-pair-a', pairA)
  check('J2 同一会话两条块：B 取自己那条 5004 且不拿 A 的读数', pairB?.state === 'blocked' && pairB?.seq === 5004
    && pairB?.taskId === 'selftest-report-pair-b', pairB)

  const pairAgain = (await post('status', { taskId: 'selftest-report-pair-a' })).json.pointers[0].report
  check('J3 缓存按（会话+任务号）分开：A 第二次命中，B 第一次仍要扫', pairAgain?.fromCache === true
    && pairB?.fromCache === false, { a: pairAgain?.fromCache, b: pairB?.fromCache })

  const noOwner = (await post('status', { taskId: 'selftest-report-none-owner' })).json.pointers[0].report
  check('J4 没有自己任务号的块 -> unreported 且整份读完', noOwner?.state === 'unreported'
    && noOwner?.scannedFrames === noOwner?.bodyFrames && noOwner?.scannedFrames > 0, noOwner)

  let jBytes = readFileSync(pointerPath)
  let mismatch = await post('pointer', {
    taskId: 'selftest-report-none-owner', sessionId: ID.reportPair, stage: 'reported_ready', seq: 5002,
  })
  check('J5 拿别的票的 seq 挪站 -> 400 report-task-mismatch', mismatch.status === 400
    && mismatch.json.code === 'report-task-mismatch', mismatch)
  check('J6 mismatch 的报错写明这条不是这张票的', /names selftest-report-pair-a, not selftest-report-none-owner/.test(String(mismatch.json.error)), mismatch.json.error)
  check('J7 mismatch 后指针文件字节不变', readFileSync(pointerPath).equals(jBytes), readFileSync(pointerPath).length)

  const missingTask = (await post('status', { taskId: 'selftest-report-missing-task' })).json.pointers[0].report
  check('J8 缺任务行 -> invalid 且点名任务行', missingTask?.state === 'invalid'
    && Array.isArray(missingTask?.missing) && missingTask.missing.includes('任务'), missingTask)

  jBytes = readFileSync(pointerPath)
  const missingTaskStage = await post('pointer', {
    taskId: 'selftest-report-missing-task', sessionId: ID.reportMissingTask, stage: 'reported_ready', seq: 5200,
  })
  check('J9 挪站复核缺任务行 -> 400 report-missing-task', missingTaskStage.status === 400
    && missingTaskStage.json.code === 'report-missing-task', missingTaskStage)
  check('J10 复核失败不写指针', readFileSync(pointerPath).equals(jBytes), readFileSync(pointerPath).length)

  const lineAnchor = (await post('status', { taskId: 'selftest-line-anchor' })).json.pointers[0].report
  check('J11 凭据行里夹带的“汇报状态: ready”不算锚点，真锚点解析为 blocked', lineAnchor?.state === 'blocked'
    && lineAnchor?.seq === 5300 && /汇报状态: ready」/.test(String(lineAnchor?.lines?.evidence)), lineAnchor)

  const anchorNoise = (await post('status', { taskId: 'selftest-anchor-noise' })).json.pointers[0].report
  check('J12 锚点行冒号后还有别的话 -> invalid 且点名这条规则', anchorNoise?.state === 'invalid'
    && /carries text after the status word/.test(String(anchorNoise?.reason)), anchorNoise)

  const newestNoTask = (await post('status', { taskId: 'selftest-report-newest' })).json.pointers[0].report
  check('J13 最新块没有任务行时不回退到更老的块 -> invalid 缺任务', newestNoTask?.state === 'invalid'
    && newestNoTask?.missing?.includes('任务') && newestNoTask?.seq === 6100, newestNoTask)

  jBytes = readFileSync(pointerPath)
  const wrongWord = await post('pointer', {
    taskId: 'selftest-report-pair-b', sessionId: ID.reportPair, stage: 'reported_ready', seq: 5004,
  })
  check('J14 块认领本票但状态词不符 -> 400 report-unverified', wrongWord.status === 400
    && wrongWord.json.code === 'report-unverified' && readFileSync(pointerPath).equals(jBytes), wrongWord)

  section('第二轮：cost 七字段与缺行 null')
  entry = (await post('status', { taskId: 'selftest-report-good' })).json.pointers[0]
  check('G1 cost 七个字段与投影逐字段一致', JSON.stringify(entry?.cost) === JSON.stringify(COST_EXPECTED), entry?.cost)
  entry = (await post('status', { taskId: 'selftest-report-missing' })).json.pointers[0]
  check('G2 投影没有成本两行 -> cost 为 null 不是 0', entry?.cost === null, entry?.cost)

  const goodProjection = join(projDir, ID.reportGood + '.json')
  const goodProjectionBytes = readFileSync(goodProjection, 'utf8')
  const goodProjectionJson = JSON.parse(goodProjectionBytes)
  delete goodProjectionJson.record.rows.tokenUsage
  delete goodProjectionJson.record.rows.contextPressure
  writeFileSync(goodProjection, JSON.stringify(goodProjectionJson))
  const pointerBytesBeforeCost = readFileSync(pointerPath)
  entry = (await post('status', { taskId: 'selftest-report-good' })).json.pointers[0]
  check('G3 删掉投影两行后 cost 为 null', entry?.cost === null, entry?.cost)
  check('G4 cost 破坏性试验不改指针文件', readFileSync(pointerPath).equals(pointerBytesBeforeCost), 'pointer changed')
  writeFileSync(goodProjection, goodProjectionBytes)
  entry = (await post('status', { taskId: 'selftest-report-good' })).json.pointers[0]
  check('G5 恢复投影后 cost 回到原值', JSON.stringify(entry?.cost) === JSON.stringify(COST_EXPECTED), entry?.cost)

  section('第二轮：stage 迁移表、证据复核、conflict')
  const pointerBytes = () => readFileSync(pointerPath)
  const unchanged = (before) => pointerBytes().equals(before)
  let stageSessionsMade = 0
  const stageSessions = new Map()
  /**
   * 每张票一个专属会话：正文里的块写明它的任务号（缺陷 I），所以同一批断言不会
   * 因为「会话里最近一条汇报属于别的票」而串号。
   */
  const startStage = async (taskId, extra = {}) => {
    stageSessionsMade += 1
    const sessionId = 'session-selftest-stage-' + String(stageSessionsMade)
    const cwd = 'D:\\fixture\\selftest-stage-' + String(stageSessionsMade)
    writeProjection(sessionId, cwd, 'idle')
    writeBody(cwd, sessionId, [
      [assistantMessage(5000, reportText('blocked', taskId, { prerequisite: 'need a human decision' }))],
      [assistantMessage(5002, reportText('ready', taskId))],
      [assistantMessage(5500, reportText('failed', taskId))],
      [assistantMessage(5600, reportText('dropped', taskId))],
    ])
    stageSessions.set(taskId, sessionId)
    return post('pointer', { taskId, sessionId, mode: 'read', ...extra })
  }
  const stageWrite = (taskId, body) => post('pointer', { taskId, sessionId: stageSessions.get(taskId), ...body })

  await startStage('selftest-stage-1')
  let beforeBytes = pointerBytes()
  let stageResult = await stageWrite('selftest-stage-1', { stage: 'reported_blocked', seq: 5000 })
  check('H1 表内 delivered -> reported_blocked 成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'reported_blocked', stageResult)
  check('H2 成功追加一条 history（report + seq）', stageResult.json.pointer?.history?.length === 1
    && stageResult.json.pointer.history[0]?.evidence?.kind === 'report'
    && stageResult.json.pointer.history[0]?.evidence?.seq === 5000, stageResult.json.pointer?.history)
  check('H3 history 只记 seq 不存汇报原文', !JSON.stringify(stageResult.json.pointer.history).includes('selftest conclusion'),
    stageResult.json.pointer?.history)

  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-1', { stage: 'accepted', note: 'human accept' })
  check('H4 表外 reported_blocked -> accepted 被拒 4xx', stageResult.status >= 400 && stageResult.status < 500, stageResult)
  check('H5 表外迁移后指针文件字节不变', unchanged(beforeBytes), pointerBytes().length)

  stageResult = await stageWrite('selftest-stage-1', { stage: 'voided', note: 'no longer needed' })
  check('H6 表内 reported_blocked -> voided 成功且记录 human note', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'voided'
    && stageResult.json.pointer.history.at(-1)?.evidence?.kind === 'human', stageResult.json.pointer)

  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-1', { stage: 'reported_ready', seq: 5002 })
  check('H7 voided 不可直接回 reported_* -> 4xx 且文件不变', stageResult.status >= 400
    && stageResult.status < 500 && unchanged(beforeBytes), stageResult)

  stageResult = await stageWrite('selftest-stage-1', { stage: 'delivered', requestId: 'selftest-redeliver-1' })
  check('H8 新 requestId 重投 -> delivered 且保留 history', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered' && stageResult.json.pointer.history.length === 3, stageResult.json.pointer)
  check('H9 重投证据为 redeliver + requestId', stageResult.json.pointer.history.at(-1)?.evidence?.kind === 'redeliver'
    && stageResult.json.pointer.history.at(-1)?.evidence?.requestId === 'selftest-redeliver-1', stageResult.json.pointer.history.at(-1))

  await startStage('selftest-stage-2', { requestId: 'selftest-req-stage-2' })
  stageResult = await stageWrite('selftest-stage-2', { stage: 'reported_blocked', seq: 5000 })
  check('H10 首站 delivered -> reported_blocked', stageResult.status === 200, stageResult)
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-2', { stage: 'reported_blocked', seq: 5000 })
  check('H11 同 requestId seq 不增的改口被拒且文件不变', stageResult.status >= 400
    && stageResult.status < 500 && unchanged(beforeBytes), stageResult)
  stageResult = await stageWrite('selftest-stage-2', { stage: 'reported_ready', seq: 5002 })
  check('H12 seq 严格增的改口成功且两站都留痕', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'reported_ready'
    && stageResult.json.pointer.history.filter(item => item.evidence?.kind === 'report').length === 2, stageResult.json.pointer)

  await startStage('selftest-stage-3')
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-3', { stage: 'reported_ready', seq: 5000 })
  check('H13 seq 处正文是 blocked 却报 ready -> 拒写且文件不变', stageResult.status === 400
    && unchanged(beforeBytes), stageResult)
  stageResult = await stageWrite('selftest-stage-3', { stage: 'reported_ready', seq: 999999 })
  check('H14 正文没有该 seq -> 拒写', stageResult.status === 400, stageResult)
  stageResult = await stageWrite('selftest-stage-3', { stage: 'reported_ready' })
  check('H15 reported_* 不带 seq -> 400', stageResult.status === 400, stageResult)

  await startStage('selftest-stage-4')
  stageResult = await stageWrite('selftest-stage-4', { stage: 'reported_ready', seq: 5002 })
  check('H16 先到 reported_ready', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'reported_ready', stageResult)
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-4', { stage: 'accepted' })
  check('H17 accepted 不带 note -> 400 且文件不变', stageResult.status === 400 && unchanged(beforeBytes), stageResult)
  stageResult = await stageWrite('selftest-stage-4', { stage: 'accepted', note: 'human accepts' })
  check('H18 accepted 带 note -> 成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'accepted', stageResult)
  check('H19 acceptance 恒等于 stage === accepted', stageResult.json.pointer?.acceptance === 'accepted',
    stageResult.json.pointer?.acceptance)
  check('H20 acceptedAt 等于 accepted 那站时间', stageResult.json.pointer?.acceptedAt === stageResult.json.pointer?.history?.at(-1)?.at,
    { acceptedAt: stageResult.json.pointer?.acceptedAt, last: stageResult.json.pointer?.history?.at(-1) })
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-4', { stage: 'voided', note: 'x' })
  check('H21 accepted 不可直接 voided -> 4xx 且文件不变', stageResult.status >= 400
    && stageResult.status < 500 && unchanged(beforeBytes), stageResult)
  beforeBytes = pointerBytes()
  stageResult = await post('pointer', { taskId: 'selftest-stage-4', sessionId: ID.reportGood, acceptance: 'accepted' })
  check('H22 acceptance 不再是可写字段 -> 400 且文件不变', stageResult.status === 400
    && unchanged(beforeBytes), stageResult)

  beforeBytes = pointerBytes()
  stageResult = await post('pointer', { taskId: 'selftest-conflict', sessionId: ID.run, stage: 'reported_ready', seq: 6000 })
  check('H23 对方报 ready 但投影在跑 -> 409 conflict', stageResult.status === 409
    && stageResult.json.code === 'conflict', stageResult)
  check('H24 conflict 返回两侧读数', stageResult.json.stage?.current === 'delivered'
    && stageResult.json.live?.openStep !== null, stageResult.json)
  check('H25 conflict 后指针文件字节不变', unchanged(beforeBytes), pointerBytes().length)

  // 迁移表其余行：failed / dropped / ready->delivered / ready->voided /
  // blocked->delivered / accepted->delivered。
  await startStage('selftest-stage-failed', { requestId: 'selftest-req-failed' })
  stageResult = await stageWrite('selftest-stage-failed', { stage: 'reported_failed', seq: 5500 })
  check('H51 delivered -> reported_failed 成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'reported_failed', stageResult)
  stageResult = await stageWrite('selftest-stage-failed', { stage: 'delivered', requestId: 'selftest-redeliver-failed' })
  check('H52 reported_failed -> delivered（新 requestId）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered', stageResult)

  await startStage('selftest-stage-dropped')
  stageResult = await stageWrite('selftest-stage-dropped', { stage: 'reported_dropped', seq: 5600 })
  check('H53 delivered -> reported_dropped 成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'reported_dropped', stageResult)
  stageResult = await stageWrite('selftest-stage-dropped', { stage: 'delivered', requestId: 'selftest-redeliver-dropped' })
  check('H54 reported_dropped -> delivered（新 requestId）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered', stageResult)

  await startStage('selftest-stage-ready-deliver')
  stageResult = await stageWrite('selftest-stage-ready-deliver', { stage: 'reported_ready', seq: 5002 })
  check('H55 delivered -> reported_ready 成功', stageResult.status === 200, stageResult)
  stageResult = await stageWrite('selftest-stage-ready-deliver', { stage: 'delivered', requestId: 'selftest-redeliver-ready' })
  check('H56 reported_ready -> delivered（同任务重投）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered', stageResult)

  await startStage('selftest-stage-ready-void')
  await stageWrite('selftest-stage-ready-void', { stage: 'reported_ready', seq: 5002 })
  stageResult = await stageWrite('selftest-stage-ready-void', { stage: 'voided', note: 'ready but discarded' })
  check('H57 reported_ready -> voided 成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'voided', stageResult)

  await startStage('selftest-stage-blocked-deliver')
  await stageWrite('selftest-stage-blocked-deliver', { stage: 'reported_blocked', seq: 5000 })
  stageResult = await stageWrite('selftest-stage-blocked-deliver', { stage: 'delivered', requestId: 'selftest-redeliver-blocked' })
  check('H58 reported_blocked -> delivered（同任务重投）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered', stageResult)

  await startStage('selftest-stage-accepted-deliver')
  await stageWrite('selftest-stage-accepted-deliver', { stage: 'reported_ready', seq: 5002 })
  await stageWrite('selftest-stage-accepted-deliver', { stage: 'accepted', note: 'accepted for delivery test' })
  stageResult = await stageWrite('selftest-stage-accepted-deliver', { stage: 'delivered', requestId: 'selftest-redeliver-accepted' })
  check('H59 accepted -> delivered（新 requestId）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'delivered', stageResult)

  // `delivered` 有一条 `accepted` 出边：人带 note 直接结单，不必等对方按协议回话。
  // note 必填、终局不接受对方自报、结单后补报撞表外，三条都不放宽。
  await startStage('selftest-stage-deliver-accept')
  stageResult = await stageWrite('selftest-stage-deliver-accept', { stage: 'accepted', note: 'human closes it from delivered' })
  check('H60 表内 delivered -> accepted（人带 note）成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'accepted', stageResult)
  check('H61 直接结单追加 human 证据且带 note', stageResult.json.pointer?.history?.at(-1)?.evidence?.kind === 'human'
    && stageResult.json.pointer.history.at(-1).evidence.note === 'human closes it from delivered',
  stageResult.json.pointer?.history)
  check('H62 直接结单后 acceptance 派生为 accepted', stageResult.json.pointer?.acceptance === 'accepted',
    stageResult.json.pointer?.acceptance)
  check('H63 直接结单后 acceptedAt 等于这一站的 at', stageResult.json.pointer?.acceptedAt === stageResult.json.pointer?.history?.at(-1)?.at,
    { acceptedAt: stageResult.json.pointer?.acceptedAt, last: stageResult.json.pointer?.history?.at(-1) })

  await startStage('selftest-stage-deliver-accept-nonote')
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-deliver-accept-nonote', { stage: 'accepted' })
  check('H64 站在 delivered 直接结单不带 note -> 400 且文件字节不变', stageResult.status === 400
    && unchanged(beforeBytes), stageResult)

  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-deliver-accept', { stage: 'reported_ready', seq: 5002 })
  check('H65 结单后同 requestId 补报 reported_ready -> 4xx 且文件字节不变', stageResult.status >= 400
    && stageResult.status < 500 && unchanged(beforeBytes), stageResult)

  await startStage('selftest-stage-blocked-accept')
  await stageWrite('selftest-stage-blocked-accept', { stage: 'reported_blocked', seq: 5000 })
  beforeBytes = pointerBytes()
  stageResult = await stageWrite('selftest-stage-blocked-accept', { stage: 'accepted', note: 'blocked but accepted' })
  check('H66 reported_blocked -> accepted 仍是表外，4xx 且文件字节不变', stageResult.status >= 400
    && stageResult.status < 500 && unchanged(beforeBytes), stageResult)

  const legacyPending = {
    taskId: 'selftest-legacy-pending', sessionId: ID.reportUnreported, mode: 'read',
    requestId: null, acceptance: 'pending', acceptedAt: null, createdAt: 100, note: null,
  }
  const legacyAccepted = {
    taskId: 'selftest-legacy-accepted', sessionId: ID.reportUnreported, mode: 'read',
    requestId: null, acceptance: 'accepted', acceptedAt: 123456, createdAt: 100, note: null,
  }
  const pointerDoc = JSON.parse(readFileSync(pointerPath, 'utf8'))
  pointerDoc.pointers.push(legacyPending, legacyAccepted)
  writeFileSync(pointerPath, JSON.stringify(pointerDoc, null, 2) + '\n')
  const legacyPendingStatus = await post('status', { taskId: 'selftest-legacy-pending' })
  const legacyAcceptedStatus = await post('status', { taskId: 'selftest-legacy-accepted' })
  check('H26 既有 pending 记录派生 delivered', legacyPendingStatus.json.pointers[0]?.stage === 'delivered'
    && legacyPendingStatus.json.pointers[0]?.acceptance === 'pending', legacyPendingStatus.json.pointers[0])
  check('H27 既有 accepted 记录派生 accepted + acceptedAt', legacyAcceptedStatus.json.pointers[0]?.stage === 'accepted'
    && legacyAcceptedStatus.json.pointers[0]?.acceptance === 'accepted'
    && legacyAcceptedStatus.json.pointers[0]?.acceptedAt === 123456, legacyAcceptedStatus.json.pointers[0])
  check('H28 派生不补写 history', Array.isArray(legacyPendingStatus.json.pointers[0]?.history)
    && legacyPendingStatus.json.pointers[0].history.length === 0, legacyPendingStatus.json.pointers[0]?.history)

  // 站点写入落盘时删掉 `acceptance`/`acceptedAt`：文件里不留第二份真相。
  const legacyWritable = {
    taskId: 'selftest-legacy-writable', sessionId: ID.reportUnreported, mode: 'read',
    requestId: null, acceptance: 'pending', acceptedAt: 999, createdAt: 100, note: null,
  }
  const keyDoc = JSON.parse(readFileSync(pointerPath, 'utf8'))
  keyDoc.pointers.push(legacyWritable)
  writeFileSync(pointerPath, JSON.stringify(keyDoc, null, 2) + '\n')
  stageResult = await post('pointer', {
    taskId: 'selftest-legacy-writable', sessionId: ID.reportUnreported, stage: 'accepted', note: 'human closes a legacy record',
  })
  check('H67 legacy 记录带 note 直接结单成功', stageResult.status === 200
    && stageResult.json.pointer?.stage === 'accepted', stageResult)
  const writtenRecord = pointerRecords().find(item => item.taskId === 'selftest-legacy-writable')
  check('H68 站点写入后文件里不再存 acceptance 键', writtenRecord !== undefined && !('acceptance' in writtenRecord), writtenRecord)
  check('H69 站点写入后文件里不再存 acceptedAt 键', writtenRecord !== undefined && !('acceptedAt' in writtenRecord), writtenRecord)
  check('H70 删键不影响派生读数', stageResult.json.pointer?.acceptance === 'accepted'
    && typeof stageResult.json.pointer?.acceptedAt === 'number', stageResult.json.pointer)
  const untouchedLegacy = pointerRecords().find(item => item.taskId === 'selftest-legacy-pending')
  check('H71 没被写过的既有记录保持原样（读侧不顺手改文件）', untouchedLegacy?.acceptance === 'pending'
    && !('stage' in untouchedLegacy), untouchedLegacy)

  // 30 天清理：终局站且终局时间超过 30 天才删，近期终局保留。
  const oldAccepted = {
    taskId: 'selftest-prune-accepted', sessionId: ID.reportUnreported, mode: 'read',
    requestId: null, acceptance: 'accepted', acceptedAt: Date.now() - 31 * 24 * 60 * 60 * 1000, createdAt: 1, note: null,
  }
  const oldVoided = {
    taskId: 'selftest-prune-voided', sessionId: ID.reportUnreported, mode: 'read', requestId: null,
    stage: 'voided', history: [{
      stage: 'voided', at: Date.now() - 31 * 24 * 60 * 60 * 1000, evidence: { kind: 'human', note: 'old' },
    }], createdAt: 1, note: 'old',
  }
  const freshAccepted = {
    taskId: 'selftest-prune-fresh', sessionId: ID.reportUnreported, mode: 'read',
    requestId: null, acceptance: 'accepted', acceptedAt: Date.now() - 1000, createdAt: 1, note: null,
  }
  const pruneDoc = JSON.parse(readFileSync(pointerPath, 'utf8'))
  pruneDoc.pointers.push(oldAccepted, oldVoided, freshAccepted)
  writeFileSync(pointerPath, JSON.stringify(pruneDoc, null, 2) + '\n')
  await post('pointer', { taskId: 'selftest-prune-trigger', sessionId: ID.reportUnreported, mode: 'read' })
  const prunedIds = JSON.parse(readFileSync(pointerPath, 'utf8')).pointers.map(pointer => pointer.taskId)
  check('H29 30 天外的 accepted 终局被清理', !prunedIds.includes('selftest-prune-accepted'), prunedIds)
  check('H30 30 天外的 voided 终局被清理', !prunedIds.includes('selftest-prune-voided'), prunedIds)
  check('H31 30 天内的 accepted 终局保留', prunedIds.includes('selftest-prune-fresh'), prunedIds)
  check('H32 当前站等于最后一条 history 的 stage', stageResult.json.pointer?.history?.at(-1)?.stage === stageResult.json.pointer?.stage,
    { stage: stageResult.json.pointer?.stage, historyLast: stageResult.json.pointer?.history?.at(-1) })

  // ================= CLI：参数校验（子进程，不经管道） =================
  section('CLI：参数校验与退出码（node bin/dsh-session.mjs ...）')
  let cliSeq = 0
  function runCli(args) {
    cliSeq += 1
    const outFile = join(cliHome, 'out-' + String(cliSeq) + '.txt')
    const errFile = join(cliHome, 'err-' + String(cliSeq) + '.txt')
    const outFd = openSync(outFile, 'w')
    const errFd = openSync(errFile, 'w')
    let result
    try {
      result = spawnSync(process.execPath, [join(repoRoot, 'bin', 'dsh-session.mjs'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, DSH_HOME: cliHome },
        stdio: ['ignore', outFd, errFd],
      })
    } finally {
      closeSync(outFd)
      closeSync(errFd)
    }
    return {
      status: result.status,
      spawnError: result.error,
      stdout: readFileSync(outFile, 'utf8'),
      stderr: readFileSync(errFile, 'utf8'),
    }
  }

  let cli = runCli(['--send', ID.pointerA, '--text', 'x'])
  check('D1 --send 缺 --access -> 退出 2 并指名该参数', cli.status === 2 && /--access/.test(cli.stderr),
    { status: cli.status, spawnError: cli.spawnError, stderr: cli.stderr.trim() })

  cli = runCli(['--send', ID.pointerA])
  check('D2 --send 缺 --text -> 退出 2', cli.status === 2 && /--text/.test(cli.stderr), { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--pointer', '--session', ID.pointerA, '--access', 'read'])
  check('D3 --pointer 缺 --task -> 退出 2', cli.status === 2 && /--task/.test(cli.stderr), { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--pointer', '--task', 'selftest-task-1', '--session', ID.pointerA])
  check('D4 --pointer 缺 --access -> 退出 2', cli.status === 2 && /--access/.test(cli.stderr), { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--accept', '--task', 'selftest-task-1'])
  check('D5 --accept 缺 --session -> 退出 2', cli.status === 2 && /--session/.test(cli.stderr), { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--send', ID.pointerA, '--text', 'x', '--access', 'read'])
  check('D6 参数齐全但没有 bridge.json -> 退出 2（读不到连接信息）', cli.status === 2 && /cannot read/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  mkdirSync(join(cliHome, 'plugin-data', 'dsh-session-bridge'), { recursive: true })
  writeFileSync(
    join(cliHome, 'plugin-data', 'dsh-session-bridge', 'bridge.json'),
    JSON.stringify({ url: 'http://127.0.0.1:9', token: FAKE_TOKEN }, null, 2) + '\n',
  )
  cli = runCli(['--dry-run', '--cwd', DIR.x])
  let dryRun = null
  try { dryRun = JSON.parse(cli.stdout) } catch { dryRun = null }
  check('D7 --dry-run -> 退出 0 且给出 url', cli.status === 0 && dryRun?.dryRun === true
    && String(dryRun?.url).startsWith('http://127.0.0.1:9/x-session-bridge/'), { status: cli.status, stdout: cli.stdout.trim() })
  check('D8 --dry-run 不打印 token', !cli.stdout.includes(FAKE_TOKEN) && !cli.stderr.includes(FAKE_TOKEN),
    { stdout: cli.stdout, stderr: cli.stderr })

  cli = runCli(['--pointer', '--task', 'selftest-task-1', '--session', ID.reportGood])
  check('D9 --pointer 既无 --access 也无 --stage -> 退出 2', cli.status === 2 && /--stage/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--pointer', '--task', 'selftest-task-1', '--session', ID.reportGood, '--stage', 'reported_ready'])
  check('D10 --stage reported_* 缺 --seq -> 退出 2', cli.status === 2 && /--seq/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--accept', '--task', 'selftest-task-1', '--session', ID.reportGood])
  check('D11 --accept 缺 --note -> 退出 2', cli.status === 2 && /--note/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--void', '--task', 'selftest-task-1', '--session', ID.reportGood])
  check('D12 --void 缺 --note -> 退出 2', cli.status === 2 && /--note/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--pointer', '--task', 'selftest-task-1', '--session', ID.reportGood, '--stage', 'bogus', '--seq', '1'])
  check('D13 非法 --stage -> 退出 2', cli.status === 2 && /--stage/.test(cli.stderr),
    { status: cli.status, stderr: cli.stderr.trim() })

  cli = runCli(['--dry-run', '--pointer', '--task', 'selftest-task-1', '--session', ID.reportGood, '--stage', 'reported_ready', '--seq', '1234'])
  let stageDryRun = null
  try { stageDryRun = JSON.parse(cli.stdout) } catch { stageDryRun = null }
  check('D14 --dry-run 透出 stage 与 seq 且仍不打印 token', cli.status === 0
    && stageDryRun?.stage === 'reported_ready' && stageDryRun?.seq === 1234
    && !cli.stdout.includes(FAKE_TOKEN), { status: cli.status, stdout: cli.stdout.trim() })

  console.log('\nSUMMARY pass=' + String(pass) + ' fail=' + String(fail))
  return fail === 0 ? 0 : 1
}

let exitCode = 1
try {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node has no zlib zstd support (need Node >= 22.15)')
  }
  exitCode = await runAll()
} catch (error) {
  console.error('selftest: ' + (error instanceof Error ? error.stack : String(error)))
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* temp dir */ }
}
process.exitCode = exitCode
