# kita-terminal-autoscroll

终端输出区**贴底自动跟随**（sticky-bottom auto-scroll）。

## 解决什么

dsh 的所有 shell 输出都走官方共享原语 `TerminalBlock`，其输出区是
`overflow-y: auto` 的滚动容器，高度由 `--dsl-terminal-output-max-height` 封顶
（后台任务 Jobs 菜单 288px，工具卡片 224px）。新输出**追加在底部**，而浏览器不会
移动 `scrollTop` —— 视图停在旧行上，每来一批输出用户都得手动把滚动条拖到底。

本插件在 DOM 层给它补上终端应有的行为：

- 输出区内容**增长**时自动滚到底；
- 用户手动向上滚 → **暂停跟随**（不抢用户的滚动位置）；
- 滚回底部 → 自动恢复跟随；
- 加载插件时**已有的**历史卡片只登记基线、不拽动（避免一进页面就被拉到最新）。

## 作用面

默认匹配所有 `[data-terminal]` 卡片内部的滚动容器，即：

- 会话头部「后台任务（Jobs）」下拉菜单里展开的输出区；
- 会话流里工具卡片（pwsh / bash）的输出区。

卡片内的**命令 banner**（长命令可滚）不在跟随范围：跟随的判据是
「该滚动容器的 `scrollHeight` 比上一帧增长」，banner 不会增长，所以长命令
的第一行不会被拽走。

## 为什么不改官方包

纯客户端插件，走 `window.__ModuleLoader__.load` 的模块图；不注入官方组件、
不匹配任何 CSS-module 类名（那串 hash 随上游构建变化），只用官方既有的稳定
契约：卡片根上的 `data-terminal` 属性 + 计算样式里的 `overflow-y`。
上游改版面也只会退化成静默 no-op，不会报错。

## 安装与版本要求

作为 **bundle 插件**发布：`package.json` 的 `dsh.bundle.patch` 指向本包自带的 `cordis.patch.yml`，
装进来即可，**不需要手改 profile 的 `cordis.patch.yml`**。自带的 patch 就是这一段：

```yaml
- insert:
    - id: 'kita-terminal-autoscroll'
      name: 'kita-terminal-autoscroll'
```

| 项 | 要求 |
|---|---|
| `@deepseek-ai/dsh` | **0.2.1-rc.2**（实测版本；0.2.x 应可用，0.1.x 的插件形态不同，不保证） |
| `@deepseek-ai/cordis` | `~4.0.5`（0.2.1-rc.2 随包版本，已声明在 `peerDependencies`） |
| Node.js | 22+（只用于安装器；插件本身跑在浏览器里） |
| 客户端 | Web 平台；`dsh.client.platform = "web"`、`dsh.client.inject = []`（本包不碰任何客户端服务，只监听 DOM） |

安装（推荐用仓库根的安装器）：

```powershell
node scripts/install.mjs --only kita-terminal-autoscroll
```

手动安装：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>/packages/kita-terminal-autoscroll
```

然后把包名写进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 数组。

**装完重启一次 dsh web**：本包新增一个客户端 entry，启动图随之变化，硬刷新不够
（client bundle 的 `rev` 是启动时算的内容 sha1、响应 `immutable`）。

## 配置项

| 键 | 默认值 | 为空 / 不设置时 |
|---|---|---|
| `selectors` | `["[data-terminal]"]` | 回落到 `[data-terminal]`（只跟随官方 `TerminalBlock` 卡片） |
| `stickThresholdPx` | `24` | 回落到 24px：距底 24px 内仍算「贴底」 |

**本版本这两项实际走代码默认值。** `lib/client.js` 的 `apply(ctx, config)` 认得这两个键，但 0.2.1-rc.2
的客户端 runner（`loader.create({ name })`）不向客户端半下发 config —— patch 里的 `config` 只会落到 host
半那个空实现上。运行时的生效值见「现场自检」里的 `options`。

```yaml
# 只有本机自己改过 lib/client.js 或走自建 runner 时这段才有效：
# - insert:
#     - id: kita-terminal-autoscroll
#       name: 'kita-terminal-autoscroll'
#       config:
#         stickThresholdPx: 24
```

## 现场自检

```js
window.__kitaTerminalAutoscroll   // { engine, options }
```

## 验证

逻辑回归用真实 Chromium 跑过（headless + CDP，独立实例，不碰 9222）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 追加输出 | 滚到 `scrollHeight` | `scrollTop 0 → 304`（max 304） |
| 用户上滚后追加 | 保持用户位置 | `scrollTop 0`（max 704） |
| 滚回底部后追加 | 恢复跟随 | `scrollTop 1104`（max 1104） |
| 命令 banner（内容超出自身高度） | 不被拽走 | `headerScrollTop 0`（scrollHeight 204 > 60） |

## 已知限制

- 只跟随 **`scrollHeight` 增长**的容器：内容被整体替换（而不是追加）时不会滚到底。这是刻意的 ——
  卡片内的命令 banner 就靠这一条不被拽走。
- 判据依赖卡片根上的 `data-terminal` 属性。上游若改名，插件退化为静默 no-op（不报错、也不滚动）。
- `selectors` / `stickThresholdPx` 在当前版本无法通过 patch 下发（见「配置项」），要改需改代码常量。
- 不管横向滚动，也不接管用户自己的 `scrollTo` 动效。
- 卡片首次挂载、布局还没落定时最多补 2 帧（`MAX_SETTLE_RETRIES`）；极慢的自定义字体加载后可能有一帧停在非底部。
