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

## 装配

```yaml
- insert:
    - id: 'kita-terminal-autoscroll'
      name: 'kita-terminal-autoscroll'
```

可选配置（`config` 段）：

| 键 | 默认 | 说明 |
|---|---|---|
| `selectors` | `["[data-terminal]"]` | 卡片根选择器；想只作用于某一类可收窄 |
| `stickThresholdPx` | `24` | 距底部多少像素内仍算「贴底」 |

**新增客户端 entry 会改变启动图 ⇒ 必须重启 dsh web 才生效**（硬刷新不够：
client bundle 的 rev 是启动时算的内容 sha1、响应 `immutable`）。

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
