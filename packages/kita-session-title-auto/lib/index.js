/**
 * kita-session-title-auto — all-prompts session title provider + agent pin tool.
 *
 * 1) Registers the sole `ctx.sessionTitle` provider at `all-prompts` cadence:
 *    after every eligible human message the harness asks the provider to
 *    regenerate the title from the RECENT messages. Generation is an auxiliary
 *    small-model call (separate request, tiny input/output), out-of-band from
 *    the main conversation request, so the main loop's prompt-prefix cache is
 *    untouched.
 * 2) Registers the `update_session_title` model tool: the agent can pin an
 *    accurate title at the exact moment a topic switches (a user-source title
 *    stops the automatic provider), or pass `resume_auto: true` to hand
 *    control back to the automatic system.
 */
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionTitleLlmConfigFields, registerSessionTitleLlmProvider } from '@deepseek-ai/dsh-session-title-llm'

export const name = 'kita-session-title-auto'

export const inject = ['sessionTitle', 'llm', 'sessions', 'tools', 'systemPrompt']

export const Config = z.object({
  targetWords: SessionTitleLlmConfigFields.targetWords,
  targetCjkCharacters: SessionTitleLlmConfigFields.targetCjkCharacters,
  maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
  provider: SessionTitleLlmConfigFields.provider,
  model: SessionTitleLlmConfigFields.model,
})

/** Client-visible projection: the latest accepted title's provenance and clock. */
const titleAutoMetaSchema = zod.object({
  kind: zod.union([zod.literal('fallback'), zod.literal('provider'), zod.literal('user'), zod.null()]),
  title: zod.union([zod.string(), zod.null()]),
  updatedAt: zod.union([zod.number(), zod.null()]),
  seq: zod.number(),
})

/** UTF-8-safe truncation of text to at most `limit` bytes. */
function truncateToBytes(text, limit) {
  let value = text
  while (Buffer.byteLength(value, 'utf8') > limit) value = value.slice(0, -1)
  return value
}

/**
 * Select the most recent human messages for one title revision (newest
 * carries the drift), under a byte budget so JSON framing can never exceed
 * maxInputBytes. A single oversized message is truncated instead of dropped.
 */
function selectRecentMessages(messages, maxInputBytes) {
  const budget = Math.max(64, maxInputBytes - 512) // headroom for JSON framing
  const picked = []
  let bytes = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const text = typeof message.text === 'string' ? message.text : ''
    const size = Buffer.byteLength(text, 'utf8')
    const remaining = budget - bytes
    if (size > remaining) {
      if (picked.length === 0) {
        const truncated = truncateToBytes(text, remaining)
        if (truncated.length > 0) picked.unshift({ seq: message.seq, text: truncated })
      }
      break
    }
    picked.unshift(message)
    bytes += size
  }
  if (picked.length === 0) throw new Error('all-prompts title provider requires one human message')
  return picked
}

export function apply(ctx, config) {
  registerSessionTitleLlmProvider(ctx, config, name, 'all-prompts', (messages) =>
    selectRecentMessages(messages, config.maxInputBytes))

  // Publish the latest title provenance to the client (`useProjection('kitaTitleAuto')`),
  // so the header mark can show ✨ (provider-maintained) / 📌 (user-pinned) and the
  // last automatic revision's clock. A new state reference is returned for every
  // `session/title` event — even when the text is unchanged — so the client sees
  // each real revision via `seq`.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: 'kitaTitleAuto',
      stateSchema: titleAutoMetaSchema,
      init: () => ({ kind: null, title: null, updatedAt: null, seq: -1 }),
      apply: (state, event) => {
        if (event.type !== 'session/title') return state
        return {
          kind: event.data.source.kind,
          title: event.data.title,
          updatedAt: event.time,
          seq: event.seq,
        }
      },
      wire: {
        viewSchema: titleAutoMetaSchema,
        view: (state) => state,
      },
      stateVersion: 1,
    })
  })

  ctx.tools.register(defineTool({
    name: 'update_session_title',
    description: '钉住或恢复当前会话的标题。默认：传 title 钉住一个新标题（≤ 24 字，用会话语言概括当前核心工作），钉住后系统后台自动重拟标题会暂停；传 resume_auto: true 则解除钉住、恢复系统自动维护标题。当会话核心主题明显变化、且你能起出比自动生成更准确的标题时使用；主题未变化时不要调用。',
    parameters: {
      title: {
        type: 'string',
        description: '新的会话标题，会被规范化后写入会话日志并钉住；与 resume_auto 二选一。'
      },
      resume_auto: {
        type: 'boolean',
        description: '为 true 时解除钉住并恢复系统自动维护标题；与 title 二选一。'
      }
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value !== null && typeof value === 'object' && value.ok) {
          if (value.unchanged) return [{ type: 'text', text: '会话标题已是「' + value.title + '」，无需更新。' }]
          if (value.resumed) return [{ type: 'text', text: '已解除钉住，恢复系统自动维护标题。当前标题「' + (value.title || '（暂无）') + '」' }]
          const prev = typeof value.previousTitle === 'string' && value.previousTitle.length > 0 ? '（原「' + value.previousTitle + '」）' : ''
          return [{ type: 'text', text: '已钉住会话标题为「' + value.title + '」' + prev }]
        }
        const err = value !== null && typeof value === 'object' && typeof value.error === 'string' ? value.error : '未知错误'
        return [{ type: 'text', text: '更新会话标题失败：' + err }]
      }
    },
    async execute(args, exec) {
      const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
      if (agent === undefined || agent === null) return { ok: false, error: '工具调用缺少 agent 上下文' }
      const session = agent.session !== undefined && agent.session !== null ? agent.session : ctx.sessions.get(agent.id)
      if (session === undefined) return { ok: false, error: '找不到 live 会话 ' + String(agent.id) }
      if (args.resume_auto === true) {
        try {
          const snapshot = await ctx.sessionTitle.refresh(session)
          return { ok: true, resumed: true, title: snapshot === undefined ? null : snapshot.title, sessionId: session.id }
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error) }
        }
      }
      const raw = typeof args.title === 'string' ? args.title : ''
      const trimmed = raw.trim()
      if (trimmed.length === 0) return { ok: false, error: '标题不能为空（或传 resume_auto: true 恢复自动维护）' }
      if (trimmed.length > 80) return { ok: false, error: '标题过长（' + String(trimmed.length) + ' 字符，上限 80），请精简' }
      const current = ctx.sessionTitle.get(session)
      try {
        const snapshot = ctx.sessionTitle.rename(session, trimmed)
        const previousTitle = current !== undefined && current.title !== snapshot.title ? current.title : undefined
        return {
          ok: true,
          unchanged: current !== undefined && current.title === snapshot.title,
          title: snapshot.title,
          previousTitle,
          sessionId: session.id
        }
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }
  }))

  ctx.systemPrompt.section({
    name: 'session-auto-title',
    order: 118,
    text: [
      '## 会话标题维护',
      '本会话的标题由系统自动维护（后台根据最新消息重拟）。',
      '当你明确知道主题已切换、且能起出比自动生成更准确的标题时，调用 `update_session_title` 钉住新标题（≤ 24 字，用会话语言）；主题未变化时不要调用。',
      '钉住后系统自动重拟暂停；若想恢复自动维护，调用 `update_session_title` 并传 `resume_auto: true`。'
    ].join('\n')
  })
}
