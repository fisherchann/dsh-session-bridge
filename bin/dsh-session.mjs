#!/usr/bin/env node
/**
 * dsh-session: ask the running DSH desktop host to open a new session, attach an
 * existing session to its Workspace, deliver a message, and keep the
 * Ticket-to-Session pointer the host bridge stores.
 *
 * Reads the loopback endpoint + bearer token that the dsh-session-bridge host
 * plugin wrote to `$DSH_HOME/plugin-data/dsh-session-bridge/bridge.json`.
 *
 * Exit status is trustworthy, so a script can branch on it: 0 delivered, 1 the
 * bridge refused or failed, 2 bad arguments, 3 the bridge is unreachable.
 *
 * The process never calls `process.exit()`. On Windows, an explicit exit while
 * the keep-alive sockets of the last `fetch` are still closing tears down a libuv
 * async handle that is already in UV_HANDLE_CLOSING, which aborts the process
 * with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
 * src\win\async.c, line 94` after the real work is done (Defect B). Setting
 * `process.exitCode` and letting the loop drain exits promptly (idle keep-alive
 * sockets do not hold it open) and cannot hit that ordering.
 *
 * Usage:
 *   node dsh-session.mjs --cwd <dir> [--preset <agent-preset-id>] [--no-create-workspace]
 *   node dsh-session.mjs --attach <sessionId> --cwd <dir>
 *   node dsh-session.mjs --sessions [--cwd <dir> | --workspace <id>]
 *   node dsh-session.mjs --send <sessionId> --text "<first message>" --access read|write [--mode queue|steer] [--request-id <uuid>]
 *   node dsh-session.mjs --send <sessionId> --text "…" --task task-6 --access read
 *   node dsh-session.mjs --pointer --task task-6 --session <sessionId> --access read [--request-id <uuid>] [--note "…"]
 *   node dsh-session.mjs --pointer --task task-6 --session <sessionId> --stage reported_ready --seq 1234
 *   node dsh-session.mjs --accept --task task-6 --session <sessionId> --note "<人作出的结论>"
 *   node dsh-session.mjs --void --task task-6 --session <sessionId> --note "<作废原因>"
 *   node dsh-session.mjs --status [--task task-6] [--session <sessionId>] [--cwd <dir>]
 *   node dsh-session.mjs --dry-run [--cwd <dir>]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const readFlag = (flag) => {
  const at = args.indexOf(flag)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined
}
const hasFlag = (flag) => args.includes(flag)

/**
 * Resolve the requested directory. Accepts a Git-Bash style `/d/dir/...` on
 * Windows (Qoder's default shell) in addition to native absolute paths.
 */
function normalizeCwd(raw) {
  if (process.platform === 'win32') {
    const posixDrive = /^\/([a-zA-Z])(\/.*)?$/.exec(raw)
    if (posixDrive !== null) {
      const drive = posixDrive[1].toUpperCase()
      const rest = (posixDrive[2] ?? '/').replaceAll('/', '\\')
      return `${drive}:${rest}`
    }
  }
  return isAbsolute(raw) ? raw : resolve(raw)
}

const cwdArg = readFlag('--cwd') ?? process.cwd()
const preset = readFlag('--preset')
const workspaceId = readFlag('--workspace')
const attachSessionId = readFlag('--attach')
const sendSessionId = readFlag('--send')
const sendText = readFlag('--text')
const sendRequestId = readFlag('--request-id')
const listSessions = hasFlag('--sessions')
const sendMode = readFlag('--mode')
const taskId = readFlag('--task')
const access = readFlag('--access')
const note = readFlag('--note')
const sessionIdFlag = readFlag('--session')
const stageArg = readFlag('--stage')
const seqArg = readFlag('--seq')
const pointerMode = hasFlag('--pointer')
const acceptMode = hasFlag('--accept')
const voidMode = hasFlag('--void')
const statusMode = hasFlag('--status')
const targetSession = sessionIdFlag ?? sendSessionId
// New sessions register their directory by default; a repair (--attach) never
// creates a Workspace unless the caller asks with --create-workspace.
const createWorkspace = hasFlag('--create-workspace')
  ? true
  : !hasFlag('--no-create-workspace') && attachSessionId === undefined
const dryRun = hasFlag('--dry-run')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const statePath = join(resolve(home), 'plugin-data', 'dsh-session-bridge', 'bridge.json')
const isAccess = (value) => value === 'read' || value === 'write'
/** `{ url, token }` from bridge.json; filled by `main()` once the file is read. */
let bridgeState

/**
 * A deliberate stop with a known exit status. Thrown instead of calling
 * `process.exit()`, so the loop drains and the exit stays clean (Defect B).
 */
class CliExit extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Bad arguments: exit 2. */
const fail = (message) => { throw new CliExit(2, `dsh-session: ${message}`) }

/** The seven stations a ticket can stand on (round 2). */
const STAGE_VALUES = new Set([
  'delivered',
  'reported_ready',
  'reported_blocked',
  'reported_failed',
  'reported_dropped',
  'accepted',
  'voided',
])
const stageRequested = stageArg === undefined ? undefined : stageArg.trim()
const seqRequested = seqArg === undefined
  ? null
  : (/^\d+$/.test(String(seqArg).trim()) ? Number(String(seqArg).trim()) : NaN)

/** The pointer record this call writes, after a `--send` or on its own. */
const pointerBody = (requestId) => ({
  taskId,
  sessionId: targetSession,
  ...(stageRequested === undefined ? {} : { stage: stageRequested }),
  ...(acceptMode ? { stage: 'accepted' } : {}),
  ...(voidMode ? { stage: 'voided' } : {}),
  // A plain pointer names the dispatch nature; a station write carries its
  // evidence instead (report seq or human note) and needs no access field.
  ...(stageRequested === undefined && !acceptMode && !voidMode ? { mode: access } : {}),
  ...(seqRequested === null ? {} : { seq: seqRequested }),
  ...(requestId === undefined ? {} : { requestId }),
  ...(note === undefined ? {} : { note }),
})

/** `/status` filters: `--cwd` only when the caller asked for it, never the process cwd. */
const statusBody = () => ({
  ...(taskId === undefined ? {} : { taskId }),
  ...(sessionIdFlag === undefined ? {} : { sessionId: sessionIdFlag }),
  ...(hasFlag('--cwd') ? { cwd: normalizeCwd(cwdArg) } : {}),
})

/** POST one bridge route and return `{ status, ok, payload }`. */
async function post(base, route, payload) {
  let response
  try {
    response = await fetch(`${base}/x-session-bridge/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${String(bridgeState.token)}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    // The body is fully read below before anything decides to stop; a request
    // that never reached the bridge is a distinct failure (exit 3).
    throw new CliExit(3, `dsh-session: cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text().catch(() => '')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    const trimmed = text.trim()
    parsed = { ok: false, error: trimmed === '' ? 'empty response body' : trimmed.slice(0, 400) }
  }
  return { status: response.status, ok: response.ok, payload: parsed }
}

/** Run one invocation and return the exit status; throws `CliExit` to stop early. */
async function main() {
  if (stageRequested !== undefined && !STAGE_VALUES.has(stageRequested)) {
    fail('--stage must be one of ' + [...STAGE_VALUES].join(', '))
  }
  if (stageRequested !== undefined && stageRequested.startsWith('reported_') && seqRequested === null) {
    fail('--stage ' + stageRequested + ' needs --seq <n> from the report')
  }
  if (seqRequested !== null && (!Number.isSafeInteger(seqRequested) || seqRequested <= 0)) {
    fail('--seq must be a positive integer')
  }
  if (acceptMode && voidMode) fail('--accept and --void are exclusive')
  if (stageRequested !== undefined && (acceptMode || voidMode)) fail('--stage cannot be combined with --accept/--void')
  if (sendSessionId !== undefined && (pointerMode || acceptMode || voidMode)) {
    fail('--send cannot be combined with --pointer/--accept/--void')
  }
  if (sendSessionId !== undefined && (sendText === undefined || sendText.trim().length === 0)) {
    fail('--send needs --text "<message>"')
  }
  if ((pointerMode || acceptMode || voidMode) && taskId === undefined) {
    fail('--pointer/--accept/--void need --task <id>')
  }
  if (pointerMode && stageRequested === undefined && !isAccess(access)) {
    fail('--pointer needs --access read|write or --stage <stage>')
  }
  if ((pointerMode || acceptMode || voidMode) && targetSession === undefined) {
    fail('--pointer/--accept/--void need --session <sessionId>')
  }
  if (acceptMode && (note === undefined || note.trim().length === 0)) {
    fail('--accept needs --note "<the human conclusion>"')
  }
  if (voidMode && (note === undefined || note.trim().length === 0)) {
    fail('--void needs --note "<reason>"')
  }
  if (sendSessionId !== undefined && taskId !== undefined && !isAccess(access)) {
    fail('--send with --task needs --access read|write: the pointer records the dispatch nature')
  }
  // Requirement 3: every delivery declares its read/write nature; the bridge
  // refuses one that does not, so the client must not send one either.
  if (sendSessionId !== undefined && !isAccess(access)) {
    fail('--send needs --access read|write: the dispatch nature must be declared')
  }

  const state = (() => {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch (error) {
      throw new CliExit(2, [
        `dsh-session: cannot read ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
        'dsh-session: start DeepSeek Harness once with the dsh-session-bridge plugin enabled.',
      ].join('\n'))
    }
  })()
  bridgeState = state

  const base = String(state.url).replace(/\/+$/, '')
  const cwd = normalizeCwd(cwdArg)
  const target = statusMode
    ? 'status'
    : (pointerMode || acceptMode || voidMode)
      ? 'pointer'
      : listSessions
        ? 'sessions'
        : sendSessionId !== undefined
          ? 'prompt'
          : attachSessionId === undefined ? 'new' : 'attach'

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      url: `${base}/x-session-bridge/${target}`,
      attachUrl: `${base}/x-session-bridge/attach`,
      healthUrl: `${base}/x-session-bridge/health`,
      cwd,
      preset: preset ?? null,
      workspaceId: workspaceId ?? null,
      attach: attachSessionId ?? null,
      send: sendSessionId ?? null,
      status: statusMode,
      task: taskId ?? null,
      access: access ?? null,
      stage: stageRequested ?? null,
      seq: Number.isSafeInteger(seqRequested) ? seqRequested : null,
      void: voidMode,
      createWorkspace,
    }, null, 2))
    return 0
  }

  const body = statusMode
    ? statusBody()
    : (pointerMode || acceptMode || voidMode)
      ? pointerBody(sendRequestId)
      : listSessions
        ? (workspaceId === undefined ? { cwd } : { workspaceId })
        : sendSessionId !== undefined
          ? {
            sessionId: sendSessionId,
            text: sendText,
            access,
            ...(taskId === undefined ? {} : { taskId }),
            ...(sendMode === undefined ? {} : { mode: sendMode }),
            ...(sendRequestId === undefined ? {} : { requestId: sendRequestId }),
          }
          : attachSessionId === undefined
            ? { cwd, ...(preset === undefined ? {} : { preset }), ...(workspaceId === undefined ? {} : { workspaceId }), createWorkspace }
            : { sessionId: attachSessionId, cwd, ...(workspaceId === undefined ? {} : { workspaceId }), createWorkspace }

  const result = await post(base, target, body)
  const output = { status: result.status, ...result.payload }
  let failed = !result.ok

  // A `--send --task` dispatch records its pointer after the delivery is accepted,
  // reusing the requestId the host generated so the two halves agree.
  if (sendSessionId !== undefined && taskId !== undefined && result.ok) {
    const requestId = typeof result.payload.requestId === 'string' ? result.payload.requestId : sendRequestId
    const pointer = await post(base, 'pointer', pointerBody(requestId))
    output.pointer = { status: pointer.status, ...pointer.payload }
    if (!pointer.ok) failed = true
  }

  console.log(JSON.stringify(output, null, 2))
  return failed ? 1 : 0
}

try {
  process.exitCode = await main()
} catch (error) {
  if (error instanceof CliExit) {
    if (error.message.length > 0) console.error(error.message)
    process.exitCode = error.code
  } else {
    console.error(`dsh-session: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
