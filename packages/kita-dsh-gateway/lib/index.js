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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'

export const name = 'kita-dsh-gateway'

export const Config = z.object({
  port: z.natural().max(65535).default(3081),
  targetPort: z.natural().max(65535).default(3080),
  codeMinutes: z.natural().min(1).default(10),
})

const COOKIE_NAME = 'kita_gw'
const TARGET_HOST = '127.0.0.1'
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000 // 90 days
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

function loadTokens() {
  try {
    if (!existsSync(storagePath())) return new Map()
    const data = JSON.parse(readFileSync(storagePath(), 'utf8'))
    const map = new Map()
    const now = Date.now()
    for (const [token, meta] of Object.entries(data.tokens ?? {})) {
      if (meta?.at && now - meta.at < TOKEN_TTL_MS) map.set(token, meta)
    }
    return map
  } catch {
    return new Map()
  }
}

function loadCurrentCode() {
  try {
    if (!existsSync(storagePath())) return undefined
    const data = JSON.parse(readFileSync(storagePath(), 'utf8'))
    return typeof data.currentCode === 'string' ? data.currentCode : undefined
  } catch {
    return undefined
  }
}

function saveState(tokens, currentCode) {
  try {
    const file = storagePath()
    mkdirSync(dirname(file), { recursive: true })
    const data = { currentCode, tokens: Object.fromEntries(tokens) }
    writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (error) {
    console.error('[kita-dsh-gateway] state persist failed:', error)
  }
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

function isAuthed(req, tokens) {
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[COOKIE_NAME] && tokens.has(cookies[COOKIE_NAME])) return cookies[COOKIE_NAME]
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    return tokens.has(token) ? token : null
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

function proxyHttp(req, res, targetPort) {
  // Rewrite Host to loopback and strip Origin/Referer/Sec-Fetch-Site: the
  // browser on a LAN origin sends its own Origin, and dsh's loopback fence
  // rejects any request whose Origin host differs from the Host header.
  const headers = { ...req.headers, host: `${TARGET_HOST}:${targetPort}` }
  delete headers.origin
  delete headers.referer
  delete headers['sec-fetch-site']
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

const PAIR_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配对 · dsh</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;
       background:#0f1115;color:#e8eaed}
  .card{background:#1a1d24;border:1px solid #2a2e38;border-radius:16px;padding:28px 24px;
        width:min(320px,84vw);text-align:center}
  h1{font-size:17px;font-weight:600;margin:0 0 8px}
  p{font-size:13px;color:#9aa3b2;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a4150;
        background:#0f1115;color:#e8eaed;font-size:20px;text-align:center;letter-spacing:8px;
        outline:none}
  input:focus{border-color:#4f6ef7}
  button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f6ef7;
         color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5}
  .err{color:#f28b82;font-size:13px;margin-top:12px;min-height:18px}
</style>
</head>
<body>
  <div class="card">
    <h1>配对 dsh</h1>
    <p>输入电脑终端里显示的 6 位配对码</p>
    <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
    <button id="go">配对</button>
    <div class="err" id="err"></div>
  </div>
<script>
const go = document.getElementById('go')
const code = document.getElementById('code')
const err = document.getElementById('err')
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
    err.textContent = body.error || ('配对失败（HTTP ' + res.status + '）')
  } catch { err.textContent = '网络错误，请重试' }
  go.disabled = false
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
</style>
</head>
<body>
  <div class="wrap">
    <h1>dsh 配对管理</h1>
    <p class="sub">把配对码输入手机上的配对页即可。此页面仅本机可访问。</p>
    <div class="code">
      <div class="h">当前配对码（自动轮换）</div>
      <div class="v" id="code">------</div>
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
async function refresh() {
  try {
    const res = await fetch('/admin/code')
    const data = await res.json()
    document.getElementById('code').textContent = data.code
    document.getElementById('fuse').style.display = data.fused ? 'block' : 'none'
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
      t.textContent = tText
      const btn = document.createElement('button')
      btn.textContent = '吊销'
      btn.addEventListener('click', async () => {
        await fetch('/admin/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.token }) })
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

export function apply(ctx, config) {
  const port = config?.port ?? 3081
  const targetPort = config?.targetPort ?? 3080
  const codeMinutes = config?.codeMinutes ?? 10

  const tokens = loadTokens()
  let currentCode = newCode()
  saveState(tokens, currentCode)
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
    const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    const forwarded = req.headers['cf-connecting-ip']
    if (local && typeof forwarded === 'string' && forwarded !== '') return forwarded
    return addr === '' ? 'unknown' : addr
  }

  /**
   * True only for a genuine local operator. A tunneled request ALWAYS counts
   * as remote even though cloudflared dials from 127.0.0.1 — otherwise the
   * /admin surface (pairing code + device list + revoke) would be public
   * through the tunnel.
   */
  const isLoopback = (req) => {
    if (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'] !== '') return false
    const addr = req.socket.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  const printCode = () => {
    console.log(`[kita-dsh-gateway] 配对码 ${currentCode}（${codeMinutes} 分钟内有效）`)
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
    const meta = tokens.get(token)
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
      if (typeof code !== 'string' || !timingSafeEqual(code, currentCode)) {
        globalFailures.push(now)
        const windowStart = now - GLOBAL_FAIL_WINDOW_MS
        while (globalFailures.length > 0 && globalFailures[0] < windowStart) globalFailures.shift()
        if (globalFailures.length >= GLOBAL_FAIL_LIMIT) {
          pairingFused = true
          console.log('[kita-dsh-gateway] 全局熔断：一小时内配对失败过多，配对已禁用')
        }
        attempts.set(ip, { failures: [...recent, now], strikes: state?.strikes ?? 0, lockedUntil: state?.lockedUntil ?? 0 })
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '配对码不正确' }))
        return
      }
      const token = crypto.randomBytes(32).toString('hex')
      const meta = { ua: String(req.headers['user-agent'] ?? '').slice(0, 200), at: Date.now(), ip, lastActive: Date.now() }
      tokens.set(token, meta)
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
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://x').pathname } catch { /* keep '/' */ }
    if (req.method === 'POST' && pathname === '/pair') { handlePair(req, res); return }
    if (req.method === 'GET' && pathname === '/gateway-pair') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAIR_PAGE)
      return
    }
    // Admin surface: loopback only (a remote client must already be paired).
    if (pathname.startsWith('/admin')) {
      if (!isLoopback(req)) {
        res.writeHead(404)
        res.end()
        return
      }
      if (req.method === 'GET' && pathname === '/admin') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ADMIN_PAGE)
        return
      }
      if (req.method === 'GET' && pathname === '/admin/code') {
        const devices = [...tokens.entries()].map(([token, meta]) => ({
          token,
          ua: meta?.ua ?? '',
          at: meta?.at ?? 0,
          ip: meta?.ip ?? '',
          lastIp: meta?.lastIp ?? '',
          lastActive: meta?.lastActive ?? 0,
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: currentCode, devices, fused: pairingFused, failedThisHour: globalFailures.length }))
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
      if (req.method === 'POST' && pathname === '/admin/revoke') {
        let body = ''
        req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          let token = null
          try { token = JSON.parse(body).token } catch { /* handled below */ }
          const ok = typeof token === 'string' && tokens.delete(token)
          if (ok) saveState(tokens, currentCode)
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
    proxyHttp(req, res, targetPort)
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

  const codeTimer = setInterval(() => {
    currentCode = newCode()
    saveState(tokens, currentCode)
    printCode()
  }, codeMinutes * 60 * 1000)
  codeTimer.unref()

  server.listen(port, '0.0.0.0', () => {
    console.log(`[kita-dsh-gateway] 网关已启动 http://0.0.0.0:${port} → 127.0.0.1:${targetPort}`)
    printCode()
  })
  server.on('error', (error) => {
    console.error('[kita-dsh-gateway] listen failed:', error.message)
  })

  return () => {
    clearInterval(codeTimer)
    if (persistTimer !== null) clearTimeout(persistTimer)
    saveState(tokens, currentCode)
    server.close()
    for (const socket of server._sockets ?? []) socket.destroy()
    console.log('[kita-dsh-gateway] 网关已停止')
  }
}
