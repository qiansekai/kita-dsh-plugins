/**
 * The local-admin grant: the credential that decides who may see the pairing
 * code, the QR that carries it, and the /admin surface.
 *
 * Why this exists (2026-09-28 incident): the gateway treated "the socket peer
 * is loopback" as "the operator is sitting at this machine". That is only true
 * for a browser. Every tunnel agent — cloudflared, frp/sakurafrp, ngrok —
 * dials the gateway from 127.0.0.1 on behalf of the internet, so a public
 * request looked exactly like a local one: /gateway-pair rendered the QR and
 * /gateway-pair/qr.json handed out the 6-digit code, which is the entire
 * authentication. Two things were missing:
 *
 *   1. cloudflared was special-cased through `cf-connecting-ip`; frp has no
 *      equivalent header, so nothing marked its traffic as remote.
 *   2. There was no secret proving the caller really sits on this machine.
 *
 * The first cannot be fixed by looking at the socket alone: an unknown tunnel
 * is indistinguishable from a browser at that layer. The second can. The
 * gateway mints a local-admin secret at first boot and keeps it in
 * `<DSH_HOME>/storages/kita-dsh-gateway-admin.json` — a file only this
 * machine can read, which no tunnel can forge — and every local-only surface
 * now requires it as a cookie. Loopback is still checked, but it is the second
 * condition, never the first.
 *
 * Nothing here touches the network, so the pure helpers below are asserted
 * directly by `scripts/verify-gateway.mjs`.
 */
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cookie that carries the grant once the browser has been handed it. */
export const ADMIN_COOKIE = 'kita_gw_admin'

/**
 * Query parameter used for the one-time handover. It is deliberately short and
 * unrelated to the pairing code (`k=`), because the two travel to different
 * audiences: `k=` goes to a phone, `a=` must never leave this machine.
 */
export const ADMIN_QUERY = 'a'

/** On-disk schema this build writes. */
export const ADMIN_STORE_VERSION = 1

/** How long a browser keeps its grant without re-reading the hint file. */
export const ADMIN_GRANT_TTL_S = 90 * 24 * 3600

/** A fresh 32-byte secret, hex encoded. */
export function newAdminSecret() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Constant-time comparison of a presented grant against the secret.
 * Both sides are hashed first so the comparison never depends on length, and
 * an empty/absent value can never match a real secret.
 */
export function adminSecretMatches(presented, secret) {
  const a = typeof presented === 'string' ? presented : ''
  const b = typeof secret === 'string' ? secret : ''
  if (a === '' || b === '') return false
  const left = crypto.createHash('sha256').update(a).digest()
  const right = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(left, right)
}

/**
 * The URL the operator opens once on this machine.
 *
 * It targets the pairing page rather than /admin: scanning the QR for a phone
 * is the everyday need, and the same cookie unlocks /admin afterwards.
 */
export function adminEntryUrl(port, secret, host = '127.0.0.1') {
  return `http://${host}:${port}/gateway-pair?${ADMIN_QUERY}=${secret}`
}

/** Sibling text file holding the entry URL, so it survives a log rotation. */
export function adminEntryHintPath(storeFile) {
  return String(storeFile).replace(/\.json$/, '-url.txt')
}

/**
 * Read the secret, minting and persisting one on first boot.
 *
 * A configured value always wins, so a deployment can pin it (and thereby keep
 * the entry URL stable across machines). A file that is missing, unreadable or
 * malformed yields a fresh secret: refusing to boot would take the gateway —
 * and therefore every paired phone — down with it.
 *
 * @returns `{ secret, created, source }`.
 */
export function loadAdminSecret(storeFile, configured = '') {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') return { secret: explicit, created: false, source: 'config' }
  if (existsSync(storeFile)) {
    try {
      const data = JSON.parse(readFileSync(storeFile, 'utf8'))
      const stored = typeof data?.secret === 'string' ? data.secret.trim() : ''
      if (stored !== '') return { secret: stored, created: false, source: 'file' }
    } catch {
      console.error('[kita-dsh-gateway] 本机管理令牌读取失败，将重新生成:', storeFile)
    }
  }
  const secret = newAdminSecret()
  try {
    mkdirSync(dirname(storeFile), { recursive: true })
    const tmp = `${storeFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: ADMIN_STORE_VERSION, secret, createdAt: Date.now() }, null, 2))
    renameSync(tmp, storeFile)
  } catch (error) {
    console.error('[kita-dsh-gateway] 本机管理令牌写入失败（令牌仅本次进程有效）:', error?.message ?? error)
  }
  return { secret, created: true, source: 'generated' }
}

/** Best-effort write of the entry hint; a failure only costs convenience. */
export function writeAdminEntryHint(hintFile, url) {
  try {
    mkdirSync(dirname(hintFile), { recursive: true })
    writeFileSync(hintFile, `${url}\n`, 'utf8')
    return true
  } catch (error) {
    console.error('[kita-dsh-gateway] 本机管理入口提示写入失败:', error?.message ?? error)
    return false
  }
}

/** The Set-Cookie value that hands the grant to a local browser. */
export function adminGrantCookie(secret) {
  return `${ADMIN_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_GRANT_TTL_S}`
}
