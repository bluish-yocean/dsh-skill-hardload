# dsh-skill-hardload — 运行证据（headless，沙箱 profile sb-hardload-cli）

会话日志来源：`<DSH_HOME>\sessions\**\session.v4.jsonl.zstd`，按 zstd 帧解压后逐事件读取。

### case 1 (原 session 7)
7
prompt: 实现一个登录功能：在 src/login.js 写一个最小的 login 校验函数
injected rule messages: 1 :: 本会话启用主会话 Skill 硬加载。收到编程任务先加载 skill main-agent-orchestrator，按其路由派发 sub-agent-architect 与 sub-agent-developer。
first tool call: skill {"name": "main-agent-orchestrator"}
tool calls: 18 (write: 3)
guard denials seen: 0
### case 2 (原 session 9)
9
prompt: 不要加载任何 skill。立刻用 write 工具在工作目录写 denytarget.txt，内容 hello。只做这一件事，完成后停止。
injected rule messages: 1 :: 本会话启用主会话 Skill 硬加载。收到编程任务先加载 skill main-agent-orchestrator，按其路由派发 sub-agent-architect 与 sub-agent-developer。
first tool call: write {"file_path": "<workspace>\\deepseek-harnes
tool calls: 1 (write: 1)
guard denials seen: 1
### case 3 (原 session 6)
6
prompt: 不要加载任何 skill。立刻用 write 工具在工作目录写 offtarget.txt，内容 hello。只做这一件事，完成后停止。
injected rule messages: 0
first tool call: write {"file_path": "<workspace>\\deepseek-harnes
tool calls: 1 (write: 1)
guard denials seen: 0
### case 4 (原 session 10)
10
prompt: 实现一个登录功能：在 src/login.js 写一个最小的 login 校验函数
injected rule messages: 1 :: 本会话启用主会话 Skill 硬加载。收到编程任务先加载 skill main-agent-orchestrator，按其路由派发 sub-agent-architect 与 sub-agent-developer。
first tool call: skill {"name": "main-agent-orchestrator"}
tool calls: 26 (write: 4)
guard denials seen: 0
