# kita-session-title-auto

会话标题维护插件（host + client）。按 DSH 0.2.1-rc.2 的 **bundle 插件形态**分发：
自带 `cordis.patch.yml`，包名进 profile 的 `dsh.profile.bundles` 即生效，
不需要手改 profile 的 `cordis.patch.yml`。

## 做什么

1. **`update_session_title` 工具**：agent 在主题切换的瞬间钉住一个更准确的标题
   （user 来源，钉住后自动重拟暂停）；传 `resume_auto: true` 解除钉住、恢复自动维护。
2. **提示段**：`session-auto-title`（order 118），告知 agent 何时该主动钉住标题、何时别调。
3. **标题旁标记（client 半）**：host 注册 `kitaTitleAuto` 投影（最新
   `session/title` 事件的 kind / title / updatedAt / seq），client 在
   `conversation.session.header.actions`（order -20）渲染：
   - ✨ = 标题由 AI 自动维护；每次重拟**且文本变化**时弹出「已更新」高亮约 4 秒
     （动画结束事件自清理，无定时器）；
   - 📌 = 标题被钉住（自动重拟暂停）；
   - 悬停 tooltip 显示「最近更新 HH:MM:SS」（每次重拟的 `seq` 都推进 tooltip 时钟，
     即使文本未变）。

> 2026-10-13（对齐 DSH 0.2.1）：**自动重拟本身已交给官方**。0.2.1 用
> `executeSessionTitleLlm` 取代了旧的 `registerSessionTitleLlmProvider`，
> 官方 `@deepseek-ai/dsh-experimental-session-titles-bundle`（`all-prompts` 档位，内部是
> `@deepseek-ai/dsh-session-title-all-prompts-llm`）就是「每条人类消息后旁路小模型重拟、
> 不碰主循环 prompt 前缀缓存」的现成实现。本包因此**不再注册** `ctx.sessionTitle` 提供者，
> host 半只剩工具 / 投影 / 提示段。

## 装法与版本要求

- DSH **0.2.1-rc.2**（随包 `@deepseek-ai/cordis ~4.0.5`、`@deepseek-ai/schemastery ~3.18.5`）。
  0.2.x 应可用；0.1.x 没有 bundle 形态与 `executeSessionTitleLlm`，不保证可用。
- 本包 peer：`@deepseek-ai/cordis ~4.0.5`、`@deepseek-ai/dsh-tools >=0.2.1-rc.2 <0.3.0-0`、
  `zod >=4.0.0 <5.0.0`。**不再依赖** `@deepseek-ai/dsh-session-title-llm` 与
  `@deepseek-ai/schemastery`（`lib/index.js` 只 import `zod` 和 `@deepseek-ai/dsh-tools`）。
- 安装（仓库根，任选其一）：
  - `node scripts/install.mjs --only kita-session-title-auto`
  - 手动：`dsh plugin --profile web add link:<仓库绝对路径>/packages/kita-session-title-auto`，
    再把 `kita-session-title-auto` 加进 `<DSH_HOME>/profiles/web/package.json` 的
    `dsh.profile.bundles`，重启 dsh web（host 半 + 新增 client entry 都要重启）。
- **想要自动重拟，官方 bundle 必须同时装**：`@deepseek-ai/dsh-experimental-session-titles-bundle`
  也要在 `dsh.profile.bundles` 里。本包自带 patch 会停用 `session-title-llm`（官方首条消息
  提供者）；若不同时装官方 all-prompts bundle，就没有任何自动重拟提供者，标题只剩「首条消息」
  兜底 —— 钉住工具与标记仍然可用。
- 自定义标题模型路由时，别在本包行写 config，改官方提供者那一行（见下表）。

## 配置项

本包**没有** `Config` schema：`apply(ctx, config)` 不读 config，patch 里写 `config` 不会生效
（2026-10-13 起，原 schemastery `Config` 已随旧提供者一起删除）。

真正可调的是它依赖的官方 all-prompts 提供者那一行，在 profile 的 `cordis.patch.yml` 按 `id`
覆盖即可（默认值来自官方 bundle 自带的 patch）：

| 行 id | 配置项 | 默认值 | 说明 / 为空时 |
|---|---|---|---|
| `optional-session-title-all-prompts` | `targetWords` | `5` | 英文标题目标词数 |
| 〃 | `targetCjkCharacters` | `10` | 中日韩标题目标字数 |
| 〃 | `maxInputBytes` | `4096` | 输入字节上限（必填，共享 schema 无库默认值） |
| 〃 | `maxOutputTokens` | `64` | 输出 token 上限（必填）；是上限不是目标，推理模型的思考也算在内 |
| 〃 | `timeoutMs` | `60000` | 单次旁路请求的硬超时（必填，≤ Node 定时器上限） |
| 〃 | `provider` / `model` | 空（不覆盖） | 必须成对出现且非空；**为空时**沿用该会话 `request/header` 记下的模型路由；两者都为空且会话没有可用的请求路由时，该次重拟报错（只落 logger 警告，不影响对话） |

例（优先级：profile patch 覆盖 bundle 自带值）：

```yaml
- id: optional-session-title-all-prompts
  config:
    maxOutputTokens: 96
    provider: newapi
    model: deepseek-v4-flash
```

`provider` / `model` 必须是本机已配置的 provider / 模型名，写错只影响标题重拟。

## 已知限制

- 只负责「钉住 / 恢复 / 标记」，**不产生标题**；自动重拟依赖上面的官方 bundle。
- 标题提供者是**单例**：同一时刻只允许一个 `ctx.sessionTitle` 提供者。本包 patch 已停用官方
  `session-title-llm`；若你另装了别的提供者包，装配期会报
  `session-title provider "..." is already registered`，那是 id 冲突/装配顺序问题，不是本包故障。
- 重拟是**旁路小模型调用**，会额外花 token（输入上限 4096 字节、输出上限 64 token）。失败只写
  logger 警告（`dsh-session-title` 内部 `ctx.logger.warn(...automatic title generation failed...)`），
  不打断主流程、不影响装配。
- `update_session_title` 需要 agent 上下文（`exec.agent`）才能执行；标题上限 80 字符（提示词建议
  ≤ 24 字）。空标题、超长标题、找不到 live 会话都返回结构化错误，不抛异常。
- client 半的产物 `lib/client.js` 已入库，是 `window.__ModuleLoader__.load({ id, factory })` 形式的
  CJS bundle，只 require 静态表里的 `react`；朋友安装不需要自行构建。改它必须保持该形式。

## 附录：消息选取策略（历史实现，现由官方提供者承担）

`all-prompts` 档位的选取策略：倒序取最近的人类消息，字节预算 = `maxInputBytes - 512`
（JSON 框架余量）；单条超长消息截断而不是丢弃；`messageSeqs` 保留原始 seq，满足标题来源不变量。

`lib/index.js` 里的 `truncateToBytes()` / `selectRecentMessages()` 是这段历史的留存参考，
2026-10-13 起 `apply()` 已不再调用（官方 `dsh-session-title-all-prompts-llm` 负责选取）。
