# kita-dsh-shell-bridge

把 DSH 的会话运行状态推给 **dsh-mobile-shell** 的 WebView 壳，让手机端能弹系统通知。

## 为什么是"路由 + 轮询"而不是 session 投影

DSH 的 session projection 是**按会话**的：一个页面只打开了一个会话，就只看得见那个会话。
需求是「所有会话都要提醒」，所以必须有一个全局视角 —— 部署自己的 webServer 正好是
桌面页（loopback）和手机（经 kita-dsh-gateway 配对鉴权）都已经能带着浏览器会话 cookie 访问的通道。

## 路由

    GET /kita-shell/state
    -> { sessions: [{ sessionId, title, running, state, updatedAt }], diagnostics }

只读，不返回任何凭据；带同源围栏（sec-fetch-site / Origin 比对 Host）。

## 客户端

`lib/client.js` 在 `shell.overlay` 挂一个不渲染任何东西的轮询组件：

1. 每 4 秒 `fetch('/kita-shell/state')`；
2. 某个会话 `running` 由 false 变 true -> 调 `window.DshShell.notifySessionState`，state=`working`；
3. 由 true 变 false -> state=`done`；
4. 页面不在手机壳里时 `window.DshShell` 不存在，组件静默什么都不做（桌面浏览器零感知）。

## 安装与版本要求

作为 **bundle 插件**发布：`package.json` 的 `dsh.bundle.patch` 指向本包自带的 `cordis.patch.yml`，
装进来即可，**不需要手改 profile 的 `cordis.patch.yml`**。自带的 patch 就是这一段：

```yaml
- insert:
    - id: kita-dsh-shell-bridge
      name: 'kita-dsh-shell-bridge'
      config:
        titleMaxBytes: 120
        includeIdle: false
```

| 项 | 要求 |
|---|---|
| `@deepseek-ai/dsh` | **0.2.1-rc.2**（实测版本；0.2.x 应可用，0.1.x 的插件形态不同，不保证） |
| `@deepseek-ai/cordis` | `~4.0.5`（0.2.1-rc.2 随包版本） |
| `@deepseek-ai/schemastery` | `~3.18.5`（host 半的 `Config` 用它定义 schema） |
| Node.js | 22+（只用于安装器；插件本身跑在浏览器 / dsh 进程里） |
| 客户端 | Web 平台；`dsh.client.platform = "web"`、`dsh.client.inject = ["@deepseek-ai/dsh-client-ui-renderer"]`（客户端半只用到该包提供的 `slots`） |

安装（推荐用仓库根的安装器）：

```powershell
node scripts/install.mjs --only kita-dsh-shell-bridge
```

手动安装：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>/packages/kita-dsh-shell-bridge
```

然后把包名写进 `<DSH_HOME>/profiles/web/package.json` 的 `dsh.profile.bundles` 数组。

**装完重启一次 dsh web**：host 半要注册 `/kita-shell/state` 路由，客户端半还要新增一个 entry
（`shell.overlay` 上的轮询组件），两者都只在装配时生效，硬刷新不够。

本包**不要求** `dropzone.exe` 存在就能安装和启动：装配只依赖 `webServer`、`sessions`、`agents`
三个官方 host 服务，缺 `dropzone.exe` 只影响拖放功能（见下）。同理，不在手机壳里的桌面浏览器
也能照常装配，只是不推通知。

## 配置项

`config` 只有两项，都在 host 半（`lib/index.js` 的 `Config`，schema 约束写在代码里）：

| 配置项 | 默认值 | 取值范围 / 为空时怎样 |
|---|---|---|
| `titleMaxBytes` | `120` | 转发给手机的会话标题 UTF-8 字节上限，`16..512`；超出按字节安全截断，`0`/空会走默认 120 |
| `includeIdle` | `false` | `true` 时把没有 agent 的会话也推给手机；`false`（默认）只推运行中的 |

**dropzone 端口是客户端开关，不是 patch config**（浏览器读不到 host 配置）：

| 覆盖方式 | 默认值 | 说明 |
|---|---|---|
| `localStorage["kita-shell-bridge.dropzonePort"]` | `47615` | 必须与原生 dropzone 的 `config.ini` 里的端口一致；设为非整数或缺省时回落到 47615 |

改端口要**两边一起改**：`config.ini` 改了而 localStorage 没改，表现为「拖进去没反应」；
反之同理。浏览器控制台里设置：

```js
localStorage.setItem('kita-shell-bridge.dropzonePort', '47615')  // 与 config.ini 对齐
localStorage.removeItem('kita-shell-bridge.dropzonePort')        // 恢复默认 47615
```

其余行为是代码常量（不可配置）：通知轮询 `POLL_MS = 4000`、dropzone 轮询 `DROPZONE_POLL_MS = 900`、
失败退避 `DROPZONE_RETRY_MS = 15000`（第 3 次失败起）与 `DROPZONE_RETRY_MAX_MS = 60000`（第 10 次起）。

## 没有 dropzone.exe（或不在手机壳里）时怎么降级

| 缺失的东西 | 表现 | 恢复方式 |
|---|---|---|
| `window.DshShell`（桌面浏览器、非手机壳 WebView） | 轮询组件挂载后立刻返回，**一个请求都不发**；拖放半照常工作 | 在手机壳里打开即自动生效，不用重装 |
| `dropzone.exe` 没运行 | `/take` 失败被静默吞掉（不刷日志）：第 3 次失败起每 15s 试一次，第 10 次起每 60s 试一次 | 启动 `dropzone.exe` 后**不必刷新页面**：切回标签页（`visibilitychange`）会重置退避并立刻重试，或等退避到期自动接上 |
| 端口对不上（`config.ini` 与 localStorage 不一致） | 与「没运行」同表现，永远连不上 | 把两处端口改成同一个值 |
| `webServer` 路由注册失败（端口/API 变化、路由重名） | host 半只打一行 `[kita-dsh-shell-bridge] ... 已跳过` 日志并 return，**不抛错**；dsh 其余功能不受影响 | 修复冲突后重启 dsh web |

一句话：本包最差只是自己不做任何事，不会让对方的 profile 装配失败。

## 已知限制

- 通知只看 `running` 的 true/false **翻转**：两次轮询（4s）之间开始的极短任务可能整段错过。
- `/kita-shell/state` 是只读快照 + 同源围栏（`sec-fetch-site` / `Origin` 对 `Host`）。反向代理若改写
  `Host` 头，围栏会判 403 —— 手机端请走 kita-dsh-gateway 的配对鉴权入口，不要自己另加改头代理。
- `diagnostics` 会带回累计 poll 次数、最近一次 UA 与时间戳；只有会话存在性、标题与运行态，
  不含凭据，也不含消息内容。
- `includeIdle = true` 时手机也会收到空闲会话，更容易误报通知。
- dropzone 的 `/take` 是**破坏性**的（取走即清空）：多标签页并发轮询时只有抢到的那页能拿到路径，
  建议手机上只开一个 dsh 标签页。
- 拖放插入依赖官方 composer 的 `[data-composer-card]` 与 `[data-composer-input]` 两个标记；
  上游改名则退化为「把路径还回队列」而不是插入。
