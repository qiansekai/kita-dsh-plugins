/**
 * kita-dsh-restart — host half.
 *
 * A restart button in the browser cannot be served by the process it restarts:
 * the requester dies with it, and (on this machine) dsh runs inside a Windows
 * Job Object, so anything it spawns is killed with the job. The restart is
 * therefore delegated to an on-demand Task Scheduler task, whose process is
 * started by the Task Scheduler service — outside dsh's process tree and job —
 * and therefore survives the kill it performs.
 *
 * Routes (registered on the profile's own webServer; reached directly on
 * loopback by the desktop browser and through kita-dsh-gateway's pairing auth
 * by LAN clients):
 *
 *   POST /kita-restart/run     { delaySeconds? }  -> run the restart task
 *   GET  /kita-restart/status                      -> phase + boot identity
 *
 * The client half polls `/status` and compares `bootId`: a different id means a
 * new process answered, i.e. the restart finished, and the page reloads. No
 * launch token is ever returned — the browser-session cookie is signed with a
 * secret persisted in the home's credentials store, so it stays valid across a
 * process restart.
 *
 * The task is registered idempotently at apply time. Its definition carries no
 * triggers at all (manual `/Run` only): a scheduled trigger would silently
 * restart the deployment on its own clock.
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'kita-dsh-restart'

/** The web carrier owns the routes; the config service locates this deployment. */
export const inject = ['webServer']

/** Package root, resolved from this module so nothing machine-specific is baked in. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RESTART_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'restart-dsh.ps1')
const STATE_FILE_NAME = 'kita-restart.json'
const LOG_FILE_NAME = 'kita-restart.log'
const TASK_XML_VERSION = '1.3'
const TASK_NS = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
/** How long a finished restart request keeps the button's cooldown armed. */
const DEFAULT_COOLDOWN_MS = 60_000

export const Config = z.object({
  /** Scheduled task that performs the restart (created on demand when absent). */
  taskName: z.string().default('kita-dsh-restart'),
  /** Restart script the task runs; empty = this package's scripts/restart-dsh.ps1. */
  restartScript: z.string().default(''),
  /** Absolute pwsh path for the task action; empty = auto-detect. */
  pwshPath: z.string().default(''),
  /** Absolute dsh home; empty = $DSH_HOME. */
  dshHome: z.string().default(''),
  /** Directory holding start.ps1 and active-env.txt; empty = two levels above the home. */
  dshEnvsDir: z.string().default(''),
  /** Seconds the task waits before killing dsh, so the HTTP response can land. */
  delaySeconds: z.natural().default(4),
  /** Register/repair the scheduled task while the plugin applies. */
  ensureTask: z.boolean().default(true),
  /** Window in which a second restart request is refused as a duplicate. */
  requestCooldownMs: z.natural().default(DEFAULT_COOLDOWN_MS),
  /** When the task cannot be started, restart via a direct child process instead. */
  fallbackSpawn: z.boolean().default(true),
})

/** Escape the five XML predefined entities for attribute/text content. */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Run one executable to completion, resolving with its exit code and streams. */
function runFile(file, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000, ...options }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1)
      resolvePromise({
        code,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        message: error === null ? '' : String(error.message ?? error),
      })
    })
  })
}

/** Read one `key = value` entry from the environment pointer file. */
function readPointer(envsDir, key) {
  const path = join(envsDir, 'active-env.txt')
  if (!existsSync(path)) return ''
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      const match = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'u').exec(line)
      if (match !== null) return match[1]
    }
  } catch {
    return ''
  }
  return ''
}

/** Locate PowerShell 7: explicit config first, then PATH, then the standard install. */
function detectPwsh(configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  for (const candidate of [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ]) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return 'pwsh.exe'
}

/** Resolve this deployment's home and dsh-envs directory, or explain what is missing. */
function resolveLayout(config) {
  const home = config.dshHome !== '' ? config.dshHome : (process.env.DSH_HOME ?? '')
  if (home === '') throw new Error('kita-dsh-restart: no dsh home (set config.dshHome or $DSH_HOME)')
  const envsDir = config.dshEnvsDir !== '' ? config.dshEnvsDir : resolve(home, '..', '..')
  if (!existsSync(join(envsDir, 'start.ps1'))) {
    throw new Error(`kita-dsh-restart: no start.ps1 under "${envsDir}" (set config.dshEnvsDir)`)
  }
  return { home, envsDir }
}

/** Build the task definition XML: manual start only, no triggers, highest available token. */
function buildTaskXml(options) {
  const arguments_ = [
    '-NoProfile',
    '-WindowStyle', 'Hidden',
    '-File', `"${options.restartScript}"`,
    '-DelaySeconds', String(options.delaySeconds),
    '-Port', String(options.port),
    '-EnvsDir', `"${options.envsDir}"`,
    '-LogPath', `"${options.logPath}"`,
    '-NodeDir', `"${options.nodeDir}"`,
  ].join(' ')
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="${TASK_XML_VERSION}" xmlns="${TASK_NS}">`,
    '  <RegistrationInfo>',
    `    <Author>${escapeXml(options.author)}</Author>`,
    '    <Description>kita-dsh-restart: on-demand dsh web restart requested from the dsh web GUI sidebar.</Description>',
    `    <URI>\\${escapeXml(options.taskName)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers />',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(options.userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(options.pwshPath)}</Command>`,
    `      <Arguments>${escapeXml(arguments_)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

/**
 * Reject cross-site callers. The routes reach a privileged action and dsh's own
 * loopback carrier performs no authentication of its own, so the CSRF shape
 * (an arbitrary page posting to 127.0.0.1) has to be refused here: a cross-site
 * fetch always carries a mismatching Origin, or `Sec-Fetch-Site: cross-site`.
 */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const restartScript = config.restartScript !== '' ? config.restartScript : DEFAULT_RESTART_SCRIPT
  const pwshPath = detectPwsh(config.pwshPath)
  const bootId = randomUUID()
  const bootedAt = Date.now()

  let layout = null
  let layoutError = null
  try {
    layout = resolveLayout(config)
  } catch (error) {
    layoutError = String(error && error.message ? error.message : error)
  }

  const stateFile = layout === null ? '' : join(layout.home, 'storages', STATE_FILE_NAME)
  const logFile = layout === null ? '' : join(layout.home, 'storages', LOG_FILE_NAME)

  /** Task registration/continuity facts surfaced through /status. */
  const task = { name: config.taskName, exists: false, ready: false, error: null, checkedAt: 0 }
  /** The in-flight restart request for THIS process, if any. */
  let pending = null

  function appendLog(line) {
    if (logFile === '') return
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\r\n`, 'utf8')
    } catch {
      /* logging must never break the request path */
    }
  }

  function readState() {
    if (stateFile === '' || !existsSync(stateFile)) return {}
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }

  function writeState(patch) {
    if (stateFile === '') return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const next = { ...readState(), ...patch, version: 1 }
      writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      /* the restart itself never depends on the bookkeeping file */
    }
  }

  /** Current web port: the carrier's own binding is the only authoritative source. */
  function currentPort() {
    const bound = ctx.webServer.port
    if (typeof bound === 'number' && bound > 0) return bound
    const pointer = layout === null ? '' : readPointer(layout.envsDir, 'port')
    return pointer === '' ? 3080 : Number(pointer)
  }

  async function currentUserSid() {
    const result = await runFile(pwshPath, [
      '-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ])
    const sid = result.stdout.trim()
    return /^S-\d(-\d+)+$/u.test(sid) ? sid : ''
  }

  /** Register the restart task when missing, and repair it when its action drifted. */
  async function ensureTask() {
    task.checkedAt = Date.now()
    if (layout === null) {
      task.error = layoutError
      return
    }
    if (!existsSync(restartScript)) {
      task.error = `restart script not found: ${restartScript}`
      return
    }
    const query = await runFile('schtasks', ['/Query', '/TN', config.taskName, '/XML'])
    const port = currentPort()
    if (query.code === 0) {
      task.exists = true
      const expectedScript = escapeXml(`"${restartScript}"`)
      const hasScript = query.stdout.includes(expectedScript) || query.stdout.includes(restartScript)
      const highest = query.stdout.includes('<RunLevel>HighestAvailable</RunLevel>')
      // The delay lives in the task action, not only in config, so a drifted
      // value would otherwise survive every later restart.
      const delayOk = query.stdout.includes(`-DelaySeconds ${String(config.delaySeconds)}`)
      if (hasScript && highest && delayOk) {
        task.ready = true
        task.error = null
        appendLog(`task "${config.taskName}" already registered and current`)
        return
      }
      appendLog(`task "${config.taskName}" drifted (script=${String(hasScript)} highest=${String(highest)} delay=${String(delayOk)}); re-registering`)
    }
    const sid = await currentUserSid()
    if (sid === '') {
      task.error = 'could not resolve the current user SID for the task principal'
      return
    }
    const xml = buildTaskXml({
      taskName: config.taskName,
      author: process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : (process.env.USERNAME ?? 'unknown'),
      userId: sid,
      pwshPath,
      restartScript,
      delaySeconds: config.delaySeconds,
      port,
      envsDir: layout.envsDir,
      logPath: logFile,
      // The task environment need not carry the node directory dsh itself runs from.
      nodeDir: dirname(process.execPath),
    })
    const xmlPath = join(tmpdir(), `kita-dsh-restart-${randomUUID()}.xml`)
    try {
      // schtasks requires a UTF-16 XML document; write the BOM explicitly.
      writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]))
      const created = await runFile('schtasks', ['/Create', '/TN', config.taskName, '/XML', xmlPath, '/F'])
      if (created.code !== 0) {
        task.error = `schtasks /Create failed (${String(created.code)}): ${(created.stderr || created.message).trim()}`
        appendLog(`task registration FAILED: ${task.error}`)
        return
      }
      task.exists = true
      task.ready = true
      task.error = null
      appendLog(`task "${config.taskName}" registered (runlevel=HighestAvailable, no triggers)`)
    } finally {
      try {
        writeFileSync(xmlPath, '')
      } catch {
        /* best effort */
      }
    }
  }

  /** Start the registered task; the restart happens outside dsh's process tree. */
  async function startTask() {
    const result = await runFile('schtasks', ['/Run', '/TN', config.taskName])
    if (result.code === 0) return { ok: true, mode: 'task' }
    const detail = (result.stderr || result.message).trim()
    if (!config.fallbackSpawn) return { ok: false, mode: 'task', error: detail }
    appendLog(`schtasks /Run failed (${detail}); falling back to a direct child process`)
    try {
      const child = spawn(pwshPath, [
        '-NoProfile', '-WindowStyle', 'Hidden',
        '-File', restartScript,
        '-DelaySeconds', String(config.delaySeconds),
        '-Port', String(currentPort()),
        '-EnvsDir', layout.envsDir,
        '-LogPath', logFile,
        '-NodeDir', dirname(process.execPath),
      ], { stdio: 'ignore', windowsHide: true, detached: false })
      child.unref()
      return { ok: true, mode: 'spawn-fallback' }
    } catch (error) {
      return { ok: false, mode: 'spawn-fallback', error: `${detail}; spawn fallback failed: ${String(error && error.message ? error.message : error)}` }
    }
  }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolvePromise) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => resolvePromise(body))
      req.on('error', () => resolvePromise(''))
    })
  }

  function statusPayload() {
    const stored = readState()
    return {
      ok: true,
      bootId,
      bootedAt,
      phase: pending === null ? 'idle' : 'pending',
      pending,
      task: {
        name: task.name,
        exists: task.exists,
        ready: task.ready,
        error: task.error,
        checkedAt: task.checkedAt,
      },
      lastRequest: typeof stored.lastRequestAt === 'number'
        ? { at: stored.lastRequestAt, mode: stored.lastMode ?? '', taskName: stored.lastTaskName ?? '' }
        : null,
      port: currentPort(),
      delaySeconds: config.delaySeconds,
      layoutError,
    }
  }

  async function handleStatus(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'GET only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    json(res, 200, statusPayload())
  }

  async function handleRun(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST only' })
      return
    }
    if (!isTrustedRequest(req)) {
      json(res, 403, { ok: false, error: 'untrusted origin' })
      return
    }
    const body = await readBody(req)
    let requestedDelay = config.delaySeconds
    if (body !== '') {
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed?.delaySeconds === 'number' && Number.isFinite(parsed.delaySeconds)) {
          requestedDelay = Math.min(60, Math.max(0, Math.floor(parsed.delaySeconds)))
        }
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
    }
    if (pending !== null) {
      json(res, 409, { ok: false, error: 'a restart is already pending', pending })
      return
    }
    const stored = readState()
    if (typeof stored.lastRequestAt === 'number' && Date.now() - stored.lastRequestAt < config.requestCooldownMs) {
      const waitMs = config.requestCooldownMs - (Date.now() - stored.lastRequestAt)
      json(res, 429, { ok: false, error: `recent restart request; retry in ${String(Math.ceil(waitMs / 1000))}s` })
      return
    }
    if (!task.ready) await ensureTask()
    if (!task.exists) {
      json(res, 503, { ok: false, error: task.error ?? 'restart task is unavailable' })
      return
    }
    const started = await startTask()
    if (!started.ok) {
      appendLog(`restart request rejected: ${started.error}`)
      json(res, 500, { ok: false, error: started.error })
      return
    }
    const requestedAt = Date.now()
    pending = { at: requestedAt, mode: started.mode, taskName: config.taskName, delaySeconds: requestedDelay }
    writeState({
      lastRequestAt: requestedAt,
      lastMode: started.mode,
      lastTaskName: config.taskName,
      lastPid: process.pid,
    })
    appendLog(`restart requested via ${started.mode}; task="${config.taskName}" delay=${String(requestedDelay)}s bootId=${bootId}`)
    json(res, 200, {
      ok: true,
      mode: started.mode,
      taskName: config.taskName,
      delaySeconds: requestedDelay,
      bootId,
      requestedAt,
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: '/kita-restart/run', handler: (req, res) => { void handleRun(req, res) } }),
    ctx.webServer.register({ kind: 'exact', path: '/kita-restart/status', handler: (req, res) => { void handleStatus(req, res) } }),
  ]
  ctx.effect(() => () => {
    for (const disposer of disposers) disposer()
  }, 'kita-dsh-restart: routes')

  appendLog(`plugin applied: bootId=${bootId} pwsh="${pwshPath}" envs="${layout === null ? '<unresolved>' : layout.envsDir}"`)
  if (config.ensureTask) {
    void ensureTask().catch((error) => {
      task.error = String(error && error.message ? error.message : error)
      appendLog(`task ensure threw: ${task.error}`)
    })
  }
}
