# dsh-skill-hardload

会话级开关：开启后本会话强制先加载指定的主会话技能（默认 `main-agent-orchestrator`）；未加载前拦截写文件与构建命令。设置页可改技能名与新会话的默认开关。

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半侧：会话 flag、`agent/pre-step` 注入、`tools/pre-execute` 守卫并就地识别加载、`tools/post-execute` 兜底记录、三条 HTTP 路由、`settings.json` 读写 |
| `lib/guard.js` | 纯策略：技能名规则、注入/拒绝文案、哪些调用受守卫、什么算命中技能加载 |
| `client/client.js` | 浏览器半侧：`window.__ModuleLoader__` 工厂，注册 `conversation.input.right` 的 chip 与 `settings.section` 的设置页；不存设置，全部走宿主 |
| `cordis.patch.yml` | bundle patch，插入插件行 |
| `test/` | 43 条用例（守卫策略 10 + 宿主 import 白名单 3 + 宿主路由/注入/持久化 17 + 客户端两个座位 13） |
| `settings.json` | 运行时由本插件写的设置文件（首次保存时出现），优先级高于 `config:` |
| `evidence/` | 沙箱实测截图与证据说明 |

## 接口

- `GET  /dsh-skill-hardload/api/state?sessionId=<id>` → `{ enabled, loaded, skill }`（`skill` 是该会话自己生效的名字）
- `POST /dsh-skill-hardload/api/enable` body `{ sessionId, enabled }` → 同上
- `GET  /dsh-skill-hardload/api/settings` → `{ defaultEnabled, skill }`
- `POST /dsh-skill-hardload/api/settings` body `{ defaultEnabled?, skill? }` → `{ defaultEnabled, skill, saved, persisted }`
  - 保存语义：只改默认值，然后写 `settings.json`；**不动任何已有会话**。
  - `persisted` 是宿主对「文件此刻确实持有这组值」的报告。`false` 表示本次运行有效、重启会回到 `config:` 默认值——页面据它提示，而不是假装成功。
- `GET  /dsh-skill-hardload/api/trace` → `{ settingsPath, tracePath, lines }`：最近 40 条状态决策（哪个 sessionId 取了什么值、由 seed 还是既有状态），见「诊断」。
- 配置（patch 层，只作为**首次运行**的种子）：`defaultEnabled`（默认 `false`）、`defaultSkill`（默认 `main-agent-orchestrator`，非法名回退默认）、`settingsPath`（可选，改设置文件位置；默认是本包旁的 `settings.json`）。
- 优先级：`settings.json` > `config:`。每次 `apply` 先按 `config:` 播种，再用文件覆盖——重启不会把用户保存的值抹掉。

## 语义

两层状态，刻意分开：

- **设置**（每 profile 一份）：默认开关 + 强制技能名，由宿主写进 `settings.json` 并在每次挂载时读回；页面只读宿主、只写宿主，不留副本。
- **会话**（每 session 一份）：首次见到该会话时把当时的开关、技能名、`loaded` 一起快照。

因此：改默认值只影响**本插件还没见过的会话**，且不需要重启 dsh（内存态在同一个 POST 内更新）。已经有状态的会话保持自己的开关与自己的技能名。改名后，已经被告知加载旧名的会话仍认旧名（否则它的规则与守卫会互相矛盾而死锁）。

**不要**在保存时按 `agents.list()` 去「冻结已打开会话」。那份列表里同时有用户尚未打开的空会话与预备记录，把它们钉在旧默认值上，正好会让下一次「新建会话」读到旧值、把 composer 开关显示成关——这就是「设置明明存成开、新会话却是关」的来源。`agents` 服务因此不再被注入。

`loaded` 在调用 `skill(<本会话的技能名>)` 的 **pre-execute** 阶段就置位，`post-execute` 只作兜底。原因是守卫拿不到 `loaded` 时会把会话锁死，而用户唯一的自救手段（改插件再重载）恰好也要写文件——那也会被拦。

## 启用

### 从 GitHub 安装

```sh
dsh plugin --profile <name> add github:bluish-yocean/dsh-skill-hardload
dsh web --profile <name> --port <port>
```

`dsh plugin add` 会把包名追加进该 profile 的 `dsh.profile.bundles`，patch 层随即生效；`dsh --profile <name> --dump-config` 里应出现 `# == dsh-skill-hardload`。

本包**不需要** git 安装的构建授权（`allowBuilds`）：包里没有 `prepare` / `install` / `postinstall` 脚本，`lib/` 与 `client/` 都是随仓库提交的 ESM 源码，没有构建步骤；宿主半侧只 import `node:*`。也就是说 pnpm 在安装期无事可跑。

要固定版本，用 tag 或 commit：`github:bluish-yocean/dsh-skill-hardload#v0.0.1`。

安装形态下 `settings.json` 写在**包目录旁**，而 git 依赖的包目录位于 pnpm store：`pnpm store prune` 或重装会把它清掉，此时设置回落 `config:` 默认值。要让它稳定，用 patch 层把 `settingsPath` 指到固定位置：

```yaml
- id: skill-hardload
  name: dsh-skill-hardload
  config:
    settingsPath: <profile 目录>/skill-hardload.settings.json
```

### 从本地目录安装（开发）

1. 把本目录挂进 profile（开发用 `link:`，或 `dsh plugin --profile <name> add file:<绝对路径>`）：

```json
{
  "dependencies": { "dsh-skill-hardload": "link:<绝对路径>/dsh-skill-hardload" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-skill-hardload"] } }
}
```

2. 在 profile 目录 `pnpm install`（或手工把目录联接建到 `node_modules/dsh-skill-hardload`）。
3. 重启该 profile 的 dsh：`dsh web --profile <name> --port <port>`。
4. patch 层可覆盖默认值：

```yaml
- id: skill-hardload
  name: dsh-skill-hardload
  config:
    defaultEnabled: false
    defaultSkill: main-agent-orchestrator
```

## 手动验收（GUI）

1. 打开 `dsh web` 打印的 `?token=` URL。
2. 进入任一会话：composer 工具栏、模型选择器左侧应出现 `Skill 硬加载 关`。
3. 在输入框输入「实现一个登录功能」：同一位置变为「检测到开发任务，未开启主会话 skill 硬加载」+「开启」。
4. 点「开启」：变为 `Skill 硬加载 开`；此时模型的第一动作应是 `skill(<配置的技能名>)`。
5. 再次点击关闭：不再注入、不再拦截。
6. 侧栏底部「设置」→ 最后一页「Skill 硬加载」：可改技能名、拨「新会话默认开启」，点保存后提示「已保存到 settings.json。之后新建的会话按此默认值；已打开的会话保持它们自己的状态。」（若文件写不进去，提示会明说「重启后会回到配置默认值」）
7. 保存后**新建**会话：默认应已是新值，无需重启 dsh；原会话的 chip 不变。
8. 重启 dsh 后再打开设置页：值仍在（读的是 `settings.json`，不是浏览器缓存）。

## 座位与实测几何

chip 座位由 `client/client.js` 顶部两个常量决定，换座位只改这两行：

```js
const SLOT = 'conversation.input.right'
const ORDER = 100
```

实测（沙箱 `sb-hardload`，1280×720，draft composer）：`conversation.input.right` 渲染在模型选择器**左侧**，同一 `standardControls` 行内 chip 在前，所以不需要回退。

| 元素 | 选择器 | x | y | w | h |
|---|---|---|---|---|---|
| chip | `div.dsh-skill-hardload` | 857 | 432 | 94 | 24 |
| 模型选择器 | `button._9r0rkG_trigger`（文案 `Select model`） | 962 | 430 | 104 | 28 |

chip 右边界 951，模型选择器左边界 962，间隔 11px。若未来版式把该座位排到模型选择器右侧，把 `SLOT` 改为 `conversation.input.left`、`ORDER` 抬到该组最大值（簇内最大 order 落在最右，即紧邻模型选择器之前）即可。

设置页是独立的 `settings.section` 条目（`id: skill-hardload`，`order: 440`），和 `save-token`（430）、`permissions`（30）同一套机制。

证据文件：

- `evidence/g2-sandbox-boot.md`：`link:` 挂载下宿主半侧加载（日志 + `--dump-config`）
- `evidence/sb-toolbar.png`：chip 与 `Select model` 同排（关态）
- `evidence/sb-chip-on.png`：点一次后文案变 `Skill 硬加载 开`
- `evidence/sb-chip-off.png`：再点一次复原 `关`

## 诊断

chip 显示的值来自 `GET /api/state`，守卫用的值来自 `agent/pre-step` / `tools/pre-execute` 里的 `agent.id`。两侧只要不是同一个 SessionId，就各看一份状态：页面显示一个值、守卫握着另一个，而且谁也不报错。

`GET /dsh-skill-hardload/api/trace` 列出最近 40 条决策（`seed <id> -> enabled=…`、`GET state <id> -> …`、`POST enable …`、`POST settings …`），用来对齐这两侧。日志写在 `settings.json.trace.log`（与设置文件同目录），超过 400 行自动截断。

页面不跟随插件更新时，trace 里**只有宿主自己的 `seed` 行、没有 `GET state` 行**：浏览器那半侧没在请求，得刷新页面。

## 已知边界

- 设置持久化在宿主侧：本包旁（`lib/../settings.json`）的 JSON 文件，`apply` 每次读回，优先级高于 `config:`。写入用「临时文件 + rename」替换，崩在中间也不会留下半截文件；`persisted: false` 说明写失败（目录只读、磁盘满等），此时本次运行仍生效、重启回落 `config:`。**不使用浏览器 `localStorage`**：那份副本没有权威性，只会与宿主产生分歧，正是「开关设成开会话却是关」的一类来源。
- 该路径能写的前提是挂载方式让 `import.meta.url` 指向真实目录（`link:` 与 `file:` 安装都是）。若插件被打进 asar 或只读镜像，写入会失败——`persisted: false` 会如实报告，而不是静默丢设置。
- 会话 flag 是插件内存状态（`Map<sessionId, state>`），宿主重启或插件重载即回到当时的默认值；不写会话日志。
- 守卫只覆盖**主会话**（`isMainSession`：SessionId 以 `session-` 开头）。子代理会话的 id 是裸 uuid，既不注入规则也不拦截：子代理要加载的是它自己的 skill（不是编排技能），而且它必须写被派发的文件，拦下去会把每次派发锁死。这条读的是宿主的 id 命名约定；宿主改命名时守卫退化成「永不拦截」，不是「永远拦截」。
- 守卫覆盖：`write`/`edit` 恒拦；`bash`/`pwsh` 的构建类命令（npm、pnpm、npx、cargo、go test、pytest 等前缀）；`run_code` 中调用写类工具（`tools.write`、`tools.pwsh` …）或 Node 写盘/起进程 API（`writeFileSync`、`spawn` …）。三者都是文本匹配，不是 shell 或 JS 解析器，误判方向偏向「多拦一次」。
- 天花板：`pwsh`/`bash` 里的写文件（`Set-Content`、`> file`）未被识别——判定以「构建命令」为准，不追写操作。要闭合这条，得把 `isBuildCommand` 换成「任意外部副作用」判定，代价是只读命令也会被要求先加载技能。
- `run_code` 的写盘判断停在文本层：动态拼接（`tools['wr' + 'ite']`）或 eval 出来的调用可绕过。真正的闸门应是宿主能力级（未加载技能时禁用写类工具），不是文本匹配。
- 设置页**不判断技能是否存在**：宿主级 `skills.list()` 只含内置技能，用户级 `skills/` 下的名字在那里看不到，据此报警只会误报。名字打错会在模型第一次 `skill(...)` 时暴露。
- 「已打开会话」的边界：本插件**不查询** `agents.list()`。一个会话在它第一次到达本插件（`agent/pre-step` 或 `/api/state`）时取当时默认值并固定；此后再保存默认值都不影响它。所以「已打开」= 已经有过一次请求，而不是「宿主内存里有记录」——后者把空会话也算进去了。
- 只使用 `react` 一个宿主模块，不依赖 `@deepseek-ai/dsh-client-ui-primitives`。
- `slots.register(meta, render)` 的第二个参数是**渲染函数** `seat => ReactNode`，不是 React 组件。传组件本身会让它的 hooks 在 React 之外执行并抛错，表现为该座位静默不出现。座位 props 由宿主给（`sessionId`、`useInput`）；`settings.section` 的 owner props 只有 `close`，本页不用。
- 座位拿不到 `useInput`（该槽位不暴露草稿）时降级为只显示「关」按钮，不做开发任务检测；`useInput` 的有无在座位整个生命周期内固定，因此分支不构成条件调用 hook。
- `dsh.client.inject` 是**客户端 row 依赖边**（必须先行物化的其它包 `client.js` 行），不是 cordis 服务注入；写成没有 `dsh.client` 声明的包名，本行永远等不到对方 factory 而不物化，`apply` 不执行、UI 静默缺失。服务注入写在 factory 返回值的 `inject` 里（`['slots']`）。
- **`link:` 挂载下宿主半侧的 import 白名单**：只允许 `node:*` 与 `./guard.js`（当前实际是 `node:crypto`、`node:fs`、`node:url`）。`link:` 把包解析到 profile 之外的 realpath，Node 在 realpath 旁找依赖，profile 的 `node_modules` 不在那条路径上，任何裸 `@deepseek-ai/*` 会在 import 期抛 `ERR_MODULE_NOT_FOUND`：整行 `inactive`、client 永不下发、chip 静默不出现。`boundContextSummary` / `createUserMessage` 因此在本目录内本地复刻（等价形状：uuid id、role `user`、deep freeze）。闸门为 `test/source.test.mjs`（支持跨行 `import {} from`），故意加一条 `@deepseek-ai/*` import 会变红。
- `sessionId` 与 `useInput` 是 `conversation.input.left/right` 的**标准 slot props**（`Slots.listSubTree` 的 `standardProps`），座位直接读，注册项不需要 `inject` 桥；缺 `sessionId` 时仍保留禁用态兜底（`disabled` 按钮，不发请求）。
- 设置页的表单校验只在两端做「目录名」检查（`^[a-z0-9][a-z0-9._-]{0,63}$`），不接受路径分隔符与 `..`，因此手改 `settings.json` 也写不出越权路径（宿主读回时同样按这条规则校验，不合法的整份忽略）。
- 客户端相对路径拼接必须以站点根（`origin + '/'`）为基准并保留 query：页面 URL 是 `/session/<id>`，用 `document.baseURI` 直接解析会落到 `/session/...`，而只取 `.pathname` 会丢掉 `?sessionId=`——两者都会让 `/api/state` 返回 400，chip 静默停在「关」。闸门在 `test/client.test.mjs` 的「the chip asks the host for its own session, under the site root」。
