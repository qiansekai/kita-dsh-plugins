/**
 * One-click Cloudflare Quick Tunnel for the gateway port.
 *
 * The gateway is the only authenticated entry to `dsh web`, so exposing it
 * through a tunnel is exactly what makes the phone work away from the LAN.
 * `cloudflared tunnel --url ...` needs no account, no certificate and no DNS
 * record: it prints a random `https://<words>.trycloudflare.com` hostname that
 * is live as long as the process runs. Everything here is process management
 * plus output parsing — no shell, no config files, no writes to disk.
 *
 * The tunnel exposes the **gateway**, never the loopback webserver directly, so
 * the pairing code stays the only way in. `lib/index.js` additionally refuses
 * to let a tunneled (or LAN) client start or stop a tunnel.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Hostname cloudflared prints once the quick tunnel is live. */
export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

/**
 * Printed once the Cloudflare edge really has a connection to this process.
 * The hostname above shows up a few seconds earlier, and a public request made
 * in that window is answered by the edge with HTTP 530 — so `start()` treats
 * this line as "ready", with a short grace period in case a build never logs it.
 */
export const TUNNEL_READY_PATTERN = /Registered tunnel connection/i

/** How long to keep waiting for the registration line after the URL appears. */
const READY_GRACE_MS = 5000

/** How many output lines are kept for diagnostics. */
const LOG_BUFFER = 60
/** Lines handed to the panel with each status read. */
const LOG_TAIL = 12
/** Delay before an unexpected exit is retried. */
const RESTART_DELAY_MS = 3000

/**
 * Locate the cloudflared binary.
 *
 * Order: the configured path, then `CLOUDFLARED_PATH`, then `PATH`. No machine
 * specific path is baked in — a checkout that keeps cloudflared somewhere
 * unusual points `cloudflaredPath` at it in the plugin config.
 *
 * @param explicitPath - `config.cloudflaredPath`, may be ''.
 * @param env - environment to search; injectable for tests.
 * @returns the resolved path, or '' when nothing was found.
 */
export function resolveCloudflared(explicitPath, env = process.env) {
  const candidates = []
  if (typeof explicitPath === 'string' && explicitPath.trim() !== '') candidates.push(explicitPath.trim())
  const fromEnv = env?.CLOUDFLARED_PATH
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of String(env?.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) candidates.push(join(dir, `cloudflared${ext}`))
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch { /* unreadable path: try the next candidate */ }
  }
  return ''
}

/**
 * Create the tunnel controller for one gateway port.
 *
 * @param options.port - the local gateway port to expose.
 * @param options.binary - resolved cloudflared path ('' disables the feature).
 * @param options.restartLimit - automatic restarts after unexpected exits.
 * @param options.log - logger with console's shape.
 * @param options.spawnImpl - process factory, injectable so the controller can
 * be exercised without a real cloudflared (`scripts/verify-gateway.mjs`).
 * @returns controller with `state()`, `start()`, `stop()` and `dispose()`.
 */
export function createTunnel(options = {}) {
  const port = options.port
  const binary = typeof options.binary === 'string' ? options.binary : ''
  const restartLimit = Number.isInteger(options.restartLimit) && options.restartLimit >= 0
    ? options.restartLimit
    : 5
  const log = options.log ?? console
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn

  let current = null // live child process, null when stopped
  let url = ''
  let urlAt = 0 // when the hostname appeared (edge registration follows)
  let ready = false // the edge reported a live connection (see TUNNEL_READY_PATTERN)
  let startedAt = 0
  let error = ''
  let restarts = 0
  let stopRequested = false
  let disposed = false
  let restartTimer = null
  let pending = '' // partial output line carried between chunks
  const lines = []
  const waiters = new Set()

  /**
   * Wake the waiters whose condition now holds. A waiter for "the edge is
   * registered" must survive the earlier "the hostname arrived" event, so
   * unsatisfied waiters stay registered; `force` clears them all (stop/dispose).
   */
  const settle = (force = false) => {
    for (const waiter of [...waiters]) {
      if (force || waiter.ready()) {
        waiters.delete(waiter)
        waiter.done()
      }
    }
  }

  /** Resolve when `predicate` holds, or when the `until` timestamp passes. */
  const waitUntil = (predicate, until) => new Promise((resolve) => {
    if (predicate()) {
      resolve()
      return
    }
    let settled = false
    const waiter = {
      ready: () => predicate(),
      done: () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve()
      },
    }
    const timer = setTimeout(waiter.done, Math.max(0, until - Date.now()))
    if (typeof timer.unref === 'function') timer.unref()
    waiters.add(waiter)
    if (predicate()) waiter.done() // state may have changed while registering
  })

  const pushLine = (line) => {
    const text = line.trimEnd()
    if (text === '') return
    lines.push(text)
    if (lines.length > LOG_BUFFER) lines.splice(0, lines.length - LOG_BUFFER)
    if (url === '') {
      const match = TUNNEL_URL_PATTERN.exec(text)
      if (match !== null) {
        url = match[0]
        urlAt = Date.now()
        log.log(`[kita-dsh-gateway] Cloudflare 隧道已建立 ${url}`)
        settle()
        return
      }
    }
    if (!ready && url !== '' && TUNNEL_READY_PATTERN.test(text)) {
      ready = true
      log.log('[kita-dsh-gateway] Cloudflare 边缘连接已注册，公网地址可用')
      settle()
    }
  }

  const onOutput = (chunk) => {
    pending += chunk.toString('utf8')
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() ?? ''
    for (const part of parts) pushLine(part)
    // cloudflared writes the URL line without a trailing newline in some builds.
    if (url === '' && TUNNEL_URL_PATTERN.test(pending)) {
      const line = pending
      pending = ''
      pushLine(line)
    }
  }

  /**
   * Current tunnel status; `phase` is derived, never stored.
   *
   * A pending automatic restart reports `starting`, not `error`: the process
   * is gone but another one is already scheduled, and flashing "failed" in the
   * panel for those few seconds would misdescribe what is happening.
   */
  const state = () => ({
    available: binary !== '',
    binary,
    phase: current !== null
      ? (url === '' ? 'starting' : 'running')
      : (restartTimer !== null ? 'starting' : (error === '' ? 'stopped' : 'error')),
    url,
    ready,
    startedAt,
    pid: current === null ? 0 : current.pid ?? 0,
    error,
    restarts,
    restartLimit,
    logs: lines.slice(-LOG_TAIL),
  })

  const scheduleRestart = () => {
    if (disposed || stopRequested) return
    if (restarts >= restartLimit) {
      error = `隧道进程意外退出，已自动重试 ${restarts} 次后放弃`
      log.error(`[kita-dsh-gateway] ${error}`)
      settle()
      return
    }
    restarts += 1
    log.log(`[kita-dsh-gateway] 隧道进程退出，${RESTART_DELAY_MS / 1000}s 后自动重试（第 ${restarts} 次）`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!disposed && !stopRequested) spawnChild()
    }, RESTART_DELAY_MS)
    if (typeof restartTimer.unref === 'function') restartTimer.unref()
  }

  const spawnChild = () => {
    if (disposed) return
    url = ''
    urlAt = 0
    ready = false
    error = ''
    pending = ''
    lines.length = 0
    const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']
    let proc = null
    try {
      proc = spawnImpl(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (spawnError) {
      error = `无法启动 cloudflared：${spawnError?.message ?? spawnError}`
      log.error(`[kita-dsh-gateway] ${error}`)
      settle()
      return
    }
    current = proc
    startedAt = Date.now()
    log.log(`[kita-dsh-gateway] 正在建立 Cloudflare 快速隧道（pid=${proc.pid ?? 0}）`)
    proc.stdout?.on('data', onOutput)
    proc.stderr?.on('data', onOutput)
    proc.on('error', (procError) => {
      if (proc !== current) return
      error = `cloudflared 进程错误：${procError?.message ?? procError}`
      settle()
    })
    proc.on('exit', (code, signal) => {
      if (proc !== current) return // superseded by a stop() or a restart
      current = null
      url = ''
      ready = false
      if (disposed || stopRequested) {
        settle(true)
        return
      }
      error = `隧道进程退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`
      scheduleRestart()
    })
    settle() // wake anyone waiting on a previous phase change
  }

  /**
   * Start the tunnel.
   * @param waitMs - how long to wait for a usable public URL before returning
   * the still-starting state; 0 returns immediately.
   * @returns the resulting state — `ready: true` means the edge has a live
   * connection, so a phone can actually load the URL.
   */
  const start = async (waitMs = 20000) => {
    if (disposed) return { ...state(), error: '插件已停止' }
    stopRequested = false
    if (current !== null) return state()
    if (binary === '') {
      error = '未找到 cloudflared：请在插件配置里设置 cloudflaredPath，或设置 CLOUDFLARED_PATH 环境变量'
      return state()
    }
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    restarts = 0
    error = ''
    spawnChild()
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs
      if (url === '') await waitUntil(() => url !== '' || current === null, deadline)
      // The hostname is printed before the edge has a connection to this
      // process; a public request in that window gets HTTP 530 from Cloudflare.
      // Waiting for the registration line (bounded by READY_GRACE_MS) is what
      // makes "the tunnel is up" mean the phone can load it.
      while (current !== null && url !== '' && !ready
        && Date.now() < urlAt + READY_GRACE_MS && Date.now() < deadline) {
        await waitUntil(() => ready || current === null, Math.min(deadline, urlAt + READY_GRACE_MS))
      }
    }
    return state()
  }

  /** Stop the tunnel and cancel any pending restart. */
  const stop = async () => {
    stopRequested = true
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    const proc = current
    if (proc !== null) {
      current = null // detach first: the exit handler must not restart it
      await new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, 2000)
        if (typeof timer.unref === 'function') timer.unref()
        proc.once('exit', finish)
        try {
          proc.kill()
        } catch {
          finish()
        }
      })
    }
    url = ''
    urlAt = 0
    ready = false
    error = ''
    restarts = 0
    log.log('[kita-dsh-gateway] Cloudflare 隧道已关闭')
    settle(true) // nothing is coming any more: release every waiter
    return state()
  }

  /** Stop and make the controller inert — called from the plugin teardown. */
  const dispose = async () => {
    disposed = true
    await stop()
  }

  return { state, start, stop, dispose }
}
