# kita-dsh-plugins

自用 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件合集（monorepo）。
生产装配于本机 dsh web profile（`~/.dsh/profiles/web/`），面向「远程运维 + 安全攻防」场景：
局域网配对网关、手机端终端面板、会话标题自动维护、工作区 UI 增强、额度耗尽自动重试。

## 插件

| 目录 | 名称 | 功能 | 平台 |
|---|---|---|---|
| [`packages/kita-dsh-gateway`](packages/kita-dsh-gateway) | kita-dsh-gateway | 配对码鉴权网关：dsh 保持 loopback，仅暴露一个带认证的 LAN 入口（HTTP + WebSocket 反代）；**扫码即配对**（二维码内嵌一次性码）+ **一键开启 Cloudflare 快速隧道**（外网用手机） | host + client |
| [`packages/kita-mobile-panel`](packages/kita-mobile-panel) | kita-mobile-panel | 移动端面板的 host 桥：受限 git 桥 `/mobile-git/run`（动词 + flag 双重白名单、输出上限、硬超时）。终端与文件路由已于 0.2.0 删除 —— 0.1.6 官方侧栏已自带终端与工作区文件浏览 | host |
| [`packages/kita-session-title-auto`](packages/kita-session-title-auto) | kita-session-title-auto | all-prompts 会话标题自动重拟（旁路小模型，不碰主循环前缀缓存）+ 钉住工具 + 标题旁 ✨/📌 标记 | host + client |
| [`packages/kita-reconnect-on-visible`](packages/kita-reconnect-on-visible) | kita-reconnect-on-visible | 标签页/手机回到前台后自动点掉终端的「连接异常」横幅，免手动重连 | client |
| [`packages/kita-dsh-restart`](packages/kita-dsh-restart) | kita-dsh-restart | 侧栏底部一键重启 dsh web：屏幕居中确认模态（遮罩/Esc 可取消）→ 按需计划任务（位于 dsh 进程树与 Job Object 之外，故能活过它自己执行的 kill）→ 轮询 bootId → 自动重载页面 | host + client |
| [`packages/kita-workspace-ui`](packages/kita-workspace-ui) | kita-workspace-ui | 官方 ui-workspace fork：会话行内 rename/fork/archive 按钮 + 双击改名 + 完整标题 | client |
| [`packages/kita-office-preview`](packages/kita-office-preview) | kita-office-preview | 右侧栏 Office 文件预览：Word / Excel / PowerPoint（docx / xlsx / pptx），用官方 `documentPreviews` 扩展点认领官方硬编码为「不可预览」的这批后缀 | client |
| [`packages/kita-channel-balance`](packages/kita-channel-balance) | kita-channel-balance | composer 工具行常驻渠道余额：官方 DeepSeek 读平台钱包（退路 `/user/balance`），其余渠道自动探测 new-api / one-api / Moonshot / credit_grants 计费端点 | host + client |
| [`packages/kita-terminal-autoscroll`](packages/kita-terminal-autoscroll) | kita-terminal-autoscroll | 终端输出区贴底自动跟随（后台任务 Jobs 菜单 + 会话内工具卡片）：新输出即滚到底，用户上滚暂停、滚回底部恢复；命令 banner 不受影响 | client |
| [`packages/kita-force-steer`](packages/kita-force-steer) | kita-force-steer | composer「强制插话」按钮：先 `cancel` 打断当前 turn（abort 传到正在跑的工具，PTC runtime 直接杀 node 子进程），再把草稿以 `steer` 投递 —— 官方插话只在 step 边界被领取，长工具跑着时要等它结束 | client |
| [`packages/dsh-quota-retry`](packages/dsh-quota-retry) | @dsh-external/dsh-quota-retry | 额度不足（QUOTA）无界长退避 + 鉴权失败（AUTH）有界短退避的自动重试 | host |

## 安全警告（重要）

- **kita-dsh-gateway**：为「仅限可信局域网」设计。配对后即等于获得 dsh 完整操作权限，
  切勿直接暴露公网；如需远程访问请在面板里用**一键 CF 隧道**（只暴露带鉴权的网关，用完即关）
  或叠加 frp/tailscale，并保持配对码保密。配对码只在**本机**渲染进二维码/管理页，
  远程访客拿到的是纯输入框；隧道开关也仅本机可操作（手机无论走局域网还是隧道都得到 403）。
- **kita-mobile-panel**：终端路由即宿主机 shell（命令执行面）、文件路由可读写宿主机文件
  （写操作带显式守卫：绝对路径校验、重命名单段校验、目标存在即失败、目录禁止自嵌套；`reveal` 只弹资源管理器窗口不读写）。
  它依赖 kita-dsh-gateway 的配对鉴权，**不要在无鉴权环境下单独暴露这些路由**。

## 装配

各插件装配方式见各自 README；生产装配参考本机 web profile 的 `cordis.patch.yml`。
`kita-*` 包通过 pnpm workspace junction 挂载，`dsh-quota-retry` 为纯 ESM 单文件插件（零依赖，可直接装配）。

`kita-office-preview` 是唯一需要**构建产物**（`lib/client.js`，约 3.0 MB 自包含）的包：
`npm install && npm run build`。其余包的 `lib/` 为手写或 fork 产物。

## 许可

各插件许可见各自 LICENSE：`kita-*` 为 MIT（`kita-workspace-ui` 保留上游 DeepSeek 版权声明），
`dsh-quota-retry` 为 BSD-3-Clause。