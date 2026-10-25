/**
 * Browser half of dsh-skill-hardload.
 *
 * Two seats, one settings store:
 *   - `settings.section` — a page that names the forced skill and the default
 *     switch state for *new* sessions, persisted by the host half;
 *   - `conversation.input.right` — the per-session chip in the composer
 *     toolbar, placed before the model selector. It does not take
 *     `conversation.input.activity`: that single slot belongs to the
 *     voice-input microphone.
 *
 * The chip reads and writes only its own session; the settings page reads and
 * writes only the profile-level defaults. That split is what keeps an open
 * session on the state it was opened under.
 *
 * Plain-JS bundle in the harness module-loader format; react comes from the
 * host module table.
 *
 * Slot choice is two constants below. `conversation.input.right` is the
 * preferred seat; when the chip measures to the right of the model selector,
 * switch `SLOT` to `conversation.input.left` and raise `ORDER` to the largest
 * number in that group so it lands immediately before the model control.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-hardload',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.input.right'
    const ORDER = 100
    const SETTINGS_ORDER = 440
    const API = 'dsh-skill-hardload/api'
    /* Bumped whenever this bundle's request shape changes. The harness reloads
     * a client row from the entry's mtime, so every edit here already reaches an
     * open page; the constant only makes the generation readable in a trace. */
    const CLIENT_REV = 'hardload-2'

    const DEV_WORDS = ['实现', '修复', '重构', '补测试', '开发', '写代码', '加功能', '改造', '迁移', 'feature', 'bug', 'refactor', 'fix', 'test']
    const HINT = '检测到开发任务，未开启主会话 skill 硬加载'
    const LABEL_ON = 'Skill 硬加载 开'
    const LABEL_OFF = 'Skill 硬加载 关'
    const ENABLE = '开启'
    const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

    /*
     * This page keeps no copy of the settings. The Host writes them to
     * `settings.json` beside the plugin and reads that file on every mount, so a
     * browser copy would only add a second source that can disagree with it —
     * which is one way "the default is on but a new session starts off" happens.
     * The page reads the Host on mount and posts the Host on save.
     */

    /** @param text - current composer draft. @returns whether it reads as a coding task. */
    function looksLikeDevTask(text) {
      const draft = String(text === undefined || text === null ? '' : text).toLowerCase()
      if (draft.trim().length === 0) return false
      return DEV_WORDS.some(function (word) { return draft.includes(word.toLowerCase()) })
    }

    /**
     * Resolve an API path against the site root the UI is served from.
     *
     * Two mistakes this must not make, both of which the composer chip surfaces
     * as a switch that never turns on:
     *   - `baseURI` is the current *page* URL (`.../session/<id>`), so a
     *     relative path resolves under that path, not under `/`;
     *   - a `.pathname` result drops the query string, which is where
     *     `sessionId` lives, so the state request answers 400.
     */
    function apiUrl(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      const origin = new URL(document.baseURI).origin
      const resolved = new URL(relative, origin + '/')
      return resolved.pathname + resolved.search
    }

    function getJson(path) {
      return fetch(apiUrl(path), { cache: 'no-store', credentials: 'same-origin' }).then(function (response) {
        return response.ok ? response.json() : undefined
      })
    }

    function postJson(path, body) {
      return fetch(apiUrl(path), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.ok ? response.json() : undefined
      })
    }

    function readState(sessionId) {
      return getJson(API + '/state?sessionId=' + encodeURIComponent(sessionId))
    }

    function writeState(sessionId, enabled) {
      return postJson(API + '/enable', { sessionId: sessionId, enabled: enabled })
    }

    /* ------------------------------------------------------------------ *
     * The composer chip
     * ------------------------------------------------------------------ */

    const rowStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      fontSize: '12px',
      lineHeight: '20px',
    }

    function chipStyle(enabled) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '0 8px',
        height: '24px',
        borderRadius: '999px',
        border: '1px solid ' + (enabled ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
        background: enabled ? 'var(--dsw-alias-button-info-fill)' : 'transparent',
        color: enabled ? 'var(--dsw-alias-label-primary-bluish)' : 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
    }

    function hintStyle() {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '0 8px',
        height: '24px',
        borderRadius: '999px',
        border: '1px dashed var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3))',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      }
    }

    function selectDraft(snapshot) {
      return snapshot.draft
    }

    function HardloadChip(props) {
      const sessionId = props.sessionId
      // `sessionId` is a standard prop of this toolbar list slot. A seat that
      // still arrives without one cannot reach the API, so it renders a
      // disabled chip instead of firing a request that would answer 400.
      const usable = typeof sessionId === 'string' && sessionId.length > 0
      // The host passes `useInput` only where the seat exposes a composer
      // draft. Its presence is fixed for the life of the seat, so this is a
      // constant branch rather than a conditional hook.
      const readDraft = props.useInput
      const draft = typeof readDraft === 'function' ? readDraft(selectDraft) : ''
      const [state, setState] = React.useState({ enabled: false, loaded: false, skill: '' })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(function () {
        if (!usable) return null
        let alive = true
        readState(sessionId).then(function (next) {
          if (!alive || next === undefined) return
          setState({ enabled: next.enabled === true, loaded: next.loaded === true, skill: String(next.skill || '') })
        }).catch(function () {})
        return function () { alive = false }
      }, [sessionId, usable])

      const toggle = React.useCallback(function (next) {
        if (!usable) return
        setBusy(true)
        writeState(sessionId, next).then(function (value) {
          if (value !== undefined) {
            setState({ enabled: value.enabled === true, loaded: value.loaded === true, skill: String(value.skill || '') })
          }
        }).catch(function () {}).then(function () { setBusy(false) })
      }, [sessionId, usable])

      // Session state carries its own skill name: renaming the skill in
      // settings leaves this session on the name it was opened with.
      const skill = state.skill || '该 skill'

      if (!usable) {
        return h('div', { className: 'dsh-skill-hardload', style: rowStyle },
          h('button', {
            type: 'button',
            'aria-pressed': false,
            disabled: true,
            title: '会话尚未就绪，暂时无法切换主会话 skill 硬加载',
            style: chipStyle(false),
          }, LABEL_OFF),
        )
      }

      if (state.enabled) {
        return h('div', { className: 'dsh-skill-hardload', style: rowStyle },
          h('button', {
            type: 'button',
            'aria-pressed': true,
            disabled: busy,
            title: state.loaded ? '已加载 ' + skill : '已开启；未加载前会拦截写文件与构建命令',
            onClick: function () { toggle(false) },
            style: chipStyle(true),
          }, LABEL_ON),
        )
      }

      if (looksLikeDevTask(draft)) {
        return h('div', { className: 'dsh-skill-hardload', style: rowStyle },
          h('span', { role: 'status', 'aria-live': 'polite', style: hintStyle() }, HINT),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: function () { toggle(true) },
            style: chipStyle(false),
          }, ENABLE),
        )
      }

      return h('div', { className: 'dsh-skill-hardload', style: rowStyle },
        h('button', {
          type: 'button',
          'aria-pressed': false,
          disabled: busy,
          onClick: function () { toggle(true) },
          style: chipStyle(false),
        }, LABEL_OFF),
      )
    }

    /* ------------------------------------------------------------------ *
     * The settings page
     * ------------------------------------------------------------------ */

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      padding: '14px 16px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2))',
      background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
    }

    function labelStyle() {
      return { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
    }

    function noteStyle(tone) {
      return {
        fontSize: '12px',
        lineHeight: '18px',
        color: tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
      }
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    }

    function switchStyle(on, disabled) {
      return {
        position: 'relative',
        flex: '0 0 auto',
        width: '38px',
        height: '22px',
        padding: 0,
        borderRadius: '999px',
        border: '1px solid ' + (on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
        background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-2)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }
    }

    function knobStyle(on) {
      return {
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-switch-thumb, #fff)',
        transition: 'left 120ms ease',
      }
    }

    function PrimaryButton(props) {
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          alignSelf: 'flex-start',
          padding: '6px 14px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-button-primary-fill)',
          background: 'var(--dsw-alias-button-primary-fill)',
          color: 'var(--dsw-alias-label-primary-inverted, #fff)',
          font: 'inherit',
          fontSize: '13px',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        },
      }, props.children)
    }

    function SettingsPage() {
      const [form, setForm] = React.useState({ skill: '', defaultEnabled: false })
      const [ready, setReady] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      React.useEffect(function () {
        let alive = true
        getJson(API + '/settings').then(function (value) {
          if (!alive) return
          if (value === undefined) {
            setNote('读取设置失败：宿主未响应')
            setReady(true)
            return
          }
          setForm({ skill: String(value.skill || ''), defaultEnabled: value.defaultEnabled === true })
          setReady(true)
        }).catch(function () {
          if (alive) setNote('读取设置失败')
        })
        return function () { alive = false }
      }, [])

      const skill = form.skill.trim()
      const valid = SKILL_NAME_RE.test(skill)

      const save = React.useCallback(function () {
        setBusy(true)
        setNote('')
        postJson(API + '/settings', { skill: skill, defaultEnabled: form.defaultEnabled })
          .then(function (value) {
            if (value === undefined) {
              setNote('保存失败：宿主未接受。名称需为小写 kebab-case（字母、数字、- . _）')
              return
            }
            // `persisted` is the Host's own report that the file now holds this
            // value. Without it the page could claim success for a setting that
            // reverts on the next restart, which is what used to happen.
            setNote(value.persisted === false
              ? '已生效，但写入 settings.json 失败：本次运行有效，重启后会回到配置默认值。'
              : '已保存到 settings.json。之后新建的会话按此默认值；已打开的会话保持它们自己的状态。')
          })
          .catch(function () { setNote('保存失败：无法连接宿主') })
          .then(function () { setBusy(false) })
      }, [skill, form.defaultEnabled])

      if (!ready && note === '') {
        return h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, '加载中…')
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '560px', padding: '4px 0' } },
        h('div', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
          '主会话开启后，本会话的第一次请求会先要求加载指定的 skill；在它加载成功之前，写文件、构建命令与会改动工作区的 run_code 都会被拦下。'),

        h('div', { style: cardStyle },
          h('label', { style: labelStyle(), htmlFor: 'dsh-skill-hardload-skill' }, '硬加载的 Skill 名'),
          h('div', { style: noteStyle() }, '写 skills 目录名，例如 main-agent-orchestrator。校验规则：小写字母或数字开头，可含 - . _，最长 64。'),
          h('input', {
            id: 'dsh-skill-hardload-skill',
            type: 'text',
            value: form.skill,
            placeholder: 'main-agent-orchestrator',
            spellCheck: false,
            autoComplete: 'off',
            disabled: busy,
            onChange: function (event) {
              const next = event.target.value
              setForm(function (prev) { return { skill: next, defaultEnabled: prev.defaultEnabled } })
              setNote('')
            },
            style: Object.assign({}, inputStyle, valid ? null : { borderColor: 'var(--dsw-alias-state-error-primary)' }),
          }),
          h('div', { style: noteStyle(valid ? undefined : 'warn'), role: 'status', 'aria-live': 'polite' },
            valid ? '' : (skill.length === 0 ? '不能为空。' : '名称不合法。')),
        ),

        h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: labelStyle() }, '新会话默认开启'),
              h('div', { style: noteStyle() }, '只作为新建会话的初值；已打开的会话保持它们自己的开关。'),
            ),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': form.defaultEnabled,
              'aria-label': '新会话默认开启 Skill 硬加载',
              disabled: busy,
              onClick: function () {
                const next = !form.defaultEnabled
                setForm(function (prev) { return { skill: prev.skill, defaultEnabled: next } })
                setNote('')
              },
              style: switchStyle(form.defaultEnabled, busy),
            }, h('span', { style: knobStyle(form.defaultEnabled) })),
          ),
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h(PrimaryButton, { disabled: busy || !ready || !valid, onClick: save }, busy ? '保存中…' : '保存'),
          h('div', { style: noteStyle(), role: 'status', 'aria-live': 'polite' }, note),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Nothing to restore here: the Host reads `settings.json` when it mounts,
        // so the page no longer pushes a browser copy into it. Pushing one would
        // let a stale tab overwrite a newer save.

        // `register` takes a render function, not a component: the host calls it
        // with the seat props and renders the result. Handing over the component
        // itself would run its hooks outside React and throw, which surfaces as
        // a seat that silently never appears.
        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register({
            name: SLOT,
            id: 'skill-hardload',
            order: ORDER,
            label: 'Skill 硬加载',
          }, function (seat) {
            // `sessionId` and `useInput` are standard props of every list slot
            // in this toolbar; the seat reads them directly. The chip still
            // degrades when a seat arrives without a session id.
            return h(HardloadChip, { sessionId: seat.sessionId, useInput: seat.useInput })
          })
        })

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'skill-hardload',
            order: SETTINGS_ORDER,
            label: 'Skill 硬加载',
          }, function () {
            return h(SettingsPage)
          })
        })
      },
    }
  },
})
