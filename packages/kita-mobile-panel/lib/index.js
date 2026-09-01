/**
 * kita-mobile-panel — host bridge for the dsh mobile panel views.
 *
 * Routes (registered on the web profile's own webServer, so the phone
 * reaches them through kita-dsh-gateway with its pairing auth, and the
 * loopback desktop browser reaches them directly):
 *
 *  - GET /mobile-files/list?path=<absolute path>
 *      JSON listing of one directory: child directories and files with
 *      type/size/hidden flags, directories first.
 *  - GET /mobile-files/read?path=<absolute path>
 *      Raw file content for preview: images stream with a content type
 *      (≤ MAX_IMAGE_BYTES), known text types stream as UTF-8 text
 *      (truncated at MAX_TEXT_BYTES with an X-Truncated header), anything
 *      else answers 415.
 *  - POST /mobile-files/op {op, src, ...}
 *      File ops for the files tab: rename / copy / move, plus `reveal`
 *      which opens src in the host's Windows Explorer — directories open
 *      directly, files open with /select so the entry is highlighted.
 *  - WS /mobile-terminal?cwd=<absolute path>&cols=N&rows=N
 *      xterm.js terminal bridge: spawns pwsh inside a real ConPTY via
 *      node-pty and relays JSON envelopes {t:'data'|'input'|'resize'|'exit'|'fatal'}.
 *      Dynamic resize is supported through pty.resize().
 *  - POST /mobile-git/run  {cwd, argv}
 *      Whitelisted git porcelain runner for the git view tab: verb allowlist
 *      plus a safe-flag allowlist, bounded output, hard timeout. Same trust
 *      model as the terminal (paired clients only) with a narrower surface.
 *
 * Everything is read-only for files; the terminal is the host's own shell
 * (same trust as the current danger-full-access file policy). The plugin
 * tears down every open terminal on unload.
 */
import { createReadStream, existsSync } from 'node:fs'
import { cp, rename as fsRename, rm, stat, readdir } from 'node:fs/promises'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import * as pty from 'node-pty'

export const name = 'kita-mobile-panel'
export const inject = ['webServer']

const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const TERMINAL_DEFAULT_COLS = 80
const TERMINAL_DEFAULT_ROWS = 24
const TERMINAL_MIN_COLS = 20
const TERMINAL_MAX_COLS = 500
const TERMINAL_MIN_ROWS = 5
const TERMINAL_MAX_ROWS = 300
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

/**
 * The shell executable for terminals. node-pty resolves bare names against
 * the dsh process's PATH, which does not include the user's pwsh install —
 * that spawn fails with "File not found". Resolve an absolute path instead:
 * PATH probe first, then the standard PowerShell 7 / Windows PowerShell 5.1
 * install locations. Resolved once and cached for the process lifetime.
 */
let terminalShellPath = null
function resolveTerminalShellPath() {
  if (terminalShellPath !== null) return terminalShellPath
  const candidates = []
  try {
    const found = String(execFileSync('where.exe', ['pwsh'], { encoding: 'utf8', timeout: 5000 }))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (found !== undefined) candidates.push(found)
  } catch {
    /* not on the dsh PATH */
  }
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  if (process.env.SystemRoot) candidates.push(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  terminalShellPath = candidates.find((candidate) => existsSync(candidate)) ?? 'powershell.exe'
  return terminalShellPath
}

const IMAGE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_CONTENT_TYPES))

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonc', '.json5', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yml', '.yaml',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.sh', '.ps1', '.psm1', '.py', '.c', '.h', '.cpp',
  '.hpp', '.cc', '.cs', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.sql', '.lua', '.swift',
  '.vue', '.svelte', '.bat', '.cmd', '.gitignore', '.editorconfig', '.lock', '.csv', '.tsv',
  '.srt', '.ass', '.diff', '.patch', '.tex', '.r', '.pl', '.scala', '.dart', '.zig', '.ex',
  '.exs', '.erl', '.hrl', '.fs', '.fsx', '.ml', '.mli', '.hs', '.clj', '.cljs', '.gradle',
  '.properties', '.nim', '.v', '.sv', '.proto', '.graphql', '.makefile', '.dockerfile',
])

/** Write one JSON response. */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
}

/** The absolute path a request names, or null when absent/relative. */
function requestedPath(req) {
  const url = new URL(req.url ?? '/', 'http://x')
  const value = url.searchParams.get('path')
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) return null
  return resolve(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** GET /mobile-files/list — one directory level, dirs first, name-sorted. */
async function handleList(req, res) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, code: 'method', error: 'GET only' })
    return
  }
  const target = requestedPath(req)
  if (target === null) {
    json(res, 400, { ok: false, code: 'bad-path', error: 'path must be an absolute path' })
    return
  }
  let info
  try {
    info = await stat(target)
  } catch (error) {
    json(res, 404, { ok: false, code: 'missing', error: error instanceof Error ? error.message : String(error) })
    return
  }
  if (!info.isDirectory()) {
    json(res, 400, { ok: false, code: 'not-directory', error: 'not a directory' })
    return
  }
  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch (error) {
    json(res, 500, { ok: false, code: 'unreadable', error: error instanceof Error ? error.message : String(error) })
    return
  }
  const entries = []
  for (const dirent of dirents) {
    let type = null
    if (dirent.isDirectory()) type = 'dir'
    else if (dirent.isFile()) type = 'file'
    else continue
    const entryPath = join(target, dirent.name)
    let size = null
    if (type === 'file') {
      try {
        size = (await stat(entryPath)).size
      } catch {
        size = null
      }
    }
    entries.push({
      name: dirent.name,
      path: entryPath,
      type,
      size,
      hidden: dirent.name.startsWith('.'),
    })
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  json(res, 200, { ok: true, path: target, entries })
}

/** GET /mobile-files/read — bounded raw content for the preview pane. */
async function handleRead(req, res) {
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, code: 'method', error: 'GET only' })
    return
  }
  const target = requestedPath(req)
  if (target === null) {
    json(res, 400, { ok: false, code: 'bad-path', error: 'path must be an absolute path' })
    return
  }
  let info
  try {
    info = await stat(target)
  } catch (error) {
    json(res, 404, { ok: false, code: 'missing', error: error instanceof Error ? error.message : String(error) })
    return
  }
  if (!info.isFile()) {
    json(res, 400, { ok: false, code: 'not-file', error: 'not a file' })
    return
  }
  const ext = extname(target).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (info.size > MAX_IMAGE_BYTES) {
      json(res, 413, { ok: false, code: 'too-large-image', error: `image larger than ${MAX_IMAGE_BYTES} bytes` })
      return
    }
    res.writeHead(200, {
      'Content-Type': IMAGE_CONTENT_TYPES[ext],
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    })
    createReadStream(target).pipe(res)
    return
  }
  if (ext !== '' && !TEXT_EXTENSIONS.has(ext)) {
    json(res, 415, { ok: false, code: 'unsupported', error: 'no preview for this file type' })
    return
  }
  if (info.size > MAX_TEXT_BYTES) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Truncated': 'true',
    })
    createReadStream(target, { start: 0, end: MAX_TEXT_BYTES - 1 }).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  })
  createReadStream(target).pipe(res)
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

/**
 * POST /mobile-files/op — the files tab's write surface: rename / copy / move.
 * Same trust model as the terminal (paired clients), but with explicit
 * guards: absolute paths only, rename names are single segments, the target
 * must not exist, and a directory cannot be copied/moved inside itself.
 */
async function handleFileOp(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, code: 'method', error: 'POST only' })
    return
  }
  let body = ''
  req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy() })
  req.on('end', () => {
    void (async () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        json(res, 400, { ok: false, code: 'bad-json', error: 'invalid JSON body' })
        return
      }
      const op = payload?.op
      const src = typeof payload?.src === 'string' && payload.src !== '' && isAbsolute(payload.src) ? resolve(payload.src) : null
      if (src === null) {
        json(res, 400, { ok: false, code: 'bad-path', error: 'src must be an absolute path' })
        return
      }
      try {
        if (op === 'reveal') {
          // Open the host's Explorer on the named entry: directories open
          // directly, files open with /select so the entry is highlighted.
          // stat() first so a vanished path answers an error instead of a
          // silent no-op window.
          const info = await stat(src)
          const arg = info.isDirectory() ? src : `/select,${src}`
          const child = spawn('explorer.exe', [arg], { detached: true, stdio: 'ignore' })
          child.on('error', () => {})
          child.unref()
          json(res, 200, { ok: true, path: src })
          return
        }
        if (op === 'rename') {
          const name = payload?.name
          if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
            json(res, 400, { ok: false, code: 'bad-name', error: 'name must be one plain path segment' })
            return
          }
          const dst = join(dirname(src), name)
          if (dst === src) {
            json(res, 200, { ok: true, path: dst })
            return
          }
          await fsRename(src, dst)
          json(res, 200, { ok: true, path: dst })
          return
        }
        const dst = typeof payload?.dst === 'string' && payload.dst !== '' && isAbsolute(payload.dst) ? resolve(payload.dst) : null
        if (dst === null) {
          json(res, 400, { ok: false, code: 'bad-path', error: 'dst must be an absolute path' })
          return
        }
        if (dst === src || dst.startsWith(`${src}${sep}`)) {
          json(res, 400, { ok: false, code: 'self-nesting', error: 'target must not be inside the source' })
          return
        }
        if (op === 'copy') {
          await cp(src, dst, { recursive: true, errorOnExist: true })
          json(res, 200, { ok: true, path: dst })
          return
        }
        if (op === 'move') {
          try {
            await fsRename(src, dst)
          } catch (error) {
            // Cross-volume moves fail with EXDEV; fall back to copy + delete.
            if (error === null || typeof error !== 'object' || error.code !== 'EXDEV') throw error
            await cp(src, dst, { recursive: true, errorOnExist: true })
            await rm(src, { recursive: true, force: true })
          }
          json(res, 200, { ok: true, path: dst })
          return
        }
        json(res, 400, { ok: false, code: 'bad-op', error: `unknown op "${String(op)}"` })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}

/**
 * WS /mobile-terminal — one ConPTY pwsh per socket.
 * JSON envelope both ways: client {t:'input',d}|{t:'resize',cols,rows},
 * host {t:'data',d}|{t:'exit',code}|{t:'fatal',d}.
 */
function handleTerminalUpgrade(req, socket, head, terminals) {
  const url = new URL(req.url ?? '/', 'http://x')
  const cwdParam = url.searchParams.get('cwd')
  const cwd = typeof cwdParam === 'string' && cwdParam !== '' && isAbsolute(cwdParam)
    ? resolve(cwdParam)
    : resolve('.')
  const cols = clamp(Number.parseInt(url.searchParams.get('cols') ?? '', 10) || TERMINAL_DEFAULT_COLS, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS)
  const rows = clamp(Number.parseInt(url.searchParams.get('rows') ?? '', 10) || TERMINAL_DEFAULT_ROWS, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
  stat(cwd).then((info) => {
    if (!info.isDirectory()) throw new Error('cwd is not a directory')
    const wss = new WebSocketServer({ noServer: true })
    wss.on('connection', (ws) => {
      const session = {
        shell: null,
        kill() {
          try {
            this.shell?.kill()
          } catch {
            /* already dead */
          }
        },
      }
      terminals.add(session)
      let shell = null
      try {
        shell = pty.spawn(resolveTerminalShellPath(), ['-NoLogo', '-NoProfile'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1' },
          encoding: 'utf8',
        })
      } catch (error) {
        terminals.delete(session)
        try {
          ws.send(JSON.stringify({ t: 'fatal', d: error instanceof Error ? error.message : String(error) }))
        } catch {
          /* socket already gone */
        }
        ws.close()
        return
      }
      session.shell = shell
      shell.onData((data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'data', d: data }))
      })
      shell.onExit(({ exitCode }) => {
        terminals.delete(session)
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ t: 'exit', code: exitCode }))
          } catch {
            /* closing anyway */
          }
          ws.close()
        }
      })
      ws.on('message', (raw) => {
        let message
        try {
          message = JSON.parse(String(raw))
        } catch {
          return
        }
        if (message.t === 'input' && typeof message.d === 'string') {
          try {
            shell.write(message.d)
          } catch {
            /* terminal already exited */
          }
        } else if (message.t === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          try {
            shell.resize(clamp(message.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS), clamp(message.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS))
          } catch {
            /* provider refuses mid-exit */
          }
        }
      })
      ws.on('close', () => {
        terminals.delete(session)
        session.kill()
      })
      ws.on('error', () => {})
    })
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }, () => {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
}

export function apply(ctx) {
  const terminals = new Set()
  const disposers = [
    ctx.webServer.register({
      kind: 'prefix',
      path: '/mobile-files',
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/mobile-files/list') return handleList(req, res)
        if (pathname === '/mobile-files/read') return handleRead(req, res)
        if (pathname === '/mobile-files/op') return handleFileOp(req, res)
        res.writeHead(404)
        res.end()
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/mobile-git/run',
      handler: (req, res) => handleGitRun(req, res),
    }),
    ctx.webServer.registerUpgrade({
      path: '/mobile-terminal',
      handler: (req, socket, head) => handleTerminalUpgrade(req, socket, head, terminals),
    }),
  ]
  ctx.effect(() => () => {
    for (const terminal of terminals) terminal.kill()
    terminals.clear()
    for (const disposer of disposers) disposer()
  }, 'kita-mobile-panel: routes')
}
