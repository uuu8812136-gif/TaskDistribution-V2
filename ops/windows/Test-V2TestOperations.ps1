[CmdletBinding()]
param(
  [string]$DestinationRoot = 'D:\ServerBackups\TaskDistribution-V2-Test',
  [string]$PublicHealthUrl = 'https://v2-test.horselink.cn/health',
  [ValidateRange(1, 720)][int]$MaximumBackupAgeHours = 26,
  [ValidateRange(1, 1048576)][int]$MinimumFreeGb = 10,
  [ValidateRange(1, 10)][int]$AlertAfterFailures = 2,
  [string]$WebhookFile = 'C:\ProgramData\LinuxBackup\v2-alert-webhook.txt',
  [string]$StatePath = 'C:\ProgramData\LinuxBackup\v2-operations-health-state.json'
)

$ErrorActionPreference = 'Stop'
$ExpectedInstance = 'task-distribution-v2-customer-test'
$ExpectedDatabase = 'customer_acceptance_v2_test'
$checks = [ordered]@{}

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $PublicHealthUrl -TimeoutSec 15
  $body = $response.Content | ConvertFrom-Json
  $checks.publicHealth = [ordered]@{
    ok = $response.StatusCode -eq 200 -and $body.status -eq 'ok' -and $body.instance -eq $ExpectedInstance
    statusCode = $response.StatusCode
    status = [string]$body.status
    instance = [string]$body.instance
  }
}
catch {
  $checks.publicHealth = [ordered]@{ ok = $false; error = $_.Exception.Message }
}

try {
  $latestDirectory = Get-ChildItem -LiteralPath $DestinationRoot -Directory -Filter 'backup-*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latestDirectory) { throw 'No off-host backup directory exists' }
  $manifestPath = Join-Path $latestDirectory.FullName 'manifest.json'
  $digestPath = Join-Path $latestDirectory.FullName 'manifest.sha256'
  $receiptPath = Join-Path (Join-Path $DestinationRoot 'receipts') "$($latestDirectory.Name).json"
  $actualSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $digest = ([IO.File]::ReadAllText($digestPath)).Trim()
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
  $completedAt = [DateTimeOffset]::Parse([string]$manifest.completedAt)
  $ageHours = ([DateTimeOffset]::Now - $completedAt).TotalHours
  $todaySatisfied = (Get-Date).Hour -lt 4 -or $completedAt.ToLocalTime().Date -eq (Get-Date).Date
  $backupOk = $digest -match '^([a-fA-F0-9]{64})\s+manifest\.json$' -and
    $Matches[1].ToLowerInvariant() -eq $actualSha -and
    $manifest.format -eq 'task-distribution-v2-backup/v1' -and
    $manifest.backupId -eq $latestDirectory.Name -and
    $manifest.database.name -eq $ExpectedDatabase -and
    $receipt.format -eq 'task-distribution-v2-offhost-backup-receipt/v1' -and
    $receipt.instance -eq $ExpectedInstance -and
    $receipt.backupId -eq $latestDirectory.Name -and
    [string]$receipt.manifestSha256 -ceq $actualSha -and
    $ageHours -ge 0 -and $ageHours -le $MaximumBackupAgeHours -and $todaySatisfied
  $checks.offHostBackup = [ordered]@{
    ok = $backupOk
    backupId = $latestDirectory.Name
    completedAt = $completedAt.ToUniversalTime().ToString('o')
    ageHours = [math]::Round($ageHours, 2)
    manifestSha256 = $actualSha
    currentLocalDatePresent = $todaySatisfied
  }
}
catch {
  $checks.offHostBackup = [ordered]@{ ok = $false; error = $_.Exception.Message }
}

try {
  $volume = Get-Volume -DriveLetter D -ErrorAction Stop
  $freeGb = [math]::Round($volume.SizeRemaining / 1GB, 2)
  $checks.disk = [ordered]@{ ok = $freeGb -ge $MinimumFreeGb; freeGb = $freeGb; minimumFreeGb = $MinimumFreeGb }
}
catch {
  $checks.disk = [ordered]@{ ok = $false; error = $_.Exception.Message; minimumFreeGb = $MinimumFreeGb }
}

try {
  $syncInfo = Get-ScheduledTaskInfo -TaskName 'TaskDistribution-V2-Daily-Offhost-Backup' -ErrorAction Stop
  $syncAgeHours = ((Get-Date) - $syncInfo.LastRunTime).TotalHours
  $checks.syncTask = [ordered]@{
    ok = $syncInfo.LastTaskResult -eq 0 -and $syncAgeHours -ge 0 -and $syncAgeHours -le 2
    lastRunTime = $syncInfo.LastRunTime.ToString('o')
    lastTaskResult = $syncInfo.LastTaskResult
    ageHours = [math]::Round($syncAgeHours, 2)
  }
}
catch {
  $checks.syncTask = [ordered]@{ ok = $false; error = $_.Exception.Message }
}

$healthy = @($checks.Values | Where-Object { -not $_.ok }).Count -eq 0
$previous = $null
if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
  try { $previous = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json } catch { $previous = $null }
}
$consecutiveFailures = if ($healthy) { 0 } elseif ($previous) { [int]$previous.consecutiveFailures + 1 } else { 1 }
$alerted = if ($healthy) { $false } elseif ($previous -and $previous.alerted) { $true } else { $false }
$report = [ordered]@{
  format = 'task-distribution-v2-operations-health/v1'
  status = if ($healthy) { 'HEALTHY' } else { 'DEGRADED' }
  checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
  host = $env:COMPUTERNAME
  consecutiveFailures = $consecutiveFailures
  checks = $checks
  alertChannel = if (Test-Path -LiteralPath $WebhookFile -PathType Leaf) { 'WINDOWS_EVENT_LOG_AND_WEBHOOK' } else { 'WINDOWS_EVENT_LOG' }
}

$shouldAlert = -not $healthy -and $consecutiveFailures -ge $AlertAfterFailures -and -not $alerted
$shouldRecover = $healthy -and $previous -and [bool]$previous.alerted
if ($shouldAlert -or $shouldRecover) {
  $source = 'TaskDistribution-V2 Operations'
  if (-not [Diagnostics.EventLog]::SourceExists($source)) { New-EventLog -LogName Application -Source $source }
  $eventMessage = $report | ConvertTo-Json -Depth 8 -Compress
  Write-EventLog -LogName Application -Source $source `
    -EntryType $(if ($shouldAlert) { 'Error' } else { 'Information' }) `
    -EventId $(if ($shouldAlert) { 5201 } else { 5202 }) -Message $eventMessage
  if (Test-Path -LiteralPath $WebhookFile -PathType Leaf) {
    $webhook = ([IO.File]::ReadAllText($WebhookFile)).Trim()
    if (-not $webhook) { throw 'Configured alert webhook file is empty' }
    Invoke-RestMethod -Method Post -Uri $webhook -ContentType 'application/json' `
      -Body ($report | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 15 | Out-Null
  }
  $alerted = $shouldAlert
}
$report.alerted = $alerted

$stateParent = Split-Path -Parent $StatePath
New-Item -ItemType Directory -Force -Path $stateParent | Out-Null
$temporary = "$StatePath.$([guid]::NewGuid().ToString('N')).tmp"
try {
  [IO.File]::WriteAllText($temporary, "$(($report | ConvertTo-Json -Depth 8))`n", (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}
finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
$report | ConvertTo-Json -Depth 8
if (-not $healthy) { exit 2 }
