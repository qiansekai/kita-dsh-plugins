/**
 * kita-dsh-shell-bridge — host half.
 *
 * dsh-mobile-shell wraps the dsh web UI in a WebView and exposes one JS object,
 * \`window.DshShell\`, to the page. This plugin is the other side of that wire:
 * it publishes "which session is running" so the client half can turn a
 * working -> idle transition into a system notification on the phone.
 *
 * Why a route instead of a session projection: projections are per-session, so
 * a page that has one conversation open can only ever see that conversation.
 * The requirement is "notify me about every session", which needs a global
 * view — and the deployment's own webServer is the smallest channel that both
 * the desktop page (loopback) and the phone (through kita-dsh-gateway's
 * pairing auth) already reach with the browser-session cookie.
 *
 * Route:
 *   GET /kita-shell/state -> { sessions: [{ sessionId, title, running, state, updatedAt }], diagnostics }
 *
 * The route is read-only and returns no credentials: the worst a cross-site
 * caller could learn is which sessions exist, which its same-origin fence
 * already refuses (see checkOrigin below).
 */
import z from '@deepseek-ai/schemastery'

export const name = 'kita-dsh-shell-bridge'

/** Sessions + agents give the running flag; webServer carries the route. */
export const inject = ['webServer', 'sessions', 'agents']

export const Config = z.object({
  /** Longest session title forwarded to the phone (bytes, UTF-8 safe). */
  titleMaxBytes: z.natural().min(16).max(512).default(120),
  /** Include sessions with no agent at all (archived / idle ones). */
  includeIdle: z.boolean().default(false),
})

/** UTF-8-safe truncation. */
function truncate(text, limit) {
  let value = String(text)
  while (Buffer.byteLength(value, 'utf8') > limit) value = value.slice(0, -1)
  return value
}

/** Normalize whatever the sessions service returns into a plain array. */
function asArray(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.items)) return value.items
  return []
}

/** Read one session's title without depending on a single field name. */
function titleOf(session) {
  for (const key of ['title', 'name', 'label']) {
    const value = session?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** Build the payload. Never throws: a broken service degrades to a diagnosis. */
export function snapshot(ctx, config) {
  const diagnostics = { sessionsError: null, agentsError: null, count: 0 }
  let sessions = []
  try {
    sessions = asArray(ctx.sessions.list())
  } catch (error) {
    diagnostics.sessionsError = String(error && error.message ? error.message : error)
  }
  const rows = []
  for (const session of sessions) {
    if (session === null || typeof session !== 'object') continue
    const sessionId = typeof session.id === 'string' ? session.id : String(session.id ?? '')
    if (sessionId === '') continue
    let running = false
    try {
      const agent = ctx.agents.get(sessionId)
      running = agent !== undefined && agent !== null && agent.status === 'running'
    } catch (error) {
      diagnostics.agentsError = String(error && error.message ? error.message : error)
    }
    if (!config.includeIdle && !running && sessionId === '') continue
    rows.push({
      sessionId,
      title: truncate(titleOf(session), config.titleMaxBytes),
      running,
      state: running ? 'working' : 'idle',
      updatedAt: Date.now(),
    })
  }
  diagnostics.count = rows.length
  return { sessions: rows, diagnostics }
}

/**
 * Same-origin fence, mirroring kita-dsh-restart: a cross-site page must not be
 * able to enumerate this deployment's sessions.
 */
function checkOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || origin === '' || typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const settings = {
    titleMaxBytes: config?.titleMaxBytes ?? 120,
    includeIdle: config?.includeIdle ?? false,
  }
  // Observability: how many polls arrived and from which client. Without it
  // "the phone notified nobody" is indistinguishable from "the phone never
  // polled", which is the first question any bridge bug raises.
  let polls = 0
  let lastUa = ''
  let lastAt = 0
  settings.stats = () => ({ polls, lastUa, lastAt })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/kita-shell/state',
    handler: (req, res) => {
      polls += 1
      lastUa = String(req.headers['user-agent'] ?? '').slice(0, 140)
      lastAt = Date.now()
      if (!checkOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'cross-site request refused' }))
        return
      }
      let body = null
      try {
        body = snapshot(ctx, settings)
      } catch (error) {
        body = { sessions: [], diagnostics: { fatal: String(error && error.message ? error.message : error) } }
      }
      body.diagnostics.polls = polls
      body.diagnostics.lastUa = lastUa
      body.diagnostics.lastAt = lastAt
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    },
  }), 'kita-dsh-shell-bridge: state route')
}
