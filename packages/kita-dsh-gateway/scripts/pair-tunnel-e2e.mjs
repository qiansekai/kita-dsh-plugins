// Live checks against a running gateway + dsh webserver.
//
//   node scripts/pair-tunnel-e2e.mjs                  # local + LAN + pairing
//   KITA_E2E_TUNNEL=1 node scripts/pair-tunnel-e2e.mjs   # also opens a real
//                                                        # Cloudflare tunnel
//
// Ports come from KITA_GW_PORT / KITA_DSH_PORT (defaults 3081 / 3080) and the
// LAN address from KITA_LAN_IP (auto-detected otherwise) — nothing about this
// machine is baked in.
//
// What it proves beyond `verify-gateway.mjs`: the QR payload is served **only**
// to the machine itself, a phone that paired over the LAN can use the proxy but
// cannot move the tunnel switch, and (with KITA_E2E_TUNNEL=1) the one-click
// tunnel really comes up, serves the pairing page over the public hostname, and
// goes away again.

import os from 'node:os'
import https from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { localCandidates, pairUrl } from '../lib/pair-util.js'

const GW_PORT = Number(process.env.KITA_GW_PORT ?? 3081)
const DSH_PORT = Number(process.env.KITA_DSH_PORT ?? 3080)
const WITH_TUNNEL = process.env.KITA_E2E_TUNNEL === '1'
const GATEWAY = `http://127.0.0.1:${GW_PORT}`
const PANEL = `http://127.0.0.1:${DSH_PORT}/kita-gateway/panel`

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

// The first candidate is now the best *physical* adapter (virtual switches and
// mobile hotspots are ranked below every real one), which is what a phone on the
// same Wi-Fi can actually reach.
const lanIp = process.env.KITA_LAN_IP || localCandidates([], os.networkInterfaces())[0]?.ip || ''
if (lanIp === '') {
  console.error('no usable LAN address found; set KITA_LAN_IP')
  process.exit(2)
}
const LAN = `http://${lanIp}:${GW_PORT}`
console.log(`gateway ${GATEWAY} / dsh ${PANEL}\nLAN entry ${LAN}${WITH_TUNNEL ? '\ntunnel checks: ON' : ''}`)

/** GET/POST through the gateway (the LAN door, as a phone sees it). */
async function viaGateway(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (options.cookie !== undefined) headers.Cookie = options.cookie
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${LAN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

/** Panel reads and writes on the loopback webserver (the local door). */
async function panel(action, extra = {}) {
  const options = action === undefined
    ? { headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      }
  const res = await fetch(PANEL, options)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch { /* left null */ }
  return { status: res.status, body, text }
}

// ---------------------------------------------------------------------------
console.log('\n[1] the pairing page: QR for this machine, never for a remote one')
const localPage = await fetch(`${GATEWAY}/gateway-pair`)
const localHtml = await localPage.text()
check('local page returns 200', localPage.status === 200, `status=${localPage.status}`)
check('local page renders the QR card', localHtml.includes('id="localcard"') && localHtml.includes('KITA_LOCAL = true'))
check('local page reads the code from the fragment', localHtml.includes('k=(\\d{6})'))

const remotePage = await viaGateway('/gateway-pair')
check('remote page returns 200', remotePage.status === 200, `status=${remotePage.status}`)
check('remote page hides the QR card', remotePage.text.includes('KITA_LOCAL = false'))
check('remote page does not contain a pairing link',
  !remotePage.text.includes('/gateway-pair#k='), 'found a fragment link in a remote page')

const qrLocal = await fetch(`${GATEWAY}/gateway-pair/qr.json`)
const qrPayload = await qrLocal.json().catch(() => null)
check('local qr.json returns 200', qrLocal.status === 200, `status=${qrLocal.status}`)
check('qr.json carries the LAN url with the code in the fragment',
  typeof qrPayload?.url === 'string' && /\/gateway-pair#k=\d{6}$/.test(qrPayload.url), JSON.stringify(qrPayload?.url))
check('qr.json carries rendered SVG', typeof qrPayload?.svg === 'string' && qrPayload.svg.startsWith('<svg '))
const qrRemote = await viaGateway('/gateway-pair/qr.json')
check('remote qr.json is 404 (the code never leaves the machine)', qrRemote.status === 404, `status=${qrRemote.status}`)

const code = qrPayload?.code ?? ''
check('the code is six digits', /^\d{6}$/.test(code), code)
check('a remote page never echoes the code', !remotePage.text.includes(code))

// ---------------------------------------------------------------------------
console.log('\n[2] panel state as the machine sees it')
const state = await panel()
check('panel GET succeeds', state.status === 200, `status=${state.status}`)
check('panel marks this caller as local', state.body?.entry === 'local' && state.body?.canControl === true,
  `entry=${state.body?.entry} canControl=${state.body?.canControl}`)
const panelTop = (state.body?.candidates ?? [])[0]
const panelTopIp = typeof panelTop === 'string' ? panelTop : String(panelTop?.ip ?? '')
check('the panel\'s first address is a physical adapter',
  panelTopIp !== '' && panelTop?.virtual !== true, JSON.stringify(panelTop))
check('panel exposes the scannable LAN url for its own top candidate',
  typeof state.body?.localPairUrl === 'string'
  && state.body.localPairUrl === pairUrl(`http://${panelTopIp}:${GW_PORT}`, code),
  String(state.body?.localPairUrl))
check('the address this probe dials is among the candidates',
  (state.body?.candidates ?? []).some((entry) => (typeof entry === 'string' ? entry : entry?.ip) === lanIp),
  `lanIp=${lanIp} candidates=${JSON.stringify(state.body?.candidates)}`)
check('every candidate names its adapter',
  (state.body?.candidates ?? []).every((entry) => typeof entry === 'string' || (typeof entry.name === 'string' && entry.name !== '')),
  JSON.stringify(state.body?.candidates))
check('panel reports a ready tunnel', state.body?.tunnel?.available === true,
  JSON.stringify(state.body?.tunnel?.binary))
// Whatever the tunnel and the paired devices were before this run, the run must
// leave them that way: someone may be using this gateway from their phone while
// the probe executes. Only what this script creates gets cleaned up or stopped.
const tunnelWasRunning = state.body?.tunnel?.phase === 'running'
const tokensBefore = new Set((state.body?.devices ?? []).map((device) => device.id))
if (tunnelWasRunning) console.log(`        (tunnel already running: ${state.body?.tunnel?.url} — left untouched)`)
if (tokensBefore.size > 0) console.log(`        (${tokensBefore.size} device(s) already paired — left untouched)`)

// ---------------------------------------------------------------------------
console.log('\n[3] an unpaired phone is stopped at the door')
const panelRemoteHtml = await viaGateway('/kita-gateway/panel', { headers: { Accept: 'text/html' } })
check('unpaired panel request is redirected to the pairing page',
  panelRemoteHtml.status === 302 && panelRemoteHtml.headers.get('location') === '/gateway-pair',
  `status=${panelRemoteHtml.status} location=${panelRemoteHtml.headers.get('location')}`)
const panelRemoteJson = await viaGateway('/kita-gateway/panel', { headers: { Accept: 'application/json' } })
check('unpaired JSON request is 401', panelRemoteJson.status === 401, `status=${panelRemoteJson.status}`)

// ---------------------------------------------------------------------------
console.log('\n[4] pairing over the LAN door')
const pairRes = await fetch(`${LAN}/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code }),
})
check('pairing succeeds', pairRes.status === 200, `status=${pairRes.status}`)
const setCookie = pairRes.headers.getSetCookie?.() ?? []
const cookie = (setCookie[0] ?? '').split(';')[0]
check('a gateway cookie is issued', /^kita_gw=[0-9a-f]{64}$/.test(cookie), cookie.slice(0, 16))
check('the cookie is HttpOnly', setCookie.join(';').includes('HttpOnly'))

const rootAfterPair = await viaGateway('/', { cookie })
check('a paired phone reaches dsh', [200, 302, 303].includes(rootAfterPair.status), `status=${rootAfterPair.status}`)
check('it is not bounced back to pairing',
  (rootAfterPair.headers.get('location') ?? '') !== '/gateway-pair', String(rootAfterPair.headers.get('location')))

const panelAsPhone = await viaGateway('/kita-gateway/panel', { cookie, headers: { Accept: 'application/json' } })
check('a paired phone can read the panel', panelAsPhone.status === 200, `status=${panelAsPhone.status}`)
let phoneView = null
try {
  phoneView = JSON.parse(panelAsPhone.text)
} catch { /* left null */ }
check('the phone is not granted local control',
  phoneView?.entry === 'lan' && phoneView?.canControl === false,
  `entry=${phoneView?.entry} canControl=${phoneView?.canControl}`)
// The pairing code is the whole authentication: a device that already holds a
// credential must not be able to read it off its own screen and hand it on.
check('a paired phone is never handed the pairing code',
  phoneView?.code === '' && phoneView?.codeLocalOnly === true,
  `code=${JSON.stringify(phoneView?.code)} codeLocalOnly=${phoneView?.codeLocalOnly}`)
check('a paired phone gets no code-carrying url',
  phoneView?.localPairUrl === '' && phoneView?.tunnel?.pairUrl === '',
  `localPairUrl=${JSON.stringify(phoneView?.localPairUrl)}`)
check('a paired phone is told which device it is',
  typeof phoneView?.selfId === 'string' && phoneView.selfId.length === 16,
  String(phoneView?.selfId))
check('device rows carry a handle, never a token',
  (phoneView?.devices ?? []).every((device) => typeof device.id === 'string' && device.token === undefined),
  JSON.stringify((phoneView?.devices ?? [])[0] ?? null))
const refused = await viaGateway('/kita-gateway/panel', {
  cookie,
  method: 'POST',
  headers: { Accept: 'application/json' },
  body: { action: 'tunnel-start' },
})
check('a phone may not open the public door', refused.status === 403, `status=${refused.status} body=${refused.text.slice(0, 120)}`)

const forged = await viaGateway('/kita-gateway/panel', {
  cookie,
  method: 'POST',
  headers: { Accept: 'application/json', 'cf-connecting-ip': '' },
  body: { action: 'tunnel-stop' },
})
check('a phone may not close the tunnel either', forged.status === 403, `status=${forged.status}`)

// ---------------------------------------------------------------------------
if (WITH_TUNNEL) {
  console.log('\n[5] one-click tunnel (this exposes the gateway for a few seconds)')
  const started = await panel('tunnel-start')
  check('tunnel-start is accepted', started.status === 200 && started.body?.ok === true,
    `status=${started.status} error=${started.body?.error ?? started.body?.tunnel?.error}`)
  const tunnelUrl = started.body?.tunnel?.url ?? ''
  check('a public hostname was assigned', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(tunnelUrl), tunnelUrl)

  /**
   * A freshly assigned hostname needs a moment before the Cloudflare edge has a
   * live connection to cloudflared, so an immediate request can still fail —
   * retry instead of calling the tunnel broken.
   */
  const fetchPublic = async (url, attempts = 6, gapMs = 3000) => {
    let error = ''
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await fetch(url, { redirect: 'manual' })
        if (res.status < 500) return { res, status: res.status, body: '', error: '' }
        error = `HTTP ${res.status}`
      } catch (fetchError) {
        error = String(fetchError?.cause?.code ?? fetchError?.message ?? fetchError)
      }
      if (attempt === 0) console.log(`        (public hostname not answering yet: ${error}; retrying)`)
      await delay(gapMs)
    }
    return { res: null, status: 0, body: '', error }
  }

  /**
   * Resolve a hostname over DoH. A local resolver that has just cached
   * NXDOMAIN for a brand-new tunnel hostname (or that answers with an AAAA the
   * machine cannot route) makes a plain fetch fail even though the tunnel is
   * reachable — this is the escape hatch, and it is called out in the log.
   */
  const resolveViaDoh = async (host) => {
    const endpoint = process.env.KITA_E2E_DOH ?? 'https://dns.alidns.com/resolve'
    const res = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { Accept: 'application/dns-json' },
    })
    const body = await res.json()
    return (body.Answer ?? []).find((entry) => entry.type === 1)?.data ?? ''
  }

  /** GET straight at a resolved IPv4 address, keeping SNI + Host for TLS. */
  const getViaIp = (url, ip) => new Promise((resolve) => {
    const target = new URL(url)
    const req = https.request({
      host: ip,
      servername: target.hostname,
      port: 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Host: target.host, Accept: 'text/html' },
      timeout: 15000,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, error: '' }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolve({ status: 0, body: '', error: String(error?.code ?? error.message) }))
    req.end()
  })

  let publicAttempt = tunnelUrl === ''
    ? { status: 0, body: '', error: 'no hostname' }
    : await fetchPublic(`${tunnelUrl}/gateway-pair`)
  if (publicAttempt.status !== 200 && tunnelUrl !== '') {
    // Two environment traps make a plain fetch of a brand-new tunnel hostname
    // fail even though the tunnel is fine: a local resolver still negative-
    // caching it, and an AAAA answer this machine cannot route. So resolve over
    // DoH and connect to the IPv4 directly, keeping SNI and Host so the TLS
    // certificate is still validated against the real hostname.
    let ip = await resolveViaDoh(new URL(tunnelUrl).hostname).catch(() => '')
    for (let attempt = 0; attempt < 6 && ip !== ''; attempt += 1) {
      if (attempt === 0) console.log(`        (plain fetch said "${publicAttempt.error}"; retrying via DoH ${ip})`)
      const viaIp = await getViaIp(`${tunnelUrl}/gateway-pair`, ip)
      if (viaIp.status === 200) {
        publicAttempt = viaIp
        break
      }
      // 530 means the edge knows the hostname but has no connection to
      // cloudflared yet — that is a "not yet", not a failure, so keep polling.
      publicAttempt = { ...viaIp, error: viaIp.status === 0 ? viaIp.error : `HTTP ${viaIp.status}` }
      await delay(3000)
      if (ip === '') ip = await resolveViaDoh(new URL(tunnelUrl).hostname).catch(() => '')
    }
  }
  check('the tunnel serves the pairing page', publicAttempt.status === 200,
    `status=${publicAttempt.status} error=${publicAttempt.error}`)
  if (typeof publicAttempt.res?.text === 'function') publicAttempt.body = await publicAttempt.res.text()
  check('the tunnel page hides the QR card (it is not a local request)',
    publicAttempt.body.includes('KITA_LOCAL = false'))

  const afterStart = await panel()
  check('panel reports the tunnel running', afterStart.body?.tunnel?.phase === 'running',
    String(afterStart.body?.tunnel?.phase))
  check('panel derives a public pairing url',
    typeof afterStart.body?.tunnel?.pairUrl === 'string' && afterStart.body.tunnel.pairUrl.includes('#k='),
    String(afterStart.body?.tunnel?.pairUrl))

  if (tunnelWasRunning) {
    console.log('        (tunnel was already up before this run — leaving it running)')
  } else {
    const stopped = await panel('tunnel-stop')
    check('tunnel-stop is accepted', stopped.status === 200, `status=${stopped.status}`)
    check('the tunnel returns to stopped', stopped.body?.tunnel?.phase === 'stopped',
      String(stopped.body?.tunnel?.phase))
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] cleanup')
const devicesNow = (await panel()).body?.devices ?? []
const created = devicesNow.filter((device) => !tokensBefore.has(device.id))
let revoked = 0
for (const device of created) {
  const result = await panel('revoke', { id: device.id })
  if (result.body?.ok === true) revoked += 1
}
check('exactly the pairing this run created was revoked', revoked === created.length,
  `created ${created.length}, revoked ${revoked}`)
check('pre-existing devices survived the probe',
  (await panel()).body?.devices?.length === tokensBefore.size,
  `before ${tokensBefore.size}, after ${(await panel()).body?.devices?.length}`)

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
