/**
 * Pure policy of dsh-skill-hardload: which skill the switch forces, which
 * executions it guards, and which call counts as loading that skill.
 *
 * The skill name is a setting, not a constant: the host half reads it from the
 * settings page and passes it in. `DEFAULT_SKILL` is only the fallback for a
 * deployment that never opened the page.
 */

/** The skill forced when no setting names one. */
export const DEFAULT_SKILL = 'main-agent-orchestrator'

/**
 * @param value - candidate skill name, as typed in the settings page.
 * @returns whether it is a legal skill directory name: kebab-case, at most 64
 *   characters, no path separator and no traversal.
 */
export function isSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

/**
 * @param sessionId - the caller agent's id.
 * @returns whether that id belongs to a main session rather than a subagent.
 *
 * A main session's id is `session-<uuid>` — the same shape the session store
 * uses for its directory — while a subagent session carries a bare uuid. The
 * switch is a *main session* rule: a subagent is never locked out, because it
 * cannot satisfy the rule (it loads its own skill, never the orchestrator one)
 * and still has to write files, which would deadlock every delegation.
 *
 * This reads the Host's id convention, so a Host release that renames sessions
 * would make every session look like a subagent: `test/guard.test.mjs` pins the
 * convention, and the switch degrades to "never blocks" rather than to
 * "always blocks".
 */
export function isMainSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('session-')
}

/**
 * @param skill - the configured skill name.
 * @returns the one-line rule injected on the first turn of an enabled session.
 */
export function rulesText(skill) {
  return '本会话启用主会话 Skill 硬加载。收到编程任务先加载 skill ' + skill + '，'
    + '按其路由派发 sub-agent-architect 与 sub-agent-developer。'
}

/**
 * @param skill - the configured skill name.
 * @returns the denial reason shown until that skill is loaded.
 */
export function blockedText(skill) {
  return '先加载 skill ' + skill + '（本会话已开启 Skill 硬加载），再执行写文件或构建命令。'
}

/**
 * Build-ish command prefixes. The guard is a prefix check on the command
 * text, not a shell parser: a quoted mention still trips it, which errs
 * toward asking the model to load the skill first.
 */
const BUILD_RE = /(?:^|[\s;&|()])(?:npm|pnpm|yarn|npx|cargo|make|mvn|mvnw|gradle|gradlew|tsc|vitest|jest|pytest|tox|dotnet\s+(?:build|test)|go\s+(?:test|build|vet)|python\s+-m\s+pytest)(?=$|[\s;&|()])/i

/**
 * @param command - the raw shell command text, when the tool has one.
 * @returns whether the command looks like a build, test or install run.
 */
export function isBuildCommand(command) {
  return typeof command === 'string' && BUILD_RE.test(command)
}

/**
 * Tools that write the workspace or run a process when they are reached from
 * inside a `run_code` program. `run_code` is the one tool that can touch the
 * workspace without passing through the tool arguments the other guards read,
 * so the program text itself is checked.
 */
const MUTATING_TOOLS = new Set(['write', 'edit', 'bash', 'pwsh', 'apply_patch'])

/** `tools.write(...)` and `tools['write'](...)` call shapes. */
const TOOL_CALL_RE = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*\(/g

/**
 * Node APIs a program would call to skip the tool layer entirely. The mismatch
 * direction is deliberate: a quoted mention trips the guard, which only asks
 * the model to load the skill first.
 */
const NODE_WRITE_RE = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|mkdirSync|spawn|spawnSync|execSync|execFileSync)\s*\(/

/**
 * @param code - the `code` argument of a `run_code` call.
 * @returns whether the program looks like it writes the workspace or spawns a
 *   process. This is a text check, not a JavaScript parser.
 */
export function isMutatingRunCode(code) {
  if (typeof code !== 'string') return false
  if (NODE_WRITE_RE.test(code)) return true
  for (const match of code.matchAll(TOOL_CALL_RE)) {
    if (MUTATING_TOOLS.has(match[1] ?? match[2])) return true
  }
  return false
}

/**
 * @param toolName - the registered tool name.
 * @param args - the frozen validated arguments of that call.
 * @returns whether the switch refuses this call until the skill is loaded.
 */
export function isGuardedExecution(toolName, args) {
  if (toolName === 'write' || toolName === 'edit') return true
  if (toolName === 'bash' || toolName === 'pwsh') return isBuildCommand(args?.command)
  if (toolName === 'run_code') return isMutatingRunCode(args?.code)
  return false
}

/**
 * @param toolName - the registered tool name.
 * @param args - the frozen validated arguments of that call.
 * @param skill - the skill the switch is forcing right now.
 * @returns whether this call loads that skill successfully.
 */
export function isSkillLoad(toolName, args, skill = DEFAULT_SKILL) {
  return toolName === 'skill' && args?.name === skill
}
