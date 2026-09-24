/**
 * kita-channel-balance — host half.
 *
 * 把本机 DSH 各 provider（渠道）的「可用余额」聚合成一个只读快照，挂在 profile 的
 * webServer 上，供 client 半在 composer 工具行常驻展示。渠道与凭据都不写死：
 * 渠道从 settings 服务现场读，凭据每次通过 ctx.credentials.resolve(ref) 解析。
 *
 * 渠道来源（优先级从低到高合并）：
 *   1. settings.describe() 里各条目 providers 字典（llm-pi-ai 等）—— 中转站 / 自建反代
 *   2. settings.describe() 里形如 { apiKeyEnv, baseURL } 的单条配置 —— 官方 DeepSeek 路由
 *   3. Config.channels —— 显式覆盖：补 baseURL、声明 balanceUrl/format/currency、停用某渠道
 *
 * 余额端点（自动探测，命中即按 provider 缓存）：
 *   deepseek      GET {root}/user/balance                                -> balance_infos[].total_balance
 *   newapi        GET {root}/v1/dashboard/billing/subscription + /usage   -> hard_limit_usd - total_usage/100
 *   moonshot      GET {root}/v1/users/me/balance                          -> data.available_balance
 *   credit-grants GET {root}/dashboard/billing/credit_grants              -> total_available
 *   自定义         Config.channels[].balanceUrl（format 可钉解析器）
 *
 * 路由（与其它 kita-* 插件一致，先过同源校验）：
 *   GET  /kita-balance/state    -> 聚合快照（client 轮询）
 *   POST /kita-balance/refresh  -> 立即刷新并返回快照
 *
 * 凭据卫生：key 只在本文件内用于构造 Authorization 头，绝不进快照、日志或响应体。
 */
import z from '@deepseek-ai/schemastery'

export const name = 'kita-channel-balance'

/** webServer 提供路由；settings/credentials/agentDefaultModel 按需 ctx.get()，缺失时降级而非挂载失败。 */
export const inject = ['webServer']

const ROUTE_STATE = '/kita-balance/state'
const ROUTE_REFRESH = '/kita-balance/refresh'

/** 凭据引用名（环境变量名）语法，与 dsh-credentials 的 REF_PATTERN 保持一致。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** baseURL 里属于「协议后缀」的尾段；剥掉后才能拼回各家余额端点。 */
const PROTOCOL_SUFFIXES = ['/v1', '/v1beta', '/anthropic', '/openai', '/beta']

/** 探测到可用模板后的默认缓存时长。 */
const DEFAULT_ENDPOINT_CACHE_MS = 30 * 60 * 1000

/** new-api 对「无限额度」token 返回的额度哨兵值（controller/billing.go: amount = 100000000）。 */
const UNLIMITED_QUOTA_SENTINEL = 100_000_000

/** 官方 DeepSeek 路由未配置 baseURL 时的兜底端点；llm-deepseek 的默认值就是它。 */
const OFFICIAL_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

export const Config = z.object({
  /** 上游余额轮询间隔；client 半按同一节奏取快照。 */
  refreshIntervalMs: z.natural().default(60_000),
  /** 单个上游请求超时。 */
  requestTimeoutMs: z.natural().default(8_000),
  /** 端点模板命中后的缓存时长；超时才重新逐模板探测。 */
  endpointCacheMs: z.natural().default(DEFAULT_ENDPOINT_CACHE_MS),
  /** 视为「官方 DeepSeek」的 host；这些渠道优先读平台钱包，其次 API key 的 /user/balance。 */
  officialHosts: z.array(z.string()).default(['api.deepseek.com']),
  /** 官方路由（llm-deepseek）没有自带 baseURL 时的兜底端点；该插件默认就是这个。 */
  officialBaseURL: z.string().default(OFFICIAL_DEFAULT_BASE_URL),
  /** 显式渠道配置，按 provider 合并进自动发现的渠道。 */
  channels: z.array(z.object({
    provider: z.string().required(),
    /** 展示名；留空用 provider id。 */
    label: z.string().default(''),
    /** 覆盖自动发现的 baseURL。 */
    baseURL: z.string().default(''),
    /** 覆盖自动发现的凭据引用。 */
    apiKeyRef: z.string().default(''),
    /** 直接指定余额端点（最高优先级，不再探测）。 */
    balanceUrl: z.string().default(''),
    /** 自定义端点的解析器：deepseek / newapi / moonshot / credit-grants / generic。 */
    format: z.string().default(''),
    /** 币种覆盖（端点上不带币种时用）。 */
    currency: z.string().default(''),
    enabled: z.boolean().default(true),
  })).default([]),
})

/** 宽松取数：接口既有字符串金额也有数字金额。 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** 把 JSON 错误体里的人类可读信息抽出来（new-api 与 OpenAI 两种形态）。 */
function errorMessageOf(body) {
  if (body === null || typeof body !== 'object') return ''
  const error = body.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  if (typeof body.message === 'string') return body.message
  return ''
}

/** 一行 HTTP 结果的诊断描述（不回显响应体全文，避免把上游回显的用户信息带出去）。 */
function describeHttp(response) {
  if (response.timeout === true) return '请求超时'
  if (typeof response.error === 'string' && response.error !== '') return response.error
  if (response.status === 0) return '网络不可达'
  return 'HTTP ' + String(response.status)
}

/** GET 一个 JSON 端点；不抛异常，把失败编码进返回值。 */
async function readJson(url, key, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(key === '' ? {} : { authorization: 'Bearer ' + key }),
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    const text = await response.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    return { status: response.status, body }
  } catch (error) {
    const errorName = error !== null && typeof error === 'object' && 'name' in error ? String(error.name) : ''
    if (errorName === 'TimeoutError' || errorName === 'AbortError') {
      return { status: 0, body: null, timeout: true }
    }
    const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
    return { status: 0, body: null, error: message }
  }
}

/** 鉴权类失败：端点存在，但这一轮拿不到数据。 */
function authFailure(response, url, templateId) {
  const message = errorMessageOf(response.body)
  return {
    ok: false,
    usable: true,
    endpoint: url,
    templateId,
    error: 'auth',
    message: message === '' ? 'HTTP ' + String(response.status) + '（鉴权失败）' : message,
  }
}

/**
 * 端点模板。load 返回三态：
 *   { ok: true, balance }                          —— 命中并解析出余额
 *   { ok: false, usable: true, error: 'auth' }     —— 端点存在但这一轮拿不到（鉴权/上游错误）
 *   { ok: false, usable: false }                   —— 不是余额端点，继续试下一个
 */
const TEMPLATES = [
  {
    id: 'deepseek',
    label: 'DeepSeek /user/balance',
    matches: (channel) => channel.official || channel.hint === 'deepseek',
    rank: (channel) => (channel.official || channel.hint === 'deepseek' ? 3 : 0),
    async load({ channel, key, timeoutMs, root }) {
      const url = root + '/user/balance'
      const response = await readJson(url, key, timeoutMs)
      if (response.body === null) {
        return { ok: false, usable: false, endpoint: url, templateId: 'deepseek', message: describeHttp(response) }
      }
      const infos = Array.isArray(response.body.balance_infos) ? response.body.balance_infos : null
      if (infos === null || infos.length === 0) {
        if (errorMessageOf(response.body) !== '') return authFailure(response, url, 'deepseek')
        return { ok: false, usable: false, endpoint: url, templateId: 'deepseek', message: '响应里没有 balance_infos' }
      }
      const picked = infos.find((info) => info !== null && typeof info === 'object' && info.currency === 'CNY') ?? infos[0]
      return {
        ok: true,
        endpoint: url,
        templateId: 'deepseek',
        available: response.body.is_available !== false,
        balance: {
          currency: typeof picked.currency === 'string' ? picked.currency : channel.currency,
          total: toNumber(picked.total_balance),
          granted: toNumber(picked.granted_balance),
          toppedUp: toNumber(picked.topped_up_balance),
        },
      }
    },
  },
  {
    id: 'newapi',
    label: 'OpenAI 兼容 /v1/dashboard/billing',
    matches: () => true,
    rank: (channel) => (channel.hint === 'newapi' ? 2 : 1),
    async load({ channel, key, timeoutMs, root }) {
      const subscriptionUrl = root + '/v1/dashboard/billing/subscription'
      const subscription = await readJson(subscriptionUrl, key, timeoutMs)
      if (subscription.body === null) {
        return { ok: false, usable: false, endpoint: subscriptionUrl, templateId: 'newapi', message: describeHttp(subscription) }
      }
      const limit = toNumber(subscription.body.hard_limit_usd)
        ?? toNumber(subscription.body.system_hard_limit_usd)
        ?? toNumber(subscription.body.soft_limit_usd)
      if (limit === null) {
        if (errorMessageOf(subscription.body) !== '') return authFailure(subscription, subscriptionUrl, 'newapi')
        return { ok: false, usable: false, endpoint: subscriptionUrl, templateId: 'newapi', message: '响应里没有 hard_limit_usd' }
      }
      const usageUrl = root + '/v1/dashboard/billing/usage'
      const usage = await readJson(usageUrl, key, timeoutMs)
      const usedCents = usage.body === null ? null : toNumber(usage.body.total_usage)
      const used = usedCents === null ? null : usedCents / 100
      return {
        ok: true,
        endpoint: subscriptionUrl,
        templateId: 'newapi',
        balance: {
          currency: channel.currency === '' ? 'USD' : channel.currency,
          total: limit,
          used,
          remaining: used === null ? limit : limit - used,
          unlimited: limit >= UNLIMITED_QUOTA_SENTINEL,
        },
      }
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot /v1/users/me/balance',
    matches: (channel) => /moonshot/i.test(channel.provider + ' ' + channel.root),
    rank: () => 2,
    async load({ channel, key, timeoutMs, root }) {
      const url = root + '/v1/users/me/balance'
      const response = await readJson(url, key, timeoutMs)
      if (response.body === null) {
        return { ok: false, usable: false, endpoint: url, templateId: 'moonshot', message: describeHttp(response) }
      }
      const data = response.body.data !== null && typeof response.body.data === 'object' ? response.body.data : null
      const available = data === null ? null : toNumber(data.available_balance)
      if (available === null) {
        if (errorMessageOf(response.body) !== '') return authFailure(response, url, 'moonshot')
        return { ok: false, usable: false, endpoint: url, templateId: 'moonshot', message: '响应里没有 available_balance' }
      }
      return {
        ok: true,
        endpoint: url,
        templateId: 'moonshot',
        balance: {
          currency: channel.currency === '' ? 'CNY' : channel.currency,
          total: available,
          granted: toNumber(data.voucher_balance),
          toppedUp: toNumber(data.cash_balance),
        },
      }
    },
  },
  {
    id: 'credit-grants',
    label: '/dashboard/billing/credit_grants',
    matches: () => true,
    rank: () => 1,
    async load({ key, timeoutMs, root }) {
      const url = root + '/dashboard/billing/credit_grants'
      const response = await readJson(url, key, timeoutMs)
      if (response.body === null) {
        return { ok: false, usable: false, endpoint: url, templateId: 'credit-grants', message: describeHttp(response) }
      }
      const total = toNumber(response.body.total_available)
        ?? toNumber(response.body.total_remaining)
        ?? toNumber(response.body.total_granted)
      if (total === null) {
        if (errorMessageOf(response.body) !== '') return authFailure(response, url, 'credit-grants')
        return { ok: false, usable: false, endpoint: url, templateId: 'credit-grants', message: '响应里没有 total_available' }
      }
      return {
        ok: true,
        endpoint: url,
        templateId: 'credit-grants',
        balance: {
          currency: 'USD',
          total,
          used: toNumber(response.body.total_used),
        },
      }
    },
  },
]

/** 通用解析：自定义端点没有声明 format 时按已知字段名宽松取数。 */
function parseGeneric(body, currency) {
  if (body === null || typeof body !== 'object') return null
  const data = body.data !== null && typeof body.data === 'object' ? body.data : body
  const total = toNumber(data.balance)
    ?? toNumber(data.total_balance)
    ?? toNumber(data.remaining)
    ?? toNumber(data.available)
    ?? toNumber(data.total_available)
    ?? toNumber(data.remaining_balance)
  if (total === null) return null
  return {
    currency: currency === '' ? 'USD' : currency,
    total,
    granted: toNumber(data.granted_balance) ?? toNumber(data.voucher_balance),
    toppedUp: toNumber(data.cash_balance) ?? toNumber(data.topped_up_balance),
    used: toNumber(data.used) ?? toNumber(data.total_used),
  }
}

/** 自定义端点命中后的统一包装（保留 is_available 之类的可用性字段）。 */
function completion(body, url, balance) {
  return { ok: true, endpoint: url, templateId: 'custom', balance, available: body.is_available !== false }
}

/** 自定义端点：按声明的 format 选解析器，未声明时按已知字段名宽松取数。 */
async function loadCustomBalance(channel, key, timeoutMs) {
  const url = channel.balanceUrl
  const response = await readJson(url, key, timeoutMs)
  if (response.body === null) {
    return { ok: false, usable: false, endpoint: url, templateId: 'custom', message: describeHttp(response) }
  }
  if (channel.format === 'deepseek') {
    const infos = Array.isArray(response.body.balance_infos) ? response.body.balance_infos : []
    const picked = infos.find((info) => info !== null && typeof info === 'object' && info.currency === 'CNY') ?? infos[0]
    if (picked === undefined) return authFailure(response, url, 'custom')
    return completion(response, url, {
      currency: typeof picked.currency === 'string' ? picked.currency : channel.currency,
      total: toNumber(picked.total_balance),
      granted: toNumber(picked.granted_balance),
      toppedUp: toNumber(picked.topped_up_balance),
    })
  }
  if (channel.format === 'newapi') {
    const limit = toNumber(response.body.hard_limit_usd) ?? toNumber(response.body.system_hard_limit_usd)
    if (limit === null) return authFailure(response, url, 'custom')
    return completion(response, url, { currency: 'USD', total: limit })
  }
  if (channel.format === 'moonshot') {
    const data = response.body.data !== null && typeof response.body.data === 'object' ? response.body.data : {}
    const available = toNumber(data.available_balance)
    if (available === null) return authFailure(response, url, 'custom')
    return completion(response, url, {
      currency: 'CNY',
      total: available,
      granted: toNumber(data.voucher_balance),
      toppedUp: toNumber(data.cash_balance),
    })
  }
  const parsed = parseGeneric(response.body, channel.currency)
  if (parsed === null) {
    if (errorMessageOf(response.body) !== '') return authFailure(response, url, 'custom')
    return { ok: false, usable: false, endpoint: url, templateId: 'custom', message: '响应里没有可识别的余额字段' }
  }
  return { ok: true, endpoint: url, templateId: 'custom', balance: parsed }
}

/** baseURL 剥掉协议后缀，得到拼装余额端点用的根。 */
function rootOf(baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim() === '') return ''
  let url
  try {
    url = new URL(baseURL.trim())
  } catch {
    return ''
  }
  let path = url.pathname.replace(/[/]+$/u, '')
  let stripping = true
  while (stripping && path !== '') {
    stripping = false
    for (const suffix of PROTOCOL_SUFFIXES) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, -suffix.length)
        stripping = true
      }
    }
  }
  return url.origin + path
}

/** 渠道 id -> hint：提示首选的端点模板。 */
function hintOf(provider, root) {
  if (/deepseek/i.test(provider) || /api[.]deepseek[.]com/i.test(root)) return 'deepseek'
  if (/newapi|one-?api|new-api/i.test(provider)) return 'newapi'
  return ''
}

/** 合并一条渠道定义；后写的非空字段覆盖先前的。 */
function mergeChannel(map, input) {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  if (provider === '') return
  const existing = map.get(provider) ?? {
    provider,
    label: '',
    baseURL: '',
    apiKeyRef: '',
    balanceUrl: '',
    format: '',
    currency: '',
    officialRoute: false,
    enabled: true,
  }
  map.set(provider, {
    ...existing,
    label: input.label === undefined || input.label === '' ? existing.label : input.label,
    baseURL: input.baseURL === undefined || input.baseURL === '' ? existing.baseURL : input.baseURL,
    apiKeyRef: input.apiKeyRef === undefined || input.apiKeyRef === '' ? existing.apiKeyRef : input.apiKeyRef,
    balanceUrl: input.balanceUrl === undefined || input.balanceUrl === '' ? existing.balanceUrl : input.balanceUrl,
    format: input.format === undefined || input.format === '' ? existing.format : input.format,
    currency: input.currency === undefined || input.currency === '' ? existing.currency : input.currency,
    officialRoute: input.officialRoute === true || existing.officialRoute === true,
    enabled: input.enabled === undefined ? existing.enabled : input.enabled,
  })
}

/** 现场收集渠道：settings 投影 + 显式配置。 */
function collectChannels(ctx, config) {
  const map = new Map()
  const settings = ctx.get('settings')
  if (settings !== undefined && settings !== null) {
    let descriptors = []
    try {
      descriptors = settings.describe()
    } catch {
      descriptors = []
    }
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      const value = descriptor === null || descriptor === undefined ? null : descriptor.value
      if (value === null || typeof value !== 'object') continue
      const providers = value.providers
      if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [provider, entry] of Object.entries(providers)) {
          if (entry === null || typeof entry !== 'object') continue
          mergeChannel(map, {
            provider,
            label: typeof entry.displayName === 'string' ? entry.displayName : '',
            baseURL: typeof entry.baseURL === 'string' ? entry.baseURL : '',
            apiKeyRef: typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : '',
          })
        }
        continue
      }
      // 形如 llm-deepseek 的单条配置：官方 DeepSeek 路由只带 apiKeyEnv，baseURL 是可选覆盖，
      // 因此不能拿 baseURL 是否存在当判据 —— 缺失时用 config.officialBaseURL 兜底。
      const officialRoute = String(descriptor === null || descriptor === undefined ? '' : descriptor.ns ?? '') === 'llm-deepseek'
        || typeof value.apiKeyEnv === 'string'
        || typeof value.baseURL === 'string'
      if (officialRoute) {
        mergeChannel(map, {
          provider: 'deepseek-official',
          baseURL: typeof value.baseURL === 'string' ? value.baseURL : '',
          apiKeyRef: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : 'DEEPSEEK_API_KEY',
          officialRoute: true,
        })
      }
    }
  }
  for (const entry of config.channels) mergeChannel(map, entry)

  const officialBaseURL = typeof config.officialBaseURL === 'string' && config.officialBaseURL !== ''
    ? config.officialBaseURL
    : OFFICIAL_DEFAULT_BASE_URL
  const channels = []
  for (const channel of map.values()) {
    if (channel.enabled === false) continue
    const baseURL = channel.baseURL !== ''
      ? channel.baseURL
      : (channel.officialRoute === true ? officialBaseURL : '')
    const root = rootOf(baseURL !== '' ? baseURL : channel.balanceUrl)
    const official = channel.officialRoute === true || config.officialHosts.some((host) => {
      const trimmed = String(host).trim()
      return trimmed !== '' && root.toLowerCase().includes(trimmed.toLowerCase())
    })
    channels.push({
      ...channel,
      label: channel.label === '' ? channel.provider : channel.label,
      baseURL,
      root,
      official,
      hint: hintOf(channel.provider, root),
    })
  }
  channels.sort((left, right) => {
    if (left.official !== right.official) return left.official ? -1 : 1
    return left.provider.localeCompare(right.provider)
  })
  return channels
}

/** 按次解析凭据：credentials 服务优先，退回宿主环境变量；空即未配置。 */
async function resolveKey(ctx, ref) {
  if (typeof ref !== 'string' || ref === '' || !REF_PATTERN.test(ref)) return ''
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved !== null && typeof resolved.value === 'string' && resolved.value !== '') {
        return resolved.value
      }
    } catch {
      // 解析失败退回环境变量
    }
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/** 探测顺序：hint 命中的模板优先，其次是通用模板。 */
function orderedTemplates(channel) {
  return TEMPLATES
    .map((template) => ({ template, rank: template.matches(channel) ? template.rank(channel) : -1 }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => right.rank - left.rank)
    .map((entry) => entry.template)
}

/**
 * 官方 DeepSeek 渠道优先读平台账号钱包（登录态，Host-only）：
 * `deepseekAccount.getBalance()` 给出充值余额与赠金余额，比 API key 的 /user/balance 更权威。
 * 未登录 / 查询失败返回 null，调用方继续走 API key 的端点探测。
 */
async function readPlatformBalance(ctx, channel) {
  if (channel.official !== true) return null
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null) return null
  let details = null
  try {
    details = await account.getBalance()
  } catch {
    return null
  }
  if (details === null || details === undefined || details.status !== 'ready') return null
  const wallets = Array.isArray(details.value) ? details.value : []
  if (wallets.length === 0) return null
  const bonusWallets = Array.isArray(details.bonusWallets) ? details.bonusWallets : []
  const toppedUp = toNumber(wallets[0].balance)
  const granted = bonusWallets.length === 0 ? null : toNumber(bonusWallets[0].balance)
  return {
    ok: true,
    endpoint: 'deepseekAccount.getBalance()',
    templateId: 'deepseek-platform',
    available: true,
    balance: {
      currency: typeof wallets[0].currency === 'string' ? wallets[0].currency : channel.currency,
      total: (toppedUp ?? 0) + (granted ?? 0),
      granted,
      toppedUp,
    },
  }
}

/** 查一个渠道：平台钱包（官方）> 自定义端点 > 模板缓存 > 逐模板探测。 */
async function queryChannel(ctx, channel, config, cache) {
  const base = {
    provider: channel.provider,
    label: channel.label,
    baseURL: channel.baseURL,
    official: channel.official,
    checkedAt: Date.now(),
  }
  if (channel.root === '' && channel.balanceUrl === '') {
    return { ...base, status: 'unsupported', message: '渠道没有可用的 baseURL' }
  }
  const key = await resolveKey(ctx, channel.apiKeyRef)
  const keyMissing = channel.apiKeyRef !== '' && key === ''
  const timeoutMs = config.requestTimeoutMs
  const root = channel.root

  let result = null
  if (channel.balanceUrl === '' && channel.official === true) {
    result = await readPlatformBalance(ctx, channel)
  }
  if (result === null && channel.balanceUrl !== '') {
    result = await loadCustomBalance(channel, key, timeoutMs)
  } else if (result === null) {
    const cached = cache.endpoints.get(channel.provider)
    if (cached !== undefined && Date.now() - cached.at < config.endpointCacheMs) {
      const template = TEMPLATES.find((candidate) => candidate.id === cached.templateId)
      if (template !== undefined) {
        const retried = await template.load({ channel, key, timeoutMs, root })
        if (retried.ok || retried.usable) {
          result = retried
        } else {
          cache.endpoints.delete(channel.provider)
        }
      }
    }
    if (result === null) {
      const authFailures = []
      for (const template of orderedTemplates(channel)) {
        const probed = await template.load({ channel, key, timeoutMs, root })
        if (probed.ok) {
          cache.endpoints.set(channel.provider, { templateId: template.id, endpoint: probed.endpoint ?? '', at: Date.now() })
          result = probed
          break
        }
        if (probed.usable) authFailures.push(probed)
      }
      if (result === null && authFailures.length > 0) {
        result = authFailures[0]
        cache.endpoints.set(channel.provider, { templateId: result.templateId, endpoint: result.endpoint ?? '', at: Date.now() })
      }
    }
  }

  if (result === null) {
    return { ...base, status: 'unsupported', message: '没有探测到余额端点' }
  }
  if (result.ok) {
    return {
      ...base,
      status: 'ok',
      balance: result.balance,
      available: result.available !== false,
      endpoint: result.endpoint ?? '',
      template: result.templateId ?? '',
    }
  }
  const keyNote = keyMissing ? '凭据 ' + channel.apiKeyRef + ' 未配置；' : ''
  return {
    ...base,
    status: keyMissing ? 'no-key' : (result.error === 'auth' ? 'auth' : 'error'),
    message: keyNote + String(result.message ?? '余额查询失败'),
    endpoint: result.endpoint ?? '',
    template: result.templateId ?? '',
  }
}

/** 组装一份快照：默认路由 + 各渠道余额。 */
async function buildSnapshot(ctx, config, cache) {
  const channels = collectChannels(ctx, config)
  const results = await Promise.all(channels.map((channel) => queryChannel(ctx, channel, config, cache)))

  let active = null
  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel !== undefined && defaultModel !== null) {
    try {
      const selection = defaultModel.currentSelection()
      if (selection !== null && selection !== undefined) {
        active = { provider: String(selection.provider ?? ''), model: String(selection.model ?? '') }
      }
    } catch {
      active = null
    }
  }

  return {
    ok: true,
    generatedAt: Date.now(),
    refreshIntervalMs: config.refreshIntervalMs,
    active,
    channels: results,
  }
}

export function apply(ctx, config) {
  /** 端点探测缓存 + 快照缓存；inflight 保证同一时刻只跑一轮。 */
  const cache = { state: null, inflight: null, endpoints: new Map() }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  }

  /** 同源校验：与 kita-dsh-restart 同一口径（跨站 fetch 带不匹配 Origin 或 Sec-Fetch-Site: cross-site）。 */
  function isTrustedRequest(req) {
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      return new URL(origin).host === new URL('http://' + host).host
    } catch {
      return false
    }
  }

  /** 取快照；force 时忽略新鲜度直接重建。 */
  function snapshot(force) {
    if (cache.inflight !== null) return cache.inflight
    if (!force && cache.state !== null && Date.now() - cache.state.generatedAt < config.refreshIntervalMs) {
      return Promise.resolve(cache.state)
    }
    cache.inflight = buildSnapshot(ctx, config, cache).then(
      (state) => {
        cache.state = state
        cache.inflight = null
        return state
      },
      (error) => {
        cache.inflight = null
        throw error
      },
    )
    return cache.inflight
  }

  async function handleState(req, res) {
    if (req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'GET only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    try {
      json(res, 200, await snapshot(false))
    } catch (error) {
      const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      json(res, 500, { ok: false, error: message })
    }
  }

  async function handleRefresh(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    try {
      json(res, 200, await snapshot(true))
    } catch (error) {
      const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      json(res, 500, { ok: false, error: message })
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: (req, res) => { void handleState(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: ROUTE_REFRESH, handler: (req, res) => { void handleRefresh(req, res) } }),
  ]
  ctx.effect(() => () => {
    for (const disposer of disposers) disposer()
  }, 'kita-channel-balance: routes')

  // 上游余额按间隔自刷新，client 只读快照；首轮延迟一拍，避免拖慢进程启动。
  const bootstrap = setTimeout(() => {
    void snapshot(true).catch(() => {})
  }, 1_500)
  const timer = setInterval(() => {
    void snapshot(true).catch(() => {})
  }, config.refreshIntervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => {
    clearTimeout(bootstrap)
    clearInterval(timer)
  }, 'kita-channel-balance: refresh timer')
}
