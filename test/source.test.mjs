/**
 * Import whitelist of the host half.
 *
 * A profile that mounts this package with `link:` resolves the plugin to a real
 * path outside the profile, so Node resolves its dependencies beside that real
 * path and never inside the profile's `node_modules`. One bare
 * `@deepseek-ai/*` import therefore kills the host half at import time, and the
 * chip never appears. These cases are the gate for that rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

/** Static import with a `from` clause, possibly spanning lines. */
const STATIC_IMPORT_FROM = /^[ \t]*import\b[\s\S]*?from\s*['"]([^'"\n]+)['"]/gm

/** Side-effect static import: `import 'specifier'`. */
const STATIC_IMPORT_BARE = /^[ \t]*import\s+['"]([^'"\n]+)['"]/gm

/** Dynamic import with a literal specifier: `import('specifier')`. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g

function specifiers(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1])
}

/** Every static specifier in one source text. */
function staticSpecifiers(source) {
  return [...specifiers(source, STATIC_IMPORT_FROM), ...specifiers(source, STATIC_IMPORT_BARE)]
}

const allowed = (specifier) => specifier.startsWith('node:') || specifier === './guard.js'

test('lib/index.js imports only node: builtins and ./guard.js', () => {
  const found = staticSpecifiers(read('../lib/index.js'))
  assert.ok(found.includes('./guard.js'), 'the guard module is still imported')
  assert.ok(found.some((specifier) => specifier.startsWith('node:')), 'a node: builtin is imported')
  for (const specifier of found) {
    assert.ok(allowed(specifier), 'not importable under a link: mount: ' + specifier)
  }
})

test('lib/index.js has no dynamic import outside the whitelist', () => {
  for (const specifier of specifiers(read('../lib/index.js'), DYNAMIC_IMPORT)) {
    assert.ok(allowed(specifier), 'not importable under a link: mount: ' + specifier)
  }
})

test('lib/guard.js stays dependency free', () => {
  assert.deepEqual(staticSpecifiers(read('../lib/guard.js')), [])
})
