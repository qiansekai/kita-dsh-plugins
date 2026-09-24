/**
 * verify-host.mjs — 离线验证 host 半：不启动 dsh，直接 apply() 到 mock ctx 上，
 * 然后调用注册的路由 handler，打印真实快照（渠道发现 + 上游余额探测）。
 *
 * 用法（必须在 web profile 目录下跑，才能解析 @deepseek-ai/schemastery）：
 *   node plugins-src/kita-channel-balance/scripts/verify-host.mjs
 *
 * 它读三份真实输入，但只打印结果、绝不打印 key：
 *   - home/profiles/web/cordis.patch.yml   （providers 定义）
 *   - home/.credentials.yaml               （凭据 refs，只用于 resolve）
 *   - 各渠道的余额端点                      （真实网络请求）
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_PROFILE = resolve(HERE, '..', '..', '..')          // home/profiles/web
const HOME = resolve(WEB_PROFILE, '..', '..')                // home

/** 从 profile patch 的 providers 段抓渠道定义（只认 apiKeyEnv/baseURL/displayName）。 */
function readProviders(text) {
  const providers = {}
  let current = null
  let inProviders = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^ {4}providers:\s*$/u.test(line)) { inProviders = true; current = null; continue }
    if (!inProviders) continue
    if (/^ {0,4}\S/u.test(line)) { inProviders = false; current = null; continue }
    const id = /^ {6}([A-Za-z0-9_.-]+):\s*$/u.exec(line)
    if (id !== null) { current = id[1]; providers[current] = {}; continue }
    if (current === null) continue
    const field = /^ {8}(apiKeyEnv|baseURL|displayName):\s*'?([^'\s]+)'?\s*$/u.exec(line)
    if (field !== null) providers[current][field[1]] = field[2]
  }
  return providers
}

/** 从凭据文件读 refs（只读，不打印）。 */
function readRefs(text) {
  const refs = {}
  let inRefs = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^refs:\s*$/u.test(line)) { inRefs = true; continue }
    if (inRefs) {
      const entry = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(line)
      // flow mapping 的成员带尾逗号；不剥掉就是一个「看起来对」的坏 key。
      if (entry !== null) refs[entry[1]] = entry[2].trim().replace(/^["']|["']$/gu, '').replace(/,$/u, '')
      else if (/^[A-Za-z]/u.test(line)) inRefs = false
    }
  }
  return refs
}

const refs = readRefs(readFileSync(join(HOME, '.credentials.yaml'), 'utf8'))
const providers = readProviders(readFileSync(join(WEB_PROFILE, 'cordis.patch.yml'), 'utf8'))

const descriptors = [
  // 真实投影里官方路由只有 apiKeyEnv（baseURL 未配置），兜底端点由插件 Config 提供。
  { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  { ns: 'llm-pi-ai', value: { providers } },
]
const settings = { describe: () => descriptors }
const credentials = {
  async resolve(ref) {
    return Object.hasOwn(refs, ref) && refs[ref] !== '' ? { value: refs[ref], source: 'verify-host' } : undefined
  },
}
const FAKE_PLATFORM = process.argv.includes('--fake-platform')
const routes = []
const disposers = []
const ctx = {
  get(name) {
    if (name === 'settings') return settings
    if (name === 'credentials') return credentials
    // 真实运行时由 @deepseek-ai/dsh-deepseek-account* 提供；这里按开关注入假钱包，
    // 用来单独验证「平台账号余额优先」这条分支。
    if (name === 'deepseekAccount' && FAKE_PLATFORM) {
      return {
        async getBalance() {
          return {
            status: 'ready',
            value: [{ currency: 'CNY', balance: '12.34' }],
            bonusWallets: [{ currency: 'CNY', balance: '1.66' }],
          }
        },
      }
    }
    return undefined
  },
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  effect(callback, label) {
    const dispose = callback()
    disposers.push({ label, dispose })
    return () => {}
  },
}

apply(ctx, {
  refreshIntervalMs: 60_000,
  requestTimeoutMs: 8_000,
  endpointCacheMs: 1_800_000,
  officialHosts: ['api.deepseek.com'],
  officialBaseURL: 'https://api.deepseek.com/anthropic',
  channels: [],
})

console.log('mode:', FAKE_PLATFORM ? 'fake platform account' : 'api-key endpoints')
console.log('routes:', routes.map((route) => route.kind + ' ' + route.path).join(', '))
console.log('providers found:', Object.keys(providers).join(', ') || '(none)')

const stateRoute = routes.find((route) => route.path === '/kita-balance/state')
if (stateRoute === undefined) throw new Error('state route not registered')

const response = {
  status: 0,
  headers: null,
  body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; return this },
  end(body) { this.body = body },
}
stateRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' } }, response)
const deadline = Date.now() + 60_000
while (response.body === '' && Date.now() < deadline) {
  await new Promise((wake) => setTimeout(wake, 100))
}
if (response.body === '') throw new Error('no response within 60s')
const snapshot = JSON.parse(response.body)
console.log(JSON.stringify(snapshot, null, 2))

// 收尾：清掉定时器与 effect，让脚本自然退出。
for (const entry of disposers) {
  if (entry !== null && typeof entry.dispose === 'function') entry.dispose()
}
process.exit(0)
