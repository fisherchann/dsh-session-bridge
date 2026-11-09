/**
 * dsh-session-bridge - open a new session in the running DSH Web GUI from an
 * external tool (Qoder, a CI job, a script).
 *
 * Why this exists: the GUI's own HTTP surface is not a public API. Everything
 * under `/` and `/api` needs the signed browser cookie minted from the
 * per-process launch token (`/connect?token=...`), and that token never leaves
 * the host process. A plugin, however, runs INSIDE the host, so it can serve a
 * route that the Web server matches before that cookie gate and can call the
 * host's own `sessionController` - the same service the GUI's "new session"
 * button uses.
 *
 * Accounting matters as much as creation. The GUI path is
 * `sessionController.create({ workspaceId })`: the controller derives the cwd
 * from `workspace.path`, then calls `workspace.attachSession(sessionId)`. A
 * session created with only `{ cwd }` is written to disk but never entered into
 * a Workspace roster, and the sidebar lists Sessions from that roster - so it
 * stays invisible. This plugin therefore resolves (or creates) the Workspace
 * first and hands the controller a `workspaceId`, reproducing the GUI path
 * instead of approximating it.
 *
 * Delivery is the other half of the story. A Session the host has never run a
 * turn on stays `blank`, and the GUI only draws a blank row when it is also the
 * current Session (`ui-workspace/src/client/tree.ts`), so a bridge-created
 * Session sits in the roster invisibly until someone types the first message.
 * `/sessions` and `/prompt` exist so the caller can decide for itself whether to
 * reuse a Session or open a new one, and then actually reach it - the host
 * dedupes `prompt` by requestId, so a delivery is safe to retry.
 *
 * Dispatch bookkeeping (Requirement 1): `/pointer` records the binding the
 * caller alone can know - which task a Session serves, the read/write nature of
 * that dispatch, and a person's acceptance - in `pointers.json` next to
 * `bridge.json`. Anything the host can compute (running, waiting, idle, blank,
 * last delivery, permission preset) is deliberately NOT stored there; it is
 * derived from the session projection cache on every read.
 *
 * Session state (Requirement 2): `/status` answers in one call for every
 * registered task, reading only the projection cache under
 * `$DSH_HOME/storages/session_projcache/sessions`. It is read-only: no browser
 * cookie, no hand-built `/api` request, no channel beyond this bridge's own
 * bearer token. The 30-day prune of finished pointers runs at plugin start and
 * on `/pointer` writes, never on `/status`.
 *
 * Security model: loopback Host allowlist plus a 32-byte bearer token kept at
 * `$DSH_HOME/plugin-data/dsh-session-bridge/bridge.json` (mode 0600). Anyone
 * able to read that file could already drive this host, so this adds no new
 * trust boundary - it only avoids reopening the browser-cookie gate.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import * as zlib from 'node:zlib'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'session-bridge'

/**
 * The Web server and the host session controller must exist before apply.
 * `workspaceRegistry` is resolved lazily instead of being injected: a host
 * without a Workspace model can still create Sessions (just unattached), and
 * injecting it would keep this plugin pending forever on such a host.
 */
export const inject = ['webServer', 'sessionController']

const NEW_PATH = '/x-session-bridge/new'
const ATTACH_PATH = '/x-session-bridge/attach'
const SESSIONS_PATH = '/x-session-bridge/sessions'
const PROMPT_PATH = '/x-session-bridge/prompt'
const POINTER_PATH = '/x-session-bridge/pointer'
const STATUS_PATH = '/x-session-bridge/status'
const HEALTH_PATH = '/x-session-bridge/health'
const MAX_BODY_BYTES = 64 * 1024
const TOKEN_BYTES = 32
/** Pointer file: the caller's Ticket-to-Session binding, kept next to bridge.json. */
const POINTER_FILE = 'pointers.json'
const POINTER_VERSION = 1
/** A finished pointer stays this long, so a later review can still trace the dispatch. */
const POINTER_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const POINTER_LIMIT = 5000
const MAX_NOTE_CHARS = 500
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
/** The read/write nature a dispatch declares: `read` runs beside writers, `write` is one per directory. */
const ACCESS_MODES = new Set(['read', 'write'])

/**
 * Ticket stations (round 2, Requirement 2). `liveState` is derived from the
 * projection and is deliberately NOT one of these: it lags a step, and persisting
 * it would create a second source of truth.
 */
const STAGES = new Set([
  'delivered',
  'reported_ready',
  'reported_blocked',
  'reported_failed',
  'reported_dropped',
  'accepted',
  'voided',
])
/** Report status word -> ticket station, for the four stations a report can write. */
const REPORT_STAGES = new Map([
  ['ready', 'reported_ready'],
  ['blocked', 'reported_blocked'],
  ['failed', 'reported_failed'],
  ['dropped', 'reported_dropped'],
])
/** The four status words the reporting protocol allows, and nothing else. */
const REPORT_STATES = new Set(REPORT_STAGES.keys())
/**
 * The literal anchor and the labelled lines of a report block. Since Defect I a block
 * names its own Ticket on the `任务` line, so one Session can carry several tickets and
 * none of them inherits another ticket's reading.
 */
const REPORT_ANCHOR = '汇报状态'
const REPORT_LABELS = [['task', '任务'], ['conclusion', '结论'], ['evidence', '凭据'], ['prerequisite', '前置']]
/**
 * How far the report scan reaches (Defect H). The first window stays the old 8 frames, so
 * the common case costs what it did before; a miss widens the window instead of answering
 * `unreported`, and the last pass reads the whole body. `REPORT_SCAN_BYTE_LIMIT` is the
 * only ceiling: a body larger than it cannot be read in full, which is `unknown` with a
 * reason, never `unreported`.
 */
const REPORT_FRAME_LIMIT = 8
const REPORT_FRAME_WINDOWS = [REPORT_FRAME_LIMIT, 64, 512]
const REPORT_SCAN_BYTE_LIMIT = 16 * 1024 * 1024
/**
 * The seven raw projection fields `/status.cost` passes through. Zero is a real
 * reading; a missing object or field is `null`, never 0 and never inferred.
 */
const COST_FIELDS = [
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'surfaceTokens',
  'contextWindow',
  'pressureTokens',
]

/** Absolute plugin state directory under the harness home. */
function stateDir() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(resolve(home), 'plugin-data', 'dsh-session-bridge')
}

/** Absolute harness home; the projection cache sits under it, beside `plugin-data`. */
function harnessHome() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return resolve(home)
}

/** Read the persisted token, minting one on first use. */
function loadOrCreateToken(dir) {
  const file = join(dir, 'token')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // absent file: fall through and mint
  }
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  try { writeFileSync(file, token + '\n', { mode: 0o600 }) } catch { /* best effort */ }
  try { chmodSync(file, 0o600) } catch { /* Windows has no POSIX mode */ }
  return token
}

/** Reject requests whose Host is not loopback (DNS-rebinding fence). */
function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const hostname = host.replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

/** Write one JSON response and end it. */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Buffer a request body with a hard size bound. */
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error(`body exceeds ${String(MAX_BODY_BYTES)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolvePromise(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', rejectPromise)
  })
}

/** Parse one JSON object body; throws a caller-facing message. */
async function readJsonObject(req) {
  const text = await readBody(req)
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed
}

/**
 * Resolve a host service across cordis versions: the injected service first,
 * then the reflect store, then the legacy `ctx.get` probe.
 * @param ctx - plugin context.
 * @param serviceName - cordis service name, e.g. `sessionController`.
 * @returns the service, or undefined when this host does not provide it.
 */
function resolveService(ctx, serviceName) {
  try {
    const injected = ctx[serviceName]
    if (injected !== undefined && injected !== null) return injected
  } catch {
    // not injectable in this scope / on this core
  }
  try {
    const viaReflect = ctx.reflect?.get?.(serviceName)
    if (viaReflect !== undefined && viaReflect !== null) return viaReflect
  } catch {
    // ignore
  }
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch {
    // ignore
  }
  return undefined
}

/**
 * Resolve the host session controller: 0.2.x exposes `create`, 0.1.x exposes
 * `createSession`.
 * @param ctx - plugin context.
 * @returns a controller exposing `create` or `createSession`, or undefined.
 */
function resolveController(ctx) {
  const value = resolveService(ctx, 'sessionController')
  const usable = value !== undefined
    && (typeof value.create === 'function' || typeof value.createSession === 'function')
  return usable ? value : undefined
}

/** Resolve the Workspace registry, when the host has a Workspace model. */
function resolveRegistry(ctx) {
  const value = resolveService(ctx, 'workspaceRegistry')
  return value !== undefined && typeof value.resolveByPath === 'function' ? value : undefined
}

/**
 * Canonicalize a directory the way the Workspace registry does, so a resolved
 * Workspace and the Session header agree byte for byte.
 * @param raw - absolute or relative directory.
 * @returns the canonical absolute path (best effort when it does not exist).
 */
function canonicalCwd(raw) {
  const absolute = isAbsolute(raw) ? raw : resolve(raw)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** Session id from either controller generation's result shape. */
function sessionIdOf(created) {
  const session = created?.agent?.session
  return created?.sessionId
    ?? session?.header?.id
    ?? session?.id
    ?? created?.agent?.id
    ?? null
}

/** A caller-facing 400, thrown by the request validators. `extra` rides along in the body. */
function badRequest(message, extra) {
  const error = new Error(message)
  error.status = 400
  if (extra !== undefined) error.extra = extra
  return error
}

/**
 * A caller-facing 409, thrown when a request conflicts with a rule the caller
 * must resolve (Requirement 3's single writer, Requirement 4's task binding).
 * `extra` is merged into the response body so the caller sees who holds what.
 */
function conflict(message, extra) {
  const error = new Error(message)
  error.status = 409
  if (extra !== undefined) error.extra = extra
  return error
}

/** Where the host keeps the projection cache: one `<sessionId>.json` per Session. */
function projectionSessionsDir() {
  return join(harnessHome(), 'storages', 'session_projcache', 'sessions')
}

/** Where the host keeps one Session's projection cache. */
function projectionFile(sessionId) {
  return join(projectionSessionsDir(), sessionId + '.json')
}

/**
 * Read one projection's `record.rows`.
 * @returns the rows object, `undefined` when the cache has no entry yet (a
 *   Session that never got a projection), or `{ corrupt: true }` when it cannot
 *   be parsed.
 */
function readProjectionRows(sessionId) {
  let text
  try {
    text = readFileSync(projectionFile(sessionId), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    const rows = parsed?.record?.rows
    if (rows === undefined || rows === null || typeof rows !== 'object' || Array.isArray(rows)) return { corrupt: true }
    return rows
  } catch {
    return { corrupt: true }
  }
}

/** One projection row's `val`, the shape every row uses. */
function rowValue(rows, key) {
  const row = rows?.[key]
  return row !== undefined && row !== null && typeof row === 'object' ? row.val : undefined
}

/** The JSONL body DSH keeps per Session; one zstd frame per write, several records per frame. */
const SESSION_BODY_FILE = 'session.v4.jsonl.zstd'
/** The one tool whose suspended call means a person is being asked a question. */
const ASK_QUESTION_TOOL = 'ask_user_question'

/** The callIds in one `sessionStats.pendingCalls` value; 0.2.x keys it by callId. */
function pendingCallIds(pendingCalls) {
  if (Array.isArray(pendingCalls)) {
    return pendingCalls
      .map(item => (typeof item === 'string' ? item : item?.callId))
      .filter(id => typeof id === 'string' && id.length > 0)
  }
  if (pendingCalls !== null && typeof pendingCalls === 'object') return Object.keys(pendingCalls)
  return []
}

/**
 * The directory name DSH uses for one working directory under `$DSH_HOME/sessions`.
 *
 * Separators collapse to a single `-`; anything outside `[A-Za-z0-9._-]` becomes
 * `~` + its upper-case hexadecimal code point; the whole name is wrapped in `--`.
 * The rule was checked against real store directory names. Examples:
 * `D:\work\demo` -> `--D-work-demo--`, `D:\项目\demo` -> `--D-~9879~76EE-demo--`,
 * `C:\Users\ADMIN~1\x` -> `--C-Users-ADMIN~007E1-x--`.
 */
function workspaceBucketName(directory) {
  const segments = String(directory).split(/[\\/:]+/).filter(segment => segment.length > 0)
  const encoded = segments.map(segment => Array.from(segment, (char) => {
    if (/[A-Za-z0-9._-]/.test(char)) return char
    return '~' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  }).join('')).join('-')
  return '--' + encoded + '--'
}

/**
 * Locate one Session's JSONL body from its working directory, without guessing.
 * The bucket name is derived from the projection's `workingDirectory`, then matched
 * against the real listing (case-insensitively, because Windows paths are).
 *
 * @returns `{ file, error }`; `error` explains why the body cannot be located.
 */
function sessionBodyFile(workingDirectory, sessionId) {
  if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) {
    return { file: null, error: 'the projection carries no workingDirectory' }
  }
  const root = join(harnessHome(), 'sessions')
  const expected = workspaceBucketName(workingDirectory)
  const direct = join(root, expected, sessionId, SESSION_BODY_FILE)
  if (existsSync(direct)) return { file: direct, error: null }
  let buckets
  try {
    buckets = readdirSync(root)
  } catch (error) {
    return { file: null, error: `cannot list ${root}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const lower = expected.toLowerCase()
  const bucket = buckets.find(name => name.toLowerCase() === lower)
  if (bucket !== undefined) {
    const matched = join(root, bucket, sessionId, SESSION_BODY_FILE)
    if (existsSync(matched)) return { file: matched, error: null }
    return { file: null, error: `the session has no body under bucket ${bucket}` }
  }
  return { file: null, error: `no session bucket for workingDirectory ${workingDirectory}` }
}

/** Byte offsets of every zstd frame in `buffer` (magic `28 b5 2f fd`). */
function zstdFrameOffsets(buffer) {
  const offsets = []
  for (let at = 0; at + 4 <= buffer.length; at += 1) {
    if (buffer[at] === 0x28 && buffer[at + 1] === 0xb5 && buffer[at + 2] === 0x2f && buffer[at + 3] === 0xfd) offsets.push(at)
  }
  return offsets
}

/**
 * Resolve the tool name behind each pending callId, plus any approval request that
 * is still open, from the Session's JSONL body (Defect E, second revision).
 *
 * The body is a sequence of zstd frames; each frame decompresses to text holding one
 * or more JSONL records (`zstdDecompressSync` only reads the first frame of a
 * buffer, hence the manual framing). Only called when `pendingCalls` is non-empty.
 *
 * An approval is "still open" when an `approval/asked` record references the callId
 * and no `approval/decided` carries its approval id - that is a person being asked
 * to approve an operation.
 *
 * @returns `{ names, openApprovals, missing, error }`; `missing` lists callIds the
 *   body has no `tool/call` for, which is a reason to report `unknown`, not a guess.
 */
function pendingCallToolNames(workingDirectory, sessionId, callIds) {
  const located = sessionBodyFile(workingDirectory, sessionId)
  if (located.file === null) {
    return { names: new Map(), openApprovals: new Set(), missing: [...callIds], error: located.error }
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return { names: new Map(), openApprovals: new Set(), missing: [...callIds], error: 'this Node has no zlib.zstdDecompressSync' }
  }
  let buffer
  try {
    buffer = readFileSync(located.file)
  } catch (error) {
    return {
      names: new Map(),
      openApprovals: new Set(),
      missing: [...callIds],
      error: `cannot read the session body: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const pending = new Set(callIds)
  const names = new Map()
  const askedByCall = new Map()
  const decided = new Set()
  const offsets = zstdFrameOffsets(buffer)
  for (let frame = 0; frame < offsets.length; frame += 1) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(offsets[frame], offsets[frame + 1] ?? buffer.length)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.type === 'tool/call') {
        const callId = record.data?.callId
        const toolName = record.data?.name
        if (typeof callId === 'string' && typeof toolName === 'string' && pending.has(callId) && !names.has(callId)) {
          names.set(callId, toolName)
        }
      } else if (record?.type === 'approval/asked') {
        const callId = record.data?.callId
        const approvalId = record.data?.id
        if (typeof callId === 'string' && typeof approvalId === 'string') askedByCall.set(callId, approvalId)
      } else if (record?.type === 'approval/decided') {
        const approvalId = record.data?.id
        if (typeof approvalId === 'string') decided.add(approvalId)
      }
    }
  }
  const openApprovals = new Set()
  for (const [callId, approvalId] of askedByCall) {
    if (!decided.has(approvalId)) openApprovals.add(callId)
  }
  const missing = callIds.filter(callId => !names.has(callId))
  return { names, openApprovals, missing, error: null }
}

/** Leading decoration a report line may carry: whitespace, quote/fence and emphasis marks. */
const REPORT_DECORATION = /^[\s>#*_`+-]+/

/**
 * Drop the leading decoration of one line (Defect J). The keyword must follow immediately,
 * so a quoted `汇报状态: ready` inside a `凭据:` line is not a block at all.
 */
function reportLineBody(line) {
  return String(line).replace(/\r$/, '').replace(REPORT_DECORATION, '')
}

/**
 * Parse `汇报状态: <word>` from one line (Defect J). Returns null when the line is not an
 * anchor line, otherwise `{ word, extra }`:
 *   - `word` is the leading ASCII word after the colon (the status words are ASCII);
 *   - `extra` is whatever follows it once decorative characters are removed. Anything left
 *     means the anchor line carries prose after the word, which is `invalid`: a long quoted
 *     sentence must never be read as a status word.
 */
function parseReportAnchorLine(line) {
  const body = reportLineBody(line)
  if (!body.startsWith(REPORT_ANCHOR)) return null
  const rest = body.slice(REPORT_ANCHOR.length)
  const match = /^[\s*_`]*[:：]\s*([\s\S]*)$/.exec(rest)
  if (match === null) return null
  const raw = match[1]
  const head = /^[\s*_`'"”’]*([A-Za-z]+)/.exec(raw)
  const word = head === null ? '' : head[1]
  const extra = raw.slice(head === null ? 0 : head[0].length).replace(/[\s*_`'"”’]+/g, '')
  return { word, extra }
}

/** True when the line opens a new report block. */
function isReportAnchorLine(line) {
  return parseReportAnchorLine(line) !== null
}

/**
 * Value after `任务:` / `结论:` / `凭据:` / `前置:`, or null when this line is not that
 * label. Labels are line-anchored too (Defect J), so a mention inside a sentence is not a
 * field.
 */
function parseReportLabel(line, label) {
  const body = reportLineBody(line)
  const match = new RegExp('^' + label + '\\s*[:：]\\s*(.*)$').exec(body)
  if (match === null) return null
  const value = match[1].replace(/[\s*_`]+$/, '').trim()
  return value.length === 0 ? null : value
}

/**
 * Parse one report block (Defects I/J). `lines[0]` is the anchor line; every field must open
 * its own line, and the block ends at the next anchor line so a report never borrows a line
 * from the next one.
 *
 * `invalid` names what is missing (任务 / 结论 / 凭据 / blocked 的 前置) or why the anchor is
 * unusable. It never degrades to `unreported` and never guesses a status word.
 */
function parseReportBlock(lines) {
  const anchor = parseReportAnchorLine(lines[0] ?? '')
  if (anchor === null) return null
  const parsed = { task: null, conclusion: null, evidence: null, prerequisite: null }
  for (let index = 1; index < lines.length; index += 1) {
    if (isReportAnchorLine(lines[index])) break
    for (const [key, label] of REPORT_LABELS) {
      if (parsed[key] !== null) continue
      const value = parseReportLabel(lines[index], label)
      if (value !== null) parsed[key] = value
    }
  }
  const linesOut = { conclusion: parsed.conclusion, evidence: parsed.evidence, prerequisite: parsed.prerequisite }
  const missing = []
  if (parsed.task === null) missing.push('任务')
  if (parsed.conclusion === null) missing.push('结论')
  if (parsed.evidence === null) missing.push('凭据')
  if (anchor.word === 'blocked' && parsed.prerequisite === null) missing.push('前置')
  if (anchor.extra.length > 0) {
    return {
      state: 'invalid',
      taskId: parsed.task,
      missing,
      reason: 'the anchor line carries text after the status word: ' + anchor.extra.slice(0, 80),
      lines: linesOut,
    }
  }
  if (!REPORT_STATES.has(anchor.word)) {
    return {
      state: 'invalid',
      taskId: parsed.task,
      missing,
      reason: anchor.word.length === 0
        ? 'the anchor line carries no status word'
        : 'status word is not one of ready/blocked/failed/dropped: ' + anchor.word.slice(0, 80),
      lines: linesOut,
    }
  }
  if (missing.length > 0) {
    return {
      state: 'invalid',
      taskId: parsed.task,
      missing,
      reason: 'missing required report line(s): ' + missing.join(', '),
      lines: linesOut,
    }
  }
  return { state: anchor.word, taskId: parsed.task, missing: [], reason: null, lines: linesOut }
}

/**
 * Report blocks carried by one assistant message, newest first (Defect I: every block is a
 * candidate, because attribution happens later on its 任务 line).
 */
function reportBlocksFromMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const texts = content
    .filter(item => item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
  const blocks = []
  for (let item = texts.length - 1; item >= 0; item -= 1) {
    const lines = texts[item].split('\n')
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      if (!isReportAnchorLine(lines[line])) continue
      const block = lines.slice(line)
      for (let next = item + 1; next < texts.length; next += 1) block.push(...texts[next].split('\n'))
      const parsed = parseReportBlock(block)
      if (parsed !== null) blocks.push(parsed)
    }
  }
  return blocks
}

/** Report blocks carried by one body record, newest first. */
function reportBlocksFromRecord(record) {
  if (record?.type !== 'assistant/message') return []
  if (record?.data?.message?.role !== 'assistant') return []
  return reportBlocksFromMessage(record.data.message)
}

/** `message` of anything thrown, as a single readable line for a `stateReason`. */
function errorText(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

/** Report blocks carried by one decompressed frame's text, newest first, with their seqs. */
function reportBlocksFromFrameText(text) {
  const lines = text.split('\n')
  const blocks = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes(REPORT_ANCHOR)) continue
    let record
    try { record = JSON.parse(lines[index]) } catch { continue }
    for (const block of reportBlocksFromRecord(record)) {
      blocks.push({ report: block, seq: typeof record.seq === 'number' ? record.seq : null })
    }
  }
  return blocks
}

/**
 * Read one Ticket's report out of a body file (Defects H/I). Frames are walked backwards so
 * the newest matching block wins, and the walk widens instead of giving up: the old 8-frame
 * window, then 64, then 512, then the whole body. A block only answers for the ticket its
 * `任务` line names; blocks for other tickets are skipped, and the newest block - which names
 * no ticket - is answered as `invalid` rather than skipped (requirement 5).
 *
 * `unreported` is the answer only when every frame of the body was consumed and no block
 * named this ticket. Every other way of not getting an answer is `unknown` with a
 * `stateReason` that names the broken step, and they are kept byte-distinct:
 *   - the body could not be located / statted / read;
 *   - a frame could not be decompressed, so a newer report cannot be ruled out;
 *   - the body is larger than `REPORT_SCAN_BYTE_LIMIT`, so it was not read in full.
 *
 * @returns `{ outcome, report, seq, stateReason, scan, body }` where `scan` is the
 *   `{ frames, bytes, errors }` this call actually consumed and `body` is the file's
 *   `{ frames, bytes }`.
 */
function scanReportBody(file, taskId) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch (error) {
    return scanResult('unknown', 'the session body could not be read: ' + errorText(error),
      { frames: 0, bytes: 0, errors: 0 }, { frames: null, bytes: null })
  }
  const offsets = zstdFrameOffsets(buffer)
  const total = offsets.length
  const scan = { frames: 0, bytes: 0, errors: 0 }
  const body = { frames: total, bytes: buffer.length }
  // A non-empty body with no zstd frame is not a body that "holds no report": nothing in
  // it could be read at all, so calling it `unreported` would be the old collapse again.
  if (total === 0 && buffer.length > 0) {
    return scanResult('unknown', 'the session body holds no zstd frame: ' + String(buffer.length) + ' bytes could not be decompressed', scan, body)
  }
  let cursor = total
  // Defect I: the newest block in the body is special. If it names no ticket it cannot be
  // attributed to anyone, so the answer is `invalid` (missing 任务) rather than a silent
  // skip to an older block that happens to carry this ticket's name.
  let newestSeen = false
  for (const window of [...REPORT_FRAME_WINDOWS, Infinity]) {
    const floor = window === Infinity ? 0 : Math.max(0, total - window)
    while (cursor > floor) {
      const index = cursor - 1
      const start = offsets[index]
      const end = offsets[index + 1] ?? buffer.length
      const size = end - start
      // Only the last pass can reach past the byte budget. Stopping here means the whole
      // body was NOT read, so this is not the `unreported` fact.
      if (window === Infinity && scan.bytes + size > REPORT_SCAN_BYTE_LIMIT) {
        return scanResult('unknown',
          'the body is larger than REPORT_SCAN_BYTE_LIMIT and was not read in full: stopped after '
          + String(scan.bytes) + ' of ' + String(buffer.length) + ' bytes ('
          + String(scan.frames) + ' of ' + String(total) + ' frames)', scan, body)
      }
      cursor -= 1
      let text
      try {
        text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      } catch {
        scan.errors += 1
        continue
      }
      scan.frames += 1
      scan.bytes += size
      // Defect I: a block answers only for the ticket its 任务 line names. Blocks for other
      // tickets are skipped; the newest block, if it names nobody, is answered as `invalid`.
      for (const block of reportBlocksFromFrameText(text)) {
        const isNewest = !newestSeen
        newestSeen = true
        const named = block.report.taskId
        if (!isNewest && named !== taskId) continue
        if (isNewest && named !== null && named !== taskId) continue
        if (scan.errors > 0) {
          // A newer frame did not decompress, so a newer report may sit in it. Returning
          // this older block would be a guess, which the protocol forbids.
          return scanResult('unknown',
            'a newer frame could not be decompressed (' + String(scan.errors) + ' frame(s)), so a newer report cannot be ruled out',
            scan, body)
        }
        return scanResult('hit', null, scan, body, block)
      }
    }
  }
  if (scan.errors > 0) {
    return scanResult('unknown',
      'the session body could not be decompressed: ' + String(scan.errors) + ' of ' + String(total) + ' frame(s) failed',
      scan, body)
  }
  return scanResult('unreported', null, scan, body)
}

/** The one shape of a scan answer, so every caller branch stays identical. */
function scanResult(outcome, stateReason, scan, body, hit = null) {
  return {
    outcome,
    report: hit === null ? null : hit.report,
    seq: hit === null ? null : hit.seq,
    stateReason,
    scan,
    body,
  }
}

/** One `/status.report` reading; every field is present so callers need no defaults. */
function reportReading(state, extra = {}) {
  return {
    state,
    // The 任务 line of the block this reading came from; null when no block answered.
    taskId: null,
    seq: null,
    missing: [],
    reason: null,
    lines: null,
    stateReason: null,
    scannedFrames: 0,
    scannedBytes: 0,
    bodyFrames: null,
    bodyBytes: null,
    fromCache: false,
    ...extra,
  }
}

/** Per-process report cache: same file + byte size + mtime reuses a definite reading. */
const reportCache = new Map()

/**
 * `/status.report` for one Ticket (Requirement 1, defects H/I). An unchanged body is served
 * from the cache; a changed body is scanned with the widening window for the first block
 * whose `任务` line names `taskId`.
 *
 * Only a definite reading is cached - a block (one naming this ticket, or the newest block
 * naming nobody), or a whole body with no block for this ticket. An `unknown` is re-evaluated
 * on every call, so repairing the body shows the answer at once without a host restart, and
 * a failure reading is never frozen into "did not report".
 */
function ticketReport(taskId, sessionId, workingDirectory) {
  // The direct bucket path is the common case. Stat it first so an unchanged body
  // costs one stat and no directory scan; fall back to the case-insensitive
  // lookup only when the direct path does not exist.
  let file = null
  let stats = null
  if (typeof workingDirectory === 'string' && workingDirectory.length > 0) {
    const direct = join(harnessHome(), 'sessions', workspaceBucketName(workingDirectory), sessionId, SESSION_BODY_FILE)
    try {
      stats = statSync(direct)
      file = direct
    } catch {
      file = null
    }
  }
  if (file === null) {
    const located = sessionBodyFile(typeof workingDirectory === 'string' ? workingDirectory : null, sessionId)
    if (located.file === null) {
      return reportReading('unknown', { stateReason: 'the session body could not be located: ' + located.error })
    }
    file = located.file
    try {
      stats = statSync(file)
    } catch (error) {
      return reportReading('unknown', { stateReason: 'the session body could not be statted: ' + errorText(error) })
    }
  }
  // Defect I: one Session can answer several tickets, each from its own block, so the
  // cache key is the ticket as well as the Session.
  const cacheKey = taskId + '\u0000' + sessionId
  const cached = reportCache.get(cacheKey)
  if (cached !== undefined && cached.file === file && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    // This call decompressed nothing, so the counters describe the call, not the cache.
    return { ...cached.reading, scannedFrames: 0, scannedBytes: 0, fromCache: true }
  }
  const scanned = scanReportBody(file, taskId)
  const counts = {
    scannedFrames: scanned.scan.frames,
    scannedBytes: scanned.scan.bytes,
    bodyFrames: scanned.body.frames,
    bodyBytes: scanned.body.bytes,
  }
  const reading = scanned.outcome === 'hit'
    ? reportReading(scanned.report.state, { ...scanned.report, seq: scanned.seq, ...counts })
    : reportReading(scanned.outcome === 'unreported' ? 'unreported' : 'unknown', {
      ...counts,
      stateReason: scanned.stateReason,
    })
  if (scanned.outcome !== 'unknown') {
    reportCache.set(cacheKey, { file, size: stats.size, mtimeMs: stats.mtimeMs, reading })
  }
  return { ...reading, fromCache: false }
}

/**
 * Re-read the body and prove that `seq` is an assistant report that names `taskId` with the
 * status word `expectedWord` (Requirement 2, defect I). A report moves no ticket until this
 * returns ok; the failure carries a `code` so the caller can tell a wrong ticket from a
 * missing task line and from a wrong status word.
 */
function verifyReportAtSeq(taskId, workingDirectory, sessionId, seq, expectedWord) {
  const located = sessionBodyFile(typeof workingDirectory === 'string' ? workingDirectory : null, sessionId)
  if (located.file === null) return { ok: false, reason: located.error }
  let buffer
  try {
    buffer = readFileSync(located.file)
  } catch (error) {
    return { ok: false, reason: 'cannot read the session body: ' + (error instanceof Error ? error.message : String(error)) }
  }
  const offsets = zstdFrameOffsets(buffer)
  for (let frame = offsets.length - 1; frame >= 0; frame -= 1) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(offsets[frame], offsets[frame + 1] ?? buffer.length)).toString('utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let record
      try { record = JSON.parse(lines[index]) } catch { continue }
      if (record?.seq !== seq) continue
      const blocks = reportBlocksFromRecord(record)
      if (blocks.length === 0) {
        return { ok: false, code: 'report-unverified', reason: 'the record at seq ' + String(seq) + ' is not an assistant report' }
      }
      const parsed = blocks[0]
      if (parsed.taskId === null) {
        return {
          ok: false,
          code: 'report-missing-task',
          reason: 'the report at seq ' + String(seq) + ' has no 任务 line, so it cannot be attributed to ' + taskId,
        }
      }
      if (parsed.taskId !== taskId) {
        return {
          ok: false,
          code: 'report-task-mismatch',
          reason: 'the report at seq ' + String(seq) + ' names ' + parsed.taskId + ', not ' + taskId,
        }
      }
      if (parsed.state !== expectedWord) {
        return {
          ok: false,
          code: 'report-unverified',
          reason: 'the report at seq ' + String(seq) + ' parses as ' + parsed.state + ', not ' + expectedWord,
        }
      }
      return { ok: true, report: parsed }
    }
  }
  return { ok: false, code: 'report-unverified', reason: 'the session body has no record with seq ' + String(seq) }
}

/** The seven raw cost fields, or null when either projection row is missing/empty. */
function costFromRows(rows) {
  const usage = rowValue(rows, 'tokenUsage')
  const pressure = rowValue(rows, 'contextPressure')
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  if (pressure === null || pressure === undefined || typeof pressure !== 'object') return null
  const totals = usage.totals
  if (totals === null || totals === undefined || typeof totals !== 'object') return null
  const values = {
    uncachedInputTokens: totals.uncachedInputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    surfaceTokens: pressure.surfaceTokens,
    contextWindow: pressure.contextWindow,
    pressureTokens: pressure.pressureTokens,
  }
  for (const field of COST_FIELDS) {
    if (typeof values[field] !== 'number' || !Number.isFinite(values[field])) return null
  }
  return values
}

/** The station a pointer is on; legacy records (no `stage`) derive it from `acceptance`. */
function pointerStage(pointer) {
  if (pointer !== null && typeof pointer === 'object' && STAGES.has(pointer.stage)) return pointer.stage
  return pointer?.acceptance === 'accepted' ? 'accepted' : 'delivered'
}

/** The append-only history; a missing/invalid array is empty, never invented. */
function pointerHistory(pointer) {
  return Array.isArray(pointer?.history) ? pointer.history : []
}

/** `acceptance` is derived: it is exactly `stage === 'accepted'`. */
function pointerAcceptance(pointer) {
  return pointerStage(pointer) === 'accepted' ? 'accepted' : 'pending'
}

/** `acceptedAt` is the time of the `accepted` station, or null when never accepted. */
function pointerAcceptedAt(pointer) {
  const history = pointerHistory(pointer)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (entry?.stage !== 'accepted') continue
    if (typeof entry.at === 'number') return entry.at
  }
  if (pointerStage(pointer) === 'accepted' && typeof pointer.acceptedAt === 'number') return pointer.acceptedAt
  return null
}

/** When a terminal ticket (`accepted`/`voided`) stopped, for the 30-day prune. */
function pointerTerminalAt(pointer) {
  const stage = pointerStage(pointer)
  if (stage !== 'accepted' && stage !== 'voided') return null
  const history = pointerHistory(pointer)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (entry?.stage !== stage) continue
    if (typeof entry.at === 'number') return entry.at
  }
  if (stage === 'accepted' && typeof pointer.acceptedAt === 'number') return pointer.acceptedAt
  return typeof pointer.createdAt === 'number' ? pointer.createdAt : null
}

/** The last report seq recorded for this pointer, or null when it has none. */
function lastReportSeq(pointer) {
  const history = pointerHistory(pointer)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const evidence = history[index]?.evidence
    if (evidence?.kind === 'report' && typeof evidence.seq === 'number') return evidence.seq
  }
  return null
}

/** The migration table, minus the two rules spelled out separately (redeliver, changed report). */
const STAGE_TRANSITIONS = new Map([
  ['delivered', new Set(['reported_ready', 'reported_blocked', 'reported_failed', 'reported_dropped', 'accepted', 'voided'])],
  ['reported_ready', new Set(['accepted', 'voided'])],
  ['reported_blocked', new Set(['voided'])],
  ['reported_failed', new Set(['voided'])],
  ['reported_dropped', new Set(['voided'])],
])

/** The station transition the table allows, ignoring the two special rules. */
function stageTransitionAllowed(current, target) {
  const allowed = STAGE_TRANSITIONS.get(current)
  return allowed !== undefined && allowed.has(target)
}

/** The protocol status word for a `reported_*` station, or null when the station is not one. */
function reportWordForStage(stage) {
  for (const [word, value] of REPORT_STAGES) {
    if (value === stage) return word
  }
  return null
}

/** True for the four stations a report may write. */
function isReportStage(stage) {
  return reportWordForStage(stage) !== null
}

/** A 409 for a transition the table does not allow; the pointer file is not written. */
function invalidStageTransition(current, target) {
  return conflict('stage transition is not allowed: ' + current + ' -> ' + target, {
    code: 'invalid-stage-transition',
    stage: { current, target },
  })
}

/** The pointer shape both `/pointer` and `/status` expose: stored fields plus derived ones. */
function pointerView(pointer) {
  return {
    taskId: pointer.taskId,
    sessionId: pointer.sessionId,
    mode: pointer.mode ?? null,
    requestId: pointer.requestId ?? null,
    acceptance: pointerAcceptance(pointer),
    acceptedAt: pointerAcceptedAt(pointer),
    createdAt: pointer.createdAt ?? null,
    note: pointer.note ?? null,
    stage: pointerStage(pointer),
    history: pointerHistory(pointer),
  }
}

/**
 * Derived Session state, straight from the projection rows (Requirement 2), with the
 * body consulted only when it can change the answer (Defect E, second revision).
 *
 * Judges:
 *   running - `sessionStats.openStep` has a value; or `turnBoundary.openTurnStartSeq`
 *             has a value and `lastStepBoundary` is not `end`; or `pendingCalls` is
 *             non-empty and those calls are ordinary tools.
 *   waiting - `pendingCalls` is non-empty and those callIds resolve in the Session
 *             body to `ask_user_question` (a person is asked a question) or to a
 *             call whose `approval/asked` has no `approval/decided` (a person is
 *             asked to approve). `waitingKind` says which.
 *   unknown - `pendingCalls` is non-empty but the body cannot be located/read, or it
 *             holds no `tool/call` for those callIds: the state cannot be derived and
 *             is not guessed. `stateReason` says why.
 *   idle    - none of the above.
 *
 * `state` prefers `waiting` over `running` on purpose: a suspended Turn may still be
 * open by the boundary rule, but the person is the blocker, and a plain
 * `openStep === null && pendingCalls` pair does NOT mean waiting - a long tool call
 * (a `pwsh` command) looks exactly like that from the projection alone.
 *
 * The projection is written at step boundaries and not during a Step, so this is the
 * state as of the last persisted projection - `/status` reports `staleness`.
 */
function deriveState(rows, sessionId) {
  const turn = rowValue(rows, 'turnBoundary')
  const stats = rowValue(rows, 'sessionStats')
  const rawOpenStep = stats?.openStep
  const openStep = rawOpenStep === undefined ? null : rawOpenStep
  const callIds = pendingCallIds(stats?.pendingCalls)
  const openTurnStartSeq = typeof turn?.openTurnStartSeq === 'number' ? turn.openTurnStartSeq : null
  const lastStepBoundary = typeof turn?.lastStepBoundary?.kind === 'string' ? turn.lastStepBoundary.kind : null
  const openTurn = openTurnStartSeq !== null && lastStepBoundary !== 'end'
  const base = {
    openStep,
    pendingCalls: callIds.length,
    pendingCallIds: [],
    waitingKind: null,
    openTurnStartSeq,
    lastStepBoundary,
    stateReason: null,
  }
  const verdict = (state, extra) => ({
    ...base,
    ...extra,
    state,
    running: state === 'running',
    waiting: state === 'waiting',
    idle: state === 'idle',
  })
  // The model is streaming: no tool name is needed, and a suspended card cannot be
  // here because a suspended call clears `openStep` (the second differential).
  if (openStep !== null) return verdict('running')
  if (callIds.length === 0) return verdict(openTurn ? 'running' : 'idle')
  const workingDirectory = rowValue(rows, 'workingDirectory')
  const resolved = pendingCallToolNames(
    typeof workingDirectory === 'string' ? workingDirectory : null,
    sessionId,
    callIds,
  )
  if (resolved.error !== null) return verdict('unknown', { stateReason: resolved.error })
  if (resolved.missing.length > 0) {
    return verdict('unknown', {
      stateReason: 'the session body has no tool/call for pending callId(s): ' + resolved.missing.join(', '),
    })
  }
  const details = callIds.map(callId => ({ callId, name: resolved.names.get(callId) ?? null }))
  const waitingKind = details.some(item => item.name === ASK_QUESTION_TOOL)
    ? 'question'
    : details.some(item => resolved.openApprovals.has(item.callId))
      ? 'approval'
      : null
  if (waitingKind !== null) return verdict('waiting', { pendingCallIds: details, waitingKind })
  // A pending ordinary tool is work in progress, not a person being waited on.
  return verdict('running', { pendingCallIds: details })
}

/** Everything `/status` reports about one Session, all from its projection cache. */
function sessionFacts(sessionId) {
  const empty = {
    projection: false,
    state: 'unknown',
    running: null,
    waiting: null,
    idle: null,
    openStep: null,
    pendingCalls: null,
    pendingCallIds: [],
    waitingKind: null,
    stateReason: null,
    blank: null,
    lastPromptAt: null,
    agentPreset: null,
    permissions: null,
    sessionCwd: null,
    cost: null,
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) return { ...empty, projectionError: 'sessionId is not a safe identifier' }
  let rows
  try {
    rows = readProjectionRows(sessionId)
  } catch (error) {
    return { ...empty, projectionError: error instanceof Error ? error.message : String(error) }
  }
  if (rows === undefined) return empty
  if (rows.corrupt === true) return { ...empty, projectionCorrupt: true }
  const meta = rowValue(rows, 'sessionListMetadata')
  const permissions = rowValue(rows, 'permissions')
  const preset = rowValue(rows, 'agentPreset')
  const sessionCwd = rowValue(rows, 'workingDirectory')
  return {
    ...deriveState(rows, sessionId),
    projection: true,
    blank: typeof meta?.blank === 'boolean' ? meta.blank : null,
    lastPromptAt: typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : null,
    agentPreset: typeof preset === 'string' ? preset : null,
    permissions: permissions === undefined || permissions === null || typeof permissions !== 'object'
      ? null
      : {
        preset: typeof permissions.preset === 'string' ? permissions.preset : null,
        sandbox: typeof permissions.sandbox === 'string' ? permissions.sandbox : null,
        approval: typeof permissions.approval === 'string' ? permissions.approval : null,
      },
    sessionCwd: typeof sessionCwd === 'string' ? sessionCwd : null,
    // Requirement 3 (round 2): the seven raw cost fields, or null. Never 0 and
    // never derived from another field - zero spend and an unreadable projection
    // are different facts.
    cost: costFromRows(rows),
  }
}

/** Compare two directories the way this platform does: case-insensitive, trailing separators ignored. */
function samePath(left, right) {
  const normalize = (value) => String(value ?? '').replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * Every Session other than `excludeSessionId` that is busy in `workingDirectory`
 * (Requirement 3): a Turn open, a Step suspended waiting on a person, or a state
 * that cannot be derived at all.
 *
 * Grouping uses the projection fact `record.rows.workingDirectory.val`, never a
 * stored pointer directory: the caller's cwd is not the Session's (Defect A).
 *
 * Every judge comes from `deriveState`: `running` (a Turn is open), `waiting`
 * (a Step is suspended on an unanswered call, Defect E) and `unknown` (there are
 * unresolved calls but the body cannot name them, Defect F). Waiting counts as
 * busy because a delivery would only queue behind the card: the caller gets a 200
 * and wrongly believes the dispatch went out. `unknown` counts as busy for the
 * same reason R2 fails closed: a non-empty `pendingCalls` is itself evidence that
 * a call is in flight, so the Session is not provably idle. Only `idle` is skipped.
 *
 * @returns `{ peers, error }`; `error` is set only when the projection store
 *   exists but cannot be listed.
 */
function activePeers(workingDirectory, excludeSessionId) {
  let names
  try {
    names = readdirSync(projectionSessionsDir())
  } catch (error) {
    if (error?.code === 'ENOENT') return { peers: [], error: null }
    return { peers: [], error: error instanceof Error ? error.message : String(error) }
  }
  const peers = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const sessionId = name.slice(0, -'.json'.length)
    if (sessionId === excludeSessionId) continue
    let rows
    try {
      rows = readProjectionRows(sessionId)
    } catch {
      continue
    }
    if (rows === undefined || rows.corrupt === true) continue
    const directory = rowValue(rows, 'workingDirectory')
    if (typeof directory !== 'string' || !samePath(directory, workingDirectory)) continue
    const facts = deriveState(rows, sessionId)
    if (facts.state !== 'running' && facts.state !== 'waiting' && facts.state !== 'unknown') continue
    peers.push({
      sessionId,
      state: facts.state,
      ...(typeof facts.stateReason === 'string' ? { stateReason: facts.stateReason } : {}),
    })
  }
  // A stable order keeps the 409 body deterministic for the caller.
  peers.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  return { peers, error: null }
}

/**
 * The read/write nature a `/prompt` request declares (Requirement 3).
 *
 * `access` is the canonical field the CLI sends. `mode` is accepted when it
 * carries the same vocabulary, because the task book names that field; a
 * `mode` of `queue`/`steer` is the host delivery channel and never doubles as
 * the declaration.
 *
 * @returns `'read' | 'write' | null` (`null` means nothing was declared).
 */
function readDispatchAccess(request) {
  const access = typeof request.access === 'string' ? request.access.trim().toLowerCase() : ''
  if (ACCESS_MODES.has(access)) return access
  const mode = typeof request.mode === 'string' ? request.mode.trim().toLowerCase() : ''
  return ACCESS_MODES.has(mode) ? mode : null
}

/**
 * Read the pointer file.
 * A corrupt file is reported instead of being overwritten: it is the caller's
 * record, and silently replacing it would destroy the only copy.
 */
function loadPointers(dir) {
  const file = join(dir, POINTER_FILE)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, pointers: [], existed: false }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(POINTER_FILE + ' is not valid JSON; fix or remove it by hand')
  }
  if (!Array.isArray(parsed?.pointers)) throw new Error(POINTER_FILE + ' has no pointers array; fix or remove it by hand')
  return { file, pointers: parsed.pointers.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)), existed: true }
}

/**
 * The pointer a taskId is already bound to (Requirement 4: the task number is
 * the key, so there is at most one).
 * @returns `{ pointer }`, with `pointer === null` when the task is unbound.
 */
function findTaskBinding(dir, taskId) {
  const loaded = loadPointers(dir)
  return { pointer: loaded.pointers.find(item => item.taskId === taskId) ?? null }
}

/** One-line, bounded error text for `/health`; never carries the bearer token. */
function shortMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 160)
}

/**
 * Probe what the `/pointer` route needs (Defect D): its file has to parse and its
 * directory has to accept a write. `/health` used to print a literal `'function'`
 * here, which said nothing about whether the route could actually work.
 *
 * @returns `'function'`, or `'degraded: <reason>'` when the store is unusable.
 */
function probePointerStore(dir) {
  try {
    loadPointers(dir)
  } catch (error) {
    return 'degraded: ' + shortMessage(error)
  }
  try {
    accessSync(dir, constants.W_OK)
  } catch (error) {
    return 'degraded: ' + shortMessage(error)
  }
  return 'function'
}

/**
 * Probe what the `/status` route needs: the projection cache directory must be
 * listable. Absent is fine - it only means no Session has a projection yet.
 */
function probeStatusStore() {
  try {
    readdirSync(projectionSessionsDir())
  } catch (error) {
    if (error?.code === 'ENOENT') return 'function'
    return 'degraded: ' + shortMessage(error)
  }
  return 'function'
}

/**
 * Probe what the `/sessions` route needs (Defect D): the controller has to
 * expose `list`, AND that call has to answer with an items array.
 *
 * `typeof list` alone only proves the route is wired to something; a controller
 * whose `list` throws still printed a healthy `'function'` before this probe.
 */
async function probeSessionsList(controller) {
  if (typeof controller?.list !== 'function') return 'undefined'
  try {
    const page = await controller.list({}, new AbortController().signal)
    return Array.isArray(page?.items) ? 'function' : 'degraded: list returned no items array'
  } catch (error) {
    return 'degraded: ' + shortMessage(error)
  }
}

/**
 * Why the projection store cannot be listed, or `null` when it can.
 *
 * An absent directory counts as usable (no Session has a projection yet), which
 * is a different case from a directory that exists but cannot be read - on
 * Windows a blocked path can even answer ENOENT to a child `readFileSync`, so the
 * store itself has to be probed rather than inferred from one Session's file.
 * R2: a non-null result must make the single-writer check fail closed.
 */
function projectionStoreError() {
  try {
    readdirSync(projectionSessionsDir())
    return null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return error instanceof Error ? error.message : String(error)
  }
}

/** Write the pointer file atomically, mode 0600, next to `bridge.json`. */
function savePointers(file, pointers, now) {
  const payload = { version: POINTER_VERSION, updatedAt: now, pointers }
  const temporary = file + '.' + String(process.pid) + '.tmp'
  writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch { /* Windows has no POSIX mode */ }
  renameSync(temporary, file)
}

/** Drop terminal tickets (`accepted`/`voided`) whose terminal time is over 30 days old. */
function prunePointers(pointers, now) {
  const kept = []
  let dropped = 0
  for (const pointer of pointers) {
    const terminal = pointerTerminalAt(pointer)
    if (terminal !== null && now - terminal > POINTER_KEEP_MS) {
      dropped += 1
      continue
    }
    kept.push(pointer)
  }
  return { kept, dropped }
}

/** Validate one `/pointer` body into the record the file keeps. */
function normalizePointerRequest(raw) {
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : ''
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : ''
  const stage = typeof raw.stage === 'string' ? raw.stage.trim() : ''
  const rawSeq = raw.seq
  const acceptance = typeof raw.acceptance === 'string' ? raw.acceptance.trim() : ''
  const note = typeof raw.note === 'string' ? raw.note.trim() : ''
  if (taskId.length === 0) throw badRequest('taskId is required')
  if (!TASK_ID_PATTERN.test(taskId)) throw badRequest('taskId must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/')
  if (sessionId.length === 0) throw badRequest('sessionId is required')
  if (!SESSION_ID_PATTERN.test(sessionId)) throw badRequest('sessionId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/')
  if (mode.length > 0 && mode !== 'read' && mode !== 'write') throw badRequest('mode must be "read" or "write"')
  if (stage.length > 0 && !STAGES.has(stage)) {
    throw badRequest('stage must be one of ' + [...STAGES].join(', '))
  }
  let seq = null
  if (rawSeq !== undefined && rawSeq !== null && String(rawSeq).trim().length > 0) {
    const numeric = typeof rawSeq === 'number' ? rawSeq : (/^\d+$/.test(String(rawSeq).trim()) ? Number(String(rawSeq).trim()) : NaN)
    if (!Number.isSafeInteger(numeric) || numeric <= 0) throw badRequest('seq must be a positive integer')
    seq = numeric
  }
  if (seq !== null && (stage.length === 0 || reportWordForStage(stage) === null)) {
    throw badRequest('seq is only valid with a reported_* stage')
  }
  if (stage.length > 0 && reportWordForStage(stage) !== null && seq === null) {
    throw badRequest('stage "' + stage + '" needs the report seq')
  }
  // acceptance is derived from stage now; it is not a writable field. Rejecting it
  // instead of silently ignoring it keeps a legacy caller from believing it wrote.
  if (acceptance.length > 0) {
    throw badRequest('acceptance is derived from stage; write stage "accepted" or "voided" with a note instead')
  }
  if (requestId.length > 0 && !REQUEST_ID_PATTERN.test(requestId)) throw badRequest('requestId must match /^[A-Za-z0-9._:-]{1,200}$/')
  if (note.length > MAX_NOTE_CHARS) throw badRequest('note must be at most ' + String(MAX_NOTE_CHARS) + ' characters')
  return {
    taskId,
    sessionId,
    // Defect A: the directory is a projection fact, not the caller's cwd, so the
    // pointer never stores one. An incoming `cwd` is accepted and ignored.
    mode: mode.length === 0 ? null : mode,
    requestId: requestId.length === 0 ? null : requestId,
    stage: stage.length === 0 ? null : stage,
    seq,
    note: note.length === 0 ? null : note,
  }
}

/**
 * Insert or refresh one pointer (round 2, Requirement 2).
 *
 * The station moves only on the evidence the requirements name: a verified report
 * (`reported_*` + seq checked against the body), a human terminal (`accepted`/
 * `voided` + note), or a redelivery (new requestId -> `delivered`). Everything
 * else is refused before `savePointers`, so a rejected request leaves the file's
 * bytes untouched. `acceptance`/`acceptedAt` are derived by `pointerView`.
 */
function upsertPointer(dir, input, now) {
  const { file, pointers } = loadPointers(dir)
  // Requirement 4: the task number is the key. A dispatch for a task already
  // bound to another Session is a conflict for the caller to resolve; the
  // target it named is never silently rewritten to the bound Session.
  const at = pointers.findIndex(item => item.taskId === input.taskId)
  if (at >= 0 && pointers[at].sessionId !== input.sessionId) {
    throw conflict('taskId is already bound to another session', {
      code: 'task-bound',
      taskId: input.taskId,
      boundSessionId: pointers[at].sessionId,
    })
  }
  if (at < 0) {
    if (pointers.length >= POINTER_LIMIT) throw new Error(POINTER_FILE + ' already holds ' + String(POINTER_LIMIT) + ' records; prune it by hand')
    if (input.stage !== null && input.stage !== 'delivered') {
      throw badRequest('a new pointer starts at "delivered"; stage "' + input.stage + '" is not a valid first station')
    }
    if (input.mode === null) throw badRequest('mode is required for a new pointer')
    if (input.seq !== null) throw badRequest('a seq belongs to a report, not to a new pointer')
    const pointer = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      mode: input.mode,
      requestId: input.requestId,
      createdAt: now,
      note: input.note,
      stage: 'delivered',
      history: [],
    }
    pointers.push(pointer)
    const pruned = prunePointers(pointers, now)
    savePointers(file, pruned.kept, now)
    return { pointer, pruned: pruned.dropped, count: pruned.kept.length }
  }

  const previous = pointers[at]
  const currentStage = pointerStage(previous)
  const currentRequestId = typeof previous.requestId === 'string' ? previous.requestId : null
  const incomingRequestId = input.requestId
  const differentRequest = incomingRequestId !== null && incomingRequestId !== currentRequestId
  const history = [...pointerHistory(previous)]
  // Drop only `cwd` (Defect A). Legacy `acceptance`/`acceptedAt` stay as stored on
  // a record nobody has written a station to yet, because for such a record
  // `acceptance` is the only provenance of the derived station.
  const rest = { ...previous }
  delete rest.cwd
  let stage = currentStage
  let entry = null
  const target = input.stage

  if (target === null) {
    // A refresh. A new requestId is a redelivery and pulls the ticket back to
    // `delivered`; the old history is kept. A plain refresh changes nothing else.
    if (differentRequest) {
      stage = 'delivered'
      entry = { stage: 'delivered', at: now, evidence: { kind: 'redeliver', requestId: incomingRequestId } }
    }
  } else if (target === 'delivered') {
    if (!differentRequest) throw badRequest('a redelivery needs a requestId different from the current one')
    stage = 'delivered'
    entry = { stage: 'delivered', at: now, evidence: { kind: 'redeliver', requestId: incomingRequestId } }
  } else if (reportWordForStage(target) !== null) {
    if (incomingRequestId !== null && incomingRequestId !== currentRequestId) {
      throw badRequest('a report for a different requestId needs a redelivery first')
    }
    if (isReportStage(currentStage)) {
      // Same requestId: the caller may change its story, but only forward in time.
      const last = lastReportSeq(previous)
      if (last === null || input.seq === null || input.seq <= last) {
        throw conflict('report seq must increase within the same requestId', {
          code: 'report-seq-not-increasing',
          stage: { current: currentStage, target },
          lastSeq: last,
          seq: input.seq,
        })
      }
    } else if (!stageTransitionAllowed(currentStage, target)) {
      throw invalidStageTransition(currentStage, target)
    }
    const facts = sessionFacts(input.sessionId)
    const workingDirectory = typeof facts.sessionCwd === 'string' ? facts.sessionCwd : null
    const verified = verifyReportAtSeq(input.taskId, workingDirectory, input.sessionId, input.seq, reportWordForStage(target))
    if (!verified.ok) {
      // Defect I: a block that names another ticket (or no ticket) is not this ticket's
      // report, and the caller must be able to tell that apart from a wrong status word.
      throw badRequest('the report at seq ' + String(input.seq) + ' does not verify: ' + verified.reason, {
        code: verified.code ?? 'report-unverified',
        taskId: input.taskId,
        seq: input.seq,
      })
    }
    // State facts veto a ready report: the projection still shows work in flight,
    // so "ready" is not yet true. The caller gets both readings and nothing is written.
    if (target === 'reported_ready' && (facts.openStep !== null || (typeof facts.pendingCalls === 'number' && facts.pendingCalls > 0))) {
      throw conflict('the session is still busy, so a ready report cannot move the ticket', {
        code: 'conflict',
        taskId: input.taskId,
        sessionId: input.sessionId,
        stage: { current: currentStage, target },
        live: {
          liveState: facts.state,
          openStep: facts.openStep,
          pendingCalls: facts.pendingCalls,
          pendingCallIds: facts.pendingCallIds,
        },
      })
    }
    stage = target
    entry = { stage: target, at: now, evidence: { kind: 'report', seq: input.seq } }
  } else if (target === 'accepted' || target === 'voided') {
    if (input.note === null || input.note.length === 0) throw badRequest('stage "' + target + '" needs a note')
    if (incomingRequestId !== null && incomingRequestId !== currentRequestId) {
      throw badRequest('a terminal stage cannot change the requestId')
    }
    if (!stageTransitionAllowed(currentStage, target)) throw invalidStageTransition(currentStage, target)
    stage = target
    entry = { stage: target, at: now, evidence: { kind: 'human', note: input.note } }
  }

  if (entry !== null) {
    history.push(entry)
    // `stage` + `history` are the truth from this write on; leaving the derived keys
    // in the file would put two values for the same fact side by side.
    delete rest.acceptance
    delete rest.acceptedAt
  }
  const pointer = {
    ...rest,
    mode: input.mode ?? previous.mode,
    requestId: incomingRequestId ?? currentRequestId,
    note: input.note ?? previous.note ?? null,
    stage,
    history,
  }
  pointers[at] = pointer
  const pruned = prunePointers(pointers, now)
  savePointers(file, pruned.kept, now)
  return { pointer, pruned: pruned.dropped, count: pruned.kept.length }
}

/** Read and validate one `/status` body into its filters. */
function statusFilters(request) {
  const text = (key) => (typeof request[key] === 'string' ? request[key].trim() : '')
  const acceptance = text('acceptance').toLowerCase()
  if (acceptance.length > 0 && acceptance !== 'pending' && acceptance !== 'accepted') {
    throw badRequest('acceptance must be "pending" or "accepted"')
  }
  const cwd = text('cwd')
  return {
    taskId: text('taskId'),
    sessionId: text('sessionId'),
    cwd: cwd.length === 0 ? '' : canonicalCwd(cwd),
    acceptance,
  }
}

/** Mount the routes and the bridge state file. */
export function apply(ctx, config) {
  if (config !== undefined && config !== null && config.enabled === false) return
  const dir = stateDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
  const expected = Buffer.from(loadOrCreateToken(dir))

  // Finished pointers age out after 30 days; do the sweep once per host start so
  // `/status` can stay strictly read-only.
  try {
    const loaded = loadPointers(dir)
    const pruned = prunePointers(loaded.pointers, Date.now())
    if (pruned.dropped > 0) {
      savePointers(loaded.file, pruned.kept, Date.now())
      ctx.logger?.info?.('session-bridge: pruned ' + String(pruned.dropped) + ' accepted pointer(s) older than 30 days')
    }
  } catch (error) {
    ctx.logger?.warn?.('session-bridge: ' + POINTER_FILE + ' left untouched: ' + String(error instanceof Error ? error.message : error))
  }

  /** Constant-time bearer check. */
  const authorized = (req) => {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match === null) return false
    const supplied = Buffer.from(match[1].trim())
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  /** Persist where the CLI client should connect. */
  const writeState = () => {
    const scheme = String(ctx.webServer.protocol ?? 'http:').replace(/:+$/, '')
    const url = typeof ctx.webServer.getOrigin === 'function'
      ? ctx.webServer.getOrigin()
      : `${scheme}://127.0.0.1:${String(ctx.webServer.port)}`
    const file = join(dir, 'bridge.json')
    try {
      writeFileSync(file, JSON.stringify({ url, token: expected.toString('utf8') }, null, 2) + '\n', { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch (error) {
      ctx.logger?.warn?.(`session-bridge: cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return url
  }

  /**
   * Resolve, and optionally register, the Workspace that owns `cwd`.
   * @returns `{ registry, workspace, created, reason }`; `workspace` undefined
   *   means no Workspace could be used for this directory.
   */
  const resolveWorkspace = async (cwd, options) => {
    const registry = resolveRegistry(ctx)
    if (registry === undefined) return { registry, workspace: undefined, created: false, reason: 'host has no workspaceRegistry' }
    let existing
    try {
      existing = await registry.resolveByPath(cwd)
    } catch (error) {
      return {
        registry,
        workspace: undefined,
        created: false,
        reason: `cwd does not resolve: ${error instanceof Error ? error.message : String(error)}`,
        fatal: true,
      }
    }
    if (existing !== undefined && existing !== null) return { registry, workspace: existing, created: false }
    if (options.createWorkspace === false) {
      return { registry, workspace: undefined, created: false, reason: 'no Workspace is registered for this directory' }
    }
    try {
      const workspace = await registry.create(cwd)
      return { registry, workspace, created: true }
    } catch (error) {
      return {
        registry,
        workspace: undefined,
        created: false,
        reason: `cannot register the directory as a Workspace: ${error instanceof Error ? error.message : String(error)}`,
        fatal: true,
      }
    }
  }

  /**
   * Confirm the Session is on the Workspace roster, attaching it when the
   * controller generation does not do that itself.
   * @returns `{ attached, error }`; `attached: null` means no Workspace is in play.
   */
  const ensureAttached = async (registry, workspace, sessionId) => {
    if (workspace === undefined || sessionId === null) return { attached: null }
    try {
      const live = (typeof registry.get === 'function' ? registry.get(workspace.id) : undefined) ?? workspace
      const listed = Array.isArray(live?.sessionIds) ? live.sessionIds : []
      if (listed.includes(sessionId)) return { attached: true }
      if (typeof live?.attachSession !== 'function') return { attached: false, error: 'workspace exposes no attachSession' }
      await live.attachSession(sessionId)
      return { attached: true }
    } catch (error) {
      return { attached: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Create one session through the host controller, into a Workspace. */
  const handleNew = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const cwdRaw = typeof request.cwd === 'string' ? request.cwd.trim() : ''
    const workspaceIdRaw = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
    if (cwdRaw.length === 0 && workspaceIdRaw.length === 0) {
      send(res, 400, { ok: false, error: 'cwd or workspaceId is required' })
      return
    }
    const cwd = cwdRaw.length === 0 ? '' : canonicalCwd(cwdRaw)
    const preset = typeof request.preset === 'string' && request.preset.trim().length > 0 ? request.preset.trim() : undefined
    const controller = resolveController(ctx)
    if (controller === undefined) {
      send(res, 503, { ok: false, error: 'sessionController is unavailable in this host' })
      return
    }

    let resolved
    if (workspaceIdRaw.length > 0) {
      const registry = resolveRegistry(ctx)
      if (registry === undefined) {
        send(res, 503, { ok: false, error: 'workspaceRegistry is unavailable in this host' })
        return
      }
      const workspace = typeof registry.get === 'function' ? registry.get(workspaceIdRaw) : undefined
      if (workspace === undefined || workspace === null) {
        send(res, 404, { ok: false, error: `workspace "${workspaceIdRaw}" not found` })
        return
      }
      resolved = { registry, workspace, created: false }
    } else {
      resolved = await resolveWorkspace(cwd, { createWorkspace: request.createWorkspace !== false })
    }
    if (resolved.workspace === undefined && resolved.registry !== undefined) {
      const status = resolved.fatal === true ? 500 : 409
      send(res, status, {
        ok: false,
        error: resolved.reason,
        cwd,
        hint: status === 409 ? 'omit createWorkspace:false to register the directory, or add it in the GUI first' : undefined,
      })
      return
    }

    let created
    let sessionCwd = cwd
    try {
      // 0.2.x: create({workspaceId}) -> the controller uses workspace.path as the
      // cwd AND calls workspace.attachSession(). Passing only {cwd} skips the
      // accounting, which is what left earlier sessions invisible in the GUI.
      // 0.1.x: createSession(...) has no Workspace concept.
      const args = resolved.workspace === undefined
        ? { cwd, ...(preset === undefined ? {} : { agentPreset: preset }) }
        : { workspaceId: resolved.workspace.id, ...(preset === undefined ? {} : { agentPreset: preset }) }
      if (resolved.workspace !== undefined) sessionCwd = resolved.workspace.path ?? cwd
      created = typeof controller.create === 'function'
        ? await controller.create(args)
        : await controller.createSession(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`session-bridge: create failed: ${message}`)
      send(res, 500, { ok: false, error: message, cwd })
      return
    }

    const sessionId = sessionIdOf(created)
    const attach = await ensureAttached(resolved.registry, resolved.workspace, sessionId)
    const url = writeState()
    ctx.logger?.info?.(`session-bridge: created ${String(sessionId)} cwd=${sessionCwd}${preset === undefined ? '' : ` preset=${preset}`}${resolved.workspace === undefined ? '' : ` workspace=${resolved.workspace.id} attached=${String(attach.attached)}`}`)
    send(res, 200, {
      ok: true,
      sessionId,
      cwd: sessionCwd,
      agentPreset: created?.agentPreset ?? preset ?? null,
      workspaceId: resolved.workspace?.id ?? null,
      workspaceTitle: resolved.workspace?.title ?? null,
      workspaceCreated: resolved.created === true,
      attached: attach.attached,
      ...(attach.error === undefined ? {} : { attachError: attach.error }),
      ...(resolved.workspace === undefined ? { warning: resolved.reason } : {}),
      guiUrl: url,
    })
  }

  /** Attach one already-created Session to its Workspace (repair path). */
  const handleAttach = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId.length === 0) { send(res, 400, { ok: false, error: 'sessionId is required' }); return }
    const registry = resolveRegistry(ctx)
    if (registry === undefined) {
      send(res, 503, { ok: false, error: 'workspaceRegistry is unavailable in this host' })
      return
    }
    let workspace
    if (typeof request.workspaceId === 'string' && request.workspaceId.trim().length > 0) {
      workspace = typeof registry.get === 'function' ? registry.get(request.workspaceId.trim()) : undefined
      if (workspace === undefined || workspace === null) {
        send(res, 404, { ok: false, error: `workspace "${request.workspaceId}" not found` })
        return
      }
    } else {
      const cwdRaw = typeof request.cwd === 'string' ? request.cwd.trim() : ''
      if (cwdRaw.length === 0) { send(res, 400, { ok: false, error: 'cwd or workspaceId is required' }); return }
      const resolved = await resolveWorkspace(canonicalCwd(cwdRaw), { createWorkspace: request.createWorkspace === true })
      if (resolved.workspace === undefined) {
        const status = resolved.fatal === true ? 500 : 404
        send(res, status, { ok: false, error: resolved.reason ?? 'no Workspace is registered for this directory' })
        return
      }
      workspace = resolved.workspace
    }
    try {
      await workspace.attachSession(sessionId)
      const listed = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
      ctx.logger?.info?.(`session-bridge: attached ${sessionId} to workspace ${String(workspace.id)}`)
      send(res, 200, {
        ok: true,
        sessionId,
        workspaceId: workspace.id ?? null,
        workspaceTitle: workspace.title ?? null,
        attached: true,
        sessionCount: listed.length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 500, { ok: false, error: message, sessionId, workspaceId: workspace.id ?? null })
    }
  }

  /**
   * List host Sessions, optionally narrowed to one Workspace roster, each with
   * the `blank` flag the GUI filters on. The caller decides reuse-or-create.
   */
  const handleSessions = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const controller = resolveService(ctx, 'sessionController')
    if (typeof controller?.list !== 'function') {
      send(res, 503, { ok: false, error: 'sessionController.list is unavailable in this host' })
      return
    }
    const cwdRaw = typeof request.cwd === 'string' ? request.cwd.trim() : ''
    const workspaceIdRaw = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
    let workspace
    if (workspaceIdRaw.length > 0 || cwdRaw.length > 0) {
      const registry = resolveRegistry(ctx)
      if (registry === undefined) {
        send(res, 503, { ok: false, error: 'workspaceRegistry is unavailable in this host' })
        return
      }
      workspace = workspaceIdRaw.length > 0
        ? (typeof registry.get === 'function' ? registry.get(workspaceIdRaw) : undefined)
        : await registry.resolveByPath(canonicalCwd(cwdRaw)).catch(() => undefined)
      if (workspace === undefined || workspace === null) {
        send(res, 404, { ok: false, error: 'no Workspace matches cwd or workspaceId' })
        return
      }
    }

    let items
    try {
      items = (await controller.list({}, new AbortController().signal)).items ?? []
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const roster = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : undefined
    const rows = items
      // 0.2.x `SessionSummary` names the id `sessionId`; older generations used `id`.
      // Reading only `session.id` silently filtered every row out.
      .map(session => ({ id: session.sessionId ?? session.id, session }))
      .filter(row => roster === undefined || roster.includes(row.id))
      .map(({ id, session }) => ({
        sessionId: id,
        blank: session.blank === true,
        running: session.running === true,
        title: session.title ?? null,
        cwd: session.cwd ?? null,
        updatedAt: session.updatedAt ?? null,
        origin: session.origin ?? null,
      }))
    send(res, 200, {
      ok: true,
      workspaceId: workspace?.id ?? null,
      workspaceTitle: workspace?.title ?? null,
      count: rows.length,
      blankCount: rows.filter(row => row.blank).length,
      sessions: rows,
    })
  }

  /**
   * Deliver one message to a Session, which is what ends its blank state. The
   * host admits a requestId only once, so a retried delivery is not a second turn.
   */
  const handlePrompt = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    const text = typeof request.text === 'string' ? request.text : ''
    if (sessionId.length === 0) { send(res, 400, { ok: false, error: 'sessionId is required' }); return }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      send(res, 400, { ok: false, error: 'sessionId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/' })
      return
    }
    if (text.trim().length === 0) { send(res, 400, { ok: false, error: 'text is required' }); return }

    // Requirement 3: the caller must declare the nature of the dispatch. The
    // server never guesses one; a missing declaration is refused before the
    // host sees the message.
    const access = readDispatchAccess(request)
    if (access === null) {
      send(res, 400, {
        ok: false,
        error: 'mode is required: declare "read" or "write" for this dispatch',
        reason: 'mode-required',
        sessionId,
      })
      return
    }

    const controller = resolveService(ctx, 'sessionController')
    if (typeof controller?.prompt !== 'function') {
      send(res, 503, { ok: false, error: 'sessionController.prompt is unavailable in this host' })
      return
    }

    // Requirement 4: when the dispatch names a task, that task's Session is the
    // only one it may reach. A bound-elsewhere dispatch is refused before the
    // host sees the message; the caller decides whether to reuse the Session.
    const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : ''
    if (taskId.length > 0) {
      if (!TASK_ID_PATTERN.test(taskId)) {
        send(res, 400, { ok: false, error: 'taskId must match /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/' })
        return
      }
      let bound
      try {
        bound = findTaskBinding(dir, taskId)
      } catch (error) {
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (bound.pointer !== null && bound.pointer.sessionId !== sessionId) {
        send(res, 409, {
          ok: false,
          error: 'taskId is already bound to another session',
          code: 'task-bound',
          taskId,
          sessionId,
          boundSessionId: bound.pointer.sessionId,
        })
        return
      }
    }
    // Requirement 3: only a write dispatch is serialized per working directory.
    // Appending to a Session that is already RUNNING stays exempt - it is the
    // normal follow-up path (a question, a correction). A Session waiting on a
    // question card is not an append target (R1): the delivery would only queue
    // in `inbox.next-turn` while the card stays up and the caller sees 200.
    if (access === 'write') {
      // R2: probe the store itself first. A per-Session read error is not the only
      // shape of a broken store, and on Windows one can masquerade as ENOENT.
      const storeError = projectionStoreError()
      if (storeError !== null) {
        ctx.logger?.warn?.(`session-bridge: projection store unavailable: ${storeError}`)
        send(res, 503, {
          ok: false,
          error: 'the session projection store cannot be listed, so the single-writer check cannot run',
          code: 'projection-store-unavailable',
          reason: storeError,
          sessionId,
          mode: 'write',
        })
        return
      }
      const facts = sessionFacts(sessionId)
      if (facts.waiting === true) {
        const waitingCwd = typeof facts.sessionCwd === 'string' ? facts.sessionCwd : null
        ctx.logger?.info?.(`session-bridge: refused write to ${sessionId}; it is waiting on a question card`)
        send(res, 409, {
          ok: false,
          error: 'this session is waiting on a question card',
          code: 'session-waiting',
          sessionId,
          mode: 'write',
          workingDirectory: waitingCwd,
          occupant: { sessionId, state: 'waiting' },
          needsHuman: true,
          hint: 'the target session is waiting on a question card; answer it in the GUI - the bridge does not answer a person\'s question, and a queued delivery would not run until the card is cleared',
        })
        return
      }
      // Defect F: `unknown` is not idle. `deriveState` only reports it when
      // `pendingCalls` is non-empty, so a call is in flight; the body just cannot
      // say whether a person is blocking it. Admitting the dispatch here would be
      // the same fail-open R2 removed for an unreadable store - the message queues
      // behind a card the caller never sees while the caller gets 200. A Session
      // with no projection at all is a different case: there is no state evidence
      // to derive, and it is still admitted below.
      if (facts.projection === true && facts.state === 'unknown') {
        const unknownCwd = typeof facts.sessionCwd === 'string' ? facts.sessionCwd : null
        const occupant = { sessionId, state: 'unknown', stateReason: facts.stateReason }
        ctx.logger?.info?.(`session-bridge: refused write to ${sessionId}; its state cannot be derived: ${facts.stateReason}`)
        send(res, 409, {
          ok: false,
          error: 'the state of this session cannot be derived, so it is treated as busy',
          code: 'session-unknown',
          sessionId,
          mode: 'write',
          workingDirectory: unknownCwd,
          occupant,
          occupants: [occupant],
          hint: 'this session has unresolved tool calls, but its session body cannot be read or does not name them, so the state cannot be derived; confirm that session is idle or repair its session body path, then retry - nothing was delivered',
        })
        return
      }

      // R2: a projection file that exists but cannot be read (ENOTDIR, EACCES, a
      // broken mount, ...) means the store is broken - not that the Session is
      // new. The single-writer check cannot run, so fail closed instead of
      // admitting the dispatch. A Session with no projection at all is a
      // different case and is still admitted below.
      if (typeof facts.projectionError === 'string') {
        ctx.logger?.warn?.(`session-bridge: projection store unavailable for ${sessionId}: ${facts.projectionError}`)
        send(res, 503, {
          ok: false,
          error: 'the session projection store cannot be read, so the single-writer check cannot run',
          code: 'projection-store-unavailable',
          reason: facts.projectionError,
          sessionId,
          mode: 'write',
        })
        return
      }
      const workingDirectory = typeof facts.sessionCwd === 'string' ? facts.sessionCwd : null
      if (workingDirectory === null) {
        // No usable directory fact to group by: either the Session has no
        // projection yet (ENOENT) or its projection carries no
        // `workingDirectory`. It cannot be proven to collide with anyone, and
        // `/prompt` is also the call that gives a fresh Session its first
        // projection, so this is admitted. An existing projection with
        // unresolved calls is `unknown` and was refused above (Defect F); it
        // never reaches this branch.
        ctx.logger?.info?.(`session-bridge: ${sessionId} has no projection directory fact; concurrency not checked`)
      } else {
        const { peers, error } = activePeers(workingDirectory, sessionId)
        if (error !== null) {
          // R2: the lock must not fail open. If the store cannot even be listed,
          // nothing proves the directory is free, so the caller gets 503 and the
          // message is not delivered.
          ctx.logger?.warn?.(`session-bridge: concurrency scan failed: ${error}`)
          send(res, 503, {
            ok: false,
            error: 'the session projection store cannot be listed, so the single-writer check cannot run',
            code: 'projection-store-unavailable',
            reason: error,
            sessionId,
            mode: 'write',
            workingDirectory,
          })
          return
        }
        if (peers.length > 0) {
          const occupant = peers[0]
          const waitingOccupants = peers.filter(peer => peer.state === 'waiting')
          // Defect F: an unknown state is busy, but nobody can be sent to answer
          // a card that may not exist. Only a provable waiting occupant sets
          // `needsHuman`; unknown occupants carry their `stateReason` instead.
          const unknownOccupants = peers.filter(peer => peer.state === 'unknown')
          const hints = []
          if (waitingOccupants.length > 0) {
            hints.push('a session in this directory is waiting on a question card; answer it in the GUI - the bridge does not answer a person\'s question, and a queued delivery would not run until the card is cleared')
          }
          if (unknownOccupants.length > 0) {
            hints.push('a session in this directory has unresolved tool calls, but its session body cannot be read or does not name them, so it is treated as busy; confirm that session is idle or repair its session body path, then retry')
          }
          ctx.logger?.info?.(`session-bridge: refused write to ${sessionId}; ${occupant.sessionId} is ${occupant.state} in ${workingDirectory}`)
          send(res, 409, {
            ok: false,
            error: 'another session is busy in this directory',
            code: 'directory-busy',
            sessionId,
            mode: 'write',
            workingDirectory,
            occupant,
            occupants: peers,
            // A delivery to a Session that is waiting on a card would only queue
            // behind it while the caller sees 200. Say who must clear the block.
            ...(waitingOccupants.length === 0 ? {} : { needsHuman: true, waitingOccupants }),
            ...(unknownOccupants.length === 0 ? {} : { unknownOccupants }),
            ...(hints.length === 0 ? {} : { hint: hints.join('; ') }),
          })
          return
        }
      }
    }

    const requestId = typeof request.requestId === 'string' && request.requestId.trim().length > 0
      ? request.requestId.trim()
      : randomUUID()
    // `mode` on the host call is the delivery channel (queue|steer); the read/write
    // declaration travels in `access`, so the two never share a field.
    const deliveryMode = request.mode === 'steer' ? 'steer' : 'queue'

    try {
      const value = await controller.prompt({
        requestId,
        sessionId,
        mode: deliveryMode,
        content: [{ type: 'text', text }],
      }, new AbortController().signal)
      ctx.logger?.info?.(`session-bridge: prompted ${sessionId} access=${access} requestId=${requestId} accepted=${String(value?.accepted)}`)
      send(res, 200, { ok: value?.accepted === true, sessionId, requestId, access })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`session-bridge: prompt failed: ${message}`)
      send(res, 500, { ok: false, error: message, sessionId, requestId })
    }
  }

  /**
   * Record or refresh the Ticket-to-Session pointer (Requirement 1). The caller
   * writes it, never a DSH Session, so `LEDGER.md` stays the one semantic record.
   */
  const handlePointer = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let input
    try {
      input = normalizePointerRequest(request)
    } catch (error) {
      const status = error?.status === 400 ? 400 : 500
      send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    try {
      const stored = upsertPointer(dir, input, Date.now())
      ctx.logger?.info?.(`session-bridge: pointer ${input.taskId} -> ${input.sessionId} stage=${pointerStage(stored.pointer)} acceptance=${pointerAcceptance(stored.pointer)}`)
      send(res, 200, { ok: true, pointer: pointerView(stored.pointer), pruned: stored.pruned, count: stored.count })
    } catch (error) {
      // A missing mode on a first record is the caller's mistake; a task already
      // bound to another Session is a 409 the caller must resolve; the rest is a
      // host failure.
      const status = error?.status === 400 ? 400 : error?.status === 409 ? 409 : 500
      send(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error?.extra ?? {}),
      })
    }
  }

  /**
   * Derived state of every registered Ticket's Session, in one call
   * (Requirement 2). Read-only by construction: it loads the pointer file, reads
   * projection caches, and writes nothing.
   */
  const handleStatus = async (req, res) => {
    if (!loopbackHost(req)) { send(res, 403, { ok: false, error: 'forbidden host' }); return }
    if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'POST only' }); return }
    if (!authorized(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return }
    let request
    try {
      request = await readJsonObject(req)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let filters
    try {
      filters = statusFilters(request)
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let loaded
    try {
      loaded = loadPointers(dir)
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const now = Date.now()
    const summary = { running: 0, waiting: 0, idle: 0, unknown: 0 }
    const pointers = []
    for (const pointer of loaded.pointers) {
      if (filters.taskId.length > 0 && pointer.taskId !== filters.taskId) continue
      if (filters.sessionId.length > 0 && pointer.sessionId !== filters.sessionId) continue
      if (filters.acceptance.length > 0 && pointerAcceptance(pointer) !== filters.acceptance) continue
      const facts = sessionFacts(pointer.sessionId)
      // Defect A: the directory is the projection fact, never a stored pointer
      // cwd (which used to be the caller's process cwd). A Session with no
      // projection has no directory fact at all; dropping it here would repeat
      // Defect C's data loss, so it stays and `sessionCwd: null` says why.
      if (filters.cwd.length > 0 && typeof facts.sessionCwd === 'string' && !samePath(facts.sessionCwd, filters.cwd)) continue
      if (facts.state === 'running' || facts.state === 'waiting' || facts.state === 'idle') summary[facts.state] += 1
      else summary.unknown += 1
      // Defect I: the reading belongs to the ticket, not to the Session. A block that does
      // not name this taskId never answers for it.
      const report = ticketReport(pointer.taskId, pointer.sessionId, facts.sessionCwd)
      pointers.push({
        ...pointerView(pointer),
        ...facts,
        // Requirement 2 (round 2): the live reading and the station are separate
        // facts. `state` stays as the round-1 alias of `liveState`; neither enters
        // the pointer file or `history`.
        liveState: facts.state,
        report,
      })
    }
    send(res, 200, {
      ok: true,
      checkedAt: now,
      // Defect E: the projection is persisted at step boundaries and not during a
      // Step, so this is one boundary behind a live Turn. State the lag rather
      // than implying a real-time view.
      derivedFrom: 'session-projection-cache',
      staleness: 'state is computed from the last projection persisted at a step boundary; work inside an open step is not visible until that boundary is written',
      count: pointers.length,
      summary,
      pointers,
    })
  }

  /** Liveness probe: no token, loopback only, reveals no secrets. */
  const handleHealth = async (req, res) => {
    const diag = {
      inject: Array.isArray(inject) ? inject : Object.keys(inject ?? {}),
      controller: resolveController(ctx) !== undefined,
    }
    // Defect D: all three route probes ask the implementation, not a literal or a
    // `typeof`. pointer/status depend on a store; sessions depends on the
    // controller actually answering. A route mounted over a broken implementation
    // reports `degraded:` instead of `function`, which is the distinction the
    // liveness probe exists for.
    diag.pointer = probePointerStore(dir)
    diag.status = probeStatusStore()
    try {
      const value = resolveService(ctx, 'sessionController')
      diag.injected = value === undefined ? 'undefined' : typeof value
      diag.create = typeof value?.create
      diag.createSession = typeof value?.createSession
      diag.list = typeof value?.list
      diag.prompt = typeof value?.prompt
      diag.sessions = await probeSessionsList(value)
      try {
        const proto = value === undefined ? undefined : Object.getPrototypeOf(value)
        diag.proto = proto === undefined || proto === null ? null : Object.getOwnPropertyNames(proto).slice(0, 60)
      } catch { /* proxy */ }
    } catch (error) {
      diag.injected = `throw: ${String(error?.message ?? error).slice(0, 160)}`
      if (diag.sessions === undefined) diag.sessions = 'degraded: controller resolution failed'
    }
    const registry = resolveRegistry(ctx)
    diag.workspaceRegistry = registry === undefined ? 'undefined' : typeof registry
    if (registry !== undefined) {
      try {
        const list = typeof registry.list === 'function' ? registry.list() : []
        diag.workspaceCount = Array.isArray(list) ? list.length : null
      } catch (error) {
        diag.workspaceCount = `throw: ${String(error?.message ?? error).slice(0, 120)}`
      }
    }
    send(res, 200, { ok: true, name, ...diag })
  }

  ctx.effect(() => {
    const disposeNew = ctx.webServer.register({ kind: 'exact', path: NEW_PATH, handler: handleNew })
    const disposeAttach = ctx.webServer.register({ kind: 'exact', path: ATTACH_PATH, handler: handleAttach })
    const disposeSessions = ctx.webServer.register({ kind: 'exact', path: SESSIONS_PATH, handler: handleSessions })
    const disposePrompt = ctx.webServer.register({ kind: 'exact', path: PROMPT_PATH, handler: handlePrompt })
    const disposePointer = ctx.webServer.register({ kind: 'exact', path: POINTER_PATH, handler: handlePointer })
    const disposeStatus = ctx.webServer.register({ kind: 'exact', path: STATUS_PATH, handler: handleStatus })
    const disposeHealth = ctx.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: handleHealth })
    return () => {
      disposeNew(); disposeAttach(); disposeSessions(); disposePrompt()
      disposePointer(); disposeStatus(); disposeHealth()
    }
  }, 'session-bridge: routes')

  ctx.effect(() => {
    writeState()
    return () => { /* state file is a hint; leave it for the next launch */ }
  }, 'session-bridge: bridge state')

  ctx.logger?.info?.(`session-bridge: POST ${NEW_PATH} + ${ATTACH_PATH} + ${POINTER_PATH} + ${STATUS_PATH} ready (token in ${join(dir, 'bridge.json')})`)
}
