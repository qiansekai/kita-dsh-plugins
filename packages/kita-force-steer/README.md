# kita-force-steer

composer 工具行的「强制插话」按钮：**打断当前 turn，并立即把草稿作为插话发送**。

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

本插件把两者合成一个手势：**先 cancel，再把草稿以 steer 投递**。于是消息不再排在长工具后面，
而是等被取消的活动收敛后立刻执行。

## 交互

按钮渲染在 `conversation.input.right`（提交按钮左侧）：

| 状态 | 行为 |
|---|---|
| agent 未运行 / 会话已删除 / 提交机器忙 | 禁用（title：仅运行中可强制插话） |
| 运行中 + 草稿为空 | 只打断（等价"停止生成"） |
| 运行中 + 草稿为纯文本 | 打断 + `prompt(草稿, 'steer')`（带本地 echo），成功后清空草稿 |
| 运行中 + 草稿带附件 | 打断 + 交回官方提交机器 `inputActions.submit()`（文件 receipt / 图片序列化只能走它），投递模式仍是会话的 busyEnter 偏好 |

清空草稿带防误删守卫：只有提交后草稿未被改动才清空。

## 装配（4 处 + 重启）

1. 包目录：`plugins-src/kita-force-steer`（与 monorepo `packages/kita-force-steer` 双落点）
2. `home/profiles/web/pnpm-workspace.yaml` 的 packages 列表加一行
3. `home/profiles/web/package.json` 的 dependencies 加 `"kita-force-steer": "workspace:*"`
4. `home/profiles/web/cordis.patch.yml` 加 `- insert:` 条目
5. `node_modules/kita-force-steer` 建 junction 指向 `plugins-src/kita-force-steer`

**新增客户端 entry 会改变启动图 → 必须重启 dsh web 才生效，硬刷新不够。**
不跑 `pnpm install`（dsh web 运行时重建 node_modules 会把 profile 依赖清空）。

## 限制

- 只处理纯文本草稿的直发路径；含附件时退回官方提交机器，此时投递模式受 `busyEnter` 设置影响
  （无论哪种模式，紧接着的 cancel 都保证它不必等当前 turn 跑完）。
- `ctx.sessions.binding(id)` 无值时（会话未 materialize）按钮禁用，不猜测。
- 打断会中止当前 turn 与正在跑的工具，这是本插件的语义本身；不想中断就用官方插话。
