/**
 * kita-dsh-gateway — pairing-code auth gateway for `dsh web`.
 *
 * Keeps the dsh webserver loopback-only while exposing ONE authenticated
 * entry point on the LAN (default :3081). First visit shows a pairing page;
 * entering the code printed in the dsh console issues a long-lived random
 * token (HttpOnly cookie + Bearer header). Every authenticated request is
 * reverse-proxied to 127.0.0.1:<targetPort> with the Host header rewritten,
 * so dsh sees a local client (loopback fence passes, local-only features
 * work). WebSocket upgrades (the mux/host event streams) are proxied too.
 *
 * Threats this answers: LAN neighbours, and future frp / cloudflared /
 * tailscale tunnels pointed at this port. What it does NOT protect against:
 * processes already running on this machine (they can read the token file).
 */
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  DEVICE_HEADER,
  ENTRY_HEADER,
  ENTRY_LAN,
  ENTRY_LOCAL,
  ENTRY_TUNNEL,
  entryOf,
  isUsableIp,
  localCandidates,
  pairUrl,
} from './pair-util.js'
import { qrSvg } from './qr.js'
import {
  TOKEN_TTL_MS,
  deviceId,
  expiresAt,
  hashToken,
  isExpired,
  loadStore,
  pruneExpired,
  saveStore,
} from './token-store.js'
import {
  ADMIN_COOKIE,
  ADMIN_QUERY,
  adminEntryUrl,
  adminEntryHintPath,
  adminGrantCookie,
  adminSecretMatches,
  loadAdminSecret,
  writeAdminEntryHint,
} from './local-admin.js'
import { createTunnel, resolveCloudflared } from './tunnel.js'

export const name = 'kita-dsh-gateway'

export const Config = z.object({
  port: z.natural().max(65535).default(3081),
  targetPort: z.natural().max(65535).default(3080),
  codeMinutes: z.natural().min(1).default(10),
  /**
   * Path to cloudflared for the one-click Quick Tunnel. Empty falls back to
   * `CLOUDFLARED_PATH` and then to `PATH`, so no machine-specific location is
   * baked into the plugin.
   */
  cloudflaredPath: z.string().default(''),
  /** Automatic restarts after the tunnel process dies unexpectedly. */
  tunnelRestartLimit: z.natural().max(50).default(5),
  /**
   * Transport for the one-click Quick Tunnel. `auto` leaves the choice to
   * cloudflared, which prefers QUIC over UDP — on a network that silently
   * drops QUIC (campus and guest Wi-Fi, some carrier links) that preference
   * never registers, so the tunnel shows zero edge connections and Cloudflare
   * answers every public request with Error 1033. `http2` forces TCP 443,
   * which those networks pass. Measured 2026-09-14 on HNGY: `quic` failed to
   * dial for 30s straight while `http2` registered in 1s.
   *
   * Note: schemastery exposes `z.union`, not `z.enum` — `z.enum` is undefined
   * and throws while the plugin loads, taking the whole gateway down with it.
   */
  tunnelProtocol: z.union(['auto', 'http2', 'quic']).default('http2'),
  /** How long a `tunnel-start` request waits for the public URL. */
  tunnelStartTimeoutMs: z.natural().max(120000).default(25000),
  /**
   * Pin the local-admin secret instead of letting the gateway mint one into
   * `<DSH_HOME>/storages/kita-dsh-gateway-admin.json`. A deployment value;
   * empty (the default) means "read the file, mint on first boot".
   */
  adminToken: z.string().default(''),
})

const COOKIE_NAME = 'kita_gw'
const TARGET_HOST = '127.0.0.1'
const MAX_PAIR_ATTEMPTS = 5
const PAIR_WINDOW_MS = 60 * 1000
/**
 * Escalating lockout tiers after each burst of MAX_PAIR_ATTEMPTS failures in
 * PAIR_WINDOW_MS: the first burst locks the ip for 5 minutes, the next for
 * 30, then 6 hours, then 24 hours, and a fifth burst locks it permanently
 * (until the process restarts). A successful pairing clears the strikes.
 */
const LOCKOUT_TIERS = [
  { strikes: 1, ms: 5 * 60 * 1000 },
  { strikes: 2, ms: 30 * 60 * 1000 },
  { strikes: 3, ms: 6 * 3600 * 1000 },
  { strikes: 4, ms: 24 * 3600 * 1000 },
  { strikes: 5, ms: null }, // permanent until restart
]
/** Global fuse: more than this many failed attempts in an hour disables pairing entirely until restart. */
const GLOBAL_FAIL_LIMIT = 300
const GLOBAL_FAIL_WINDOW_MS = 3600 * 1000

const sha256 = (s) => crypto.createHash('sha256').update(s).digest()
const timingSafeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)))

function storagePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'kita-dsh-gateway-tokens.json')
}

/**
 * Where the local-admin secret lives. Separate from the token store on
 * purpose: rotating one must never disturb the other, and the file is the one
 * thing a tunnel cannot read.
 */
function adminStoragePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'kita-dsh-gateway-admin.json')
}

/**
 * Persist the store. Every caller funnels through here so the hashed-key shape
 * and the atomic write stay in one place (`lib/token-store.js`).
 */
function saveState(tokens, currentCode) {
  return saveStore(storagePath(), tokens, currentCode)
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * The token this request carries, or null.
 *
 * The cookie / Bearer value is the raw token as issued to the device; the store
 * is keyed by its hash, so every lookup hashes first. Expiry is evaluated here,
 * on every request, because a token that only expires when the process restarts
 * is not a 90-day token at all.
 */
function isAuthed(req, tokens) {
  const cookies = parseCookies(req.headers.cookie)
  const cookie = cookies[COOKIE_NAME]
  if (typeof cookie === 'string' && cookie !== '') {
    const meta = tokens.get(hashToken(cookie))
    if (meta !== undefined && !isExpired(meta)) return cookie
  }
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    const meta = tokens.get(hashToken(token))
    if (meta !== undefined && !isExpired(meta)) return token
  }
  return null
}

function acceptsHtml(req) {
  const accept = req.headers.accept ?? ''
  return accept.includes('text/html')
}

/** alpha launch token captured by the start script; empty when unavailable. */
function launchToken() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    return readFileSync(join(home, 'storages', 'alpha-web-token.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** True when the request already carries a dsh browser cookie. */
function hasDshCookie(req) {
  const cookies = parseCookies(req.headers.cookie)
  return Object.keys(cookies).some((k) => k.startsWith('dsh-auth-'))
}

/**
 * Attach the alpha launch token to the sign-in entry (GET / without token).
 * Browsers that already hold a valid dsh cookie must NOT receive the token
 * again: dsh answers a token-bearing request with a valid cookie by
 * 303 -> "/" (token-stripping), and the next hop would be re-injected here,
 * looping forever (ERR_TOO_MANY_REDIRECTS).
 */
function withLaunchToken(url, req) {
  try {
    const u = new URL(url, 'http://gateway.invalid')
    if (u.pathname === '/' && !u.searchParams.has('token')) {
      if (hasDshCookie(req)) return url
      const t = launchToken()
      if (t) {
        u.searchParams.set('token', t)
        return u.pathname + u.search
      }
    }
  } catch {}
  return url
}

/** True when the socket peer is this machine (the browser or cloudflared). */
function isLoopbackPeer(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function proxyHttp(req, res, targetPort, token = '') {
  // Rewrite Host to loopback and strip Origin/Referer/Sec-Fetch-Site: the
  // browser on a LAN origin sends its own Origin, and dsh's loopback fence
  // rejects any request whose Origin host differs from the Host header.
  const headers = { ...req.headers, host: `${TARGET_HOST}:${targetPort}` }
  delete headers.origin
  delete headers.referer
  delete headers['sec-fetch-site']
  // Stamp which door this request came through, and never accept the client's
  // own answer: the mark is stripped here and rebuilt from what this process
  // can observe. `cf-connecting-ip` survives only when cloudflared dialled us
  // over loopback — a LAN client must not be able to name its own address, or
  // it could park its failed pairing attempts in someone else's rate-limit
  // bucket (and the panel would see a forged tunnel origin).
  const viaTunnel = isLoopbackPeer(req) && typeof req.headers['cf-connecting-ip'] === 'string'
  delete headers[ENTRY_HEADER]
  delete headers['cf-connecting-ip']
  headers[ENTRY_HEADER] = viaTunnel ? ENTRY_TUNNEL : ENTRY_LAN
  if (viaTunnel) headers['cf-connecting-ip'] = req.headers['cf-connecting-ip']
  // Only the panel consumes this, so only the panel hop carries it: the rest
  // of the webserver keeps seeing exactly the headers it saw before.
  delete headers[DEVICE_HEADER]
  if (token !== '') headers[DEVICE_HEADER] = deviceId(token)
  const target = http.request({
    host: TARGET_HOST,
    port: targetPort,
    method: req.method,
    path: withLaunchToken(req.url, req),
    headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers)
    upstream.pipe(res)
  })
  target.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('upstream dsh unreachable')
  })
  req.pipe(target)
}

function proxyWs(req, socket, head, targetPort) {
  const upstream = net.connect(targetPort, TARGET_HOST, () => {
    const lines = [
      `${req.method} ${req.url} HTTP/1.1`,
      `host: ${TARGET_HOST}:${targetPort}`,
      ...Object.entries(req.headers)
        .filter(([k]) => k !== 'host' && k !== 'origin' && k !== 'referer' && k !== 'sec-fetch-site')
        .map(([k, v]) => `${k}: ${v}`),
      '', '',
    ]
    upstream.write(lines.join('\r\n'))
    if (head && head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
}

/**
 * The pairing page served on the gateway port.
 *
 * `local === true` only when the page is open on this machine AND the browser
 * carries the local-admin grant — then, and only then, it renders the QR that
 * carries the code plus a poller that keeps that QR in step with the rotation.
 * A phone, a LAN neighbour and a tunnel visitor all get the plain six-digit
 * form: rendering the code into a page anyone can load would hand out the
 * pairing code itself, and that code is the entire authentication.
 *
 * `locked === true` is the in-between case: a loopback caller whose browser has
 * not picked up the grant yet (fresh profile, cleared cookies, or the very first
 * visit after the secret was minted). It is told where the entry link lives
 * instead of being shown a code it may not see.
 *
 * A scanned link carries the code in the fragment and the page submits it on
 * its own, so scanning means being paired — no typing.
 */
const pairPage = (local, paired = false, locked = false) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对 · dsh</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;
       background:#0f1115;color:#e8eaed}
  .stack{display:flex;flex-direction:column;gap:16px;width:min(320px,84vw)}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;padding:28px 24px;
        text-align:center}
  h1{font-size:17px;font-weight:600;margin:0 0 8px}
  p{font-size:13px;color:#9aa3b2;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a4150;
        background:#0f1115;color:#e8eaed;font-size:20px;text-align:center;letter-spacing:8px;
        outline:none}
  input:focus{border-color:#4f6ef7}
  button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f6ef7;
         color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5}
  a.enter{display:block;margin-top:14px;color:#8ab4ff;font-size:14px;text-decoration:none}
  .err{color:#f28b82;font-size:13px;margin-top:12px;min-height:18px}
  .qr{background:#fff;display:inline-block;padding:8px;border-radius:10px;line-height:0}
  .qrurl{font-size:11px;color:#9aa3b2;word-break:break-all;margin-top:10px;user-select:all}
  .cap{font-size:11px;color:#9aa3b2;margin-top:8px}
</style>
</head>
<body>
  <div class="stack">
    <div class="card" id="pairedcard" style="display:none">
      <h1>这台设备已经配对过了</h1>
      <p>凭据仍在有效期内，不需要重新输入配对码。</p>
      <a class="enter" href="/">进入 dsh</a>
    </div>
    <div class="card" id="paircard">
      <h1>配对 dsh</h1>
      <p>输入电脑上 dsh 页面「配对」页签里显示的 6 位配对码</p>
      <input id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code"
             enterkeyhint="go" autofocus>
      <button id="go">配对</button>
      <div class="err" id="err"></div>
    </div>
    <div class="card" id="localcard" style="display:none">
      <h1>扫码即配对</h1>
      <p>手机扫这个码，配对码会自动填入并直接提交</p>
      <div class="qr" id="qrimg"></div>
      <div class="qrurl" id="qrurl"></div>
      <div class="cap">这个二维码只在电脑本机打开本页时出现</div>
    </div>
    <div class="card" id="lockedcard" style="display:none">
      <h1>本机管理面需要授权</h1>
      <p>这个请求来自本机，但浏览器还没有拿到本机管理令牌。在电脑上打开 <code>storages/kita-dsh-gateway-admin-url.txt</code> 里的链接一次即可（dsh 启动日志打印了同一行；手机与隧道访客拿不到它）。</p>
    </div>
  </div>
<script>
const KITA_LOCAL = ${local ? 'true' : 'false'}
const KITA_PAIRED = ${paired ? 'true' : 'false'}
const go = document.getElementById('go')
const code = document.getElementById('code')
const err = document.getElementById('err')
const KITA_LOCKED = ${locked ? 'true' : 'false'}
let autoPair = false
code.addEventListener('input', () => { err.textContent = '' })
code.addEventListener('keydown', (e) => { if (e.key === 'Enter') pair() })
go.addEventListener('click', pair)
async function pair() {
  const value = code.value.trim()
  if (!/^\\d{6}$/.test(value)) { err.textContent = '请输入 6 位数字'; return }
  go.disabled = true
  try {
    const res = await fetch('/pair', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: value }) })
    if (res.ok) { location.href = '/'; return }
    const body = await res.json().catch(() => ({}))
    let message = body.error || ('配对失败（HTTP ' + res.status + '）')
    if (typeof body.remaining === 'number' && body.remaining > 0) {
      message += '，还剩 ' + body.remaining + ' 次机会'
    }
    if (autoPair) message += '，二维码里的配对码可能已轮换，请输入屏幕上的最新 6 位数字'
    err.textContent = message
  } catch { err.textContent = '网络错误，请重试' }
  autoPair = false
  go.disabled = false
}
// A scanned link carries the code in the fragment: fill it in, drop it from the
// address bar so a screenshot or a shared URL cannot leak it, then submit.
;(function autoFromHash() {
  const match = /(?:^#?|&)k=(\\d{6})(?:&|$)/.exec(location.hash || '')
  if (match === null) return
  code.value = match[1]
  try { history.replaceState(null, '', location.pathname + location.search) } catch (e) { /* ignore */ }
  autoPair = true
  pair()
})()
let lastQr = null
async function refreshQr() {
  try {
    const res = await fetch('/gateway-pair/qr.json', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    // Re-render only when the payload changed: rewriting the SVG every five
    // seconds makes the code jump while someone is lining up a phone.
    if (data.svg !== lastQr) {
      lastQr = data.svg
      document.getElementById('qrimg').innerHTML = data.svg || ''
      document.getElementById('qrurl').textContent = data.svg
        ? (data.url || '')
        : '未取到本机局域网地址，请手动访问 http://<本机IP>:' + (data.port || '') + '/gateway-pair'
    }
  } catch (e) { /* retry next tick */ }
}
if (KITA_LOCAL) {
  document.getElementById('localcard').style.display = 'block'
  refreshQr()
  setInterval(refreshQr, 5000)
}
if (KITA_PAIRED) {
  document.getElementById('pairedcard').style.display = 'block'
  document.getElementById('paircard').style.display = 'none'
}
if (KITA_LOCKED) {
  document.getElementById('lockedcard').style.display = 'block'
}
</script>
</body>
</html>`

const ADMIN_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对管理 · dsh</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;justify-content:center;font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed}
  .wrap{width:min(480px,92vw);padding:24px 0}
  h1{font-size:18px;font-weight:600;margin:0 0 4px}
  .sub{font-size:13px;color:#9aa3b2;margin:0 0 20px}
  .code{background:#1a1d24;border:1px solid #2a2e38;border-radius:14px;padding:18px;text-align:center}
  .code .v{font-size:34px;font-weight:700;letter-spacing:10px;font-variant-numeric:tabular-nums}
  .code .h{font-size:12px;color:#9aa3b2;margin-bottom:8px}
  .dev{margin-top:20px}
  .dev h2{font-size:14px;color:#9aa3b2;margin:0 0 10px}
  .row{background:#1a1d24;border:1px solid #2a2e38;border-radius:10px;padding:10px 12px;
       display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .row .ua{flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .t{font-size:11px;color:#9aa3b2;flex:none;text-align:right;max-width:48%;white-space:pre-wrap}
  .row button{flex:none;background:#3a1d22;color:#f28b82;border:1px solid #5a2a32;border-radius:8px;
              padding:6px 12px;font-size:12px;cursor:pointer}
  .empty{font-size:13px;color:#9aa3b2}
  .code button{margin-top:12px;background:#22305a;color:#cfe0ff;border:1px solid #35507f;
               border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}
  .code button:disabled{opacity:.5;cursor:default}
  .qr{margin-top:16px;background:#1a1d24;border:1px solid #2a2e38;border-radius:14px;padding:18px;
      text-align:center}
  .qr .h{font-size:12px;color:#9aa3b2;margin-bottom:10px}
  .qr .img{background:#fff;display:inline-block;padding:8px;border-radius:10px;line-height:0}
  .qr .url{font-size:11px;color:#9aa3b2;word-break:break-all;margin-top:10px;user-select:all}
  .qr .cap{font-size:11px;color:#9aa3b2;margin-top:6px}
</style>
</head>
<body>
  <div class="wrap">
    <h1>dsh 配对管理</h1>
    <p class="sub">手机扫下面的二维码即完成配对；也可以手动把配对码输入手机上的配对页。此页面仅本机可访问。</p>
    <div class="code">
      <div class="h">当前配对码（自动轮换）</div>
      <div class="v" id="code">------</div>
      <div class="h" id="count">剩余 --:-- 轮换</div>
      <button id="rotate" type="button">立即换一组配对码</button>
    </div>
    <div class="qr">
      <div class="h">扫码即配对（含当前配对码，随轮换自动更新）</div>
      <div class="img" id="qrimg"></div>
      <div class="url" id="qrurl"></div>
      <div class="cap" id="qrcap">二维码只在电脑本机可见；Wi-Fi 不通手机时，可在电脑上开 cloudflared 隧道后用公网地址</div>
    </div>
    <div class="dev">
      <h2>已配对设备</h2>
      <div id="devices"></div>
    </div>
    <div class="dev" id="fuse" style="display:none">
      <h2 style="color:#f28b82">配对已熔断（失败尝试过多）</h2>
      <button onclick="fetch('/admin/unlock',{method:'POST'}).then(()=>refresh())">解锁配对</button>
    </div>
  </div>
<script>
let lastQr = null
let cache = null
function renderCount() {
  if (cache === null || !cache.issuedAt || !cache.codeMinutes) return
  const left = cache.issuedAt + cache.codeMinutes * 60000 - Date.now()
  const pad = (n) => String(n).padStart(2, '0')
  document.getElementById('count').textContent = left > 0
    ? '剩余 ' + Math.floor(left / 60000) + ':' + pad(Math.floor((left % 60000) / 1000)) + ' 轮换'
    : '即将轮换…'
}
setInterval(renderCount, 1000)
document.getElementById('rotate').addEventListener('click', async (event) => {
  event.target.disabled = true
  try { await fetch('/admin/rotate', { method: 'POST' }) } catch (e) { /* refresh below shows the truth */ }
  event.target.disabled = false
  refresh()
})
async function refresh() {
  try {
    const res = await fetch('/admin/code')
    const data = await res.json()
    cache = data
    document.getElementById('code').textContent = data.code
    document.getElementById('fuse').style.display = data.fused ? 'block' : 'none'
    renderCount()
    // Re-render the QR only when its payload changed: rewriting the SVG every
    // 5 seconds would make the code flicker while you line up the phone.
    if (data.qrSvg !== lastQr) {
      lastQr = data.qrSvg
      document.getElementById('qrimg').innerHTML = data.qrSvg || ''
      document.getElementById('qrurl').textContent = data.qrSvg ? (data.qrUrl || '') : '未取到本机局域网地址'
    }
    const box = document.getElementById('devices')
    const devs = data.devices || []
    if (devs.length === 0) { box.innerHTML = '<div class="empty">暂无已配对设备</div>'; return }
    box.innerHTML = ''
    for (const d of devs) {
      const row = document.createElement('div')
      row.className = 'row'
      const ua = document.createElement('div')
      ua.className = 'ua'
      ua.textContent = d.ua || '未知设备'
      const t = document.createElement('div')
      t.className = 't'
      let tText = '配对 ' + new Date(d.at).toLocaleString()
      if (d.ip) tText += ' · IP ' + d.ip
      if (d.lastActive) {
        tText += ' · 最近 ' + new Date(d.lastActive).toLocaleString()
        if (d.lastIp && d.lastIp !== d.ip) tText += ' (' + d.lastIp + ')'
      }
      if (d.expiresAt) {
        const days = Math.max(0, Math.round((d.expiresAt - Date.now()) / 86400000))
        tText += ' · 有效至 ' + new Date(d.expiresAt).toLocaleDateString() + '（剩 ' + days + ' 天）'
      }
      t.textContent = tText
      const btn = document.createElement('button')
      btn.textContent = '吊销'
      // Two-step: one tap on a phone must not drop the device you are holding.
      btn.addEventListener('click', async () => {
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1'
          btn.textContent = '确认吊销'
          setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = '吊销' } }, 4000)
          return
        }
        await fetch('/admin/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) })
        refresh()
      })
      row.append(ua, t, btn)
      box.appendChild(row)
    }
  } catch { /* retry next tick */ }
}
refresh()
setInterval(refresh, 5000)
</script>
</body>
</html>`

/**
 * Shown to a loopback browser that has not picked the admin grant up yet.
 * Remote callers never see it: they are answered with a bare 404, so the
 * existence of the local surface is not advertised to a tunnel visitor.
 */
const adminLockedPage = (hintPath) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>本机管理入口 · dsh</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;
       background:#0f1115;color:#e8eaed}
  .card{width:min(420px,88vw);background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;
        padding:26px 24px}
  h1{font-size:17px;font-weight:600;margin:0 0 10px}
  p{font-size:13px;color:#9aa3b2;line-height:1.7;margin:0 0 12px}
  code{background:#0f1115;border:1px solid #2a2e38;border-radius:6px;padding:2px 6px;font-size:12px}
</style>
</head>
<body>
  <div class="card">
    <h1>本机管理面需要授权</h1>
    <p>这个请求来自本机，但浏览器还没有拿到本机管理令牌。配对码、二维码与设备吊销都只对持有该令牌的浏览器开放，这样任何隧道（frp / cloudflared / ngrok）都无法把这些内容带走。</p>
    <p>在电脑上打开下面文件里的链接一次即可（dsh 启动日志里也打印了同一行）：</p>
    <p><code>${hintPath}</code></p>
    <p>链路只在本机 loopback 上生效：链接被复制到别的机器打不开任何东西。</p>
  </div>
</body>
</html>`

// ---------------------------------------------------------------------------
// WebUI panel bridge
// ---------------------------------------------------------------------------
// The browser half (lib/client.js) adds a 「配对」 tab to the conversation view
// row and reads this exact route on the dsh webserver (targetPort), not on the
// gateway port. A relative fetch therefore works from both entry points: the
// desktop page at 127.0.0.1:3080 and a phone page reverse-proxied through the
// gateway. `connection.requestRejection` applies the same Host/Origin fence and
// browser-session check every other host route uses; when that service is not
// visible in this context the fence is enforced locally instead of skipped
// (see `fenceBuiltin`).
//
// A composition without webServer makes the whole bridge a no-op: the gateway
// keeps working and simply has no panel.

const PANEL_PATH = '/kita-gateway/panel'
const PANEL_MAX_BODY = 4096

// Address ranking, the pairing URL and the entry-point rule live in
// `lib/pair-util.js` so they can be asserted against without booting the
// plugin (see `scripts/verify-gateway.mjs`).

/**
 * Register the WebUI panel route on the dsh webserver.
 * @param ctx - the gateway plugin context.
 * @param api - live gateway state readers and mutators.
 * @returns true when the route was registered here; false when webServer is
 * not visible yet in this context (the caller then retries through ctx.inject).
 */
function mountPanelBridge(ctx, api) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.log('[kita-dsh-gateway] 面板桥：webServer 在当前上下文不可见')
    return false
  }
  const connection = ctx.get('connection')
  if (connection === undefined) {
    console.log('[kita-dsh-gateway] 面板桥：connection 不可见，改用内置 Host/Origin 围栏')
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /**
   * Host/Origin fence used when `connection` is not visible in this context.
   * The official `connection.requestRejection` is preferred, but it applied
   * *after* this plugin in the 2026-09 production boot (the log reads
   * "connection 不可见"), and a panel that skips the fence entirely lets any
   * web page POST revoke / unlock / tunnel actions at 127.0.0.1 from the user's
   * own browser. So the same rule is enforced here: the Host header must name
   * this webserver, and an Origin, when present, must match it.
   */
  const fenceBuiltin = (req) => {
    const host = String(req.headers.host ?? '').toLowerCase()
    if (!api.allowedHosts.includes(host)) return 403
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      let originHost = ''
      try {
        originHost = new URL(origin).host.toLowerCase()
      } catch {
        return 403
      }
      if (!api.allowedHosts.includes(originHost)) return 403
    }
    return undefined
  }
  /** false = the fence answered the request itself. */
  const authorized = (req, res) => {
    const rejection = connection !== undefined
      ? connection.requestRejection({ headers: req.headers })
      : fenceBuiltin(req)
    if (rejection === undefined) return true
    res.writeHead(rejection)
    res.end()
    return false
  }
  const readBody = (req) => new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > PANEL_MAX_BODY) req.destroy()
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })

  const snapshot = (req) => {
    const devices = api.listDevices()
    const recent = devices.map((d) => (d.lastIp !== '' ? d.lastIp : d.ip)).filter((ip) => isUsableIp(ip))
    const candidates = localCandidates(recent)
    const entry = entryOf(req.headers, req.socket?.remoteAddress ?? '')
    const canControl = entry === ENTRY_LOCAL
    // The pairing code is the entire authentication, so only the machine
    // itself is given it — together with the QR that carries it. A paired
    // phone (LAN or tunnel) reading the code off its own screen could hand a
    // third device full access, which is exactly what the loopback-only rule
    // on /gateway-pair and /gateway-pair/qr.json already prevents.
    const code = canControl ? api.getCode() : ''
    const tunnel = api.tunnelState()
    const qrTarget = canControl && candidates.length > 0 ? candidates[0].ip : ''
    // Every candidate ships a ready-made pairing link when this is the
    // machine's own page, so the copy button hands over exactly what the QR
    // encodes: pasted into any browser, the link pairs without typing the
    // code. Remote callers get '' and fall back to the bare address.
    const candidateList = candidates.map((entry) => ({
      ...entry,
      pairUrl: canControl ? pairUrl(`http://${entry.ip}:${api.port}`, code) : '',
    }))
    return {
      ok: true,
      port: api.port,
      code,
      codeLocalOnly: !canControl,
      issuedAt: canControl ? api.getIssuedAt() : 0,
      codeMinutes: canControl ? api.codeMinutes : 0,
      fused: api.isFused(),
      failedThisHour: api.failedThisHour(),
      candidates: candidateList,
      recentIp: recent.length > 0 ? recent[0] : '',
      devices,
      selfId: api.selfId(req),
      entry,
      canControl,
      localPairUrl: qrTarget === '' ? '' : pairUrl(`http://${qrTarget}:${api.port}`, code),
      tunnel: {
        ...tunnel,
        pairUrl: !canControl || tunnel.url === '' ? '' : pairUrl(tunnel.url, code),
      },
    }
  }

  const route = webServer.register({
    kind: 'exact',
    path: PANEL_PATH,
    handler: async (req, res) => {
      if (!authorized(req, res)) return
      if (req.method === 'GET') {
        sendJson(res, 200, snapshot(req))
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let action = ''
      let id = ''
      try {
        const parsed = JSON.parse(await readBody(req))
        action = typeof parsed?.action === 'string' ? parsed.action : ''
        id = typeof parsed?.id === 'string' ? parsed.id : ''
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (action === 'rotate') {
        // Rotating the code is a local-only act for the same reason moving the
        // tunnel is: a paired phone must not invalidate the code someone is
        // reading off the desktop screen right now.
        const entry = entryOf(req.headers, req.socket?.remoteAddress ?? '')
        if (entry !== ENTRY_LOCAL) {
          sendJson(res, 403, { ok: false, error: '仅本机（电脑上打开的 dsh 页面）能更换配对码' })
          return
        }
        api.rotateCode()
        sendJson(res, 200, { ok: true })
        return
      }
      if (action === 'tunnel-start' || action === 'tunnel-stop') {
        // Only the machine itself may move the public door: a paired phone —
        // on the LAN or through the tunnel — must not be able to expose the
        // gateway to the internet, nor to close a tunnel someone else uses.
        const entry = entryOf(req.headers, req.socket?.remoteAddress ?? '')
        if (entry !== ENTRY_LOCAL) {
          sendJson(res, 403, { ok: false, error: '仅本机（电脑上打开的 dsh 页面）能开关隧道' })
          return
        }
        const state = action === 'tunnel-start' ? await api.tunnelStart() : await api.tunnelStop()
        sendJson(res, 200, { ok: state.error === '', tunnel: state, error: state.error })
        return
      }
      if (action === 'revoke') {
        if (!/^[0-9a-f]{16}$/.test(id)) {
          sendJson(res, 400, { ok: false, error: '设备句柄格式不正确，已拒绝执行' })
          return
        }
        sendJson(res, 200, { ok: api.revoke(id) })
        return
      }
      if (action === 'revoke-all') {
        // `id` doubles as "the caller's own device": it is kept, so clearing
        // the list from a phone cannot lock that phone out.
        sendJson(res, 200, { ok: true, removed: api.revokeAll(/^[0-9a-f]{16}$/.test(id) ? id : '') })
        return
      }
      if (action === 'unlock') {
        api.unlock()
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
    },
  })
  ctx.effect(() => route)
  console.log(`[kita-dsh-gateway] WebUI 配对面板已挂载 ${PANEL_PATH}`)
}

/**
 * Instance-scoped port override. Two dsh instances can legitimately share one
 * home (production on 3080 plus a shadow instance on 3280 for verification),
 * but the home-level `cordis.patch.yml` can only hold ONE gateway port — the
 * second instance to boot otherwise loses the bind and loops on EADDRINUSE
 * (outages on 2026-09-23 and 2026-09-24). The start script passes
 * `DSH_GATEWAY_PORT` / `DSH_GATEWAY_TARGET_PORT` derived from that instance's
 * own web port; the environment wins over the file config.
 */
function envPort(name) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : undefined
}

export function apply(ctx, config) {
  const port = envPort('DSH_GATEWAY_PORT') ?? config?.port ?? 3081
  const targetPort = envPort('DSH_GATEWAY_TARGET_PORT') ?? config?.targetPort ?? 3080
  const codeMinutes = config?.codeMinutes ?? 10
  const tunnelStartTimeoutMs = config?.tunnelStartTimeoutMs ?? 25000
  /**
   * The one-click Quick Tunnel. `resolveCloudflared` searches the configured
   * path, then `CLOUDFLARED_PATH`, then `PATH`, so a machine that keeps the
   * binary somewhere unusual only has to say so in the plugin config.
   */
  const cloudflared = resolveCloudflared(config?.cloudflaredPath ?? '')
  const tunnel = createTunnel({
    port,
    binary: cloudflared,
    restartLimit: config?.tunnelRestartLimit ?? 5,
    protocol: config?.tunnelProtocol ?? 'http2',
  })
  if (cloudflared === '') {
    console.log('[kita-dsh-gateway] 未找到 cloudflared，一键 Cloudflare 隧道不可用'
      + '（配置 cloudflaredPath 或设置 CLOUDFLARED_PATH）')
  } else {
    console.log(`[kita-dsh-gateway] 一键 Cloudflare 隧道就绪：${cloudflared}`)
  }

  /**
   * The local-admin secret. Minted on first boot into <DSH_HOME>/storages/
   * and reused after that, so a browser only has to be handed the entry link
   * once. Never logged by value in the pairing path, never sent to a phone.
   */
  const adminFile = adminStoragePath()
  const admin = loadAdminSecret(adminFile, config?.adminToken ?? '')
  const adminSecret = admin.secret
  const adminHintFile = adminEntryHintPath(adminFile)

  const store = loadStore(storagePath())
  const tokens = store.tokens
  let currentCode = store.currentCode ?? newCode()
  /** When the current code was minted — the WebUI panel renders a countdown from it. */
  let codeIssuedAt = Date.now()
  /**
   * The code retired by the last rotation, still honoured for a short grace
   * period so a phone that scanned the QR a moment too early is not punished.
   * The QR itself always carries the live code.
   */
  let previousCode = ''
  let previousUntil = 0
  const CODE_GRACE_MS = 60 * 1000
  saveState(tokens, currentCode)
  if (store.migrated) {
    console.log('[kita-dsh-gateway] 凭据存储已迁移为哈希格式（旧明文令牌已即时哈希，设备无需重新配对）')
  }
  const attempts = new Map() // ip -> { failures: number[], strikes: number, lockedUntil: number }
  const globalFailures = [] // failed-pair timestamps across all ips (pruned to the fuse window)
  let pairingFused = false // global kill switch after GLOBAL_FAIL_LIMIT failures in the window

  /**
   * The effective client address. Direct LAN/loopback callers are the socket
   * peer; requests arriving through a Cloudflare Tunnel carry the real client
   * ip in `CF-Connecting-IP` (set by the CF edge, forwarded by cloudflared),
   * because the socket peer is always the local cloudflared process. The
   * header is only trusted when the socket peer IS loopback — a LAN attacker
   * forging the header must not get fresh rate-limit buckets.
   */
  const clientIp = (req) => {
    const addr = req.socket.remoteAddress ?? ''
    const forwarded = req.headers['cf-connecting-ip']
    if (isLoopbackPeer(req) && typeof forwarded === 'string' && forwarded !== '') return forwarded
    return addr === '' ? 'unknown' : addr
  }

  /**
   * True only for a genuine local operator. A tunneled request ALWAYS counts
   * as remote even though cloudflared dials from 127.0.0.1 — otherwise the
   * /admin surface (pairing code + device list + revoke) and the one-click
   * tunnel switch would be reachable from the internet.
   */
  const isLoopback = (req) => {
    if (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'] !== '') return false
    return isLoopbackPeer(req)
  }

  /**
   * True when the caller proved it holds this machine's admin secret.
   *
   * Loopback alone is NOT proof, and that is exactly the bug this closes: every
   * tunnel agent (frpc, cloudflared, ngrok) dials the gateway from 127.0.0.1 on
   * behalf of the internet, so a public request and a browser request are
   * indistinguishable at the socket. The secret lives in a file only this
   * machine can read, so a tunnel can neither present it nor read it.
   *
   * Both conditions matter: the grant keeps an unknown tunnel out, and loopback
   * keeps a leaked ?a= link from working anywhere else.
   */
  const isLocalAdmin = (req) => {
    if (!isLoopback(req)) return false
    const value = parseCookies(req.headers.cookie)[ADMIN_COOKIE]
    return adminSecretMatches(typeof value === 'string' ? value : '', adminSecret)
  }

  /** Addresses of recently active paired devices, best guess for "phone's /24". */
  const recentDeviceIps = () => [...tokens.values()]
    .map((meta) => (typeof meta?.lastIp === 'string' && meta.lastIp !== '' ? meta.lastIp : (meta?.ip ?? '')))
    .filter((ip) => isUsableIp(ip))

  /**
   * The payload behind every scannable QR shown on this machine: the LAN URL a
   * phone should open with the current code in its fragment, rendered as SVG.
   * Never served to a remote caller — the code inside is the credential.
   */
  const pairingQr = () => {
    const candidates = localCandidates(recentDeviceIps())
    const url = candidates.length > 0 ? pairUrl(`http://${candidates[0]}:${port}`, currentCode) : ''
    return {
      code: currentCode,
      url,
      svg: url === '' ? '' : qrSvg(url),
      candidates,
      issuedAt: codeIssuedAt,
      codeMinutes,
      port,
    }
  }

  const printCode = () => {
    console.log(`[kita-dsh-gateway] 配对码 ${currentCode}（${codeMinutes} 分钟内有效）`)
  }

  /**
   * Mint a new pairing code right now. The retired code stays acceptable for
   * `CODE_GRACE_MS`, because a phone can scan the QR a second before a rotation
   * and would otherwise be told its (correct) code is wrong.
   */
  const rotateCode = () => {
    previousCode = currentCode
    previousUntil = Date.now() + CODE_GRACE_MS
    currentCode = newCode()
    codeIssuedAt = Date.now()
    saveState(tokens, currentCode)
    printCode()
  }

  /** True when the input matches the live code, or the one just retired. */
  const codeAccepted = (input) => {
    if (timingSafeEqual(input, currentCode)) return true
    return previousCode !== '' && Date.now() < previousUntil && timingSafeEqual(input, previousCode)
  }

  /**
   * Resolve the handle the browser was given back to its store key.
   * The browser never sees a token — only `deviceId()`'s 16 hex characters —
   * so every revoke has to come back through this lookup.
   */
  const keyById = (id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null
    for (const key of tokens.keys()) {
      if (key.slice(0, 16) === id) return key
    }
    return null
  }

  /** Revoke one device by its handle. @returns true when something was removed. */
  const revokeById = (id) => {
    const key = keyById(id)
    if (key === null) return false
    const removed = tokens.delete(key)
    if (removed) saveState(tokens, currentCode)
    return removed
  }

  /**
   * Revoke every device except `exceptId`. @returns how many were removed.
   * The caller passes the device making the request so a phone cannot lock
   * itself out by accident when it clears the list.
   */
  const revokeAll = (exceptId = '') => {
    const keep = exceptId === '' ? null : keyById(exceptId)
    let removed = 0
    for (const key of [...tokens.keys()]) {
      if (keep !== null && key === keep) continue
      tokens.delete(key)
      removed += 1
    }
    if (removed > 0) saveState(tokens, currentCode)
    return removed
  }

  /** Debounced persistence of activity touches (2s batches request bursts). */
  let persistTimer = null
  const persistSoon = () => {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      saveState(tokens, currentCode)
    }, 2000)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }
  /** Record one authenticated activity tick per token: last seen time + ip. */
  const touchToken = (token, req) => {
    const meta = tokens.get(hashToken(token))
    if (meta === undefined) return
    meta.lastActive = Date.now()
    meta.lastIp = clientIp(req)
    persistSoon()
  }

  const handlePair = (req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      // Rate limit per real client IP (CF-Connecting-IP when tunneled), with
      // escalating lockout bursts and a global fuse.
      const ip = clientIp(req)
      const now = Date.now()
      if (pairingFused) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '配对已暂时禁用（异常尝试过多），请在本机管理页解锁或重启 dsh' }))
        return
      }
      const state = attempts.get(ip)
      if (state !== undefined && state.lockedUntil > now) {
        const message = state.lockedUntil === Infinity
          ? '该地址配对已锁定，请本机管理页解锁'
          : `尝试次数过多，请 ${Math.ceil((state.lockedUntil - now) / 60000)} 分钟后再试`
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
        return
      }
      const recent = (state?.failures ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
      if (recent.length >= MAX_PAIR_ATTEMPTS) {
        const strikes = (state?.strikes ?? 0) + 1
        const tier = LOCKOUT_TIERS.find((entry) => entry.strikes === strikes) ?? LOCKOUT_TIERS[LOCKOUT_TIERS.length - 1]
        const lockedUntil = tier.ms === null ? Infinity : now + tier.ms
        attempts.set(ip, { failures: [], strikes, lockedUntil })
        console.log(`[kita-dsh-gateway] 配对锁定 ip=${ip} strikes=${strikes}${lockedUntil === Infinity ? ' 永久' : ''}`)
        res.writeHead(429, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: lockedUntil === Infinity ? '该地址配对已锁定' : `尝试次数过多，请 ${Math.ceil(tier.ms / 60000)} 分钟后再试` }))
        return
      }
      let code = null
      try { code = JSON.parse(body).code } catch { /* handled below */ }
      if (typeof code !== 'string' || !codeAccepted(code)) {
        const failures = [...recent, now]
        globalFailures.push(now)
        const windowStart = now - GLOBAL_FAIL_WINDOW_MS
        while (globalFailures.length > 0 && globalFailures[0] < windowStart) globalFailures.shift()
        if (globalFailures.length >= GLOBAL_FAIL_LIMIT) {
          pairingFused = true
          console.log('[kita-dsh-gateway] 全局熔断：一小时内配对失败过多，配对已禁用')
        }
        attempts.set(ip, { failures, strikes: state?.strikes ?? 0, lockedUntil: state?.lockedUntil ?? 0 })
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: '配对码不正确',
          remaining: Math.max(0, MAX_PAIR_ATTEMPTS - failures.length),
        }))
        return
      }
      const token = crypto.randomBytes(32).toString('hex')
      const meta = { ua: String(req.headers['user-agent'] ?? '').slice(0, 200), at: Date.now(), ip, lastActive: Date.now() }
      // Only the hash is stored: a copy of the state file is not a credential.
      tokens.set(hashToken(token), meta)
      saveState(tokens, currentCode)
      attempts.delete(ip)
      console.log(`[kita-dsh-gateway] 已配对设备：${meta.ua || '未知'}（ip=${ip}）`)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
      })
      res.end(JSON.stringify({ ok: true }))
    })
  }

  const server = http.createServer((req, res) => {
    let url = null
    let pathname = '/'
    try {
      url = new URL(req.url, 'http://x')
      pathname = url.pathname
    } catch { /* keep '/' */ }
    // One-time handover of the local-admin grant. The URL printed at boot (and
    // kept in <storages>/kita-dsh-gateway-admin-url.txt) carries the secret as
    // ?a=...; opening it here trades the secret for a cookie and drops it from
    // the address bar, so the long-lived form is never the one in a screenshot.
    // Loopback is required as well: a leaked link must not work remotely.
    if (req.method === 'GET' && url !== null) {
      const presented = url.searchParams.get(ADMIN_QUERY) ?? ''
      if (isLoopback(req) && adminSecretMatches(presented, adminSecret)) {
        url.searchParams.delete(ADMIN_QUERY)
        res.writeHead(302, {
          'Set-Cookie': adminGrantCookie(adminSecret),
          'Cache-Control': 'no-store',
          Location: url.pathname + url.search,
        })
        res.end()
        return
      }
    }
    if (req.method === 'POST' && pathname === '/pair') { handlePair(req, res); return }
    if (req.method === 'GET' && pathname === '/gateway-pair') {
      // The QR block (and the code it carries) appears only for a page opened
      // on this machine by a browser that holds the admin grant. A phone, a LAN
      // neighbour and a tunnel visitor get the plain form; a local browser that
      // has not picked the grant up yet is told where the entry link lives.
      const local = isLocalAdmin(req)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(pairPage(local, isAuthed(req, tokens) !== null, isLoopback(req) && !local))
      return
    }
    if (req.method === 'GET' && pathname === '/gateway-pair/qr.json') {
      if (!isLocalAdmin(req)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(pairingQr()))
      return
    }
    // Admin surface: this machine, with the grant. A tunnel of any kind dials
    // in from loopback, so the grant — not the socket — is what decides here.
    if (pathname.startsWith('/admin')) {
      if (!isLocalAdmin(req)) {
        if (!isLoopback(req)) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(adminLockedPage(adminHintFile))
        return
      }
      if (req.method === 'GET' && pathname === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ADMIN_PAGE)
        return
      }
      if (req.method === 'GET' && pathname === '/admin/code') {
        const devices = [...tokens.entries()].map(([hash, meta]) => ({
          id: hash.slice(0, 16),
          ua: meta?.ua ?? '',
          at: meta?.at ?? 0,
          ip: meta?.ip ?? '',
          lastIp: meta?.lastIp ?? '',
          lastActive: meta?.lastActive ?? 0,
          expiresAt: expiresAt(meta),
        }))
        const qr = pairingQr()
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          code: currentCode,
          issuedAt: codeIssuedAt,
          codeMinutes,
          devices,
          fused: pairingFused,
          failedThisHour: globalFailures.length,
          qrUrl: qr.url,
          qrSvg: qr.svg,
          candidates: qr.candidates,
        }))
        return
      }
      if (req.method === 'POST' && pathname === '/admin/unlock') {
        pairingFused = false
        globalFailures.length = 0
        attempts.clear()
        console.log('[kita-dsh-gateway] 本机管理页解锁：熔断与锁定已清除')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.method === 'POST' && pathname === '/admin/rotate') {
        rotateCode()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, code: currentCode }))
        return
      }
      if (req.method === 'POST' && pathname === '/admin/revoke') {
        let body = ''
        req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          let id = null
          try { id = JSON.parse(body).id } catch { /* handled below */ }
          const ok = revokeById(id)
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok }))
        })
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    const token = isAuthed(req, tokens)
    if (token === null) {
      if (acceptsHtml(req)) {
        res.writeHead(302, { Location: '/gateway-pair' })
        res.end()
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized: pair at /gateway-pair' }))
      }
      return
    }
    touchToken(token, req)
    proxyHttp(req, res, targetPort, pathname.startsWith('/kita-gateway/') ? token : '')
  })

  server.on('upgrade', (req, socket, head) => {
    const token = isAuthed(req, tokens)
    if (token === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    touchToken(token, req)
    proxyWs(req, socket, head, targetPort)
  })

  const codeTimer = setInterval(rotateCode, codeMinutes * 60 * 1000)
  codeTimer.unref()

  /**
   * Expired credentials are already refused on every request (`isAuthed`); this
   * only stops them from accumulating in the file of a long-running process.
   */
  const pruneTimer = setInterval(() => {
    const removed = pruneExpired(tokens)
    if (removed > 0) {
      saveState(tokens, currentCode)
      console.log(`[kita-dsh-gateway] 已清理 ${removed} 个过期设备凭据`)
    }
  }, 3600 * 1000)
  pruneTimer.unref()

  /**
   * Bind the entry port, retrying briefly when the old instance has not let go
   * yet. A plugin reload (dsh-hot-reload) disposes the previous fiber and
   * applies this one in the same tick, and `server.close()` releases the port
   * asynchronously — without the retry the gateway would come back dead with
   * "listen EADDRINUSE" while the web UI kept running, which is exactly the
   * failure the 2026-09 blue/green switch hit on this port.
   */
  const listenDeadlineMs = Date.now() + 15000
  const listenWithRetry = () => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[kita-dsh-gateway] 网关已启动 http://0.0.0.0:${port} → 127.0.0.1:${targetPort}`)
      printCode()
      // The operator has to be handed the grant once, and a log line plus a file
      // is the only channel a tunnel cannot read. Both carry the same URL.
      const adminEntry = adminEntryUrl(port, adminSecret)
      writeAdminEntryHint(adminHintFile, adminEntry)
      console.log(`[kita-dsh-gateway] 本机管理入口（本机打开一次即可授权）${adminEntry}`)
      // A previously started tunnel pointed at this port; if it is somehow
      // still running (a reload that missed the teardown), keep it as is.
      if (tunnel.state().phase === 'running') {
        console.log(`[kita-dsh-gateway] Cloudflare 隧道仍在运行 ${tunnel.state().url}`)
      }
    })
    server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE' && Date.now() < listenDeadlineMs) {
        console.log(`[kita-dsh-gateway] ${port} 仍被占用，500ms 后重试监听`)
        setTimeout(listenWithRetry, 500).unref?.()
        return
      }
      console.error('[kita-dsh-gateway] listen failed:', error.message)
    })
  }
  listenWithRetry()

  const panelApi = {
    port,
    codeMinutes,
    /** Host header values this webserver may legitimately be reached by. */
    allowedHosts: [`127.0.0.1:${targetPort}`, `localhost:${targetPort}`, `[::1]:${targetPort}`],
    getCode: () => currentCode,
    getIssuedAt: () => codeIssuedAt,
    isFused: () => pairingFused,
    failedThisHour: () => globalFailures.length,
    tunnelState: () => tunnel.state(),
    tunnelStart: () => tunnel.start(tunnelStartTimeoutMs),
    tunnelStop: () => tunnel.stop(),
    rotateCode: () => rotateCode(),
    /**
     * The handle of the device making this request, stamped by the gateway on
     * the proxied panel hop. Empty for a direct loopback visit (the desktop
     * page), which is not a paired device to begin with.
     */
    selfId: (req) => {
      const value = req.headers[DEVICE_HEADER]
      return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) ? value : ''
    },
    listDevices: () => [...tokens.entries()]
      .map(([hash, meta]) => ({
        id: hash.slice(0, 16),
        ua: meta?.ua ?? '',
        at: meta?.at ?? 0,
        ip: meta?.ip ?? '',
        lastIp: meta?.lastIp ?? '',
        lastActive: meta?.lastActive ?? 0,
        expiresAt: expiresAt(meta),
      }))
      .sort((a, b) => b.lastActive - a.lastActive),
    revoke: (id) => revokeById(id),
    revokeAll: (exceptId) => revokeAll(exceptId),
    unlock: () => {
      pairingFused = false
      globalFailures.length = 0
      attempts.clear()
      console.log('[kita-dsh-gateway] WebUI 面板解锁：熔断与锁定已清除')
    },
  }
  // The webserver bundle may apply after this plugin: retry through a scoped
  // inject instead of silently shipping a gateway with no panel.
  if (mountPanelBridge(ctx, panelApi) === false) {
    console.log('[kita-dsh-gateway] 面板桥：等待 webServer 服务就绪后重试')
    ctx.inject(['webServer'], (scope) => {
      mountPanelBridge(scope, panelApi)
    })
  }

  return () => {
    clearInterval(codeTimer)
    clearInterval(pruneTimer)
    if (persistTimer !== null) clearTimeout(persistTimer)
    saveState(tokens, currentCode)
    // Never leave a public hostname pointing at a port this process just gave
    // up: the tunnel dies with the plugin (a reload re-applies it cleanly).
    void tunnel.dispose()
    server.close()
    for (const socket of server._sockets ?? []) socket.destroy()
    console.log('[kita-dsh-gateway] 网关已停止')
  }
}
