# kita-session-title-auto

会话标题自动维护插件（host + client），挂在 dsh web profile 上。

## 功能

1. **all-prompts 标题提供者**：注册唯一的 `ctx.sessionTitle` 提供者，档位
   `all-prompts`——每条人类消息后，后台用**小模型旁路调用**（独立请求，
   最近消息为输入、64 token 输出）重拟会话标题。完全不进入主循环请求，
   **不影响主对话的 prompt 前缀缓存**。路由默认钉在 `newapi / deepseek-v4-flash`。
2. **`update_session_title` 工具**：agent 在主题切换瞬间可钉住一个更准确的
   标题（user 来源，钉住后自动重拟暂停）；传 `resume_auto: true` 解除钉住、
   恢复自动维护。
3. **提示段**：告知 agent 何时该主动钉住标题。
4. **标题旁标记（client 半）**：host 注册 `kitaTitleAuto` 投影（最新
   `session/title` 事件的 kind/title/updatedAt/seq），client 在
   `conversation.session.header.actions`（order -20）渲染：
   - ✨ = 标题由 AI 自动维护；每次重拟**且文本变化**时弹出「已更新」
     高亮约 4 秒（动画结束事件自清理，无定时器）；
   - 📌 = 标题被钉住（自动重拟暂停）；
   - 悬停 tooltip 显示「最近更新 HH:MM:SS」（每次重拟的 `seq` 都推进
     tooltip 时钟，即使文本未变）。

## 装配

- 行：`kita-session-title-auto`（profile `cordis.patch.yml` insert）
- 依赖：`@deepseek-ai/dsh-session-title-llm`（官方共享生成策略）、
  `@deepseek-ai/dsh-tools`（defineTool）、`zod`（投影 schema）
- client 半由 `package.json` 的 `dsh.client` 声明自动进入模块图
  （`lib/client.js` 是 `window.__ModuleLoader__` 形式的 CJS bundle，
  仅依赖静态表 `react`），**无需改动装配行**
- **必须同时禁用**官方 `session-title-llm`
  （`@deepseek-ai/dsh-session-title-first-prompt-llm`）行——标题提供者是
   单例，两个同挂会注册冲突。

## 消息选取策略

倒序取最近的人类消息，字节预算 = `maxInputBytes - 512`（JSON 框架余量）；
单条超长消息截断而不是丢弃；`messageSeqs` 保留原始 seq，满足标题来源不变量。
