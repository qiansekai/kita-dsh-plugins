# kita-reconnect-on-visible

回到前台时自动重连，并顺手修好**在后台期间变旧**的会话列表。

## 做什么

两件独立的毛病，两个修复，都只在页面/手机从后台回到前台时动手：

### 1. 断了的连接不再只靠 `online` 事件

官方 `ConnectionController` 按 0.5s → 10s 的阶梯重试，重试耗尽后落到终态 disconnected，
此后只等浏览器的 `online` 事件才恢复。**解锁屏幕、切回标签页都不触发 `online`**，
所以以前每次都要自己点一下重连按钮。

现在 `visibilitychange` 且页面可见时，若发现终态断开横幅还在
（`button[data-phase="disconnected"]`），就替你点一次（同一按钮 4 秒内最多点一次，防抖）。

### 2. 会话列表是增量维护的，会一直缺行

Host 只在会话**创建那一刻**广播一次 `api-session/added`，之后从不重放。一个断连窗口内
别的客户端（例如手机）新建的会话，本页侧栏就会永久缺这些行，直到手动刷新页面。
官方 `handleConnected → refreshList` 只在连接真的断开再重建时才跑；错过广播窗口、又没测出
断连的页面永远不会自愈。

回到前台后本包会把 Host 的会话列表和本页列表比一次：缺失就重建。
重建是 `location.reload()` —— 客户端没有暴露 `refreshList` 的公开服务，全页刷新是唯一可行手段，
所以外面套了一圈护栏（见「配置项」）：编辑框有草稿、客户端列表还没 ready、同一组缺失刚重建过、
两次重建间隔太近，都**不重建**，只弹横幅让你手动点刷新。

## 装法与版本要求

作为 **bundle 插件**发布：`package.json` 的 `dsh.bundle.patch` 指向本包自带的 `cordis.patch.yml`，
装进来即可，**不需要手改 profile 的 `cordis.patch.yml`**。自带的 patch 就是这一段：

```yaml
- insert:
    - id: 'kita-reconnect-on-visible'
      name: 'kita-reconnect-on-visible'
```

| 项 | 要求 |
|---|---|
| `@deepseek-ai/dsh` | **0.2.1-rc.2**（实测版本；0.2.x 应可用，0.1.x 的插件形态不同，不保证） |
| `@deepseek-ai/cordis` | `~4.0.5`（0.2.1-rc.2 随包版本，已声明在 `peerDependencies`） |
| Node.js | 22+（只用于安装器与离线验证脚本；插件本身跑在浏览器里） |
| 客户端 | Web 平台（`dsh.client.platform = "web"`） |

安装（推荐用仓库根的安装器）：

```powershell
node scripts/install.mjs --only kita-reconnect-on-visible
```

手动安装：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>/packages/kita-reconnect-on-visible
```

然后把包名写进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 数组。

**装完重启一次 dsh web**：本包新增一个客户端 entry，启动图随之变化，硬刷新不够
（client bundle 的 `rev` 是启动时算的内容 sha1、响应 `immutable`）。

### 客户端依赖（两个官方包，随官方包装好，不需要另装）

`dsh.client.inject` 列的是**包名**，对应 `lib/client.js` 里声明的三个 cordis 服务：

| 服务（`inject`） | 提供的包 | 用途 |
|---|---|---|
| `sessions` | `@deepseek-ai/dsh-api-session-controller` | 读本页的 Session 列表快照（`sessions.list.getSnapshot()`） |
| `remote` | `@deepseek-ai/dsh-api-gateway` | 网关服务；`remote.<namespace>` 由它动态挂载 |
| `remote.session` | 同上（命名空间由 `dsh-api-session-controller` 注册） | 向 Host 要一次真实列表（`remote.session.list({})`） |

任一服务缺失时本包**只降级不报错**：比对返回 `unavailable`，既不重载也不弹横幅；
缺的是哪一环可以从下面的 debug 句柄的 `probe` 里读到。

host 半（`lib/index.js`）是空 `apply`，纯粹为了让插件出现在 host 的 cordis 树里。

## 配置项

本包**没有 patch config**（`cordis.patch.yml` 的 `insert` 行不带 `config`）。可用的开关只有下面这些：

| 项 | 默认值 | 设为别的值时 |
|---|---|---|
| `localStorage["kita-reconnect-on-visible.autoReload"]` | 不设置 = 开启自动重建 | `"off"` = 关闭自动重建；断连重连照旧，列表陈旧时只弹横幅 + 手动刷新按钮 |
| `globalThis.__kitaReconnectOnVisible.disableAutoReload()` | 自动重建开启 | 运行中关掉自动重建（本次会话内存内生效，`enableAutoReload()` 可开回） |

代码常量（**不可配置**，需要改就改源码）：

| 常量 | 值 | 作用 |
|---|---|---|
| `CLICK_GAP_MS` | 4000 | 两次「替你点重连」之间的最小间隔 |
| `CHECK_GAP_MS` | 20000 | 两次列表校验之间的最小间隔 |
| `POLL_MS` | 120000 | 后台仅弹横幅的校验节拍 |
| `RELOAD_COOLDOWN_MS` | 600000 | 同一组缺失在这段时间内不再自动重建 |
| `RELOAD_MIN_GAP_MS` | 60000 | 任意两次自动重建之间的硬间隔（防循环） |

## 现场自检

```js
globalThis.__kitaReconnectOnVisible.tryReconnect()   // 手动跑一次重连点击
globalThis.__kitaReconnectOnVisible.runCheck(false)  // 手动跑一次列表校验（不重载）
globalThis.__kitaReconnectOnVisible.probe()          // 看三个服务各是 present / missing
```

`runCheck` 返回 `{ status, missing, detail }`，`status` 取值：
`unavailable`（服务缺失）、`not-ready`（客户端列表未就绪）、`list-failed`（Host 查询失败）、
`clean`（无缺失）、`stale`（有缺失，附 id 列表）。

## 验证

```powershell
node scripts/verify-client.mjs      # 或 npm run verify
```

离线回归：stubbed `document` / `localStorage` / `location` 下跑纯函数（缺失集合比对、签名、
冷却判定、草稿检测）与 `apply()` 的三条分支（重载 / 横幅 / 什么都不做）。

## 已知限制

- **重建是全页刷新**：页面内的瞬时 UI 状态（滚动位置、展开的卡片、未提交的草稿）会丢；
  服务端的 agent 任务不受影响。编辑框里有草稿时本包不会自动重建（只出横幅）。
- 只在客户端列表 `phase === 'ready'` 时比对，半加载状态一律跳过 —— 宁可晚一次，不可误刷。
- `origin === 'subagent'` 的子代理会话按侧栏设计本来就隐藏，**不参与比对**，不会因它们触发重建。
- 重连走的是官方那条终态断开横幅（`button[data-phase="disconnected"]`）。官方若改掉这个标记，
  重连部分退化为不动（不报错），列表修复部分不受影响。
- 不替代官方的 `online` 事件路径，只是多了一条「回到前台」的触发源。
- 冷却记在 `localStorage` 里；storage 被禁用时护栏退化为内存内，跨刷新记不住冷却。
- 浏览器冻结页面（休眠 / BFCache）时 `setInterval` 也一起冻结，恢复后靠 `visibilitychange` 兜底；
  页面完全不可见期间不会做任何校验或刷新。
