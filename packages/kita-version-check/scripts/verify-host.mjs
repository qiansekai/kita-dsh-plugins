/**
 * Offline verification for the kita-version-check host half.
 *
 * Runs the real plugin against a local fake registry, a local CONNECT proxy and
 * a capture ctx, so nothing here needs dsh itself, the public network, or a
 * restart. Asserts:
 *
 *   1. SemVer precedence (release > prerelease, numeric identifiers, build
 *      metadata ignored) and dist-tag -> channel shaping.
 *   2. The running-version resolver honours an explicit package.json, and the
 *      snapshot of an unresolved deployment is honest about it.
 *   3. /state answers the cached snapshot, the second call does not re-fetch,
 *      /refresh does, and the disk cache is written under <home>/storages.
 *   4. Cross-site callers get 403; same-origin and same-host callers get 200.
 *   5. The CONNECT proxy path returns the same document as the direct path.
 *
 * Run: node scripts/verify-host.mjs
 */
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  apply,
  compareVersions,
  normalizeRegistry,
  isTrustedRequest,
  proxyCandidates,
  fetchProxyJson,
} from '../lib/index.js'

const failures = []
let checks = 0
// A wedged fixture server must fail the run instead of hanging it.
const guard = setTimeout(() => {
  console.error('verify-host: TIMEOUT (fixture servers did not settle)')
  process.exit(2)
}, 45000)
function ok(condition, message) {
  checks += 1
  if (!condition) failures.push(message)
}
function eq(actual, expected, message) {
  ok(actual === expected, message + ' (expected ' + String(expected) + ', got ' + String(actual) + ')')
}

// ---------- 1. SemVer precedence ----------
const ordering = [
  ['0.2.1-rc.3', '0.2.1-rc.2', 1, 'rc.3 is newer than rc.2'],
  ['0.2.1', '0.2.1-rc.3', 1, 'a release outranks its prereleases'],
  ['0.2.1-alpha.5', '0.2.1-rc.2', -1, 'alpha sorts below rc'],
  ['0.2.0', '0.2.1', -1, 'minor bump is newer'],
  ['0.3.0', '0.2.9', 1, 'minor outranks patch'],
  ['1.0.0', '1.0.0', 0, 'identical versions compare equal'],
  ['1.0.0+build.5', '1.0.0', 0, 'build metadata is ignored'],
  ['0.2.1-alpha.10', '0.2.1-alpha.9', 1, 'numeric prerelease identifiers compare numerically'],
  ['0.2.1-beta', '0.2.1-alpha.99', 1, 'alphanumeric outranks numeric identifiers'],
  ['0.2.1-rc', '0.2.1-rc.1', -1, 'a longer prerelease list is newer'],
  ['v0.2.1-rc.2', '0.2.1-rc.2', 0, 'a leading v is accepted'],
]
for (const [left, right, expected, label] of ordering) {
  eq(compareVersions(left, right), expected, label)
}
eq(compareVersions('not-a-version', '1.0.0'), null, 'unparsable input yields null')

// ---------- fixture: fake registry ----------
const document_ = {
  name: '@deepseek-ai/dsh',
  'dist-tags': { latest: '0.2.1-rc.2', next: '0.2.1-rc.3', alpha: '0.2.1-alpha.5' },
  time: {
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-10-23T07:54:30.000Z',
    '0.2.1-rc.1': '2026-10-17T03:17:24.000Z',
    '0.2.1-rc.2': '2026-10-17T08:36:31.000Z',
    '0.2.1-rc.3': '2026-10-23T07:54:30.000Z',
    '0.2.1-alpha.5': '2026-10-16T12:31:49.000Z',
  },
}

let registryHits = 0
const registryServer = createServer((req, res) => {
  registryHits += 1
  if (!decodeURIComponent(req.url ?? '').includes('@deepseek-ai/dsh')) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(document_))
})
await new Promise((resolve) => registryServer.listen(0, '127.0.0.1', resolve))
const registryPort = registryServer.address().port

// ---------- fixture: CONNECT proxy in front of the same registry ----------
const proxyServer = createServer((req, res) => {
  res.statusCode = 405
  res.end()
})
proxyServer.on('connect', (req, clientSocket, head) => {
  const target = String(req.url ?? '')
  const separator = target.lastIndexOf(':')
  const host = target.slice(0, separator)
  const port = Number(target.slice(separator + 1))
  const upstream = netConnect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})
await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
const proxyPort = proxyServer.address().port

// ---------- fixture: deployment layout ----------
const root = mkdtempSync(join(tmpdir(), 'kita-version-check-'))
const home = join(root, 'home')
const envsDir = join(root, 'envs')
mkdirSync(join(home, 'storages'), { recursive: true })
mkdirSync(envsDir, { recursive: true })
writeFileSync(join(envsDir, 'active-env.txt'), 'env=alpha-test\nport=3999\n', 'utf8')
const fakeDshJson = join(root, 'dsh-package.json')
writeFileSync(fakeDshJson, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }), 'utf8')

const config = {
  registry: 'http://127.0.0.1:' + String(registryPort),
  packageName: '@deepseek-ai/dsh',
  channels: ['latest', 'next', 'alpha'],
  refreshIntervalMinutes: 60,
  requestTimeoutMs: 5000,
  proxyUrl: '',
  useEnvironmentProxy: false,
  dshHome: home,
  envsDir,
  dshPackageJson: fakeDshJson,
  versionListLimit: 5,
}

// ---------- fixture: capture ctx + carrier ----------
const routes = []
const disposers = []
const ctx = {
  webServer: {
    port: 0,
    register(spec) {
      routes.push(spec)
      return () => {
        const index = routes.indexOf(spec)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  effect(factory) {
    disposers.push(factory())
    return () => {}
  },
}

apply(ctx, config)
ok(routes.length === 2, 'apply registers two routes (got ' + String(routes.length) + ')')
ok(routes.some((route) => route.path === '/kita-version-check/state'), '/state route registered')
ok(routes.some((route) => route.path === '/kita-version-check/refresh'), '/refresh route registered')

const carrier = createServer((req, res) => {
  const path = String(req.url ?? '').split('?')[0]
  const route = routes.find((candidate) => candidate.path === path)
  if (route === undefined) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => carrier.listen(0, '127.0.0.1', resolve))
const carrierPort = carrier.address().port
const base = 'http://127.0.0.1:' + String(carrierPort)

// apply() warms the cache; give that first fetch a moment to land.
await new Promise((resolve) => setTimeout(resolve, 300))

// ---------- 3. /state, cache behaviour, disk mirror ----------
const stateResponse = await fetch(base + '/kita-version-check/state', { headers: { accept: 'application/json' } })
eq(stateResponse.status, 200, '/state answers 200')
const first = await stateResponse.json()
eq(first.ok, true, '/state payload ok')
eq(first.current.version, '0.2.1-rc.2', 'running version resolved from the explicit package.json')
eq(first.current.env, 'alpha-test', 'deployment name read from active-env.txt')
eq(first.current.resolved, true, 'version resolution flagged resolved')
eq(first.anyUpdate, true, 'next channel above the running version sets anyUpdate')
eq(first.newest.version, '0.2.1-rc.3', 'newest channel is next')
const byTag = Object.fromEntries(first.channels.map((channel) => [channel.tag, channel]))
eq(byTag.latest.relation, 'equal', 'latest is the running version')
eq(byTag.next.relation, 'newer', 'next is newer')
eq(byTag.alpha.relation, 'older', 'alpha is older')
eq(first.recent[0].version, '0.2.1-rc.3', 'recent releases are newest first')
eq(first.recent.length, 4, 'recent list is limited to published versions')
ok(existsSync(join(home, 'storages', 'kita-version-check.json')), 'disk cache mirrored under <home>/storages')
const cachedBody = JSON.parse(readFileSync(join(home, 'storages', 'kita-version-check.json'), 'utf8'))
eq(cachedBody.channels.length, 3, 'disk cache keeps all channels')

const hitsAfterFirst = registryHits
const second = await (await fetch(base + '/kita-version-check/state')).json()
eq(registryHits, hitsAfterFirst, 'a cached /state does not hit the registry again')
eq(second.cached, true, 'cached snapshot reported as cached')
eq(second.checkedAt, first.checkedAt, 'cache timestamp is stable')

const refreshed = await (await fetch(base + '/kita-version-check/refresh', { method: 'POST' })).json()
eq(registryHits, hitsAfterFirst + 1, '/refresh hits the registry again')
eq(refreshed.ok, true, '/refresh payload ok')
eq(refreshed.anyUpdate, true, '/refresh keeps the verdict')

// ---------- 4. same-origin fence ----------
const crossSite = await fetch(base + '/kita-version-check/state', { headers: { origin: 'http://evil.example' } })
eq(crossSite.status, 403, 'cross-site origin is refused')
const crossFetch = await fetch(base + '/kita-version-check/refresh', {
  method: 'POST',
  headers: { 'sec-fetch-site': 'cross-site' },
})
eq(crossFetch.status, 403, 'Sec-Fetch-Site: cross-site is refused')
eq(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } }), true, 'no origin header is trusted')
eq(
  isTrustedRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }),
  true,
  'same host origin is trusted',
)
eq(isTrustedRequest({ headers: {} }), false, 'a request without host is refused')

// ---------- 5. proxy path ----------
const proxied = await fetchProxyJson(
  'http://127.0.0.1:' + String(registryPort) + '/@deepseek-ai/dsh',
  'http://127.0.0.1:' + String(proxyPort),
  5000,
)
eq(proxied['dist-tags'].next, '0.2.1-rc.3', 'CONNECT proxy returns the registry document')
const previous = process.env.HTTPS_PROXY
process.env.HTTPS_PROXY = 'http://127.0.0.1:' + String(proxyPort)
process.env.HTTP_PROXY = 'http://127.0.0.1:' + String(proxyPort)
const candidates = proxyCandidates({ proxyUrl: 'http://127.0.0.1:9999', useEnvironmentProxy: true })
eq(candidates[0], 'http://127.0.0.1:9999', 'explicit proxy leads the candidate list')
eq(candidates.includes('http://127.0.0.1:' + String(proxyPort)), true, 'environment proxies are included')
eq(new Set(candidates).size, candidates.length, 'proxy candidates are de-duplicated')
if (previous === undefined) delete process.env.HTTPS_PROXY
else process.env.HTTPS_PROXY = previous
delete process.env.HTTP_PROXY

// ---------- normalizeRegistry contract ----------
const normalized = normalizeRegistry(document_, config)
eq(normalized.channels.length, 3, 'normalizeRegistry keeps every configured channel')
eq(normalized.channels[0].publishedAt, '2026-10-17T08:36:31.000Z', 'channel publish time carried through')
eq(normalized.modifiedAt, '2026-10-23T07:54:30.000Z', 'document modification time captured')

// ---------- teardown ----------
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* best effort */
  }
}
// Keep-alive sockets (undici pool, CONNECT tunnels) would otherwise hold
// server.close() open forever, so they are cut first.
for (const server of [carrier, registryServer, proxyServer]) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
}
await Promise.all([carrier, registryServer, proxyServer].map((server) =>
  new Promise((resolve) => server.close(resolve)),
))
rmSync(root, { recursive: true, force: true })
clearTimeout(guard)

// ---------- report ----------
if (failures.length === 0) {
  console.log('verify-host: OK (' + String(checks) + ' checks)')
  process.exit(0)
}
console.error('verify-host: FAILED ' + String(failures.length) + '/' + String(checks))
for (const failure of failures) console.error('  - ' + failure)
process.exit(1)
