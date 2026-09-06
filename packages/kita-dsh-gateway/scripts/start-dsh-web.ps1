#Requires -Version 7.0
# =====================================================================
# start-dsh-web.ps1 — dsh web 启动包装（browser-token 认证适配版）
# ---------------------------------------------------------------------
# 背景：dsh 0.1.2 系浏览器认证 = 进程级随机 launch token，启动时打印到
# stdout。kita-dsh-gateway 的登录注入依赖 storages\alpha-web-token.txt；
# 直接裸跑 `dsh web` 时该文件不会更新，token 随进程轮换后，任何经
# gateway 的新访问都会被 dsh 拒绝（401 "dsh web authentication required;
# reopen the URL printed by dsh web"）。
#
# 本包装负责：停旧实例（按端口定位，taskkill /T 顺带回收孤儿 MCP）
#   -> 起新实例（--no-open，输出重定向到日志）
#   -> 捕获 launch token 写 storages\alpha-web-token.txt
#   -> 读取 gateway 配对码（kita-dsh-gateway-tokens.json）
#   -> 默认用默认浏览器打开带 token 的 URL（-NoOpen 改为复制到剪贴板）
#
# 源仓库：AI-Agents/kita-dsh-plugins/packages/kita-dsh-gateway/scripts/
# 用法：
#   pwsh -NoProfile -File <home>\.dsh\start-dsh-web.ps1           # 默认 3080，自动开浏览器
#   pwsh -NoProfile -File <home>\.dsh\start-dsh-web.ps1 -NoOpen   # 不开浏览器，URL 进剪贴板
#   pwsh -NoProfile -File <home>\.dsh\start-dsh-web.ps1 -DryRun   # 只做预检（bin/home/token 路径）
# 注意：gateway 插件的 targetPort 由 profile cordis.patch.yml 配置；
#       传非默认 -Port 时需同步改 profile（或本包装仅用于默认端口）。
# =====================================================================
param(
  [int]$Port = 3080,
  [switch]$NoOpen,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- paths -----------------------------------------------------------------
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$gatewayPort = $Port + 1
$logPath = Join-Path $dshHome "web-$Port-restart.log"
$errPath = Join-Path $dshHome "web-$Port-restart.err.log"
$tokenPath = Join-Path $dshHome 'storages\alpha-web-token.txt'
$urlPath = Join-Path $dshHome "storages\web-$Port.url.txt"
$codePath = Join-Path $dshHome 'storages\kita-dsh-gateway-tokens.json'

# --- helpers ----------------------------------------------------------------
function Resolve-DshBinJs {
  # npm root -g was removed in newer npm; resolve via `where dsh` first
  $cmd = (where.exe dsh 2>$null | Select-Object -First 1)
  if ($cmd) {
    $cand = Join-Path (Split-Path $cmd) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $cand) { return $cand }
  }
  $prefix = (& npm config get prefix 2>$null | Select-Object -First 1)
  if ($prefix) {
    $cand = Join-Path $prefix 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $cand) { return $cand }
  }
  throw 'cannot locate @deepseek-ai/dsh (where dsh / npm prefix failed); install dsh first'
}

function Get-ListenPids([int[]]$Ports) {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in $Ports } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

# --- preflight --------------------------------------------------------------
$binJs = Resolve-DshBinJs
Write-Host "[start-dsh-web] dsh bin : $binJs"
Write-Host "[start-dsh-web] home   : $dshHome"
Write-Host "[start-dsh-web] ports  : $Port (web) / $gatewayPort (gateway)"
Write-Host "[start-dsh-web] token  : $tokenPath"
if ($DryRun) {
  Write-Host '[start-dsh-web] DRY-RUN complete; stop/start skipped'
  exit 0
}

# --- 1. stop old instance(s) ------------------------------------------------
# wait first: when launched from an agent tool call this wrapper sits inside
# the old dsh process tree; let the launcher process exit so the tree kill
# below does not sweep this wrapper along with it
Start-Sleep -Seconds 2
$oldPids = Get-ListenPids @($Port, $gatewayPort)
foreach ($procId in $oldPids) {
  Write-Host "[start-dsh-web] stopping old dsh pid $procId (tree kill)..."
  taskkill /PID $procId /T /F 2>$null | Out-Null
}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-ListenPids @($Port, $gatewayPort)).Count -gt 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
}
if ((Get-ListenPids @($Port, $gatewayPort)).Count -gt 0) {
  throw "ports $Port/$gatewayPort still busy after stopping old instance"
}
Start-Sleep -Milliseconds 400

# --- 2. start new instance with redirected output ----------------------------
Remove-Item $logPath, $errPath -ErrorAction SilentlyContinue
$launchArgs = @($binJs, 'web', '--no-open')
if ($Port -ne 3080) { $launchArgs += @('--port', "$Port") }
$proc = Start-Process -FilePath 'node' -ArgumentList $launchArgs `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath `
  -PassThru -WindowStyle Hidden
$startedAt = Get-Date
Write-Host "[start-dsh-web] new instance pid $($proc.Id); waiting for launch token..."

# --- 3. capture launch token from stdout log ---------------------------------
$tokenRe = 'https?://[^/\s]+:\d+/\?token=([A-Za-z0-9_-]+)'
$tok = $null
for ($i = 0; $i -lt 120; $i++) {
  if ($proc.HasExited) { throw "new dsh exited early (code $($proc.ExitCode)); see $errPath" }
  $content = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
  if ($content) {
    $m = [regex]::Match($content, $tokenRe)
    if ($m.Success) { $tok = $m.Groups[1].Value; break }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $tok) {
  Write-Host "[start-dsh-web] WARNING: launch token not captured within 60s; watch $logPath"
  exit 2
}

# --- 4. persist token for kita-dsh-gateway injection --------------------------
New-Item -ItemType Directory -Force -Path (Split-Path $tokenPath) | Out-Null
Set-Content $tokenPath $tok -Encoding ascii -NoNewline
Write-Host "[start-dsh-web] launch token captured -> $tokenPath"

# --- 5. gateway pairing code (currentCode refreshed by gateway on boot) -------
$code = $null
$codeDeadline = (Get-Date).AddSeconds(30)
while (-not $code -and (Get-Date) -lt $codeDeadline) {
  if (Test-Path $codePath) {
    $stamp = (Get-Item $codePath).LastWriteTime
    if ($stamp -ge $startedAt) {
      try { $code = (Get-Content $codePath -Raw | ConvertFrom-Json).currentCode } catch {}
    }
  }
  if (-not $code) { Start-Sleep -Milliseconds 500 }
}

# --- 6. report ----------------------------------------------------------------
$url = "http://127.0.0.1:$Port/?token=$tok"
Set-Content $urlPath $url -Encoding ascii -NoNewline
if ($NoOpen) {
  try {
    Set-Clipboard -Value $url
    Write-Host "[start-dsh-web] URL copied to clipboard:"
  } catch {
    Write-Host "[start-dsh-web] clipboard unavailable; URL below:"
  }
} else {
  Start-Process $url
  Write-Host "[start-dsh-web] opened in default browser:"
}
Write-Host $url
if ($code) {
  Write-Host "[start-dsh-web] gateway pairing code (10 min valid): $code"
} else {
  Write-Host "[start-dsh-web] pairing code not ready yet; see $logPath"
}
Write-Host "[start-dsh-web] done."
