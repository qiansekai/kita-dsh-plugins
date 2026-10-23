/**
 * kita-version-check - host half.
 *
 * Answers one question for the whole deployment: "which DSH version am I
 * running, and is there a newer one upstream?". Two facts, two sources:
 *
 *   current   resolved from this process, never from configuration: the entry
 *             script's own package.json (process.argv[1] lives at
 *             <env>/node_modules/@deepseek-ai/dsh/lib/bin.js), the active-env
 *             pointer's environment, and finally the module resolver. The
 *             deployment name ("alpha-022") comes from active-env.txt.
 *   upstream  the npm registry dist-tags document, cached in memory and on
 *             disk so a page load never waits on the network twice.
 *
 * Routes (same-origin only: they describe this deployment's layout):
 *
 *   GET  /kita-version-check/state    -> cached snapshot, loading once if empty
 *   POST /kita-version-check/refresh  -> force a registry query
 *
 * Version comparison implements the SemVer 2.0.0 precedence rules locally
 * (numeric identifiers compare numerically, prerelease < release, build
 * metadata ignored) so no dependency is added for it.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'kita-version-check'

/** The web carrier owns the routes. */
export const inject = ['webServer']

const STATE_FILE_NAME = 'kita-version-check.json'
const USER_AGENT = 'kita-version-check'
const DEFAULT_CHANNELS = ['latest', 'next', 'alpha']
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
const LOOSE_VERSION = /^\d+\.\d+\.\d+/u

export const Config = z.object({
  /** Registry base URL. An intranet mirror is a deployment value, not code. */
  registry: z.string().default('https://registry.npmjs.org'),
  /** Package whose dist-tags answer "what is upstream". */
  packageName: z.string().default('@deepseek-ai/dsh'),
  /** dist-tags compared against the running version, in display order. */
  channels: z.array(z.string()).default([...DEFAULT_CHANNELS]),
  /** How long a registry answer stays fresh before a page load refetches it. */
  refreshIntervalMinutes: z.natural().default(60),
  /** Per-request network budget. */
  requestTimeoutMs: z.natural().default(20000),
  /** Explicit proxy (http://host:port); empty = direct first, then the environment. */
  proxyUrl: z.string().default(''),
  /** Fall back to HTTPS_PROXY / HTTP_PROXY when a direct request fails. */
  useEnvironmentProxy: z.boolean().default(true),
  /** Absolute dsh home; empty = $DSH_HOME. */
  dshHome: z.string().default(''),
  /** Directory holding active-env.txt; empty = two levels above the home. */
  envsDir: z.string().default(''),
  /** Explicit path to the running DSH package.json (overrides detection). */
  dshPackageJson: z.string().default(''),
  /** How many recently published versions to list in the panel. */
  versionListLimit: z.natural().default(8),
})

/** Read one "key = value" entry from the environment pointer file. */
function readPointerValue(path, key) {
  if (path === '' || !existsSync(path)) return ''
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const pattern = new RegExp('^\\s*' + key + '\\s*=\\s*(\\S+)\\s*$', 'u')
      const match = pattern.exec(line)
      if (match !== null) return match[1]
    }
  } catch {
    return ''
  }
  return ''
}

/** Resolve this deployment's home, environment directory and environment name. */
function resolveLayout(config) {
  const home = config.dshHome !== '' ? config.dshHome : (process.env.DSH_HOME ?? '')
  const envsDir = config.envsDir !== ''
    ? config.envsDir
    : (home === '' ? '' : resolve(home, '..', '..'))
  const envName = envsDir === '' ? '' : readPointerValue(join(envsDir, 'active-env.txt'), 'env')
  return { home, envsDir, envName }
}

/** Read a package.json and return its version only when it is the expected package. */
function readPackageIdentity(path, packageName) {
  if (path === '' || !existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    if (typeof parsed.version !== 'string' || !LOOSE_VERSION.test(parsed.version)) return null
    if (packageName !== '' && parsed.name !== packageName) return null
    return { version: parsed.version, packageJson: path }
  } catch {
    return null
  }
}

/**
 * Candidate package.json paths for the RUNNING dsh, most trustworthy first.
 * Detection is preferred over configuration because a stale configured path
 * would silently report another deployment's version; an explicit
 * "dshPackageJson" only prepends to the list.
 */
function identityCandidates(config, layout) {
  const paths = []
  if (config.dshPackageJson !== '') paths.push(config.dshPackageJson)
  // argv[1] = <env>/node_modules/@deepseek-ai/dsh/lib/bin.js -> walk up.
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : ''
  if (entry !== '') {
    let directory = dirname(resolve(entry))
    for (let depth = 0; depth < 6; depth += 1) {
      paths.push(join(directory, 'package.json'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  if (layout.envsDir !== '' && layout.envName !== '') {
    paths.push(join(layout.envsDir, layout.envName, 'env', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  if (layout.home !== '') {
    paths.push(join(layout.home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    paths.push(join(layout.home, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  try {
    paths.push(createRequire(import.meta.url).resolve(config.packageName + '/package.json'))
  } catch {
    /* not resolvable from this package: the walk above still covers the real cases */
  }
  return paths
}

/** Resolve the running version once; returns an unresolved identity when nothing matches. */
function resolveIdentity(config, layout) {
  for (const path of identityCandidates(config, layout)) {
    const identity = readPackageIdentity(path, config.packageName)
    if (identity !== null) return { ...identity, resolved: true }
  }
  return { version: '', packageJson: '', resolved: false }
}

/** SemVer 2.0.0 parse: returns null for anything that is not a version. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER.exec(value.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** SemVer 2.0.0 precedence: -1 older, 0 equal, 1 newer; null when unparsable. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  // A release outranks any prerelease of the same core version.
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < shared; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === y) continue
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) return Number(x) > Number(y) ? 1 : -1
    if (xNumeric) return -1 // numeric identifiers rank below alphanumeric ones
    if (yNumeric) return 1
    return x > y ? 1 : -1
  }
  if (a.prerelease.length === b.prerelease.length) return 0
  return a.prerelease.length > b.prerelease.length ? 1 : -1
}

/** Direct HTTPS/HTTP JSON GET. */
async function fetchDirectJson(url, timeoutMs) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('registry HTTP ' + String(response.status))
  return await response.json()
}

/**
 * JSON GET tunnelled through an HTTP proxy with CONNECT. Node's fetch does not
 * honour the *_PROXY environment variables, and this deployment sits behind a
 * link where the registry sometimes needs the proxy.
 */
export function fetchProxyJson(url, proxyUrl, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const target = new URL(url)
    const proxy = new URL(proxyUrl)
    if (proxy.protocol !== 'http:') {
      finish(new Error('unsupported proxy protocol "' + proxy.protocol + '" (http only)'))
      return
    }
    const secure = target.protocol === 'https:'
    const targetPort = target.port !== '' ? Number(target.port) : (secure ? 443 : 80)
    const timer = setTimeout(() => finish(new Error('timeout after ' + String(timeoutMs) + 'ms')), timeoutMs)
    const headers = { host: target.host }
    if (proxy.username !== '' || proxy.password !== '') {
      const credentials = decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(credentials).toString('base64')
    }
    const tunnel = httpRequest({
      host: proxy.hostname,
      port: proxy.port !== '' ? Number(proxy.port) : 80,
      method: 'CONNECT',
      path: target.hostname + ':' + String(targetPort),
      headers,
    })
    tunnel.on('error', (error) => finish(error))
    tunnel.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(new Error('proxy CONNECT ' + String(response.statusCode ?? 0)))
        return
      }
      const request = (secure ? httpsRequest : httpRequest)({
        host: target.hostname,
        port: targetPort,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, host: target.host },
        socket,
        agent: false,
        servername: secure ? target.hostname : undefined,
      }, (reply) => {
        const chunks = []
        reply.on('data', (chunk) => chunks.push(chunk))
        reply.on('error', (error) => finish(error))
        reply.on('end', () => {
          const status = reply.statusCode ?? 0
          if (status < 200 || status >= 300) {
            finish(new Error('registry HTTP ' + String(status)))
            return
          }
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            const detail = String(error && error.message ? error.message : error)
            finish(new Error('invalid JSON from registry: ' + detail))
          }
        })
      })
      request.on('error', (error) => finish(error))
      request.end()
    })
    tunnel.end()
  })
}

/** Proxy URLs worth trying: explicit config first, then the environment. */
export function proxyCandidates(config) {
  const values = []
  if (config.proxyUrl !== '') values.push(config.proxyUrl)
  if (config.useEnvironmentProxy) {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      const value = process.env[key]
      if (typeof value === 'string' && value !== '') values.push(value)
    }
  }
  const unique = []
  for (const value of values) {
    if (value.toLowerCase() === 'none') continue
    if (!unique.includes(value)) unique.push(value)
  }
  return unique
}

/** Registry JSON: direct first, then each proxy candidate. */
async function fetchRegistryJson(url, config) {
  const attempts = []
  try {
    return { payload: await fetchDirectJson(url, config.requestTimeoutMs), via: 'direct' }
  } catch (error) {
    attempts.push('direct: ' + String(error && error.message ? error.message : error))
  }
  for (const proxyUrl of proxyCandidates(config)) {
    try {
      const payload = await fetchProxyJson(url, proxyUrl, config.requestTimeoutMs)
      return { payload, via: 'proxy ' + proxyUrl }
    } catch (error) {
      attempts.push(proxyUrl + ': ' + String(error && error.message ? error.message : error))
    }
  }
  throw new Error(attempts.join('; '))
}

/** Shape the registry document into the channels and releases the panel shows. */
export function normalizeRegistry(document, config) {
  if (typeof document !== 'object' || document === null) throw new Error('unexpected registry document')
  const tags = typeof document['dist-tags'] === 'object' && document['dist-tags'] !== null ? document['dist-tags'] : {}
  const times = typeof document.time === 'object' && document.time !== null ? document.time : {}
  const channels = []
  for (const tag of config.channels) {
    const version = tags[tag]
    if (typeof version !== 'string' || version === '') continue
    const publishedAt = typeof times[version] === 'string' ? times[version] : ''
    channels.push({ tag, version, publishedAt })
  }
  const recent = Object.keys(times)
    .filter((version) => version !== 'created' && version !== 'modified' && typeof times[version] === 'string')
    .sort((left, right) => Date.parse(times[right]) - Date.parse(times[left]))
    .slice(0, config.versionListLimit)
    .map((version) => ({ version, publishedAt: times[version] }))
  return {
    channels,
    recent,
    modifiedAt: typeof times.modified === 'string' ? times.modified : '',
  }
}

/** Reject cross-site callers: the routes describe this deployment's layout. */
export function isTrustedRequest(req) {
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

export function apply(ctx, config) {
  const layout = resolveLayout(config)
  const identity = resolveIdentity(config, layout)
  const registryUrl = config.registry.replace(/\/+$/u, '') + '/' + encodeURIComponent(config.packageName).replace(/%40/gu, '@').replace(/%2F/giu, '/')
  const ttlMs = Math.max(1, config.refreshIntervalMinutes) * 60000
  const stateFile = layout.home === '' ? '' : join(layout.home, 'storages', STATE_FILE_NAME)

  /** Cached upstream answer: kept in memory and mirrored on disk across restarts. */
  let upstream = null
  let lastError = null
  let inFlight = null

  if (stateFile !== '' && existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null
        && typeof parsed.fetchedAt === 'number'
        && Array.isArray(parsed.channels)) {
        upstream = {
          channels: parsed.channels,
          recent: Array.isArray(parsed.recent) ? parsed.recent : [],
          fetchedAt: parsed.fetchedAt,
          via: typeof parsed.via === 'string' ? parsed.via : '',
        }
      }
    } catch {
      /* an unreadable cache is simply treated as absent */
    }
  }

  function persist() {
    if (stateFile === '' || upstream === null) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify({
        fetchedAt: upstream.fetchedAt,
        via: upstream.via,
        channels: upstream.channels,
        recent: upstream.recent,
      }, null, 2), 'utf8')
    } catch {
      /* the cache is an optimisation, never a correctness dependency */
    }
  }

  function isFresh() {
    return upstream !== null && Date.now() - upstream.fetchedAt < ttlMs
  }

  async function loadUpstream(force) {
    if (!force && isFresh()) return upstream
    if (inFlight !== null) return await inFlight
    inFlight = (async () => {
      try {
        const result = await fetchRegistryJson(registryUrl, config)
        const normalized = normalizeRegistry(result.payload, config)
        upstream = { ...normalized, fetchedAt: Date.now(), via: result.via }
        lastError = null
        persist()
        return upstream
      } catch (error) {
        lastError = String(error && error.message ? error.message : error)
        return upstream
      } finally {
        inFlight = null
      }
    })()
    return await inFlight
  }

  function snapshot() {
    const channels = (upstream?.channels ?? []).map((channel) => {
      const order = identity.version === '' ? null : compareVersions(channel.version, identity.version)
      const relation = order === null ? 'unknown' : (order === 1 ? 'newer' : (order === 0 ? 'equal' : 'older'))
      return { ...channel, behind: relation === 'newer', relation }
    })
    let newest = null
    for (const channel of channels) {
      if (newest === null) {
        newest = channel
        continue
      }
      if (compareVersions(channel.version, newest.version) === 1) newest = channel
    }
    return {
      ok: true,
      current: {
        version: identity.version,
        resolved: identity.resolved,
        packageJson: identity.packageJson,
        env: layout.envName,
        envsDir: layout.envsDir,
        home: layout.home,
      },
      channels,
      newest,
      anyUpdate: channels.some((channel) => channel.behind === true),
      recent: upstream?.recent ?? [],
      checkedAt: upstream?.fetchedAt ?? 0,
      cached: Boolean(upstream),
      via: upstream?.via ?? '',
      registry: config.registry,
      packageName: config.packageName,
      refreshIntervalMinutes: config.refreshIntervalMinutes,
      error: lastError,
    }
  }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  }

  async function handleState(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'GET only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    // The first load of a fresh deployment waits once for the answer; later
    // loads read the cache so opening the panel never stalls the page.
    if (upstream === null) await loadUpstream(false)
    json(res, 200, snapshot())
  }

  async function handleRefresh(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    await loadUpstream(true)
    json(res, 200, snapshot())
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: '/kita-version-check/state', handler: (req, res) => { void handleState(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: '/kita-version-check/refresh', handler: (req, res) => { void handleRefresh(req, res) } }),
  ]
  ctx.effect(() => () => {
    for (const disposer of disposers) disposer()
  }, 'kita-version-check: routes')

  // Warm the cache once at apply time so the first sidebar paint already has an
  // answer; a failure stays reported through /state rather than thrown.
  void loadUpstream(false)
}
