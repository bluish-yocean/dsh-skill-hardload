import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SKILL,
  blockedText,
  isBuildCommand,
  isGuardedExecution,
  isMainSession,
  isMutatingRunCode,
  isSkillLoad,
  isSkillName,
  rulesText,
} from '../lib/guard.js'

test('only a main session carries the rule', () => {
  assert.equal(isMainSession('session-654dba9f-aae2-46fe-96f4-47bcc6f280ce'), true)
  assert.equal(isMainSession('654dba9f-aae2-46fe-96f4-47bcc6f280ce'), false, 'a subagent id is a bare uuid')
  assert.equal(isMainSession('session-'), true, 'the prefix is the whole test; the Host owns the rest')
  assert.equal(isMainSession(''), false)
  assert.equal(isMainSession(undefined), false)
})

test('write and edit are guarded', () => {
  assert.equal(isGuardedExecution('write', { file_path: 'a.txt' }), true)
  assert.equal(isGuardedExecution('edit', { file_path: 'a.txt' }), true)
})

test('non-mutating tools pass through', () => {
  assert.equal(isGuardedExecution('read', { file_path: 'a.txt' }), false)
  assert.equal(isGuardedExecution('write', undefined), true)
  assert.equal(isGuardedExecution('grep', { pattern: 'x' }), false)
})

test('build-ish shell calls are guarded, plain inspection is not', () => {
  assert.equal(isGuardedExecution('bash', { command: 'pnpm test' }), true)
  assert.equal(isGuardedExecution('bash', { command: 'npm run build' }), true)
  assert.equal(isGuardedExecution('bash', { command: 'npx tsc -p .' }), true)
  assert.equal(isGuardedExecution('bash', { command: 'cargo test --all' }), true)
  assert.equal(isGuardedExecution('bash', { command: 'go test ./...' }), true)
  assert.equal(isGuardedExecution('bash', { command: 'pytest -q' }), true)
  assert.equal(isGuardedExecution('pwsh', { command: 'Get-ChildItem' }), false)
  assert.equal(isGuardedExecution('bash', { command: 'ls -la' }), false)
  assert.equal(isGuardedExecution('bash', {}), false)
})

test('run_code is guarded when its program mutates the workspace', () => {
  assert.equal(isGuardedExecution('run_code', { code: 'await tools.write({ file_path: "a", content: "" })' }), true)
  assert.equal(isGuardedExecution('run_code', { code: "await tools['edit']({})" }), true)
  assert.equal(isGuardedExecution('run_code', { code: 'await tools.pwsh({ command: "Get-ChildItem" })' }), true)
  assert.equal(isGuardedExecution('run_code', { code: 'const fs = await import("node:fs"); fs.writeFileSync("a", "")' }), true)
  assert.equal(isGuardedExecution('run_code', { code: 'const { spawn } = await import("node:child_process"); spawn("x")' }), true)
})

test('run_code inspection passes through', () => {
  assert.equal(isGuardedExecution('run_code', { code: 'return await tools.read({ file_path: "a.txt" })' }), false)
  assert.equal(isGuardedExecution('run_code', { code: 'const x = 1 + 1; return x' }), false)
  assert.equal(isGuardedExecution('run_code', { code: '\n   \n' }), false)
  assert.equal(isGuardedExecution('run_code', undefined), false)
  assert.equal(isMutatingRunCode(undefined), false)
})

test('a quoted mention of a tool name does not trip the guard', () => {
  assert.equal(isBuildCommand('echo "npm is great"'), false)
  assert.equal(isBuildCommand('echo npm'), true)
  assert.equal(isBuildCommand('cat package.json'), false)
})

test('skill load matches the forced skill by name', () => {
  assert.equal(isSkillLoad('skill', { name: DEFAULT_SKILL }), true)
  assert.equal(isSkillLoad('skill', { name: DEFAULT_SKILL }), true, 'the default still matches with no third argument')
  assert.equal(isSkillLoad('skill', { name: 'other' }), false)
  assert.equal(isSkillLoad('skill', undefined), false)
  assert.equal(isSkillLoad('read', { name: DEFAULT_SKILL }), false)
})

test('a configured skill name replaces the default', () => {
  assert.equal(isSkillLoad('skill', { name: 'my-orchestrator' }, 'my-orchestrator'), true)
  assert.equal(isSkillLoad('skill', { name: DEFAULT_SKILL }, 'my-orchestrator'), false)
})

test('skill names are directory names, never paths', () => {
  assert.equal(isSkillName('main-agent-orchestrator'), true)
  assert.equal(isSkillName('a'), true)
  assert.equal(isSkillName('v2.orchestrator_runner'), true)
  assert.equal(isSkillName(''), false)
  assert.equal(isSkillName('Main'), false, 'upper case is not a skill directory name')
  assert.equal(isSkillName('-lead'), false, 'must start with a letter or digit')
  assert.equal(isSkillName('a/b'), false)
  assert.equal(isSkillName('../escape'), false)
  assert.equal(isSkillName('x'.repeat(65)), false)
  assert.equal(isSkillName(undefined), false)
})

test('the injected rule and the denial both name the configured skill', () => {
  assert.match(rulesText('foo'), /skill foo/)
  assert.match(blockedText('foo'), /skill foo/)
  assert.match(rulesText(DEFAULT_SKILL), new RegExp(DEFAULT_SKILL))
})
