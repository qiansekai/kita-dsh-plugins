<#
.SYNOPSIS
  kita-dsh-restart: restart the dsh web deployment from outside the dsh process.

.DESCRIPTION
  Launched by the on-demand scheduled task registered by the kita-dsh-restart
  dsh plugin. The Task Scheduler service starts this process, so it lives
  outside dsh's process tree and outside the Windows Job Object dsh runs in -
  which is exactly why it survives the kill it is about to perform.

  The stop/start work is deliberately NOT reimplemented here. This script calls
  the deployment's own start.ps1, which already stops whatever occupies the
  port, clears the orphaned credentials lock, starts the new instance with a
  clean log, captures the fresh launch token, and waits for the port to listen.
  One restart procedure, one source of truth.

  Every deployment-specific value (PowerShell path, port, dsh-envs directory,
  log path, node directory) arrives as a parameter from the plugin, which
  derives it from the running process - nothing machine-specific is baked in.

.PARAMETER DelaySeconds
  Wait before touching dsh, so the HTTP response that requested the restart can
  reach the browser first.

.PARAMETER Port
  Web port to restart. 0 = let start.ps1 use the active-env.txt pointer.

.PARAMETER EnvsDir
  Directory holding start.ps1 / active-env.txt. Empty = derived from $DSH_HOME.

.PARAMETER LogPath
  Append-only log file for this restart's narration.

.PARAMETER NodeDir
  Directory holding node.exe, prepended to PATH because the task environment
  does not necessarily carry the directory dsh itself runs from.
#>
param(
  [int]$DelaySeconds = 4,
  [int]$Port = 0,
  [string]$EnvsDir = '',
  [string]$LogPath = '',
  [string]$NodeDir = ''
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [restart-task pid=$PID] $Message" |
      Add-Content -Path $LogPath -Encoding utf8
  } catch {
    # Logging must never be the reason a restart fails.
  }
}

Write-Log "started; delay=${DelaySeconds}s port=$Port envs='$EnvsDir' nodeDir='$NodeDir'"

# Locate the deployment: explicit parameter first, then the home's grandparent.
if ([string]::IsNullOrWhiteSpace($EnvsDir) -and -not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $EnvsDir = Split-Path -Parent (Split-Path -Parent $env:DSH_HOME)
}
$startScript = if ([string]::IsNullOrWhiteSpace($EnvsDir)) { '' } else { Join-Path $EnvsDir 'start.ps1' }
if (-not (Test-Path $startScript)) {
  Write-Log "FATAL: start.ps1 not found at '$startScript'"
  exit 2
}

# dsh's own node directory may be absent from the task environment's PATH.
if (-not [string]::IsNullOrWhiteSpace($NodeDir) -and (Test-Path (Join-Path $NodeDir 'node.exe'))) {
  $env:Path = "$NodeDir;$env:Path"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Log 'WARN: node is still not resolvable; start.ps1 will report it'
}

# Let the HTTP response reach the browser before the process it came from dies.
if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

$pwshExe = (Get-Process -Id $PID).Path
$startArgs = @('-NoProfile', '-File', $startScript)
if ($Port -gt 0) { $startArgs += @('-Port', "$Port") }

Write-Log "invoking: $pwshExe $($startArgs -join ' ')"
& $pwshExe @startArgs *>&1 | ForEach-Object { Write-Log "start.ps1: $_" }
Write-Log "start.ps1 exited with code $LASTEXITCODE"

# Post-restart self-check: answering this plugin's OWN route proves the new
# process loaded the plugin tree with kita-dsh-restart mounted. Without it, a
# silent mount failure would only ever surface as "the button disappeared".
if ($Port -le 0 -and -not [string]::IsNullOrWhiteSpace($EnvsDir)) {
  $pointerPath = Join-Path $EnvsDir 'active-env.txt'
  if (Test-Path $pointerPath) {
    foreach ($line in (Get-Content $pointerPath -ErrorAction SilentlyContinue)) {
      if ($line -match '^\s*port\s*=\s*(\d+)\s*$') { $Port = [int]$Matches[1] }
    }
  }
}
if ($Port -gt 0) {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    try {
      $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/kita-restart/status" -TimeoutSec 5
      Write-Log "self-check OK: bootId=$($status.bootId) phase=$($status.phase) taskReady=$($status.task.ready)"
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
}

exit $LASTEXITCODE
