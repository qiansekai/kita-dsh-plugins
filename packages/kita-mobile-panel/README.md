# kita-mobile-panel

手机面板的 host 桥：在 dsh web profile 自己的 webServer 上注册路由，供移动端
（配合 `@dsh-external/dsh-mobile-nav` 前端）使用。按 DSH 0.2.1-rc.2 的 **bundle 插件形态**
分发，自带 `cordis.patch.yml`。

## 做什么

只提供**受限 git 桥**一条路由（`POST /mobile-git/run`），给移动端 git 标签页用：

| 路由 | 功能 |
|---|---|
| `POST /mobile-git/run {cwd, argv}` | 受限 git 桥：动词白名单 + 安全 flag 白名单 + 输出上限 + 硬超时 |

终端与文件路由已移除（本包 0.2.0 起只剩 git 桥）：`WS /mobile-terminal`（node-pty ConPTY 终端）
与 `/mobile-files/list|read|op`（文件列表、预览、写操作）随 DSH 0.1.6 一并删除（2026-09-16）——
0.1.6 起官方右侧栏自带终端（含 shell 选择，默认 shell 由 profile patch 的
`terminal-controller.shell` 指定）与工作区文件浏览，移动端经「新标签页 → 新建终端 / 工作区文件」可达。
本插件只保留官方未覆盖的 git 标签。`node-pty` 与 `ws` 依赖随之移除（`dependencies` 为空）。

## 装法与版本要求

- DSH **0.2.1-rc.2**（随包 `@deepseek-ai/cordis ~4.0.5`）；0.2.x 应可用。需要 profile 有
  `webServer` 服务（`@deepseek-ai/dsh-host-webserver`，web profile 默认有）；纯 CLI / headless
  profile 里插件会保持 pending，不报错也不可用。
- 本包 peer：`@deepseek-ai/cordis ~4.0.5`。无运行时第三方依赖（只用 `node:child_process` /
  `node:path`），不需要 `schemastery`。
- 安装（仓库根，任选其一）：
  - `node scripts/install.mjs --only kita-mobile-panel`
  - 手动：`dsh plugin --profile web add link:<仓库绝对路径>/packages/kita-mobile-panel`，再把
    `kita-mobile-panel` 加进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles`，重启 dsh web。
- **前端不在本包**：移动端界面由 `@dsh-external/dsh-mobile-nav` 提供，本包只给 git 标签供数。

## 配置项

本包**没有** `Config` schema，patch 里不写 `config`，没有可配项（写 `config` 不生效）。
下面这些是代码内的**固定上限**，改它们要改 `lib/index.js`：

| 键 | 默认值 / 上限 | 说明 |
|---|---|---|
| `POST /mobile-git/run` 路径 | 固定 | 改动 = 同时改前端 |
| 请求体上限 | `8192` 字节 | 超过即断开连接 |
| `argv` 长度 | `1..8` 个字符串 | 第一个必须是白名单动词 |
| 输出上限 | `200 KB`（stdout / stderr 各自截断） | 超长输出截断后照常返回成功 |
| 单次超时 | `30 s` | `execFile` 的 `timeout`，到点杀掉 git 子进程 |
| git 动词白名单 | `status log diff show branch rev-parse ls-files add commit pull push stash switch checkout restore reset fetch merge remote describe` | 不在表内 → `verb-denied` |
| flag 白名单 | `--porcelain --oneline --decorate --stat --name-only --cached --staged --short --abbrev-ref --show-toplevel -A -m -v --all --tags --no-pager --follow -n -a -u --` | 任何 `-`/`--` 开头且不在表内 → `flag-denied`（`-c key=val`、`--exec-path` 这类注入被挡在这里） |

响应一律是 JSON：`{ok, code, out, err}`（git 非零退出也算 `ok: true` + `code`），
请求非法则是 4xx + `{ok: false, code, error}`（`method` / `bad-json` / `bad-path` / `bad-argv` /
`verb-denied` / `flag-denied`）。

## 已知限制

- **没有自带鉴权**：路由本身不校验调用方。设计前提是经 `kita-dsh-gateway` 的配对码鉴权访问
  （手机侧），或本机 loopback 直连（桌面侧）。**不要在无鉴权环境下单独把该路由暴露到网络。**
- `cwd` 由调用方给（必须是绝对路径），本包**不限制根目录**：配置了 `cwd` 的地方就能跑上述 git 动词。
  也就是说，鉴权边界 = 网关配对鉴权，不是路径白名单。
- 只有白名单动词与白名单 flag 可用：`git -c`、`--exec-path`、`--git-dir`、分页器自定义、`-c core.*`
  之类全部被拒；需要更复杂的 git 操作请在桌面侧做。
- 一次调用只能跑一条 git 命令（`argv` 最多 8 项），长输出按 200 KB 截断。
- 终端与文件读写不再由本包提供，见上面「做什么」的说明。
- 装配失败不影响 profile：拿不到 `webServer` 时插件只是 pending，不抛错、不打断别人的 dsh 启动。

## 安全警告

git 路由可在宿主机执行**白名单内的** git 命令（动词 + flag 双重白名单、输出 200 KB、30 s 硬超时）。
写操作（`add` / `commit` / `checkout` / `reset` / `push` …）也在白名单里 —— 配对客户端等于拿到了
「在任意绝对路径下执行这些 git 写命令」的能力。**不要在无鉴权环境下单独暴露该路由。**
