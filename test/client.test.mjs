/**
 * Browser half, without a browser: the bundle is evaluated in this process,
 * react is a hook-shaped stand-in, and `fetch` is a recorder. The cases pin the
 * two registrations (composer chip, settings page) and the settings page's
 * request shape.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** Minimal react stand-in: the bundle needs createElement and three hooks. */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

function loadBundle() {
  let loaded
  globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  new Function(source)()
  assert.ok(loaded, 'bundle registers itself on window.__ModuleLoader__')
  return loaded
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/** Collect every node matching `predicate`. */
function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

/** First `button` in a rendered tree. */
function findButton(node) {
  return findAll(node, (candidate) => candidate.type === 'button')[0]
}

/** Mount the bundle; return the registration for one slot. */
function mount(slotName = 'conversation.input.right', react = reactStub()) {
  const entry = loadBundle()
  assert.equal(entry.id, 'dsh-skill-hardload')
  const exports = entry.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(key, cb) { injections.push(key); cb() },
      register(meta, render) { registrations.push({ meta, render }); return () => {} },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(exports.inject, ['slots'])
  assert.deepEqual(injections, ['conversation.input.right', 'settings.section'], 'never takes conversation.input.activity')
  const registration = registrations.find((item) => item.meta.name === slotName)
  assert.ok(registration, 'registered in ' + slotName)
  return { registration, registrations }
}

/** Render one seat the way the host does: props in, element out, element rendered. */
function seat(props) {
  const { registration } = mount()
  const element = registration.render(props)
  assert.equal(typeof element.type, 'function', 'render returns a component element')
  return textOf(element.type(element.props))
}

test('the chip registers in the list slot before the model selector', () => {
  const { registration, registrations } = mount()
  assert.equal(registration.meta.name, 'conversation.input.right')
  assert.equal(registration.meta.id, 'skill-hardload')
  assert.equal(typeof registration.meta.order, 'number')
  assert.notEqual(registration.render.name, 'HardloadChip', 'the component itself is never registered')
  assert.equal(registrations.length, 2, 'one composer chip and one settings page')
})

test('the registration reads the slot standard props without an inject bridge', () => {
  const { registration } = mount()
  // `sessionId` and `useInput` are standard props of this toolbar list slot, so
  // the seat reads them directly and the registration carries no `inject`.
  assert.equal(registration.meta.inject, undefined)
})

test('a seat without a session id renders a disabled chip and sends no request', () => {
  const realFetch = globalThis.fetch
  let sent = 0
  globalThis.fetch = () => { sent += 1; return Promise.resolve({ ok: false }) }
  try {
    const { registration } = mount()
    const element = registration.render({})
    const tree = element.type(element.props)
    assert.match(textOf(tree), /Skill 硬加载 关/)
    assert.doesNotMatch(textOf(tree), /检测到开发任务/)
    assert.equal(findButton(tree)?.props.disabled, true, 'the chip is inert without a session')
    assert.equal(sent, 0, 'no state request without a session id')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('off state renders an off chip', () => {
  assert.match(seat({ sessionId: 's1', useInput: (select) => select({ draft: '' }) }), /Skill 硬加载 关/)
})

test('a coding draft raises the enable hint', () => {
  for (const draft of ['实现一个登录功能', 'fix the crash', '帮我重构这段代码', '加功能：导出 CSV']) {
    const text = seat({ sessionId: 's1', useInput: (select) => select({ draft }) })
    assert.match(text, /检测到开发任务，未开启主会话 skill 硬加载/, draft)
    assert.match(text, /开启/)
  }
})

test('ordinary chat raises no hint', () => {
  for (const draft of ['', '今天天气怎么样', '翻译这段话']) {
    const text = seat({ sessionId: 's1', useInput: (select) => select({ draft }) })
    assert.doesNotMatch(text, /检测到开发任务/)
    assert.match(text, /Skill 硬加载 关/)
  }
})

test('a seat without useInput still renders the off chip', () => {
  const text = seat({ sessionId: 's1' })
  assert.match(text, /Skill 硬加载 关/)
  assert.doesNotMatch(text, /检测到开发任务/)
})

/* ---------------------------------------------------------------------- *
 * Settings page: a tiny hook runtime so the fetch → state → render path runs.
 * ---------------------------------------------------------------------- */

/**
 * Render the settings page, run its effects, and re-render after each state
 * write. `interact` runs inside the mocked-fetch window, so clicks that would
 * send a request see the recorder rather than the network. Pass `slotName` to
 * drive the composer chip through the same hook runtime.
 */
async function renderPage(props, respond, interact, slotName = 'settings.section') {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, json: async () => respond(String(url), init) }
  }
  try {
    const states = []
    const effectDeps = []
    let slot = 0
    let effectSlot = 0
    let effects = []
    let draw = () => {}
    const React = {
      createElement: (type, properties, ...children) => ({ type, props: properties ?? {}, children }),
      useState(initial) {
        const index = slot
        slot += 1
        if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
        return [states[index], (value) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value
          draw()
        }]
      },
      /**
       * With a dependency list, an effect runs only when it changes — the same
       * rule react applies. Without one, the effect is re-run on every render.
       */
      useEffect(effect, deps) {
        const index = effectSlot
        effectSlot += 1
        const previous = effectDeps[index]
        const same = Array.isArray(deps) && Array.isArray(previous)
          && deps.length === previous.length
          && deps.every((value, position) => Object.is(value, previous[position]))
        if (!same) {
          effects.push(effect)
          effectDeps[index] = deps
        }
      },
      useCallback: (fn) => fn,
    }
    const { registration } = mount(slotName, React)
    let tree
    draw = () => {
      slot = 0
      effectSlot = 0
      effects = []
      const element = registration.render(props ?? {})
      tree = element.type(element.props)
    }
    const view = () => tree
    const text = () => textOf(tree)
    /** Run queued effects and let their promise chains settle, re-rendering. */
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) {
        const pending = effects.slice()
        effects = []
        for (const effect of pending) await effect()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    draw()
    await settle()
    if (interact !== undefined) await interact({ tree: view, text, calls, settle })
    return { tree: view, text, calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

/** The rendered save control, whatever react stub is in play. */
function saveButton(tree) {
  return findAll(tree, (node) => typeof node.type === 'function' && node.type.name === 'PrimaryButton')[0]
}

test('the settings page registers its own section entry', () => {
  const { registration } = mount('settings.section')
  assert.equal(registration.meta.name, 'settings.section')
  assert.equal(registration.meta.id, 'skill-hardload')
  assert.equal(registration.meta.label, 'Skill 硬加载')
  assert.equal(typeof registration.meta.order, 'number')
  assert.equal(typeof registration.render, 'function')
})

test('the page shows the saved skill and the default switch', async () => {
  const page = await renderPage({}, () => ({ defaultEnabled: true, skill: 'main-agent-orchestrator' }))
  assert.match(page.text(), /硬加载的 Skill 名/)
  const input = findAll(page.tree(), (node) => node.type === 'input')[0]
  assert.equal(input?.props.value, 'main-agent-orchestrator')
  const toggle = findAll(page.tree(), (node) => node.props?.role === 'switch')[0]
  assert.equal(toggle?.props['aria-checked'], true)
  assert.equal(page.calls.length, 1)
  assert.match(page.calls[0].url, /dsh-skill-hardload\/api\/settings$/)
})

test('saving posts the trimmed name and the switch', async () => {
  const page = await renderPage({}, (_url, init) => (init?.method !== 'POST'
    ? { defaultEnabled: false, skill: 'main-agent-orchestrator' }
    : { ...JSON.parse(init.body), saved: true, persisted: true }), async (page) => {
    findAll(page.tree(), (node) => node.type === 'input')[0].props.onChange({ target: { value: '  my-orchestrator  ' } })
    findAll(page.tree(), (node) => node.props?.role === 'switch')[0].props.onClick()
    saveButton(page.tree()).props.onClick()
    await page.settle()
  })
  const posted = page.calls.filter((call) => call.init?.method === 'POST')
  assert.equal(posted.length, 1)
  assert.deepEqual(JSON.parse(posted[0].init.body), { skill: 'my-orchestrator', defaultEnabled: true })
  assert.match(page.text(), /已保存/)
})

test('a save the host could not write to disk says so', async () => {
  const page = await renderPage({}, (_url, init) => (init?.method !== 'POST'
    ? { defaultEnabled: false, skill: 'main-agent-orchestrator' }
    : { ...JSON.parse(init.body), saved: true, persisted: false }), async (page) => {
    saveButton(page.tree()).props.onClick()
    await page.settle()
  })
  assert.match(page.text(), /写入 settings\.json 失败/)
  assert.doesNotMatch(page.text(), /已保存到/, 'no success claim for a value that reverts on restart')
})

test('an illegal name disables the save button', async () => {
  const page = await renderPage({}, () => ({ defaultEnabled: false, skill: 'main-agent-orchestrator' }), async (page) => {
    findAll(page.tree(), (node) => node.type === 'input')[0].props.onChange({ target: { value: '../escape' } })
    await page.settle()
  })
  assert.equal(saveButton(page.tree()).props.disabled, true)
  assert.match(page.text(), /名称不合法/)
})

/* ---------------------------------------------------------------------- *
 * The chip's own request: this is where "the default is on but a new session
 * still shows off" used to come from.
 * ---------------------------------------------------------------------- */

test('the chip asks the host for its own session, under the site root', async () => {
  const realDocument = globalThis.document
  // The page the seat renders on is a session route, so a naive
  // `new URL(relative, baseURI)` would land under `/session/<id>`.
  globalThis.document = { baseURI: 'http://127.0.0.1:59057/session/abc' }
  try {
    const page = await renderPage(
      { sessionId: 's1', useInput: (select) => select({ draft: '' }) },
      () => ({ enabled: true, loaded: false, skill: 'main-agent-orchestrator' }),
      undefined,
      'conversation.input.right',
    )
    assert.equal(page.calls.length, 1, 'one state read per mounted seat')
    assert.equal(
      page.calls[0].url,
      '/dsh-skill-hardload/api/state?sessionId=s1',
      'the path stays rooted and the query survives',
    )
    assert.match(page.text(), /Skill 硬加载 开/, 'a session the host reports as on renders as on')
  } finally {
    globalThis.document = realDocument
  }
})

