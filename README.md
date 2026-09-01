# kita-dsh-plugins

自用 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件合集（monorepo）。
生产装配于本机 dsh web profile（`~/.dsh/profiles/web/`），面向「远程运维 + 安全攻防」场景：
局域网配对网关、手机端终端面板、会话标题自动维护、工作区 UI 增强、额度耗尽自动重试。

## 插件

| 目录 | 名称 | 功能 | 平台 |
|---|---|---|---|
| [`packages/kita-dsh-gateway`](packages/kita-dsh-gateway) | kita-dsh-gateway | 配对码鉴权网关：dsh 保持 loopback，仅暴露一个带认证的 LAN 入口（HTTP + WebSocket 反代） | host |
| [`packages/kita-mobile-panel`](packages/kita-mobile-panel) | kita-mobile-panel | 手机面板桥：ConPTY 终端（node-pty + WebSocket）、只读文件列表/预览、受限 git 桥 | host |
| [`packages/kita-session-title-auto`](packages/kita-session-title-auto) | kita-session-title-auto | all-prompts 会话标题自动重拟（旁路小模型，不碰主循环前缀缓存）+ 钉住工具 + 标题旁 ✨/📌 标记 | host + client |
| [`packages/kita-workspace-ui`](packages/kita-workspace-ui) | kita-workspace-ui | 官方 ui-workspace fork：会话行内 rename/fork/archive 按钮 + 双击改名 + 完整标题 | client |
| [`packages/dsh-quota-retry`](packages/dsh-quota-retry) | @dsh-external/dsh-quota-retry | 额度不足（QUOTA）无界长退避 + 鉴权失败（AUTH）有界短退避的自动重试 | host |

## 安全警告（重要）

- **kita-dsh-gateway**：为「仅限可信局域网」设计。配对后即等于获得 dsh 完整操作权限，
  切勿直接暴露公网；如需远程访问请叠加 frp/cloudflared/tailscale 等隧道并保持配对码保密。
- **kita-mobile-panel**：终端路由即宿主机 shell（命令执行面）、文件路由可读取宿主机文件。
  它依赖 kita-dsh-gateway 的配对鉴权，**不要在无鉴权环境下单独暴露这些路由**。

## 装配

各插件装配方式见各自 README；生产装配参考本机 web profile 的 `cordis.patch.yml`。
`kita-*` 包通过 pnpm workspace junction 挂载，`dsh-quota-retry` 为纯 ESM 单文件插件（零依赖，可直接装配）。

## 许可

各插件许可见各自 LICENSE：`kita-*` 为 MIT（`kita-workspace-ui` 保留上游 DeepSeek 版权声明），
`dsh-quota-retry` 为 BSD-3-Clause。
