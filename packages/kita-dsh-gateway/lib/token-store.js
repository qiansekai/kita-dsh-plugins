/**
 * Persistence for the gateway's paired-device tokens.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **The raw token never reaches the disk.** The file is keyed by
 *    `sha256(token)`, so a copy of it cannot be replayed as a credential. The
 *    panel goes through `deviceId()` for the same reason: the browser gets a
 *    16-hex handle, never the token itself.
 * 2. **A write is atomic.** `saveStore` writes a sibling `.tmp` and renames it
 *    over the target. A torn write would otherwise leave unparseable JSON, and
 *    `loadStore` swallows parse errors by returning an empty map — which would
 *    silently log every paired device out and mint a fresh pairing code.
 * 3. **The TTL is enforced on every read.** v1 filtered expired tokens once, at
 *    startup, and never again; a long-running `dsh web` therefore handed out
 *    credentials that never expired.
 *
 * The file lives under `<DSH_HOME>/storages/` and is deliberately plain JSON:
 * it is small, human-inspectable, and the version field below is what makes the
 * v1 → v2 migration safe.
 */
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** How long an issued token stays valid. */
export const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000

/** On-disk schema this build writes. v1 keyed the map by the raw token. */
export const STORE_VERSION = 2

/** sha256 hex of a token — what goes to disk, and what is compared against. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Non-reversible handle for one device.
 *
 * It is the first 16 hex characters of the token hash, which is plenty to be
 * collision-free across the handful of devices a gateway ever holds, and
 * useless as a credential.
 */
export function deviceId(token) {
  return hashToken(token).slice(0, 16)
}

/** True when a token record is past its 90 days (or was written without a date). */
export function isExpired(meta, now = Date.now()) {
  const at = typeof meta?.at === 'number' ? meta.at : 0
  return at <= 0 || now - at >= TOKEN_TTL_MS
}

/** When the token behind `meta` stops being accepted. */
export function expiresAt(meta) {
  const at = typeof meta?.at === 'number' ? meta.at : 0
  return at <= 0 ? 0 : at + TOKEN_TTL_MS
}

/** Drop every expired record in place. @returns how many were removed. */
export function pruneExpired(tokens, now = Date.now()) {
  let removed = 0
  for (const [key, meta] of [...tokens]) {
    if (isExpired(meta, now)) {
      tokens.delete(key)
      removed += 1
    }
  }
  return removed
}

/**
 * Read the store.
 *
 * @param file - absolute path to the JSON store.
 * @returns `{ tokens, currentCode, migrated }` — `tokens` is keyed by token
 * hash, `migrated` is true when the file was still v1 so the caller knows to
 * write the new shape back. A missing or unreadable file yields an empty store
 * rather than throwing: the gateway must still come up.
 */
export function loadStore(file) {
  const empty = { tokens: new Map(), currentCode: undefined, migrated: false }
  try {
    if (!existsSync(file)) return empty
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const migrated = data.version !== STORE_VERSION
    const map = new Map()
    const now = Date.now()
    for (const [key, meta] of Object.entries(data.tokens ?? {})) {
      if (isExpired(meta, now)) continue
      // v1 wrote the raw token as the key. Hashing it on load is what lets
      // every already-paired phone keep working across the upgrade: the cookie
      // in its browser still carries the raw token, and the lookup hashes that
      // before comparing — so the same value matches, just from the other side.
      map.set(migrated ? hashToken(key) : key, meta)
    }
    const currentCode = typeof data.currentCode === 'string' ? data.currentCode : undefined
    return { tokens: map, currentCode, migrated }
  } catch {
    return empty
  }
}

/**
 * Write the store atomically.
 * @returns true when the file was replaced.
 */
export function saveStore(file, tokens, currentCode) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const data = { version: STORE_VERSION, currentCode, tokens: Object.fromEntries(tokens) }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, file)
    return true
  } catch (error) {
    console.error('[kita-dsh-gateway] state persist failed:', error)
    return false
  }
}
