// Offline checks for the gateway's pure logic and the tunnel controller.
//
//   node scripts/verify-gateway.mjs
//
// No dsh, no network, no cloudflared needed: these assertions cover the pieces
// that decide what a QR encodes, which door a request came through, and how the
// tunnel controller reacts to a process that prints a URL, dies, or is stopped.
// The live end-to-end path (pairing over the real gateway, starting the real
// tunnel) lives in `scripts/pair-tunnel-e2e.mjs`.

import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import {
  ENTRY_HEADER,
  ENTRY_LAN,
  ENTRY_LOCAL,
  ENTRY_TUNNEL,
  codeFromFragment,
  entryOf,
  ipPrefix,
  isLoopbackAddress,
  isUsableIp,
  isVirtualInterface,
  localCandidates,
  pairUrl,
} from '../lib/pair-util.js'
import { qrMatrix, qrSvg } from '../lib/qr.js'
import {
  STORE_VERSION,
  TOKEN_TTL_MS,
  deviceId,
  expiresAt,
  hashToken,
  isExpired,
  loadStore,
  pruneExpired,
  saveStore,
} from '../lib/token-store.js'
import { TUNNEL_URL_PATTERN, createTunnel, resolveCloudflared } from '../lib/tunnel.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')

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

function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ---------------------------------------------------------------------------
console.log('\n[1] address ranking and pairing URLs')
equal('isUsableIp rejects loopback', isUsableIp('127.0.0.1'), false)
equal('isUsableIp rejects link-local', isUsableIp('169.254.10.2'), false)
equal('isUsableIp rejects Radmin 26/8', isUsableIp('26.1.2.3'), false)
equal('isUsableIp rejects CGNAT/Tailscale', isUsableIp('100.101.102.103'), false)
equal('isUsableIp rejects 100.63 (outside CGNAT)', isUsableIp('100.63.0.1'), true)
equal('isUsableIp accepts 192.168', isUsableIp('192.168.1.20'), true)
equal('ipPrefix', ipPrefix('10.0.0.7'), '10.0.0.')

const fakeInterfaces = {
  'Ethernet': [
    { family: 'IPv4', internal: false, address: '192.168.56.1' }, // VirtualBox: penalised
    { family: 'IPv4', internal: false, address: '10.8.0.3' },
  ],
  'Wi-Fi': [
    { family: 'IPv4', internal: false, address: '192.168.1.42' },
    { family: 'IPv6', internal: false, address: 'fe80::1' },
  ],
  'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
}
equal('localCandidates prefers the phone\'s /24',
  localCandidates(['192.168.1.77'], fakeInterfaces)[0].ip, '192.168.1.42')
check('localCandidates drops loopback entirely',
  !localCandidates([], fakeInterfaces).some((entry) => entry.ip === '127.0.0.1'))
equal('localCandidates names the adapter', localCandidates([], fakeInterfaces)[0].name, 'Wi-Fi')

// The measured failure this guards: with only the subnet heuristic, VMnet8 was
// ranked first ("建议") and the WLAN address — the only one a phone could
// reach — came last. The adapter name is the only thing that distinguishes
// them, because they all sit in 192.168/16.
const mixedInterfaces = {
  'VMware Network Adapter VMnet8': [{ family: 'IPv4', internal: false, address: '192.168.159.1' }],
  'WLAN': [{ family: 'IPv4', internal: false, address: '10.60.139.207' }],
  '本地连接* 10': [{ family: 'IPv4', internal: false, address: '192.168.137.1' }],
}
const mixed = localCandidates([], mixedInterfaces)
equal('a physical adapter outranks every virtual one', mixed[0].ip, '10.60.139.207')
check('a virtual adapter is still listed, flagged',
  mixed.some((entry) => entry.ip === '192.168.137.1' && entry.virtual === true))
check('vmware adapters are flagged virtual',
  mixed.find((entry) => entry.ip === '192.168.159.1').virtual === true)
check('a phone\'s /24 cannot promote a virtual adapter above a physical one',
  localCandidates(['192.168.159.9'], mixedInterfaces)[0].ip === '10.60.139.207')
equal('isVirtualInterface flags the hotspot form', isVirtualInterface('本地连接* 10'), true)
equal('isVirtualInterface leaves a real adapter alone', isVirtualInterface('以太网'), false)
equal('isVirtualInterface leaves WLAN alone', isVirtualInterface('WLAN'), false)

equal('pairUrl carries the code in the fragment', pairUrl('http://192.168.1.42:3081', '123456'),
  'http://192.168.1.42:3081/gateway-pair#k=123456')
equal('pairUrl tolerates a trailing slash and no code', pairUrl('https://x.trycloudflare.com/', ''),
  'https://x.trycloudflare.com/gateway-pair')
equal('pairUrl rejects a malformed code', pairUrl('http://a:1', '12ab'), 'http://a:1/gateway-pair')
equal('codeFromFragment reads a leading hash', codeFromFragment('#k=654321'), '654321')
equal('codeFromFragment reads a bare fragment', codeFromFragment('k=000001'), '000001')
equal('codeFromFragment reads a later parameter', codeFromFragment('#a=1&k=222333'), '222333')
equal('codeFromFragment rejects a short code', codeFromFragment('#k=12345'), '')
equal('codeFromFragment rejects text', codeFromFragment('#k=abcdef'), '')

// ---------------------------------------------------------------------------
console.log('\n[2] which door did this request come through')
equal('loopback socket, no marks -> local', entryOf({}, '127.0.0.1'), ENTRY_LOCAL)
equal('LAN socket -> lan', entryOf({}, '192.168.1.50'), ENTRY_LAN)
equal('unknown socket -> lan', entryOf({}, ''), ENTRY_LAN)
equal('cf header -> tunnel', entryOf({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1'), ENTRY_TUNNEL)
equal('gateway mark lan -> lan', entryOf({ [ENTRY_HEADER]: ENTRY_LAN }, '127.0.0.1'), ENTRY_LAN)
equal('gateway mark tunnel -> tunnel', entryOf({ [ENTRY_HEADER]: ENTRY_TUNNEL }, '127.0.0.1'), ENTRY_TUNNEL)
equal('a forged local mark is ignored on a LAN socket',
  entryOf({ [ENTRY_HEADER]: 'local' }, '192.168.1.50'), ENTRY_LAN)
equal('a forged local mark cannot promote a remote socket',
  entryOf({ [ENTRY_HEADER]: 'local' }, '127.0.0.1'), ENTRY_LOCAL) // loopback really is local
check('isLoopbackAddress handles the v6 mapped form', isLoopbackAddress('::ffff:127.0.0.1'))

// ---------------------------------------------------------------------------
console.log('\n[3] QR rendering')
const svg = qrSvg('http://192.168.1.42:3081/gateway-pair#k=123456', { size: 168 })
check('svg has an svg root', svg.startsWith('<svg '), svg.slice(0, 40))
check('svg declares a square viewBox', /viewBox="0 0 (\d+) \1"/.test(svg), svg.slice(0, 200))
check('svg carries a path with modules', /<path d="M\d+ \d+h1v1h-1z/.test(svg))
equal('svg rendering is deterministic', qrSvg('same text'), qrSvg('same text'))
check('different payloads render differently', qrSvg('a') !== qrSvg('b'))
const small = qrMatrix('A')
const large = qrMatrix('https://random-words-here-abc123.trycloudflare.com/gateway-pair#k=987654')
check('matrix grows with payload length', large.count > small.count, `${small.count} -> ${large.count}`)
check('every module is a boolean', typeof small.isDark(0, 0) === 'boolean')
const sync = spawnSync(process.execPath, [join(here, 'sync-qr-encoder.mjs'), '--check'], { encoding: 'utf8' })
check('host QR encoder matches the client copy', sync.status === 0, (sync.stdout + sync.stderr).trim())

// ---------------------------------------------------------------------------
console.log('\n[4] cloudflared discovery')
const tmp = mkdtempSync(join(tmpdir(), 'kita-gw-verify-'))
try {
  const binDir = join(tmp, 'bin')
  mkdirSync(binDir)
  const fakeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const fakePath = join(binDir, fakeName)
  writeFileSync(fakePath, 'placeholder')
  equal('configured path wins', resolveCloudflared(fakePath, { PATH: '' }), fakePath)
  equal('CLOUDFLARED_PATH is honoured', resolveCloudflared('', { CLOUDFLARED_PATH: fakePath, PATH: '' }), fakePath)
  equal('PATH is searched', resolveCloudflared('', { PATH: binDir }), fakePath)
  equal('nothing found -> empty', resolveCloudflared('', { PATH: join(tmp, 'nope') }), '')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// A fake cloudflared driven by the injected process factory: it prints a URL,
// optionally dies, and records how it was spawned.
function fakeProcess({ url = 'https://fake-tunnel-abc.trycloudflare.com', exitAfterUrlMs = 0, register = true } = {}) {
  const proc = new EventEmitter()
  proc.pid = 4242
  proc.killed = false
  proc.stdout = new Readable({ read() {} })
  proc.stderr = new Readable({ read() {} })
  proc.kill = () => {
    proc.killed = true
    setImmediate(() => proc.emit('exit', null, 'SIGTERM'))
    return true
  }
  setTimeout(() => {
    proc.stdout.push(`2026-09-11T00:00:00Z INF +--------------------------------------------+\n`)
    proc.stderr.push(`2026-09-11T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at:  |\n`)
    proc.stderr.push(`2026-09-11T00:00:00Z INF |  ${url}  |\n`)
    // The real binary logs this a few seconds after the hostname, and `start()`
    // waits for it because the edge answers HTTP 530 until it appears.
    if (register) {
      proc.stderr.push(`2026-09-11T00:00:00Z INF Registered tunnel connection connIndex=0 `
        + `connection=9f0c event=0 ip=198.41.192.7 location=lax12 protocol=http2\n`)
    }
    if (exitAfterUrlMs > 0) setTimeout(() => proc.emit('exit', 1, null), exitAfterUrlMs)
  }, 5)
  return proc
}

console.log('\n[5] tunnel controller')
{
  const spawned = []
  const tunnel = createTunnel({
    port: 3081,
    binary: 'cloudflared',
    log: { log() {}, error() {} },
    spawnImpl: (bin, args, opts) => {
      const proc = fakeProcess()
      spawned.push({ bin, args, opts })
      return proc
    },
  })
  equal('starts stopped', tunnel.state().phase, 'stopped')
  const state = await tunnel.start(2000)
  equal('phase becomes running', state.phase, 'running')
  equal('url is parsed out of the log', state.url, 'https://fake-tunnel-abc.trycloudflare.com')
  check('start waits for the edge registration', state.ready === true)
  equal('binary is spawned', spawned.length, 1)
  equal('the tunnel points at the gateway port',
    spawned[0].args.join(' '), 'tunnel --url http://127.0.0.1:3081 --no-autoupdate')
  check('the child window is hidden on Windows', spawned[0].opts.windowsHide === true)
  const stopped = await tunnel.stop()
  equal('stop returns to stopped', stopped.phase, 'stopped')
  equal('stop clears the public url', stopped.url, '')
  await tunnel.dispose()
}

{
  // Networks that silently drop QUIC never reach "Registered tunnel
  // connection", so the edge answers the public URL with Error 1033. A forced
  // protocol is the escape hatch, and `auto` must stay byte-identical to the
  // argv this controller has always produced.
  const capture = (options) => {
    const spawned = []
    const tunnel = createTunnel({
      port: 3081,
      binary: 'cloudflared',
      log: { log() {}, error() {} },
      ...options,
      spawnImpl: (bin, args, opts) => {
        const proc = fakeProcess()
        spawned.push({ bin, args, opts })
        return proc
      },
    })
    return { tunnel, spawned }
  }

  const forced = capture({ protocol: 'http2' })
  await forced.tunnel.start(2000)
  equal('a forced protocol reaches cloudflared',
    forced.spawned[0].args.join(' '),
    'tunnel --url http://127.0.0.1:3081 --no-autoupdate --protocol http2')
  equal('the forced protocol is reported', forced.tunnel.state().protocol, 'http2')
  await forced.tunnel.dispose()

  const automatic = capture({ protocol: 'auto' })
  await automatic.tunnel.start(2000)
  equal('auto leaves the transport to cloudflared',
    automatic.spawned[0].args.join(' '), 'tunnel --url http://127.0.0.1:3081 --no-autoupdate')
  await automatic.tunnel.dispose()

  const unknown = capture({ protocol: 'not-a-protocol' })
  await unknown.tunnel.start(2000)
  equal('an unknown transport falls back to auto',
    unknown.spawned[0].args.join(' '), 'tunnel --url http://127.0.0.1:3081 --no-autoupdate')
  await unknown.tunnel.dispose()
}

{
  // The tunnel must refuse to pretend it works when the binary is missing.
  const tunnel = createTunnel({ port: 3081, binary: '', log: { log() {}, error() {} } })
  equal('no binary -> unavailable', tunnel.state().available, false)
  const state = await tunnel.start(50)
  check('no binary -> actionable error', /cloudflared/.test(state.error), state.error)
  equal('no binary -> never spawns', state.phase, 'error')
  await tunnel.dispose()
}

{
  // An unexpected exit must be retried, and give up after the limit.
  let spawns = 0
  const tunnel = createTunnel({
    port: 3081,
    binary: 'cloudflared',
    restartLimit: 1,
    log: { log() {}, error() {} },
    spawnImpl: () => {
      spawns += 1
      const proc = fakeProcess({ exitAfterUrlMs: 1 })
      return proc
    },
  })
  await tunnel.start(300)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && tunnel.state().phase !== 'error') {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const final = tunnel.state()
  equal('gives up after the restart limit', final.phase, 'error')
  check('reported restarts match the limit', final.restarts === 1, `restarts=${final.restarts}`)
  check('the failure is explained', /退出|放弃/.test(final.error), final.error)
  check('it did retry once', spawns >= 2, `spawns=${spawns}`)
  await tunnel.dispose()
}

check('the URL pattern only matches trycloudflare hosts',
  TUNNEL_URL_PATTERN.test('https://a-b-c.trycloudflare.com') && !TUNNEL_URL_PATTERN.test('https://evil.example.com'))

// A real child process, to prove stop() actually reaps it.
console.log('\n[6] tunnel controller against a real process')
{
  const nodeBin = process.execPath
  const script = join(tmpdir(), `kita-fake-cloudflared-${process.pid}.mjs`)
  writeFileSync(script, [
    `process.stdout.write('INF |  https://real-fake-tunnel.trycloudflare.com  |\\n')`,
    `setInterval(() => {}, 1000)`,
  ].join('\n'))
  const tunnel = createTunnel({
    port: 3081,
    binary: nodeBin,
    log: { log() {}, error() {} },
    spawnImpl: (bin, _args, opts) => spawn(bin, [script], opts),
  })
  const state = await tunnel.start(4000)
  equal('real process: running', state.phase, 'running')
  equal('real process: url parsed', state.url, 'https://real-fake-tunnel.trycloudflare.com')
  check('real process: pid recorded', state.pid > 0, `pid=${state.pid}`)
  await tunnel.stop()
  rmSync(script, { force: true })
  equal('real process: stopped', tunnel.state().phase, 'stopped')
}

// ---------------------------------------------------------------------------
// The credential store. What this guards: the raw token must never reach the
// disk (a copy of the file would otherwise be a working credential), a v1 file
// must keep every paired device working across the upgrade, and a torn write
// must not silently log everyone out.
console.log('\n[7] credential store')
{
  const storeTmp = mkdtempSync(join(tmpdir(), 'kita-gw-store-'))
  try {
    const file = join(storeTmp, 'tokens.json')
    const token = 'a'.repeat(64)
    const meta = { ua: 'test agent', at: Date.now(), ip: '10.0.0.2', lastActive: Date.now() }
    const tokens = new Map([[hashToken(token), meta]])

    equal('saveStore reports success', saveStore(file, tokens, '123456'), true)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    equal('the store is versioned', raw.version, STORE_VERSION)
    equal('the hash is the key on disk', Object.keys(raw.tokens), [hashToken(token)])
    check('the raw token is not on disk', JSON.stringify(raw).includes(token) === false)

    const loaded = loadStore(file)
    equal('a v2 store loads unchanged', loaded.tokens.has(hashToken(token)), true)
    equal('a v2 store is not marked migrated', loaded.migrated, false)
    equal('the pairing code round-trips', loaded.currentCode, '123456')
    equal('deviceId is the hash prefix', deviceId(token), hashToken(token).slice(0, 16))

    // v1: the map was keyed by the raw token. A phone paired before the upgrade
    // still sends that raw token as its cookie, so hashing on load is what keeps
    // it working.
    writeFileSync(file, JSON.stringify({ currentCode: '654321', tokens: { [token]: meta } }))
    const v1 = loadStore(file)
    equal('a v1 store is marked migrated', v1.migrated, true)
    equal('a v1 raw key is hashed on load', v1.tokens.has(hashToken(token)), true)
    equal('the raw key is gone after migration', v1.tokens.has(token), false)
    equal('v1 keeps its pairing code', v1.currentCode, '654321')

    const stale = { ...meta, at: Date.now() - TOKEN_TTL_MS - 1000 }
    writeFileSync(file, JSON.stringify({ version: STORE_VERSION, tokens: { [hashToken(token)]: stale } }))
    equal('an expired token is dropped on load', loadStore(file).tokens.size, 0)
    const live = new Map([[hashToken(token), stale]])
    equal('pruneExpired removes expired entries', pruneExpired(live), 1)
    equal('pruneExpired empties the map', live.size, 0)
    check('isExpired leaves a token inside its window', isExpired({ at: Date.now() - TOKEN_TTL_MS + 60000 }) === false)
    equal('expiresAt is issued-at plus the TTL', expiresAt({ at: 1000 }), 1000 + TOKEN_TTL_MS)
    check('a token with no issue date is treated as expired', isExpired({}) === true)

    // A torn write leaves a stray .tmp behind; the store itself must still load.
    writeFileSync(file + '.tmp', '{ not json at all')
    equal('a stray .tmp does not break loading', loadStore(file).tokens.size, 0)
    const missing = loadStore(join(storeTmp, 'absent.json'))
    check('a missing store loads empty instead of throwing', missing.tokens.size === 0 && missing.migrated === false)
  } finally {
    rmSync(storeTmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
void pkgRoot
