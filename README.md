# kita-dsh-plugins

自用 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件合集（monorepo，13 个包）。
面向「远程运维 + 安全攻防」的日常形态：局域网配对网关、移动端面板桥、会话标题自动维护、
工作区 UI 增强、渠道余额、终端跟随、忙时插话、额度耗尽自动重试等。

所有包都按 DSH 0.2.1-rc.2 的 **bundle 插件形态** 对齐（`dsh.bundle.patch` + 自带 `cordis.patch.yml`），
因此**别人的 dsh 可以直接安装它们，不需要手改 profile 的 cordis.patch.yml**。判据与模板见
[`docs/bundle-spec.md`](docs/bundle-spec.md)。

## 环境要求

- `@deepseek-ai/dsh` **0.2.1-rc.2**（实测版本；0.2.x 应可用，0.1.x 不保证）
- Node.js 22+
- 包管理器：`dsh` CLI 在 PATH 上，或 `pnpm`（安装器会自动二选一）
- 平台：Windows 为主要开发平台；纯客户端插件（跟随滚动 / 插话 / 重连 / Office 预览）跨平台通用，
  少数包（重启按钮、手机壳桥）依赖 Windows 侧的外部程序，缺失时会自行降级（见各包 README）

## 安装（推荐：一条脚本）

```powershell
git clone https://github.com/qiansekai/kita-dsh-plugins.git
cd kita-dsh-plugins
node scripts/install.mjs --dry-run     # 先看它准备做什么
node scripts/install.mjs               # 真正安装
```

脚本做三件事（全部幂等）：

1. 自动探测 DSH home（`$DSH_HOME`，否则 `~/.dsh`）与目标 profile（默认 `web`）
2. 对每个包执行 `dsh plugin --profile web add link:<本仓库绝对路径>`（没有 `dsh` 时回退 `pnpm add`）
3. 把包名写进 profile `package.json` 的 `dsh.profile.bundles`，并备份原文件为
   `package.json.bak-pre-kita-install-<时间戳>`

装完**重启一次 dsh web**（host 半改动与新增 client entry 都需要重启；重启后侧栏会出现本仓库的
「重启」按钮，以后就不必手动重启了）。

常用参数：

```powershell
node scripts/install.mjs --list                                  # 列出全部包与平台
node scripts/install.mjs --only kita-terminal-autoscroll,kita-force-steer
node scripts/install.mjs --profile web --home D:\somewhere\dsh-home
node scripts/install.mjs --uninstall [--only ...]                # 卸载
```

`kita-workspace-ui`（官方 `ui-workspace` 的 fork）**默认不装**：它的产物与某个具体的 dsh 版本绑定，
用不同版本可能白屏。确认版本一致后显式安装：`node scripts/install.mjs --only kita-workspace-ui`。

## 手动安装（不想跑脚本）

对单个包：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>/packages/kita-terminal-autoscroll
```

然后把包名加进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，重启。

## 插件清单

| 目录 | 包名 | 功能 | 平台 | 安装注意 |
|---|---|---|---|---|
| [`packages/kita-dsh-gateway`](packages/kita-dsh-gateway) | kita-dsh-gateway | 配对码鉴权网关：dsh 保持 loopback，只暴露一个带认证的 LAN 入口（HTTP + WebSocket 反代）；扫码配对；面板内一键 Cloudflare 快速隧道 | host + client | 默认 3081 → 3080；改端口见包内 README；**切勿直接暴露公网** |
| [`packages/kita-mobile-panel`](packages/kita-mobile-panel) | kita-mobile-panel | 移动端面板的 host 桥：受限 git 桥 `/mobile-git/run`（动词 + flag 双白名单、输出上限、硬超时） | host | 依赖 gateway 的配对鉴权；不要无鉴权单独暴露 |
| [`packages/kita-session-title-auto`](packages/kita-session-title-auto) | kita-session-title-auto | 会话标题维护：`update_session_title` 钉住工具 + 提示段 + 标题旁 ✨/📌 标记（自动重拟本身由官方 all-prompts 提供者承担） | host + client | patch 已停用官方首条消息提供者 `session-title-llm`；**要自动重拟需同时装官方 `@deepseek-ai/dsh-experimental-session-titles-bundle`** |
| [`packages/kita-reconnect-on-visible`](packages/kita-reconnect-on-visible) | kita-reconnect-on-visible | 页面/手机回到前台时自动重连，并重建侧栏会话列表（补上断连期间别的客户端新建的会话） | client | 无需配置 |
| [`packages/kita-dsh-restart`](packages/kita-dsh-restart) | kita-dsh-restart | 侧栏底部一键重启 dsh web：确认模态 → 按需计划任务（位于 dsh 进程树之外）→ 轮询 bootId → 自动重载 | host + client | 需要 `dshEnvsDir` 下有 `start.ps1` 与 `active-env.txt`；找不到时只降级不报错 |
| [`packages/kita-workspace-ui`](packages/kita-workspace-ui) | kita-workspace-ui | 官方 `ui-workspace` fork：会话行内 rename/fork/archive 按钮 + 双击改名 + 完整标题 | client | **产物与 dsh 版本绑定**，默认不装；会停用官方 `ui-workspace` |
| [`packages/kita-office-preview`](packages/kita-office-preview) | kita-office-preview | 右侧栏 Office 预览（docx / xlsx / pptx），用官方 `documentPreviews` 扩展点认领官方硬编码为不可预览的后缀 | host + client | 构建产物已入库，无需自行构建 |
| [`packages/kita-channel-balance`](packages/kita-channel-balance) | kita-channel-balance | composer 工具行常驻渠道余额：官方 DeepSeek 读平台钱包，其他渠道自动探测 new-api / one-api / Moonshot / credit_grants 端点 | host + client | 需配置 provider 探测（见包内 README） |
| [`packages/kita-terminal-autoscroll`](packages/kita-terminal-autoscroll) | kita-terminal-autoscroll | 终端输出区贴底自动跟随（后台任务 Jobs 菜单 + 会话内工具卡片）：新输出即滚到底，上滚暂停、回底恢复 | client | 无需配置 |
| [`packages/kita-force-steer`](packages/kita-force-steer) | kita-force-steer | 忙时提交 = 真插话：agent 运行时普通 Enter 与官方「插话发送」按钮在同一路径被接管 —— 先 `cancel` 打断当前 turn，再把草稿以 queue 投递 | client | `Cmd/Ctrl+Enter` 保留官方相反语义 |
| [`packages/kita-version-check`](packages/kita-version-check) | kita-version-check | 侧栏「版本更新」入口：解析当前运行版本 + 缓存 npm dist-tags，只读检测不给一键升级 | host + client | `active-env.txt` 缺失时仍能报运行版本 |
| [`packages/kita-dsh-shell-bridge`](packages/kita-dsh-shell-bridge) | kita-dsh-shell-bridge | 手机壳/悬浮球把本地文件绝对路径键入 composer（轮询本机 Dropzone 队列） | host + client | 需要外部 `dropzone.exe`；缺失时退避不刷日志 |
| [`packages/dsh-quota-retry`](packages/dsh-quota-retry) | @dsh-external/dsh-quota-retry | 额度不足（QUOTA）无界长退避 + 鉴权失败（AUTH）有界短退避的自动重试 | host | 本机未进 bundles，可单独安装启用 |

## 与官方插件规范的对齐情况

已按 0.2.1-rc.2 随包的官方 bundle（`@deepseek-ai/dsh-experimental-*-bundle`）对齐：

- 每个包声明 `dsh.bundle.patch` → 自带 `cordis.patch.yml`，并在 `exports` 暴露该文件
- `cordis.patch.yml` 用官方 `- insert:` / `- id: ... disabled: true` 结构；替代官方行的包
  （`kita-workspace-ui` → `ui-workspace`、`kita-session-title-auto` → `session-title-llm`）
  在 patch 内自行停用，不再要求用户手改
- `peerDependencies` 统一 `@deepseek-ai/cordis: ~4.0.5`（官方值）、`@deepseek-ai/schemastery: ~3.18.5`；
  未再出现裸 `cordis` 或 `*`
- 客户端半声明 `dsh.client.platform` 与 `inject`；构建产物（`lib/client.js`）随仓库提供
- 机器相关的值全部走配置项/环境变量，代码内无本机绝对路径；本机专属前置条件缺失时
  **apply 只降级不抛错**（不会把对方的 profile 装配打挂）
- 仓库自带 `node scripts/check-packages.mjs` 逐包校验上述契约

## 安全警告

- **kita-dsh-gateway**：为「仅限可信局域网」设计。配对后即等于获得 dsh 完整操作权限，切勿直接暴露公网；
  需要远程访问时用面板里的**一键 CF 隧道**（只暴露带鉴权的网关，用完即关）或叠加 frp / tailscale，
  并保持配对码保密。配对码只在本机渲染，隧道开关也仅本机可操作。
- **kita-mobile-panel**：git 桥的可执行面是宿主机 git（动词 + flag 白名单 + 硬超时），依赖 gateway 的配对鉴权，
  不要在无鉴权环境下单独暴露。
- 任何「一键重启」类插件都会中断正在跑的会话与任务，装给不熟悉的人前先说明。

## 开发

```powershell
node scripts/check-packages.mjs          # 规范自检（需要 js-yaml：npm i -D js-yaml）
node scripts/install.mjs --list          # 包清单
```

- 规范与模板：[`docs/bundle-spec.md`](docs/bundle-spec.md)
- 各包细节与坑：各自目录的 `README.md`
- 本地开发时用 `pnpm-workspace.yaml` 把 `packages/*` 串起来；安装到 profile 时仍用 `link:` 绝对路径

## 许可

各插件许可见各自 LICENSE：`kita-*` 为 MIT（`kita-workspace-ui` 保留上游 DeepSeek 版权声明），
`dsh-quota-retry` 为 BSD-3-Clause。
