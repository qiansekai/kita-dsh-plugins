# kita-dsh-restart

浏览器里一键重启 dsh web。补官方缺口：设置 →「插件列表」是**只读投影**，没有任何重启入口，
而 host 侧插件与配置改动必须重启进程才生效。

## 为什么不能由 dsh 自己重启

按钮的请求方就是要被杀死的那个进程。本机 dsh 跑在 Windows Job Object 内，它 spawn 的子进程
会落在同一个 job 里（`DSH-SETUP.md` 的「远程启动必须 exec -detach，否则进程挂 agent 的 Job
Object 随任务终结被杀」是同一机制；实测 `IsProcessInJob(dsh) => True`）。

所以重启委托给一个**按需计划任务**：进程由 Task Scheduler 服务启动，位于 dsh 的进程树与 job
之外，因而能活过它自己执行的那次 kill。

## 组成

| 文件 | 职责 |
|---|---|
| `lib/index.js` | host：注册 `/kita-restart/{run,status}`、幂等注册计划任务、触发 `/Run` |
| `lib/client.js` | client：`sidebar.footer.action` 按钮 + `shell.overlay` **屏幕居中**确认/进度模态（遮罩点击或 Esc 取消；入场/出场动画，遵循 `prefers-reduced-motion`） |
| `scripts/restart-dsh.ps1` | 计划任务动作：延迟 → 调部署自带的 `start.ps1` |

`restart-dsh.ps1` **不重复实现**停旧起新：它调部署自己的 `start.ps1`（停占用端口的实例、清
孤儿 `.credentials.yaml.lock`、起新实例、捕获 launch token、等端口 LISTEN）。重启流程单一数据源。

它用 `Start-Process` + **文件重定向**运行 `start.ps1`，**绝不用管道**：`start.ps1` 起的 dsh 会继承
父进程的句柄，管道要一直开到 dsh 退出为止 —— 任务实例于是永远停在 `Status=Running`，而
`MultipleInstancesPolicy=IgnoreNew` 会让之后每次 `/Run` 静默失效，**按钮一次即废**（2026-09-18
实测踩到，并用「旧脚本挂起 / 新脚本正常」的对照实验复现与验证）。任务另有 `ExecutionTimeLimit=PT5M`
兜底，host 侧遇 `/Run` 失败会先 `/End` 再重试。

## 计划任务

- 名称 `kita-dsh-restart`（`config.taskName` 可改）。
- `<Triggers />` **为空 —— 纯手动 `/Run`**。绝不设定时触发器：那会按自己的时钟重启生产。
- `RunLevel=HighestAvailable` + `LogonType=InteractiveToken`：重启后的 dsh 与重启前一样是提权
  进程（本机实测当前 dsh 为 High Mandatory Level）。现有 `dsh-web-autostart` 任务没有
  `RunLevel`（默认 LeastPrivilege），**直接复用它会把 dsh 降权**，computer use 之类能力随之退化。
- 动作参数（端口、dsh-envs 目录、node 目录、日志路径、pwsh 路径）全部由插件从**运行中的进程**
  推导（端口取 `ctx.webServer.port`，node 目录取 `dirname(process.execPath)`，envs 目录取
  home 上两级），脚本与插件里都没有机器专属常量。

## 路由

| 路由 | 行为 |
|---|---|
| `POST /kita-restart/run` | 触发重启任务；60 秒冷却；跨站请求拒绝 |
| `GET /kita-restart/status` | `bootId` / phase / 任务健康度 / 上次请求 |

CSRF：dsh 的 loopback 载体自身不鉴权，而 LAN 侧由 kita-dsh-gateway 的配对鉴权兜底，所以本插件
在 handler 里拒绝 `Sec-Fetch-Site: cross-site`、以及 `Origin` 与 `Host` 不同源的请求 —— 否则任意
网页都能 POST 到 `127.0.0.1:3080` 让 dsh 重启。

前端恢复：`bootId` 是每次进程启动新生成的随机 id。点击重启后前端轮询 `/kita-restart/status`
（重启期间 fetch 被拒是预期状态），一旦拿到**不同的 bootId**，就说明新进程已经在应答，随即
`location.reload()`。**不需要重新取 launch token** —— 浏览器 cookie 由持久化 secret 签名
（`dsh-client-connection` 的 `credentials` 记录），跨进程重启依然有效。

## 安装

本包按 DSH 0.2.1-rc.2 的 bundle 形态声明，`dsh.bundle.patch` 指向自带 `cordis.patch.yml`：

```powershell
dsh plugin --profile web add link:<仓库绝对路径>/packages/kita-dsh-restart
```

再把 `kita-dsh-restart` 加进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles`，
或直接用 `node scripts/install.mjs --only kita-dsh-restart`。装完需重启一次 dsh web（顺带这也是
本插件自己的首次生效条件）。

**可移植性**：插件不假定本机部署布局。`dshEnvsDir` 未配置时按 `$DSH_HOME` 上两级推断，
该目录下找不到 `start.ps1` 时**不会让 profile 装配失败**，只在 `/kita-restart/status` 的
`task.error` 里给出原因（按钮仍在，点击会显示失败卡片）。没有计划任务权限的机器上同理。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `taskName` | `kita-dsh-restart` | 计划任务名 |
| `restartScript` | 包内 `scripts/restart-dsh.ps1` | 任务动作脚本 |
| `pwshPath` | 自动探测 | 任务动作使用的 pwsh |
| `dshHome` | `$DSH_HOME` | |
| `dshEnvsDir` | home 上两级 | 需含 `start.ps1` |
| `delaySeconds` | 4 | 杀 dsh 前的等待，让 HTTP 响应先落地 |
| `ensureTask` | true | apply 时确保任务存在且未漂移 |
| `requestCooldownMs` | 60000 | 重复请求冷却窗口 |
| `fallbackSpawn` | true | 任务启动失败时改用直接子进程（不保证活过 kill） |

## 本地验证

client 半是手写 bundle，没有构建、没有类型检查 —— 选择器写错或 CSS 片段拼接坏掉只会在浏览器里
**静默失效**（不报错、不失败，只是样式不对）。离线冒烟脚本用真实 React 渲染侧栏按钮与弹窗
（`confirm` / `restarting` / `failed` / `idle` 四个 phase），并捕获 bundle 注入的样式文本逐条断言：

```
node scripts/smoke-client.cjs lib/client.js "<dsh web profile 目录>"
```

`<dsh web profile 目录>` 指含 `node_modules/react` 的那个 web profile（本机生产环境由
`Archive\dsh-envs\active-env.txt` 指针决定，profile 在 `<环境目录>\home\profiles\web`）。
全部断言通过时退出码为 0。

## 诊断

- `<home>\storages\kita-restart.log`：插件与任务的叙述日志（含 `start.ps1` 的逐行输出）。
- `<home>\storages\kita-restart.json`：最近一次请求的时间/方式/任务名。
- 手动触发：`schtasks /Run /TN kita-dsh-restart`
- 查看定义：`schtasks /Query /TN kita-dsh-restart /XML`
- 任务注册失败时 `/kita-restart/status` 的 `task.error` 会带原始 stderr，前端失败卡片直接显示。
