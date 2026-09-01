# kita-mobile-panel

手机面板的 host 桥：在 dsh web profile 自己的 webServer 上注册一组路由，供移动端
（配合 `@dsh-external/dsh-mobile-nav` 前端）使用。

## 路由

| 路由 | 功能 |
|---|---|
| `GET /mobile-files/list?path=<绝对路径>` | 目录 JSON 列表（子目录 + 文件，类型/大小/隐藏标志，目录在前） |
| `GET /mobile-files/read?path=<绝对路径>` | 文件内容预览：图片按类型流式（≤ 20MB）、已知文本流式 UTF-8（≤ 2MB，超长带 `X-Truncated` 头）、其他 415 |
| `POST /mobile-files/op {op, src, ...}` | 文件操作：rename / copy / move；`reveal` 在宿主机资源管理器打开（目录直开，文件 `/select` 高亮） |
| `WS /mobile-terminal?cwd=<绝对路径>&cols=N&rows=N` | xterm.js 终端桥：node-pty 真 ConPTY 内启动 pwsh，JSON 信封 `{t:'data'|'input'|'resize'|'exit'|'fatal'}`，支持动态 resize |
| `POST /mobile-git/run {cwd, argv}` | 受限 git 桥：动词白名单 + 安全 flag 白名单 + 输出上限 + 硬超时 |

文件部分**只读**；终端即宿主机 shell（与 danger-full-access 文件策略同信任级）。
插件卸载时关闭所有打开的终端。

## 依赖

`node-pty`、`ws`。装配：profile `cordis.patch.yml` 插入 `kita-mobile-panel` 行
（无需 `config`）。

## 安全警告

终端路由是宿主机**命令执行面**、文件路由可读宿主机文件。设计前提是
**经由 kita-dsh-gateway 的配对鉴权访问**（手机侧），或本机 loopback 直连（桌面侧）。
**不要在无鉴权环境下单独暴露这些路由。**
