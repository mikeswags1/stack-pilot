$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$receiptDir = Join-Path $PSScriptRoot 'receipts'
$logPath = Join-Path $receiptDir 'local-monitor.log'
$statusPath = Join-Path $receiptDir 'local-monitor-status.json'
$mutex = [Threading.Mutex]::new($false, 'Local\StackPilotStockMonitor')
$hasLock = $false
$startedAt = $null

New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null

try {
  $hasLock = $mutex.WaitOne(0)
  if (-not $hasLock) {
    "$(Get-Date -Format o) SKIP: stock monitor is already running" | Add-Content -Path $logPath
    exit 0
  }

  $startedAt = Get-Date
  "$(Get-Date -Format o) START: scheduled stock monitor" | Add-Content -Path $logPath
  Push-Location $projectRoot
  try {
    & 'C:\Program Files\nodejs\node.exe' 'scripts\local-stock-monitor.mjs' '250' 2>&1 |
      Tee-Object -FilePath $logPath -Append
    $exitCode = $LASTEXITCODE
    # 2026-08-01 owner blanket approval ("end all risky listings, no more from me"):
    # after each evidence pass, purge everything meeting the rulebook standards.
    # The purge script enforces strict ack verification and writes receipts.
    & 'C:\Program Files\nodejs\node.exe' 'scripts\purge-confirmed-oos.mjs' '--apply' 2>&1 |
      Tee-Object -FilePath $logPath -Append
  } finally {
    Pop-Location
  }

  [ordered]@{
    startedAt = $startedAt.ToUniversalTime().ToString('o')
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    exitCode = $exitCode
    succeeded = ($exitCode -eq 0)
    note = 'Evidence refreshed; rulebook purge runs automatically per owner blanket approval (2026-08-01).'
  } | ConvertTo-Json | Set-Content -Path $statusPath
  "$(Get-Date -Format o) FINISH: exit=$exitCode" | Add-Content -Path $logPath
  exit $exitCode
} catch {
  [ordered]@{
    startedAt = if ($startedAt) { $startedAt.ToUniversalTime().ToString('o') } else { $null }
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    exitCode = 1
    succeeded = $false
    error = $_.Exception.Message
  } | ConvertTo-Json | Set-Content -Path $statusPath
  "$(Get-Date -Format o) ERROR: $($_.Exception.Message)" | Add-Content -Path $logPath
  exit 1
} finally {
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
