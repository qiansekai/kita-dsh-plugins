// Host-half smoke test: boots the real plugin against a fake webserver and a
// fake upstream, on private ports, with DSH_HOME pointed at a temp directory.
//
//   node scripts/smoke-gateway.mjs
//
// Why this layer exists: `verify-gateway.mjs` only touches pure functions, and
// `pair-tunnel-e2e.mjs` needs a live dsh. In between sits everything that can
// only go wrong once the plugin really listens — the entry fence that decides
// who may read the pairing code, the panel's write actions, the rotation grace
// window, and the v1 -> v2 credential migration. Nothing here touches the real
// gateway: the ports are private and DSH_HOME is a temp directory.
//
// Requires `@deepseek-ai/schemastery` to resolve from this package (the monorepo
// links it from the dsh environment; a plain `npm install` also provides it).

import http from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GW = 13081
const UP = 13080

let passed = 0
const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const home = mkdtempSync(join(tmpdir(), 'kita-gw-smoke-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'storages'), { recursive: true })
const storeFile = join(home, 'storages', 'kita-dsh-gateway-tokens.json')

// A v1 store: the map is keyed by the raw token, and one device is already
// paired. The upgrade must keep that device working without re-pairing.
const legacyToken = 'b'.repeat(64)
const legacyMeta = { ua: 'legacy phone', at: Date.now(), ip: '10.0.0.9', lastActive: Date.now() }
writeFileSync(storeFile, JSON.stringify({ currentCode: '111111', tokens: { [legacyToken]: legacyMeta } }))

// Deterministic tunnel availability: no binary, no PATH to find one in.
delete process.env.CLOUDFLARED_PATH
const realPath = process.env.PATH
process.env.PATH = ''

const routes = new Map()
const webServer = {
  register({ path, handler }) {
    routes.set(path, handler)
    return () => routes.delete(path)
  },
}
const upstream = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname
  const handler = routes.get(pathname)
  if (handler !== undefined) {
    handler(req, res)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<html>__DSH_BOOT__ upstream ok</html>')
})
await new Promise((resolve) => upstream.listen(UP, '127.0.0.1', resolve))

const ctx = {
  get: (name) => (name === 'webServer' ? webServer : undefined),
  effect: (fn) => fn(),
  inject: () => {},
}

const { apply } = await import('../lib/index.js')
const quiet = console.log
const bootLog = []
console.log = (...args) => bootLog.push(args.join(' '))
const teardown = apply(ctx, { port: GW, targetPort: UP, codeMinutes: 10, cloudflaredPath: '', tunnelProtocol: 'http2' })
process.env.PATH = realPath
console.log = quiet

const deadline = Date.now() + 15000
let listening = false
while (Date.now() < deadline && !listening) {
  try {
    const res = await fetch(`http://127.0.0.1:${GW}/gateway-pair`)
    listening = res.status === 200
  } catch { /* not up yet */ }
  if (!listening) await new Promise((resolve) => setTimeout(resolve, 100))
}
check('the gateway binds its port', listening)
if (!listening) {
  console.log(bootLog.join('\n'))
  process.exit(1)
}

/** Through the gateway: the LAN door, as a phone sees it. */
const gw = (path, options = {}) => fetch(`http://127.0.0.1:${GW}${path}`, { redirect: 'manual', ...options })
async function gwJson(path, options = {}) {
  const res = await gw(path, options)
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) }
}
/** Straight at the webserver: the desktop door, which never crosses the gateway. */
async function localJson(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${UP}${path}`, { redirect: 'manual', ...options })
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) }
}
const postJson = (path, body, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
})

// ---------------------------------------------------------------------------
quiet('\n[1] the v1 -> v2 credential migration')
{
  const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
  check('the store is rewritten as v2 on boot', onDisk.version === 2, String(onDisk.version))
  check('the raw token is no longer a key on disk',
    onDisk.tokens[legacyToken] === undefined && Object.keys(onDisk.tokens).length === 1)
  check('the migration says so in the boot log',
    bootLog.some((line) => line.includes('迁移')), bootLog.join(' | ').slice(0, 200))
  const res = await gw('/', { headers: { Cookie: `kita_gw=${legacyToken}` } })
  check('the legacy device still authenticates after the migration', res.status === 200, `status=${res.status}`)
}

// ---------------------------------------------------------------------------
quiet('\n[2] the pairing page knows who is looking at it')
{
  const local = await (await gw('/gateway-pair')).text()
  check('a local pairing page renders the QR block',
    local.includes('KITA_LOCAL = true') && local.includes('id="localcard"'))
  check('a local page with no cookie is not marked paired', local.includes('KITA_PAIRED = false'))
  check('the code is read from the URL fragment', local.includes('k=(\\d{6})'))
  const paired = await (await gw('/gateway-pair', { headers: { Cookie: `kita_gw=${legacyToken}` } })).text()
  check('an already-paired device is told so', paired.includes('KITA_PAIRED = true'))

  const qr = await gwJson('/gateway-pair/qr.json')
  check('the QR payload carries the restored pairing code', qr.body?.code === '111111', String(qr.body?.code))
  check('the QR url carries the code in the fragment', /#k=111111$/.test(qr.body?.url ?? ''), String(qr.body?.url))
  check('the QR payload lists adapter-named candidates',
    Array.isArray(qr.body?.candidates) && qr.body.candidates.every((entry) => typeof entry.name === 'string'),
    JSON.stringify(qr.body?.candidates))
}

// ---------------------------------------------------------------------------
quiet('\n[3] pairing, refusals and the rotation grace window')
{
  const bad = await gwJson('/pair', postJson('/pair', { code: '000000' }))
  check('a wrong code is refused', bad.status === 401, `status=${bad.status}`)
  check('a wrong code reports the remaining attempts', bad.body?.remaining === 4, JSON.stringify(bad.body))

  const paired = await gw('/pair', postJson('/pair', { code: '111111' }))
  check('the live code pairs', paired.status === 200, `status=${paired.status}`)
  const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0]
  check('a gateway cookie is issued', /^kita_gw=[0-9a-f]{64}$/.test(cookie), cookie.slice(0, 12))
  const token = cookie.slice('kita_gw='.length)
  const onDisk = JSON.parse(readFileSync(storeFile, 'utf8'))
  check('the freshly issued token is stored hashed',
    onDisk.tokens[token] === undefined && Object.keys(onDisk.tokens).length === 2)

  await gw('/admin/rotate', { method: 'POST' })
  const admin = await gwJson('/admin/code')
  check('rotating mints a new code', admin.body?.code !== '111111', String(admin.body?.code))
  const grace = await gw('/pair', postJson('/pair', { code: '111111' }))
  check('the retired code still works inside the grace window', grace.status === 200, `status=${grace.status}`)

  const devices = admin.body?.devices ?? []
  check('admin device rows carry a 16-hex handle',
    devices.length > 0 && devices.every((d) => typeof d.id === 'string' && d.id.length === 16), JSON.stringify(devices))
  check('admin device rows never carry a token', devices.every((d) => d.token === undefined))
  check('admin device rows carry an expiry',
    devices.every((d) => typeof d.expiresAt === 'number' && d.expiresAt > Date.now()))
  const removed = await gwJson('/admin/revoke', postJson('/admin/revoke', { id: devices[0].id }))
  check('admin revoke accepts a handle', removed.status === 200 && removed.body?.ok === true, `status=${removed.status}`)

  // Keep a live credential for the panel checks below.
  const fresh = await gw('/pair', postJson('/pair', { code: admin.body?.code }))
  const freshCookie = (fresh.headers.get('set-cookie') ?? '').split(';')[0]
  check('re-pairing after the rotation issues a new cookie', /^kita_gw=[0-9a-f]{64}$/.test(freshCookie))

  // -------------------------------------------------------------------------
  quiet('\n[4] the panel: who may see the code, who may act')
  const desktop = await localJson('/kita-gateway/panel')
  check('a desktop panel read is local', desktop.body?.entry === 'local' && desktop.body?.canControl === true,
    `entry=${desktop.body?.entry}`)
  check('a desktop panel read gets the code', /^\d{6}$/.test(desktop.body?.code ?? ''), String(desktop.body?.code))
  check('a desktop panel read gets a scannable url', (desktop.body?.localPairUrl ?? '').includes('#k='))
  check('desktop candidates each carry a code-carrying link',
    Array.isArray(desktop.body?.candidates) && desktop.body.candidates.length > 0
    && desktop.body.candidates.every((c) => c.pairUrl
      === `http://${c.ip}:${desktop.body.port}/gateway-pair#k=${desktop.body.code}`),
    JSON.stringify(desktop.body?.candidates?.map((c) => c.pairUrl)))

  const phone = await gwJson('/kita-gateway/panel', { headers: { Cookie: freshCookie } })
  check('a phone panel read is marked lan', phone.body?.entry === 'lan', String(phone.body?.entry))
  check('a phone panel read is denied local control', phone.body?.canControl === false)
  check('a phone panel read is never handed the pairing code',
    phone.body?.code === '' && phone.body?.codeLocalOnly === true, JSON.stringify(phone.body?.code))
  check('a phone panel read gets no code-carrying url',
    phone.body?.localPairUrl === '' && phone.body?.tunnel?.pairUrl === '')
  check('a phone panel read gets no code-carrying candidate link',
    (phone.body?.candidates ?? []).every((c) => c.pairUrl === ''),
    JSON.stringify(phone.body?.candidates?.map((c) => c.pairUrl)))
  check('a phone panel read names its own device',
    typeof phone.body?.selfId === 'string' && phone.body.selfId.length === 16, String(phone.body?.selfId))
  check('device rows carry a handle and no token',
    (phone.body?.devices ?? []).length > 0
    && phone.body.devices.every((d) => typeof d.id === 'string' && d.token === undefined))
  check('the tunnel reports unavailable without cloudflared', phone.body?.tunnel?.available === false)

  const forged = await gwJson('/kita-gateway/panel', {
    headers: { Cookie: freshCookie, 'x-kita-gw-device': 'f'.repeat(16) },
  })
  check('a forged device handle is dropped', forged.body?.selfId !== 'f'.repeat(16) && forged.body?.selfId.length === 16,
    String(forged.body?.selfId))

  const asPhone = (body) => gwJson('/kita-gateway/panel', postJson('/kita-gateway/panel', body, { Cookie: freshCookie }))
  const asDesktop = (body) => localJson('/kita-gateway/panel', postJson('/kita-gateway/panel', body))

  check('a phone may not rotate the pairing code', (await asPhone({ action: 'rotate' })).status === 403)
  check('the desktop may rotate the pairing code',
    (await asDesktop({ action: 'rotate' })).body?.ok === true)
  check('a phone may not open the tunnel', (await asPhone({ action: 'tunnel-start' })).status === 403)

  const bulk = await asPhone({ action: 'revoke-all', id: phone.body.selfId })
  check('revoke-all reports what it removed', bulk.body?.ok === true && typeof bulk.body?.removed === 'number',
    JSON.stringify(bulk.body))
  const left = (await gwJson('/admin/code')).body?.devices ?? []
  check('revoke-all keeps the device that asked',
    left.length === 1 && left[0].id === phone.body.selfId, JSON.stringify(left.map((d) => d.id)))
}

// ---------------------------------------------------------------------------
teardown()
await new Promise((resolve) => upstream.close(resolve))
rmSync(home, { recursive: true, force: true })

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
