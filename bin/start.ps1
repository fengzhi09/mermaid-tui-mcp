# Start the gsd mermaid renderer (Windows PowerShell) in HTTP-standalone mode.
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Root       = Split-Path -Parent $ScriptDir
$PidFile    = Join-Path $Root "data\server.pid"
$LogFile    = Join-Path $Root "data\server.log"
$Port       = if ($env:MERMAID_RENDERER_PORT) { $env:MERMAID_RENDERER_PORT } else { 5300 }

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data") | Out-Null

if (Test-Path $PidFile) {
  $existing = Get-Content $PidFile -ErrorAction SilentlyContinue
  if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    Write-Host "[mermaid-renderer] already running (pid $existing) on port $Port"
    exit 0
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $Root "node_modules\mermaid\package.json"))) {
  Write-Host "[mermaid-renderer] installing dependencies (first run, ~80MB)..."
  Push-Location $Root
  try { npm install --no-audit --no-fund --loglevel=error } catch { Pop-Location; throw }
  Pop-Location
}

$env:MERMAID_RENDERER_HTTP = "1"
Push-Location $Root
try {
  $proc = Start-Process -FilePath "node" -ArgumentList "src\server.mjs" `
    -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" `
    -NoNewWindow -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii -NoNewline
} finally { Pop-Location }

$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
    Write-Host "[mermaid-renderer] FAILED — see $LogFile"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
    exit 1
  }
  try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/health" -TimeoutSec 1; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}

if ($ok) {
  Write-Host "[mermaid-renderer] started (pid $($proc.Id)) on http://127.0.0.1:${Port}"
  Write-Host "[mermaid-renderer] log: $LogFile"
  Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/health"
  Write-Host ""
} else {
  Write-Host "[mermaid-renderer] started (pid $($proc.Id)) but /health did not respond within 10s"
  Write-Host "[mermaid-renderer] check $LogFile"
  exit 0
}
