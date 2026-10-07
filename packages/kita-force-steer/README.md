# kita-force-steer

忙时提交 = 真插话：**打断当前 turn，并立刻把草稿作为插话发出去**（默认行为，没有按钮）。

## 为什么需要它

官方已经有插话（steer），入口三处：设置里的 `ui-conversation.busyEnter`（忙时 Enter = 排队/插话）、
`Cmd/Ctrl+Enter`（按与设置相反的模式提交）、以及排队消息行上的「插话发送」。
但它们都是**软插话**：`agent.steer()` 把消息放进 `next-step` 收件箱，而 `ReactLoopAgent#preStep`
只在**每个 step 开始时**才领取它。一个 step = 一次模型请求 + 它的全部工具调用，所以当 agent 正卡在
一个跑几分钟的 `run_code` / bash 里时，插话要等这个 step 结束才会被模型看到。

真正"强制"的两块积木其实都在：

- `SessionFace.cancel()` —— 契约原文：*Cancel the running turn. Pending queued work remains and
  resumes in FIFO order after the Host reaches cancellation quiescence.*（`keepInbox: true`）
- abort 一路传到工具本身：`agent.cancel()` → `phase.abort.abort()` → 工具拿到的 signal →
  PTC runtime 杀掉它的 node 子进程（`dsh-ptc-runtime-node` 的 abort 监听）。

本插件把两者变成**忙时提交的默认语义**：agent 运行时，普通 Enter 与主发送按钮在 document 捕获阶段
被接管 —— **先 cancel，等它收敛（running 落 false）后，再把草稿交给官方提交机器**。于是消息不再排在
长工具后面，而是等被取消的活动收敛后立刻执行。

### 为什么投递必须用 queue、不能用 steer（2026-10-07 连修两轮）

第一版把草稿用 `session.prompt(content, 'steer')` 直接发出去 → 用户报「有概率直接停止会话而不是插话」。
第二版改成「等 cancel 收敛后再交给官方机器」→ 5 轮实测**仍然丢 1 轮**（等待窗口不可靠）。第三版才是对的。

根因在 Host 侧的分支：

```js
// dsh-api-session-controller: prompt
if (request.mode === "steer") agent.steer(message);   // next-STEP inbox
else agent.followup(message);                          // next-TURN inbox
```

- **steer → next-step 收件箱**：只在一个**活着的 turn** 里、到 step 边界才被领取。先 cancel 再投递，
  消息就落进一个**再也不会打开的 step 收件箱** → 静默消失 = 用户看到的"直接停止会话"。
- **queue → next-turn 收件箱**：当前 turn 一结束就被消费 —— cancel 已收敛、还在收敛、甚至 cancel 失败，
  都不影响送达。

而且官方的 `resolveSubmitMode()` 是按**客户端缓存的 running** 决定模式的，它与 Host 侧 cancel 的落地之间
存在窗口（实测：cancel 发出后 2 秒 running 仍未落，此时代官方机器就会选 steer，又踩回上面的坑）。

所以最终实现**不等待、也不依赖官方解析**：纯文本固定以 `queue` 直发
（`forceSteer.send(id, text, 'queue')`），附件仍交给官方提交机器、但只在 cancel 收敛后才交接。
`agent.steer()` 这条路径在本插件里彻底不再使用。

**不打断的退路照样留着**：`Cmd/Ctrl+Enter` 仍然走官方的 accelerated 手势（与 busyEnter 相反的
投递模式；`busyEnter=steer` 时它就是「排队」）。

## 交互

| 情况 | 行为 |
|---|---|
| agent 未运行 | 完全不介入，官方提交照旧 |
| 运行中 + 普通 Enter / 点「插话发送」 | 打断 + 插话（纯文本立刻以 queue 投递；附件交给官方机器） |
| 运行中 + Cmd/Ctrl+Enter | 不介入，官方「相反模式」（busyEnter=steer ⇒ 排队） |
| 运行中 + 草稿为空 | 不介入（不会因为空 Enter 误打断） |
| 斜杠 / @ 候选菜单打开 | Enter 归菜单，不介入 |
| Shift+Enter、IME 组合中、其它按键 | 不介入（换行 / 输入法） |
| 提交机器忙（adjudicating / submitting） | 不介入，交回官方输入条 |

插件**不渲染任何 UI**：它只是 `conversation.input.right` 座位上的一个无 DOM occupant，借座位的
runtime props 拿 `sessionId / useInput / useSession / inputActions`，然后在 `ctx.effect` 里挂
document 捕获监听。**只想打断不发送**用官方「停止生成」即可。

> 2026-10-07 变更：原先是一个 `⚡打断/插话` 按钮（点击才打断）。用户要求把"打断"变成发送的默认
> 语义并删掉按钮 —— 手机上那一行已经有 5 个控件，按钮既占宽度又和发送按钮语义重叠。

## 装配（4 处 + 硬刷新）

1. 包目录：`plugins-src/kita-force-steer`（与 monorepo `packages/kita-force-steer` 双落点）
2. `home/profiles/web/pnpm-workspace.yaml` 的 packages 列表加一行
3. `home/profiles/web/package.json` 的 dependencies 加 `"kita-force-steer": "workspace:*"`
4. `home/profiles/web/cordis.patch.yml` 加 `- insert:` 条目
5. `node_modules/kita-force-steer` 建 junction 指向 `plugins-src/kita-force-steer`

**改 `lib/client.js` 内容（entry 不变）→ 服务端 no-cache 现读该文件，硬刷新即生效，不用重启 dsh web。**
只有**新增/删除客户端 entry**（slot 注册项变化）才会改变启动图、必须重启。

不跑 `pnpm install`（dsh web 运行时重建 node_modules 会把 profile 依赖清空）。

离线验证：`node scripts/verify-client.mjs`（stub 掉 ModuleLoader / document / react，断言
注册面、cancel/steer 动词与整套手势策略：放行/拦截/时序/附件分支）。

## 限制

- 插话消息按 `queue` 语义作为**下一轮**进入对话，而不是塞进当前 turn 的 step 收件箱 —— 用户感知一致
  （当前 turn 已被打断），但没有"消息插进正在跑的 step"这种更细的语义；这正是可靠性的代价。
- **含附件的草稿**走官方 `inputActions.submit()`（文件 receipt 与图片序列化只在官方实现里），因此需要
  等 cancel 收敛（上限 `CANCEL_SETTLE_TIMEOUT_MS = 2000`）后才交接，以避开官方按缓存 running 选 steer
  的坑；这段窗口内如果是极端慢的收敛，消息仍会送达，只是可能作为排队项而不是立即插话。
- `ctx.sessions.binding(id)` 无值时（会话未 materialize）不介入，不猜测。
- 打断会中止当前 turn 与正在跑的工具（PTC 会杀掉 node 子进程），这是本插件的语义本身；
  不想中断就用 Cmd/Ctrl+Enter。
