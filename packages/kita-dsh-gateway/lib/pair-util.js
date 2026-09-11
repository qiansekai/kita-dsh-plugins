/**
 * Pure helpers shared by the gateway server, the pairing pages and the tests.
 *
 * Nothing here touches the filesystem, the network or plugin state, so the
 * whole module can be imported and asserted against directly
 * (`scripts/verify-gateway.mjs`).
 */
import os from 'node:os'

/**
 * Header the gateway stamps on every request it reverse-proxies to the dsh
 * webserver. The webserver itself only ever sees the gateway process as its
 * peer, so without this mark a request that came from the LAN (or from a
 * Cloudflare tunnel) is indistinguishable from a local desktop request — and
 * the panel's mutating actions must not be reachable from either.
 *
 * The gateway strips any client-supplied copy before stamping its own, so the
 * value cannot be forged through the proxy. A direct request to the loopback
 * webserver cannot carry it at all (the LAN cannot dial 127.0.0.1).
 */
export const ENTRY_HEADER = 'x-kita-gw-entry'

/** Entry points a request can arrive through, most trusted first. */
export const ENTRY_LOCAL = 'local'
export const ENTRY_LAN = 'lan'
export const ENTRY_TUNNEL = 'tunnel'

/** True for the loopback addresses Node reports for a local socket. */
export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Which entry a request reached the webserver through.
 * @param headers - the request headers as seen by the webserver.
 * @param remoteAddress - the socket peer address.
 * @returns one of ENTRY_LOCAL / ENTRY_LAN / ENTRY_TUNNEL.
 */
export function entryOf(headers, remoteAddress) {
  const forwarded = headers?.['cf-connecting-ip']
  if (typeof forwarded === 'string' && forwarded !== '') return ENTRY_TUNNEL
  const mark = headers?.[ENTRY_HEADER]
  // Only the two remote marks are honoured: a forged `local` would be the one
  // value worth forging, and it must never be taken from the wire.
  if (mark === ENTRY_LAN || mark === ENTRY_TUNNEL) return mark
  return isLoopbackAddress(remoteAddress ?? '') ? ENTRY_LOCAL : ENTRY_LAN
}

/** Loopback, link-local and known virtual/VPN ranges cannot serve a phone. */
export function isUsableIp(ip) {
  if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) return false
  if (ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('0.')) return false
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 26) return false // 26/8 = Radmin VPN
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT / Tailscale
  if (a >= 224) return false
  return true
}

/** /24 prefix of an IPv4 address, or '' when the input is not one. */
export function ipPrefix(ip) {
  const parts = String(ip).split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.` : ''
}

/** Same /24 as a recently active device wins; then LAN-looking ranges. */
export function scoreIp(ip, devicePrefixes) {
  const [a, b] = ip.split('.').map(Number)
  let score = devicePrefixes.includes(ipPrefix(ip)) ? 200 : 0
  if (a === 192 && b === 168) score += 60
  else if (a === 10) score += 40
  else if (a === 172 && b >= 16 && b <= 31) score += 15
  else score += 5
  if (ip.startsWith('192.168.56.')) score -= 50 // VirtualBox host-only
  return score
}

/**
 * Local IPv4 candidates for the phone entry URL, best first.
 * @param deviceIps - ips of recently active paired devices.
 * @param interfaces - `os.networkInterfaces()` shape; injectable for tests.
 * @returns at most five addresses.
 */
export function localCandidates(deviceIps, interfaces = os.networkInterfaces()) {
  const prefixes = []
  for (const ip of deviceIps) {
    const prefix = ipPrefix(ip)
    if (prefix !== '' && !prefixes.includes(prefix)) prefixes.push(prefix)
    if (prefixes.length >= 5) break
  }
  const found = []
  for (const list of Object.values(interfaces ?? {})) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (!isUsableIp(info.address) || found.includes(info.address)) continue
      found.push(info.address)
    }
  }
  return found
    .map((ip) => ({ ip, score: scoreIp(ip, prefixes) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((entry) => entry.ip)
}

/**
 * The URL a phone should open, optionally carrying the pairing code.
 *
 * The code travels in the URL **fragment**: fragments are never sent to the
 * server, never appear in access logs, and are not forwarded in the Referer
 * header, so a scanned code does not leak into either side's logs. The pairing
 * page reads it, fills the field and submits on its own.
 *
 * @param origin - e.g. `http://192.168.1.5:3081` or a tunnel URL.
 * @param code - the current 6-digit code, or '' for a plain pairing link.
 */
export function pairUrl(origin, code) {
  const base = String(origin).replace(/\/+$/, '') + '/gateway-pair'
  const value = typeof code === 'string' ? code.trim() : ''
  return /^\d{6}$/.test(value) ? `${base}#k=${value}` : base
}

/**
 * Read a pairing code out of a URL fragment (`#k=123456`, `k=123456`).
 * Mirrors the browser-side parser so the behaviour is testable.
 * @param fragment - `location.hash` or a bare fragment.
 * @returns the 6 digits, or '' when absent/malformed.
 */
export function codeFromFragment(fragment) {
  const match = /(?:^#?|&)k=(\d{6})(?:&|$)/.exec(String(fragment ?? ''))
  return match === null ? '' : match[1]
}
