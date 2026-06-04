# Stop the gsd mermaid renderer (Windows PowerShell).

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Root      = Split-Path -Parent $ScriptDir
$PidFile   = Join-Path $Root "data\server.pid"

if (-not (Test-Path $PidFile)) {
  Write-Host "[mermaid-renderer] not running (no pidfile)"
  exit 0
}

$pid = Get-Content $PidFile -ErrorAction SilentlyContinue
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $pid -Force
  Write-Host "[mermaid-renderer] stopped (pid $pid)"
} else {
  Write-Host "[mermaid-renderer] stale pidfile (pid $pid not alive)"
}
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
