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

## 装配

profile 的 `cordis.patch.yml` 加一行 `insert`（见仓库 README 的双落点约定），
并在 `node_modules` 下补一个指向 `plugins-src` 的 junction。
**新增客户端 entry 改变启动图 ⇒ 必须重启 dsh web 才生效**（硬刷新不够）。
