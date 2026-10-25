/**
 * Host half of dsh-skill-hardload.
 *
 * Per-session switch: while a session has it on, the first step of a turn
 * carries a rule that forces the configured skill before coding work, and a
 * pre-execute guard refuses write/edit, build-ish shell calls and workspace
 * mutations reached through `run_code` until that skill was actually loaded in
 * the session.
 *
 * Two levels of state, on purpose:
 *   - settings, one per profile: the default switch and the forced skill name,
 *     owned by the settings page and persisted to `settings.json` beside this
 *     package;
 *   - sessions, one per session id: the switch, the skill name and the loaded
 *     flag captured the first time this plugin saw that session.
 *
 * A settings change only seeds sessions this plugin has not seen yet. Every
 * session that already has state keeps its own copy — including the skill name
 * it was told to load — so renaming the skill never strands a session that was
 * already running with the old rule.
 *
 * The rule is a *main session* rule (`isMainSession`): a subagent session is
 * left alone, because it must load its own skill rather than this one and still
 * has to write the files it was delegated.
 *
 * The Host owns persistence. `DSH_HOME` is not in its environment (it is a shell
 * fact handed to the model), but a `link:` mount resolves this module to its real
 * path, so `settings.json` beside `lib/` is writable across restarts.
 *
 * The file outranks the `config:` block: `config:` seeds a fresh install, the
 * file is what the user last saved. Without that order every restart reverted
 * the page to the shipped default, because `apply` re-reads `config:` on every
 * mount.
 *
 * Import rule: a `link:` mount resolves this package to a real path outside the
 * profile, so Node looks for dependencies beside that real path, never in the
 * profile's `node_modules`. A bare `@deepseek-ai/*` specifier therefore fails at
 * import time: `apply` never runs, the client half is never delivered, and the
 * chip silently never appears. Only `node:*` builtins and `./guard.js` may be
 * imported here; `test/source.test.mjs` fails when that rule is broken.
 */
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SKILL,
  blockedText,
  isGuardedExecution,
  isMainSession,
  isSkillLoad,
  isSkillName,
  rulesText,
} from './guard.js'

export { DEFAULT_SKILL, isSkillName }

export const name = 'dsh-skill-hardload'

/** Bound of a `notice` summary, matching the host message helper. */
const SUMMARY_MAX_CHARS = 120

/**
 * Bound one `notice` summary to {@link SUMMARY_MAX_CHARS}.
 *
 * Local copy of the host helper, exported for the message-shape test.
 * @param summary - the producer's one-line account, of any length.
 * @returns the account, ellipsized when it exceeds the bound.
 */
export function boundContextSummary(summary) {
  return summary.length <= SUMMARY_MAX_CHARS ? summary : summary.slice(0, SUMMARY_MAX_CHARS - 1) + '…'
}

/** Freeze every reachable object, as the host message helper does. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Create one identified, immutable user-role message.
 *
 * Local copy of the host `createUserMessage`: same `{ ...input, role: 'user',
 * id }` shape, detached and deep-frozen, so no `@deepseek-ai/*` import is
 * needed. Exported for the message-shape test.
 * @param input - complete content and source for the new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * Resolve the seed used when no settings file exists yet.
 *
 * The `config:` block is read as-is because exporting a `Config` schema would
 * need the `@deepseek-ai/schemastery` import this half may not make. A bad
 * `defaultSkill` falls back alone; a valid `defaultEnabled` still applies.
 *
 * @param config - the mount's `config:` block.
 * @returns the default switch state and skill name for a new session.
 */
export function resolveSeed(config) {
  return {
    enabled: config?.defaultEnabled === true,
    skill: isSkillName(config?.defaultSkill) ? config.defaultSkill : DEFAULT_SKILL,
  }
}

/** Seed applied to a session the first time this plugin sees it. */
const seed = { enabled: false, skill: DEFAULT_SKILL }

/** Settings file beside this package; `config.settingsPath` overrides it. */
const DEFAULT_SETTINGS_PATH = fileURLToPath(new URL('../settings.json', import.meta.url))

/** Where the settings for this mount live. */
let settingsPath = DEFAULT_SETTINGS_PATH

/**
 * @param path - settings file to read.
 * @returns the saved pair, or undefined when the file is absent or unusable.
 *
 * A malformed file is treated as absent instead of fatal: the `config:` seed
 * still applies, so a bad file cannot make the plugin unusable.
 */
export function readSettings(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed.defaultEnabled !== 'boolean') return undefined
  if (!isSkillName(parsed.skill)) return undefined
  return { defaultEnabled: parsed.defaultEnabled, skill: parsed.skill }
}

/**
 * Replace the settings file in one step.
 *
 * Writing a sibling and renaming over the destination keeps a crash mid-write
 * from leaving a truncated file that {@link readSettings} would reject.
 *
 * @param path - settings file to write.
 * @param value - the pair to keep.
 * @returns whether the file now holds that pair.
 */
export function writeSettings(path, value) {
  const temporary = path + '.tmp'
  const text = JSON.stringify({ defaultEnabled: value.defaultEnabled, skill: value.skill }, null, 2) + '\n'
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      /* the temporary write itself failed, so there is nothing to clean up */
    }
    return false
  }
}

const API = '/dsh-skill-hardload/api'
const MAX_BODY = 8192
const MAX_SESSION_ID = 256

/**
 * Diagnostics: one line per request that decides this plugin's state.
 *
 * A chip that reads a different session key than the guard writes is invisible
 * from both sides — the page shows one value, the guard holds another, and no
 * error is raised anywhere. This trace makes the two keys comparable.
 */
const TRACE_LIMIT = 400
const TRACE_INLINE = 40

/** Where the request trace is appended; beside the settings file. */
let tracePath = ''
let traceWrites = 0

/**
 * @param line - one diagnostic record.
 *
 * Diagnostics must never change a request's outcome, so every failure here is
 * swallowed. The file is trimmed occasionally so a long-lived page cannot grow
 * it without bound.
 */
function trace(line) {
  if (tracePath === '') return
  try {
    appendFileSync(tracePath, new Date().toISOString() + ' ' + line + '\n', 'utf8')
    traceWrites += 1
    if (traceWrites % 100 === 0) {
      const lines = readFileSync(tracePath, 'utf8').split('\n')
      if (lines.length > TRACE_LIMIT) {
        writeFileSync(tracePath, lines.slice(lines.length - TRACE_LIMIT).join('\n'), 'utf8')
      }
    }
  } catch {
    /* never break the request */
  }
}

function traceRoute(request, response) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'method' })
  let text = ''
  try {
    text = readFileSync(tracePath, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split('\n').filter((line) => line !== '')
  const skipped = lines.length > TRACE_INLINE ? ['… ' + (lines.length - TRACE_INLINE) + ' earlier lines …'] : []
  return sendJson(response, 200, { settingsPath, tracePath, lines: skipped.concat(lines.slice(-TRACE_INLINE)) })
}

/**
 * @typedef {{ enabled: boolean, skill: string, injected: boolean, loaded: boolean }} SessionState
 */

/** @type {Map<string, SessionState>} */
const sessions = new Map()

/**
 * @param sessionId - the id the host routes through this plugin.
 * @returns that session's own state, created from the seed on first contact.
 */
function stateOf(sessionId) {
  let state = sessions.get(sessionId)
  if (state === undefined) {
    state = { enabled: seed.enabled, skill: seed.skill, injected: false, loaded: false }
    sessions.set(sessionId, state)
    trace('seed   ' + sessionId + ' -> enabled=' + state.enabled + ' skill=' + state.skill)
  }
  return state
}

/**
 * @param agent - a caller agent, or the agent a pre-step payload carries.
 * @returns its session id, or undefined when the shape carries none.
 *
 * `Agent` is declared as `{ readonly id }`, so `id` is the contract. A nested
 * `session.id` is still accepted because a payload may carry the session record
 * rather than the bare agent.
 */
function agentId(agent) {
  const direct = agent?.id
  if (isSessionId(direct)) return direct
  const nested = agent?.session?.id
  return isSessionId(nested) ? nested : undefined
}

function isSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

async function readBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function stateRoute(request, response) {
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'method' })
  const url = new URL(request.url ?? '/', 'http://localhost')
  const sessionId = url.searchParams.get('sessionId')
  if (!isSessionId(sessionId)) return sendJson(response, 400, { error: 'sessionId' })
  const state = stateOf(sessionId)
  trace('GET  state  ' + sessionId + ' -> enabled=' + state.enabled + ' loaded=' + state.loaded + ' skill=' + state.skill)
  return sendJson(response, 200, { enabled: state.enabled, loaded: state.loaded, skill: state.skill })
}

async function enableRoute(request, response) {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'method' })
  if (request.headers['sec-fetch-site'] === 'cross-site') return sendJson(response, 403, { error: 'origin' })
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    return sendJson(response, 400, { error: 'body' })
  }
  if (!isSessionId(body?.sessionId)) return sendJson(response, 400, { error: 'sessionId' })
  const enabled = body.enabled === true
  const state = stateOf(body.sessionId)
  if (enabled && !state.enabled) state.injected = false
  state.enabled = enabled
  trace('POST enable ' + body.sessionId + ' -> enabled=' + state.enabled + ' loaded=' + state.loaded)
  return sendJson(response, 200, { enabled: state.enabled, loaded: state.loaded, skill: state.skill })
}

/** @returns the profile-level settings new sessions start from. */
function settingsSnapshot() {
  return { defaultEnabled: seed.enabled, skill: seed.skill }
}

async function settingsRoute(request, response) {
  if (request.method === 'GET') return sendJson(response, 200, settingsSnapshot())
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'method' })
  if (request.headers['sec-fetch-site'] === 'cross-site') return sendJson(response, 403, { error: 'origin' })
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    return sendJson(response, 400, { error: 'body' })
  }
  if (body?.defaultEnabled !== undefined && typeof body.defaultEnabled !== 'boolean') {
    return sendJson(response, 400, { error: 'defaultEnabled' })
  }
  const skill = body?.skill === undefined ? seed.skill : body.skill
  if (!isSkillName(skill)) return sendJson(response, 400, { error: 'skill' })
  // Saving only moves the default. A session keeps whatever it got the first
  // time this plugin saw it, so nothing needs freezing here — and freezing was
  // actively wrong: `agents.list()` also holds sessions no one has opened yet
  // (an idle or freshly created record), so pinning those made the next "new
  // session" read the *previous* default and show the switch as off.
  if (typeof body?.defaultEnabled === 'boolean') seed.enabled = body.defaultEnabled
  seed.skill = skill
  const persisted = writeSettings(settingsPath, { defaultEnabled: seed.enabled, skill: seed.skill })
  trace('POST settings body=' + JSON.stringify(body) + ' -> seed.enabled=' + seed.enabled + ' persisted=' + persisted)
  return sendJson(response, 200, { ...settingsSnapshot(), saved: true, persisted })
}

function rulesMessage(skill) {
  return createUserMessage({
    content: [{ type: 'text', text: rulesText(skill) }],
    source: { kind: 'skill-hardload', form: 'notice', summary: boundContextSummary('Skill 硬加载已开启，先加载 ' + skill) },
  })
}

function sessionIdOf(exec) {
  return agentId(exec?.agent)
}

async function preStep(payload, next) {
  const decision = await next()
  const sessionId = agentId(payload?.agent)
  if (sessionId === undefined || !isMainSession(sessionId)) return decision
  const state = stateOf(sessionId)
  if (!state.enabled || state.injected) return decision
  if (decision.kind !== 'enter') return decision
  state.injected = true
  return { ...decision, messages: [...decision.messages, rulesMessage(state.skill)] }
}

async function preExecute(exec, next) {
  const decision = await next()
  if (decision.kind !== 'allow') return decision
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined || !isMainSession(sessionId)) return decision
  const state = stateOf(sessionId)
  if (!state.enabled) return decision
  // Recognise the load here, where the session id is known to resolve. Relying
  // only on `post-execute` left a session locked whenever that callback could not
  // match the call, and a locked session cannot be rescued from the composer:
  // every write is refused, including the write that would fix this plugin.
  if (isSkillLoad(exec.name, exec.arguments, state.skill)) {
    state.loaded = true
    return decision
  }
  if (state.loaded) return decision
  if (!isGuardedExecution(exec.name, exec.arguments)) return decision
  return { kind: 'deny', reason: blockedText(state.skill) }
}

async function postExecute(exec, result, next) {
  const decision = await next()
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined || !isMainSession(sessionId)) return decision
  const state = stateOf(sessionId)
  if (result?.isError !== true && isSkillLoad(exec.name, exec.arguments, state.skill)) state.loaded = true
  return decision
}

export function apply(ctx, config) {
  // A reload mounts fresh scopes and this module keeps its session map, so drop
  // what the previous mount decided: the new mount starts from the saved file.
  sessions.clear()
  settingsPath = typeof config?.settingsPath === 'string' && config.settingsPath.length > 0
    ? config.settingsPath
    : DEFAULT_SETTINGS_PATH
  tracePath = settingsPath + '.trace.log'
  Object.assign(seed, resolveSeed(config))
  // The saved file outranks `config:`: a restart must not revert what the user
  // saved in the page. `config:` is the first-run seed only.
  const stored = readSettings(settingsPath)
  if (stored !== undefined) {
    seed.enabled = stored.defaultEnabled
    seed.skill = stored.skill
  }
  ctx.logger?.info?.(
    'skill-hardload: loaded; defaultEnabled=' + seed.enabled + ' skill=' + seed.skill
    + ' settings=' + settingsPath + (stored === undefined ? ' (none yet)' : ' (saved)'),
  )
  ctx.on('agent/pre-step', preStep)
  ctx.on('tools/pre-execute', preExecute)
  ctx.on('tools/post-execute', postExecute)
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const offs = [
        scoped.webServer.register({ kind: 'exact', path: API + '/state', handler: stateRoute }),
        scoped.webServer.register({ kind: 'exact', path: API + '/enable', handler: enableRoute }),
        scoped.webServer.register({ kind: 'exact', path: API + '/settings', handler: settingsRoute }),
        scoped.webServer.register({ kind: 'exact', path: API + '/trace', handler: traceRoute }),
      ]
      return () => {
        for (const off of offs) if (typeof off === 'function') off()
      }
    })
  })
}
