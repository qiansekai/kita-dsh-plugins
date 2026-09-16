# kita-mobile-panel

手机面板的 host 桥：在 dsh web profile 自己的 webServer 上注册路由，供移动端
（配合 `@dsh-external/dsh-mobile-nav` 前端）使用。

## 路由

| 路由 | 功能 |
|---|---|
| `POST /mobile-git/run {cwd, argv}` | 受限 git 桥：动词白名单 + 安全 flag 白名单 + 输出上限 + 硬超时 |

## 2026-09-16：终端与文件路由已移除

`WS /mobile-terminal`（node-pty ConPTY 终端）与 `/mobile-files/list|read|op`（文件列表、
预览、写操作）随 DSH 0.1.6 一并删除：0.1.6 官方右侧栏自带终端（含 shell 选择，默认 shell
由 profile patch 的 `terminal-controller.shell` 指定）与工作区文件浏览，移动端经
「新标签页 → 新建终端 / 工作区文件」可达。本插件只保留官方未覆盖的 git 标签。
`node-pty` 与 `ws` 依赖同时移除（`dependencies` 已空）。

## 依赖

无运行时依赖。装配：profile `cordis.patch.yml` 插入 `kita-mobile-panel` 行（无需 `config`）。

## 安全警告

git 路由可在宿主机执行**白名单内的** git 命令（动词 + flag 双重白名单、输出 200KB、
30s 硬超时）。设计前提是**经由 kita-dsh-gateway 的配对鉴权访问**（手机侧），
或本机 loopback 直连（桌面侧）。**不要在无鉴权环境下单独暴露该路由。**
