/**
 * kita-dsh-notify — desktop notifications for session completion and failure.
 *
 * Why a Host plugin instead of a browser (Client) plugin: a Client plugin is
 * mounted per Session, so it is unloaded the moment the user switches to
 * another Session — exactly when a completion notice would be useful. This
 * plugin lives on the Host, observes the Session registry directly, and raises
 * a native Windows toast through `ctx.shell`, so it keeps working no matter
 * which Session a page is showing, and with no page open at all.
 *
 * Measured 2026-09-16 (dsh 0.1.6-alpha.1, Windows):
 * - `new Notification(...)` from a dynamic Client plugin does work once the
 *   origin is allowed, but only while that Session's page is mounted; the
 *   host-side toast is the only variant that survives a Session switch.
 * - PowerShell 7 has no WinRT projection, so `Windows.UI.Notifications` must
 *   be executed by Windows PowerShell 5.1 (`powershell.exe`). The script is
 *   handed over as a UTF-16LE base64 `-EncodedCommand`, so paths and CJK
 *   titles survive quoting and console codepages intact.
 */
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'kita-dsh-notify'

/** `shell` runs the toast process; no other service is required. */
export const inject = ['shell']

export const Config = z.object({
  enabled: z.boolean().default(true),
  notifyOnComplete: z.boolean().default(true),
  notifyOnError: z.boolean().default(true),
  /** Skip Sessions whose summary declares a parent or `origin: 'subagent'`. */
  excludeSubagentSessions: z.boolean().default(true),
  /** Sessions that ran shorter than this are not worth a toast. */
  minRunningMs: z.number().default(5000),
  /** Empty selects Windows PowerShell 5.1 under %SystemRoot%. */
  powershellPath: z.string().default(''),
  /**
   * The toast's AppUserModelID. The default is the AUMID Windows already
   * registers for Windows PowerShell, so no Start-menu shortcut is needed.
   * A machine-local AUMID belongs in configuration, never in code.
   */
  appId: z.string().default('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'),
  titleComplete: z.string().default('DSH 任务完成'),
  titleError: z.string().default('DSH 会话出错'),
  timeoutMs: z.number().default(20000),
  /**
   * Sandbox policy for the toast process. The default keeps the helper
   * uncaged, because it only renders a local notification; narrow it per
   * deployment when the profile runs a stricter sandbox policy.
   */
  sandboxMode: z.string().default('danger-full-access'),
  /** Empty falls back to the dsh host process working directory. */
  workspaceRoot: z.string().default(''),
})

/** Compact human duration: `42s`, `3m07s`. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes <= 0) return String(total) + 's'
  return String(minutes) + 'm' + String(seconds).padStart(2, '0') + 's'
}

/** PowerShell single-quoted literal: doubles embedded quotes, never expands. */
function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

export function apply(ctx, config) {
  const options = config || {}

  const write = (level, message) => {
    const line = '[kita-dsh-notify] ' + message
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](line)
    else if (level === 'error') console.error(line)
    else console.log(line)
  }

  if (!options.enabled) {
    write('info', 'disabled by configuration')
    return
  }

  if (process.platform !== 'win32') {
    write('info', 'skipped: Windows toast notifications are unavailable on ' + process.platform)
    return
  }

  /** sessionId -> { cwd, subagent } from the Session list summary. */
  const sessions = new Map()
  /** sessionId -> epoch ms at which the Session last entered `running`. */
  const startedAt = new Map()

  const powershellPath = () => {
    if (options.powershellPath) return options.powershellPath
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }

  const buildScript = (title, body) => [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    "  $texts = $template.GetElementsByTagName('text')",
    '  $texts.Item(0).AppendChild($template.CreateTextNode(' + psLiteral(title) + ')) | Out-Null',
    '  $texts.Item(1).AppendChild($template.CreateTextNode(' + psLiteral(body) + ')) | Out-Null',
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + psLiteral(options.appId) + ').Show($toast)',
    "  Write-Output 'TOAST_OK'",
    '} catch {',
    "  Write-Output ('TOAST_FAIL: ' + $_.Exception.Message)",
    '}',
  ].join('\n')

  const notify = async (title, body) => {
    try {
      const script = buildScript(title, body)
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const command = '& ' + psLiteral(powershellPath())
        + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded
      const workspaceRoot = options.workspaceRoot || process.cwd()
      const result = await ctx.shell.run(ctx.shell.resolve({
        command,
        timeoutMs: options.timeoutMs,
        sandboxPolicy: { mode: options.sandboxMode, workspaceRoot },
      }))
      const stdout = result && result.stdout && typeof result.stdout.text === 'string'
        ? result.stdout.text.trim()
        : ''
      if (stdout.indexOf('TOAST_OK') === 0) {
        write('info', 'notified: ' + title + ' — ' + body)
      } else {
        write('error', 'toast failed (exit ' + String(result ? result.exitCode : 'null') + '): '
          + (stdout || '(no output)').slice(0, 300))
      }
    } catch (error) {
      write('error', 'toast error: ' + (error && error.message ? error.message : String(error)))
    }
  }

  /** `basename(cwd) · sessionId8`, so several parallel Sessions stay tellable apart. */
  const describe = (sessionId) => {
    const parts = []
    const meta = sessions.get(sessionId)
    if (meta && meta.cwd) {
      const base = path.basename(meta.cwd)
      if (base) parts.push(base)
    }
    parts.push(sessionId.slice(0, 8))
    return parts.join(' · ')
  }

  const isSubagent = (sessionId) => {
    const meta = sessions.get(sessionId)
    return meta !== undefined && meta.subagent
  }

  ctx.on('api-session/added', (summary) => {
    try {
      const id = String(summary.sessionId)
      sessions.set(id, {
        cwd: typeof summary.cwd === 'string' ? summary.cwd : '',
        subagent: summary.origin === 'subagent' || typeof summary.parentSessionId === 'string',
      })
    } catch (error) {
      write('error', 'session summary read failed: ' + (error && error.message ? error.message : String(error)))
    }
  })

  ctx.on('api-session/removed', (sessionId) => {
    const id = String(sessionId)
    sessions.delete(id)
    startedAt.delete(id)
  })

  ctx.on('api-session/status', (sessionId, running) => {
    const id = String(sessionId)
    if (running === true) {
      startedAt.set(id, Date.now())
      return
    }
    const started = startedAt.get(id)
    startedAt.delete(id)
    if (started === undefined) return
    if (!options.notifyOnComplete) return
    if (options.excludeSubagentSessions && isSubagent(id)) return
    const elapsed = Date.now() - started
    if (elapsed < options.minRunningMs) return
    void notify(options.titleComplete, describe(id) + ' · ' + formatDuration(elapsed))
  })

  ctx.on('api-session/error', (sessionId, message) => {
    if (!options.notifyOnError) return
    const id = String(sessionId)
    if (options.excludeSubagentSessions && isSubagent(id)) return
    const detail = typeof message === 'string' && message.length > 0 ? message.slice(0, 120) : '未提供错误信息'
    void notify(options.titleError, describe(id) + ' — ' + detail)
  })

  write('info', 'ready (complete=' + String(options.notifyOnComplete)
    + ' error=' + String(options.notifyOnError)
    + ' skipSubagents=' + String(options.excludeSubagentSessions)
    + ' minRunningMs=' + String(options.minRunningMs) + ')')
}
