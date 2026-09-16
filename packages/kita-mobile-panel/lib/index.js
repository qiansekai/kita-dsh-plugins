/**
 * kita-mobile-panel — host bridge for the dsh mobile panel views.
 *
 * Routes (registered on the web profile's own webServer, so the phone
 * reaches them through kita-dsh-gateway with its pairing auth, and the
 * loopback desktop browser reaches them directly):
 *
 *  - POST /mobile-git/run  {cwd, argv}
 *      Whitelisted git porcelain runner for the git view tab: verb allowlist
 *      plus a safe-flag allowlist, bounded output, hard timeout. Same trust
 *      model as the rest of the panel (paired clients only), narrow surface.
 *
 * Removed 2026-09-16: the `/mobile-files/list|read|op` routes and the
 * `/mobile-terminal` ConPTY bridge. DSH 0.1.6 ships its own right-Sidebar
 * terminal (with shell selection) and workspace file browser, so the mobile
 * panel keeps only the git tab the official UI does not cover. The
 * `node-pty` and `ws` dependencies went with them.
 */
import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

export const name = 'kita-mobile-panel'
export const inject = ['webServer']

const GIT_MAX_OUTPUT_BYTES = 200 * 1024
const GIT_TIMEOUT_MS = 30 * 1000
const GIT_MAX_ARGV = 8
/** Porcelain verbs the git tab may run. */
const GIT_VERBS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files',
  'add', 'commit', 'pull', 'push', 'stash', 'switch', 'checkout',
  'restore', 'reset', 'fetch', 'merge', 'remote', 'describe',
])
/** The only flag forms allowed; anything else flag-looking is rejected. */
const GIT_SAFE_FLAGS = new Set([
  '--porcelain', '--oneline', '--decorate', '--stat', '--name-only', '--cached',
  '--staged', '--short', '--abbrev-ref', '--show-toplevel', '-A', '-m', '-v',
  '--all', '--tags', '--no-pager', '--follow', '-n', '-a', '-u', '--',
])

/** Write one JSON response. */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/**
 * POST /mobile-git/run — run one whitelisted git command in `cwd`.
 * argv[0] must be an allowlisted verb; every flag-looking argument must be
 * in the safe-flag set (so `-c key=val` / `--exec-path` style injection is
 * rejected). Output and runtime are bounded.
 */
function handleGitRun(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, code: 'method', error: 'POST only' })
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy() })
  req.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      json(res, 400, { ok: false, code: 'bad-json', error: 'invalid JSON body' })
      return
    }
    const cwd = typeof payload?.cwd === 'string' && payload.cwd !== '' && isAbsolute(payload.cwd) ? resolve(payload.cwd) : null
    const argv = Array.isArray(payload?.argv) ? payload.argv : null
    if (cwd === null) {
      json(res, 400, { ok: false, code: 'bad-path', error: 'cwd must be an absolute path' })
      return
    }
    if (argv === null || argv.length < 1 || argv.length > GIT_MAX_ARGV || !argv.every((arg) => typeof arg === 'string')) {
      json(res, 400, { ok: false, code: 'bad-argv', error: 'argv must be 1-8 strings' })
      return
    }
    const verb = argv[0]
    if (!GIT_VERBS.has(verb)) {
      json(res, 400, { ok: false, code: 'verb-denied', error: `git verb "${verb}" is not allowed` })
      return
    }
    for (const arg of argv.slice(1)) {
      if ((arg.startsWith('--') || arg.startsWith('-')) && !GIT_SAFE_FLAGS.has(arg)) {
        json(res, 400, { ok: false, code: 'flag-denied', error: `git flag "${arg}" is not allowed` })
        return
      }
    }
    execFile('git', ['-C', cwd, ...argv], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES + 4096,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const out = (typeof stdout === 'string' ? stdout : '').slice(0, GIT_MAX_OUTPUT_BYTES)
      const err = (typeof stderr === 'string' ? stderr : '').slice(0, GIT_MAX_OUTPUT_BYTES)
      if (error !== null) {
        const code = typeof error.code === 'number' ? error.code : 1
        json(res, 200, { ok: true, code, out, err: `${err}${error.message ?? ''}`.slice(0, GIT_MAX_OUTPUT_BYTES) })
        return
      }
      json(res, 200, { ok: true, code: 0, out, err })
    })
  })
}

export function apply(ctx) {
  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/mobile-git/run',
      handler: (req, res) => handleGitRun(req, res),
    }),
  ]
  ctx.effect(() => () => {
    for (const disposer of disposers) disposer()
  }, 'kita-mobile-panel: routes')
}
