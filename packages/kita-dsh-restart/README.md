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
| `lib/client.js` | client：`sidebar.footer.action` 按钮 + `shell.overlay` 确认/进度卡 |
| `scripts/restart-dsh.ps1` | 计划任务动作：延迟 → 调部署自带的 `start.ps1` |

`restart-dsh.ps1` **不重复实现**停旧起新：它调部署自己的 `start.ps1`（停占用端口的实例、清
孤儿 `.credentials.yaml.lock`、起新实例、捕获 launch token、等端口 LISTEN）。重启流程单一数据源。

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

## 装配

profile `cordis.patch.yml`：

```yaml
- insert:
    - id: 'kita-dsh-restart'
      name: 'kita-dsh-restart'
```

host 侧改动需重启 dsh 生效；client 侧改动硬刷新即可。按本仓库双落点约定，同时存在于本
monorepo 与 `<home>\profiles\web\plugins-src\kita-dsh-restart`。

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

## 诊断

- `<home>\storages\kita-restart.log`：插件与任务的叙述日志（含 `start.ps1` 的逐行输出）。
- `<home>\storages\kita-restart.json`：最近一次请求的时间/方式/任务名。
- 手动触发：`schtasks /Run /TN kita-dsh-restart`
- 查看定义：`schtasks /Query /TN kita-dsh-restart /XML`
- 任务注册失败时 `/kita-restart/status` 的 `task.error` 会带原始 stderr，前端失败卡片直接显示。
