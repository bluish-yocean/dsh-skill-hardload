/**
 * Host-half behaviour that runs without a host: the local message helpers that
 * replaced the `@deepseek-ai/dsh-llm` import, the one-shot `agent/pre-step`
 * injection, and the settings route that seeds new sessions only.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  apply,
  boundContextSummary,
  createUserMessage,
  readSettings,
  resolveSeed,
  writeSettings,
  DEFAULT_SKILL,
} = await import('../lib/index.js')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Collect the handlers `apply` registers, without a real service container.
 * @param services - stand-ins for `agents` and `skills`; each one is mounted
 *   the way the host mounts a service scope.
 */
function fakeCtx(services = {}) {
  const handlers = new Map()
  const injects = []
  return {
    handlers,
    injects,
    logger: { info() {} },
    on(name, handler) { handlers.set(name, handler) },
    inject(names, register) {
      injects.push({ names, register })
      const key = names[0]
      const service = services[key]
      if (service !== undefined) register({ [key]: service, effect: (fn) => fn() })
    },
  }
}


/**
 * Mount against a private settings file.
 *
 * Every case owns its file: the real `settings.json` sits beside the plugin and
 * a real run can leave a saved value there, which would otherwise make these
 * cases depend on that machine's state.
 * @param ctx - the fake scope.
 * @param config - the mount's config block, without a path.
 * @returns the settings path this mount owns.
 */
function applyIsolated(ctx, config = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'skill-hardload-')), 'settings.json')
  apply(ctx, { ...config, settingsPath: path })
  return path
}


/** Mount the recorded `webServer` scope and return its route table. */
function mountWebServer(ctx) {
  const routes = new Map()
  const entry = ctx.injects.find((item) => item.names[0] === 'webServer')
  assert.ok(entry, 'the webServer scope is injected')
  entry.register({
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect: (fn) => fn(),
  })
  return routes
}

/** Drive one route handler with the request/response pair the host would use. */
async function callRoute(handler, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  const request = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  let status = 0
  let payload
  const response = {
    writeHead(code) { status = code },
    end(text) { payload = text },
  }
  await handler(request, response)
  return { status, json: payload === undefined ? undefined : JSON.parse(payload) }
}

/**
 * Drive the pre-step handler the way the host does: payload in, decision out.
 *
 * The id is branded here (`session-<name>`) because the switch only covers main
 * sessions; a bare id is a subagent and is deliberately left alone.
 */
function preStep(ctx, sessionId) {
  const decision = { kind: 'enter', messages: [] }
  const handler = ctx.handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function')
  return handler({ agent: { session: { id: 'session-' + sessionId } } }, async () => decision)
}

/** Drive the pre-execute handler: exec plus the delegate decision in. */
async function preExecute(ctx, sessionId, toolName, args) {
  const handler = ctx.handlers.get('tools/pre-execute')
  assert.equal(typeof handler, 'function')
  return handler({ name: toolName, arguments: args, agent: { session: { id: 'session-' + sessionId } } }, async () => ({ kind: 'allow' }))
}

/** Drive the post-execute handler for a successful `skill` call. */
async function postExecute(ctx, sessionId, toolName, args) {
  const handler = ctx.handlers.get('tools/post-execute')
  assert.equal(typeof handler, 'function')
  return handler({ name: toolName, arguments: args, agent: { session: { id: 'session-' + sessionId } } }, { isError: false }, async () => ({ kind: 'allow' }))
}

test('createUserMessage builds an identified frozen user message', () => {
  const source = { kind: 'skill-hardload', form: 'notice', summary: 's' }
  const message = createUserMessage({ content: [{ type: 'text', text: '规则' }], source })
  assert.match(message.id, UUID)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: '规则' }])
  assert.deepEqual(message.source, source)
  assert.ok(Object.isFrozen(message), 'message is frozen')
  assert.ok(Object.isFrozen(message.content), 'content is frozen too')
  assert.notEqual(createUserMessage({ content: [] }).id, message.id, 'each message gets its own id')
})

test('boundContextSummary ellipsizes only past the bound', () => {
  assert.equal(boundContextSummary('x'.repeat(120)), 'x'.repeat(120))
  const bounded = boundContextSummary('y'.repeat(121))
  assert.equal(bounded.length, 120)
  assert.equal(bounded, 'y'.repeat(119) + '…')
})

test('resolveSeed reads the config block, field by field', () => {
  assert.deepEqual(resolveSeed(undefined), { enabled: false, skill: DEFAULT_SKILL })
  assert.deepEqual(resolveSeed({}), { enabled: false, skill: DEFAULT_SKILL })
  assert.deepEqual(resolveSeed({ defaultEnabled: true }), { enabled: true, skill: DEFAULT_SKILL })
  assert.deepEqual(resolveSeed({ defaultSkill: 'my-orchestrator' }), { enabled: false, skill: 'my-orchestrator' })
  assert.deepEqual(
    resolveSeed({ defaultEnabled: true, defaultSkill: '../escape' }),
    { enabled: true, skill: DEFAULT_SKILL },
    'a bad name falls back alone; the switch still applies',
  )
  assert.deepEqual(resolveSeed({ defaultEnabled: 'yes' }), { enabled: false, skill: DEFAULT_SKILL })
})

test('apply registers the three events and the web scope', () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  assert.equal(ctx.handlers.has('agent/pre-step'), true)
  assert.equal(ctx.handlers.has('tools/pre-execute'), true)
  assert.equal(ctx.handlers.has('tools/post-execute'), true)
  assert.deepEqual(ctx.injects.map((entry) => entry.names), [['webServer']])
})

test('the switch starts off until enabled', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  assert.deepEqual((await preStep(ctx, 'off-1')).messages, [])
})

test('defaultEnabled injects one notice naming the skill, once', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true })
  const first = await preStep(ctx, 'on-1')
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].role, 'user')
  assert.match(first.messages[0].content[0].text, new RegExp(DEFAULT_SKILL))
  assert.equal(first.messages[0].source.kind, 'skill-hardload')
  assert.deepEqual((await preStep(ctx, 'on-1')).messages, [], 'injected once per enable')
})

test('the guard lifts only after that exact skill loads', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true })
  await preStep(ctx, 'guard-1')
  const denied = await preExecute(ctx, 'guard-1', 'write', { file_path: 'a.txt' })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, new RegExp(DEFAULT_SKILL))
  await postExecute(ctx, 'guard-1', 'skill', { name: 'some-other-skill' })
  assert.equal((await preExecute(ctx, 'guard-1', 'write', { file_path: 'a.txt' })).kind, 'deny')
  await postExecute(ctx, 'guard-1', 'skill', { name: DEFAULT_SKILL })
  assert.equal((await preExecute(ctx, 'guard-1', 'write', { file_path: 'a.txt' })).kind, 'allow')
})

test('the settings route reads, validates and applies', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  const routes = mountWebServer(ctx)

  const read = await callRoute(routes.get('/dsh-skill-hardload/api/settings'))
  assert.equal(read.status, 200)
  assert.deepEqual(
    { defaultEnabled: read.json.defaultEnabled, skill: read.json.skill },
    { defaultEnabled: false, skill: DEFAULT_SKILL },
  )

  for (const skill of ['../escape', 'Upper', '', 'a/b']) {
    const bad = await callRoute(routes.get('/dsh-skill-hardload/api/settings'), { method: 'POST', body: { skill } })
    assert.equal(bad.status, 400, 'refused ' + JSON.stringify(skill))
  }
  const badFlag = await callRoute(routes.get('/dsh-skill-hardload/api/settings'), { method: 'POST', body: { defaultEnabled: 'yes' } })
  assert.equal(badFlag.status, 400)

  const saved = await callRoute(routes.get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    body: { defaultEnabled: true, skill: 'my-orchestrator' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.saved, true)
  assert.equal(saved.json.persisted, true, 'the host reports the file write')

  const injected = await preStep(ctx, 'after-save')
  assert.match(injected.messages[0].content[0].text, /my-orchestrator/)
})


test('a session opened before the change keeps its own state', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  const routes = mountWebServer(ctx)

  assert.deepEqual((await preStep(ctx, 'kept-1')).messages, [])
  await callRoute(routes.get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    body: { defaultEnabled: true, skill: 'renamed-skill' },
  })
  assert.deepEqual((await preStep(ctx, 'kept-1')).messages, [], 'the open session stays off')
  assert.match((await preStep(ctx, 'fresh-1')).messages[0].content[0].text, /renamed-skill/, 'a new session takes the new default')
})

test('renaming never strands a session that was already told the old name', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true, defaultSkill: 'old-skill' })
  const routes = mountWebServer(ctx)

  assert.match((await preStep(ctx, 'rename-1')).messages[0].content[0].text, /old-skill/)
  await callRoute(routes.get('/dsh-skill-hardload/api/settings'), { method: 'POST', body: { skill: 'new-skill' } })
  await postExecute(ctx, 'rename-1', 'skill', { name: 'old-skill' })
  assert.equal(
    (await preExecute(ctx, 'rename-1', 'write', { file_path: 'a.txt' })).kind,
    'allow',
    'the old name still counts for the session that was told to load it',
  )
})

test('saving the default pins nothing the plugin has not seen', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  const routes = mountWebServer(ctx)

  const saved = await callRoute(routes.get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    body: { defaultEnabled: true },
  })
  // Regression: the Host lists idle and freshly created sessions in
  // `agents.list()`, and a save used to pin every one of them to the *previous*
  // default. The next "new session" then read that old value and showed the
  // composer switch as off although the page had just saved it as on.
  assert.equal('frozen' in saved.json, false, 'a save freezes no session')
  assert.equal((await preStep(ctx, 'idle-1')).messages.length, 1, 'a listed-but-unused session takes the new default')
})

test('a subagent session is neither injected nor guarded', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true })
  // A subagent session id is a bare uuid; a main session's is `session-<uuid>`.
  const subagent = '0f8a4a2e-1111-4222-8333-444455556666'

  const enter = await ctx.handlers.get('agent/pre-step')({ agent: { id: subagent } }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(enter.messages, [], 'a subagent gets no orchestrator rule')

  const write = await ctx.handlers.get('tools/pre-execute')(
    { name: 'write', arguments: { file_path: 'a.txt' }, agent: { id: subagent } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(write.kind, 'allow', 'a subagent must be able to write the files it was delegated')
})

test('a cross-site save is refused', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, {})
  const routes = mountWebServer(ctx)
  const refused = await callRoute(routes.get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { defaultEnabled: true },
  })
  assert.equal(refused.status, 403)
})

/* ---------------------------------------------------------------------- *
 * Persistence: a setting must survive a restart, which is a fresh `apply`.
 * ---------------------------------------------------------------------- */

test('a saved switch is read back by the next mount', async () => {
  const first = fakeCtx()
  const path = applyIsolated(first, {})
  const saved = await callRoute(mountWebServer(first).get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    body: { defaultEnabled: true, skill: 'persisted-skill' },
  })
  assert.equal(saved.json.persisted, true, 'the host reports the file write')
  assert.deepEqual(readSettings(path), { defaultEnabled: true, skill: 'persisted-skill' })

  // A restart is a fresh mount that reads `config:` first; the file must win.
  const second = fakeCtx()
  apply(second, { settingsPath: path, defaultEnabled: false })
  const reread = await callRoute(mountWebServer(second).get('/dsh-skill-hardload/api/settings'))
  assert.deepEqual(
    { defaultEnabled: reread.json.defaultEnabled, skill: reread.json.skill },
    { defaultEnabled: true, skill: 'persisted-skill' },
  )
  assert.match((await preStep(second, 'after-restart')).messages[0].content[0].text, /persisted-skill/)
})

test('a malformed settings file is ignored, not fatal', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'skill-hardload-')), 'settings.json')
  writeFileSync(path, '{ not json', 'utf8')
  const ctx = fakeCtx()
  apply(ctx, { settingsPath: path })
  const read = await callRoute(mountWebServer(ctx).get('/dsh-skill-hardload/api/settings'))
  assert.equal(read.json.defaultEnabled, false)
  assert.equal(read.json.skill, DEFAULT_SKILL)
})

test('an unwritable settings path is reported, not hidden', async () => {
  const blocked = join(mkdtempSync(join(tmpdir(), 'skill-hardload-')), 'missing-dir', 'settings.json')
  const ctx = fakeCtx()
  apply(ctx, { settingsPath: blocked })
  const saved = await callRoute(mountWebServer(ctx).get('/dsh-skill-hardload/api/settings'), {
    method: 'POST',
    body: { defaultEnabled: true },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.persisted, false, 'the page can warn instead of pretending')
  assert.equal(saved.json.defaultEnabled, true, 'the setting still applies to this run')
})

/* ---------------------------------------------------------------------- *
 * The lock: a session that loaded the skill must be able to write again.
 * ---------------------------------------------------------------------- */

test('loading the skill unlocks the session at the call that loads it', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true })
  await preStep(ctx, 'unlock-1')
  assert.equal((await preExecute(ctx, 'unlock-1', 'write', { file_path: 'a.txt' })).kind, 'deny')
  assert.equal((await preExecute(ctx, 'unlock-1', 'skill', { name: DEFAULT_SKILL })).kind, 'allow')
  assert.equal(
    (await preExecute(ctx, 'unlock-1', 'write', { file_path: 'a.txt' })).kind,
    'allow',
    'the session is not stranded when post-execute cannot match the call',
  )
})

test('the caller agent is read from its contract field, id', async () => {
  const ctx = fakeCtx()
  applyIsolated(ctx, { defaultEnabled: true })
  const handler = ctx.handlers.get('agent/pre-step')
  const decision = await handler({ agent: { id: 'session-contract-1' } }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1, 'a bare { id } agent gets the rule')
})
