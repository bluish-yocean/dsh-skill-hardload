# G2 沙箱证据：`link:` 挂载下宿主半侧加载

沙箱 profile：`sb-hardload`（`DSH_HOME` 指向 workspace 内的 `.sb-home`，因为 `%USERPROFILE%\.dsh\profiles` 在文件沙箱外不可写；profile 内容与主力完全隔离，未触碰 `desktop`）。

挂载方式（等价于 `link:`）：`node_modules/dsh-skill-hardload` 是指向本插件目录的 Junction，`package.json` 里 `"dsh-skill-hardload": "link:<本目录>"`，bundle 列表含 `dsh-skill-hardload`。

启动命令：

```powershell
$env:DSH_HOME = "<workspace>\.sb-home"
dsh --profile sb-hardload --port 3181 --no-open
```

启动日志（节选）：

```text
dsh web: http://127.0.0.1:3181/?token=<token>
```

- 无 `dsh: skipping profile bundle "dsh-skill-hardload"`
- 无 `ERR_MODULE_NOT_FOUND` / import 报错
- `dsh --profile sb-hardload --dump-config` 里出现本插件行：

```yaml
# == dsh-skill-hardload
- id: skill-hardload
  name: dsh-skill-hardload
```

宿主半侧 `apply` 确实执行（`apply` 第一步写 boot 文件）：

```json
{
  "at": "2026-10-25T06:27:09.147Z",
  "pid": 1776,
  "applied": true,
  "webServer": true,
  "defaultEnabled": false
}
```

`applied: true` 证明 `apply` 跑到；`webServer: true` 证明 `scoped.webServer.register` 的两条路由注册成功。

修复前同一 profile 的表现是：`Config.listConfigs` 该行 `inactive`、boot 文件不存在、`import('dsh-skill-hardload')` 抛 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'`。
