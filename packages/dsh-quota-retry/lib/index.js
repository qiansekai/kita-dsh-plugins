/**
 * dsh-quota-retry — 余额/额度不足 + 凭据类错误的延迟自动重试插件（零依赖、纯 ESM、免构建）。
 *
 * 问题背景：LLM 请求失败时，官方 dsh-llm-retry 的默认 retryableCodes
 * （EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）不含两类"终态"错误：
 * - QUOTA（Insufficient Balance / insufficient quota / credits exhausted → 余额额度耗尽）
 * - AUTH / INVALID_CREDENTIAL（"API key is invalid" → 401/403 鉴权失败）
 * 于是恢复点放行 → agent 循环直接抛 LlmError → 本轮运行直接停下。
 *
 * 本插件挂在同一个恢复扩展点 agent/request-error 上（运行时注入，排在任何
 * 官方监听之后，只接手它们放行的失败），分两种策略接管：
 *
 * 1. retryCodes（默认 ["QUOTA"]）——**无界长退避**：余额/额度耗尽按"人"的时间尺度
 *    等待充值（默认首次 60s、封顶 30min、不限次数，不主动放弃）。
 * 2. boundedRetryCodes（默认 ["AUTH"]）——**有界短退避**：鉴权/凭据错误可能是
 *    网关/中继的瞬态故障（如 new-api/one-api 上游 key 轮换、通道抽风、限流被映射成
 *    401），值得等一会再试；但真坏 key 重试 N 次结果相同，所以必须有次数上限
 *    （默认首次 10s、封顶 2min、最多 5 次，超过后仍失败 → 透传原错误，本轮停下报错）。
 *
 * 其余失败一律 next() 透传，不影响既有行为。
 *
 * 持久性：与官方 llm-retry 同语义——重试排程先落 session 事件（retry/scheduled）
 * 再进入可取消等待；同 turn/step/provider 按"策略键（含模式）"计数，
 * 断点续跑/多次失败不重置计数；等待期间插件热重载会中止等待（同 llm-retry）。
 *
 * 设计取舍：零运行时 import（不引 cordis/schemastery 运行时模块）——
 * 无需 node_modules junction、无解析/版本漂移风险，DSH 升级不报废；
 * config 手动校验 + 默认值（等价于 schemastery schema 的语义）。
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-quota-retry'
export const inject = ['agents']

const RETRY_EVENT = 'retry/scheduled'
const RETRY_STARTED_EVENT = 'retry/started'

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  /** 无界长退避的错误码集合（默认只处理余额/额度耗尽 QUOTA）。 */
  retryCodes: Object.freeze(['QUOTA']),
  /** 无界模式首次等待毫秒——给充值留时间。 */
  initialDelayMs: 60_000,
  /** 无界模式退避封顶毫秒。 */
  maxDelayMs: 1_800_000,
  /** 抖动比例 0..1，避免并发恢复同步撞车。 */
  jitterRatio: 0.2,
  /** 无界模式单步最大重试次数；0 = 不限（额度耗尽不主动放弃）。 */
  maxRetries: 0,
  /** 有界短退避的错误码集合（默认处理鉴权失败 AUTH；留空数组 = 禁用该模式）。 */
  boundedRetryCodes: Object.freeze(['AUTH']),
  /** 有界模式首次等待毫秒。 */
  boundedInitialDelayMs: 10_000,
  /** 有界模式退避封顶毫秒。 */
  boundedMaxDelayMs: 120_000,
  /** 有界模式最大重试次数（超过后仍失败 → 透传原错误停下）。 */
  boundedMaxRetries: 5,
})

const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS))

function validateCodeList(value, key, { allowEmpty }) {
  if (!Array.isArray(value)) throw new Error(`dsh-quota-retry: ${key} must be an array of non-empty strings`)
  if (!allowEmpty && value.length === 0) throw new Error(`dsh-quota-retry: ${key} must not be empty`)
  if (value.some((code) => typeof code !== 'string' || code.length === 0)) {
    throw new Error(`dsh-quota-retry: ${key} must contain only non-empty strings`)
  }
  if (new Set(value).size !== value.length) throw new Error(`dsh-quota-retry: ${key} must not contain duplicates`)
}

function validateConfig(config) {
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`dsh-quota-retry: unknown config key "${key}"`)
  }
  validateCodeList(config.retryCodes, 'retryCodes', { allowEmpty: false })
  validateCodeList(config.boundedRetryCodes, 'boundedRetryCodes', { allowEmpty: true })
  for (const key of ['initialDelayMs', 'maxDelayMs', 'boundedInitialDelayMs', 'boundedMaxDelayMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`dsh-quota-retry: ${key} must be a positive finite number`)
    }
  }
  if (config.initialDelayMs > config.maxDelayMs) {
    throw new Error('dsh-quota-retry: initialDelayMs must be less than or equal to maxDelayMs')
  }
  if (config.boundedInitialDelayMs > config.boundedMaxDelayMs) {
    throw new Error('dsh-quota-retry: boundedInitialDelayMs must be less than or equal to boundedMaxDelayMs')
  }
  if (!Number.isFinite(config.jitterRatio) || config.jitterRatio < 0 || config.jitterRatio > 1) {
    throw new Error('dsh-quota-retry: jitterRatio must be between 0 and 1')
  }
  if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new Error('dsh-quota-retry: maxRetries must be a non-negative safe integer (0 = unlimited)')
  }
  if (!Number.isSafeInteger(config.boundedMaxRetries) || config.boundedMaxRetries < 1) {
    throw new Error('dsh-quota-retry: boundedMaxRetries must be a positive safe integer')
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  validateConfig(cfg)
  const random = Math.random
  const lifetime = new AbortController()
  const active = new Set()
  const track = (operation) => {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  function localDelay(plan, retry) {
    const exponent = Math.min(retry - 1, 1024)
    const exponential = Math.min(plan.initialDelayMs * 2 ** exponent, plan.maxDelayMs)
    const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * random()
    return Math.min(exponential * jitter, cfg.maxDelayMs)
  }

  function cancellableDelay(delayMs, signal) {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, delayMs)
      function onAbort() {
        clearTimeout(timer)
        resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function recover({ agent, turn, step, provider, failure, signal }, next) {
    // 匹配策略：有界（bounded）优先于无界（unbounded）；都不匹配 → 透传。
    let plan = null
    if (cfg.boundedRetryCodes.includes(failure.code)) {
      plan = {
        mode: 'bounded',
        label: '凭据/鉴权失败',
        codes: cfg.boundedRetryCodes,
        maxRetries: cfg.boundedMaxRetries,
        initialDelayMs: cfg.boundedInitialDelayMs,
        maxDelayMs: cfg.boundedMaxDelayMs,
      }
    } else if (cfg.retryCodes.includes(failure.code)) {
      plan = {
        mode: 'unbounded',
        label: '余额/额度不足',
        codes: cfg.retryCodes,
        maxRetries: cfg.maxRetries,
        initialDelayMs: cfg.initialDelayMs,
        maxDelayMs: cfg.maxDelayMs,
      }
    }
    if (!plan) return next()
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    // 策略键含 mode：同 turn/step/provider 下两种模式计数互不干扰。
    const policyKey = JSON.stringify([
      plan.mode,
      [...plan.codes].sort(),
      plan.initialDelayMs,
      plan.maxDelayMs,
      cfg.jitterRatio,
      plan.maxRetries,
    ])
    // 重试计数从持久 session 事件推导（多次失败/断点续跑不重置）。
    const prior = agent.session.events.findLast((event) =>
      event.type === RETRY_EVENT
      && event.data.turn === turn
      && event.data.step === step
      && event.data.provider === provider
      && event.data.policyKey === policyKey)
    const previous = prior?.data.retry ?? 0
    if (plan.maxRetries > 0 && previous >= plan.maxRetries) return next()
    const retry = previous + 1
    const retryId = prior?.data.retryId ?? randomUUID()
    // 供应商显式给的 Retry-After（如 failure.providerRetryAfterMs）优先，封顶到该模式 maxDelayMs。
    let delayMs
    if (failure.providerRetryAfterMs !== void 0
      && Number.isFinite(failure.providerRetryAfterMs)
      && failure.providerRetryAfterMs > 0) {
      delayMs = Math.min(failure.providerRetryAfterMs, plan.maxDelayMs)
    } else {
      delayMs = localDelay(plan, retry)
    }
    // 先落事件（持久化排程），再进入可取消等待。
    agent.session.append(RETRY_EVENT, {
      retryId,
      turn,
      step,
      provider,
      mode: plan.mode,
      policyKey,
      retry,
      ...(plan.maxRetries > 0 ? { maxRetries: plan.maxRetries } : {}),
      delayMs,
      failure,
    })
    ctx.logger?.warn?.(
      `[dsh-quota-retry] provider "${provider}" ${plan.label}（${failure.code}: ${failure.message}）`
      + `——第 ${retry} 次重试将于 ${Math.round(delayMs / 1000)}s 后开始，本轮保持挂起不停止`
      + (plan.maxRetries > 0 ? `（最多 ${plan.maxRetries} 次）` : ''))
    if (!(await cancellableDelay(delayMs, fusedSignal))) return
    agent.session.append(RETRY_STARTED_EVENT, { retryId, turn, step, retry })
    ctx.logger?.info?.(`[dsh-quota-retry] provider "${provider}" 第 ${retry} 次重试开始`)
    return { kind: 'retry' }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(void 0)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('dsh-quota-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'dsh-quota-retry: abort and drain active recovery')
}
