[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$ReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$PreviousReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousCommit,
  [Parameter(Mandatory = $true)][string]$MigrationDryRunReport,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$MigrationDryRunReportSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$StagedEvidenceSha256,
  [Parameter(Mandatory = $true)][string]$OperationsEnvPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$AppEnvSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$OperationsEnvSha256,
  [ValidateSet('Plan', 'Hold', 'Execute')][string]$Mode = 'Plan',
  [string]$RecoveryRoot = 'C:\TaskDistribution-V2\Recovery',
  [string]$ApprovedBackupRoot = 'C:\ServerBackups\TaskDistribution-V2-Test',
  [string]$StoppedHandoffPath = '',
  [string]$StoppedHandoffSha256 = '',
  [string]$HandoffNonce = '',
  [string]$BackupDirectory = '',
  [string]$BackupId = '',
  [string]$BackupManifestSha256 = '',
  [string]$OffhostVerificationReceipt = '',
  [string]$OffhostVerificationReceiptSha256 = '',
  [string]$TrustedPublicKeyPath = '',
  [string]$TrustedPublicKeySha256 = '',
  [string]$ConfirmInstance = '',
  [string]$ConfirmDatabase = '',
  [string]$ConfirmReleaseId = '',
  [string]$ConfirmPreviousReleaseId = '',
  [string]$ConfirmBackupId = '',
  [string]$ConfirmHandoffNonce = '',
  [ValidateRange(330, 3600)][int]$StabilitySeconds = 330,
  [ValidateRange(60, 3600)][int]$WorkerStabilitySeconds = 300
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$expectedInstance = 'task-distribution-v2-customer-test-recovery'
$expectedConfirmationInstance = 'task-distribution-v2-customer-test'
$expectedDatabase = 'customer_acceptance_v2_test'
$expectedSchemaCapability = 'equipment-category-parent-name-index-v1'
$trustedPublicKeyRelativePath = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
$apiTask = 'TaskDistribution-V2-Recovery-API'
$webTask = 'TaskDistribution-V2-Recovery-Web'
$businessTunnelTask = 'TaskDistribution-V2-Recovery-Tunnel'
$managementTunnelTask = 'TaskDistribution-V2-Recovery-Management-Tunnel'
$mongoTask = 'TaskDistribution-V2-Recovery-MongoDB'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
  return $full.TrimEnd('\')
}

function Assert-PathBelow {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rootFull = Get-FullPath $Root
  $candidateFull = Get-FullPath $Candidate
  $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (-not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be below $rootFull"
  }
  return $candidateFull
}

function Assert-NoReparsePointPath {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rootFull = Get-FullPath $TrustedRoot
  $candidateFull = Get-FullPath $Candidate
  $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (
    $candidateFull -ne $rootFull -and
    -not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) { throw "$Label must be at or below trusted root $rootFull" }

  $current = $rootFull
  $components = @()
  if ($candidateFull.Length -gt $rootFull.Length) {
    $components = @($candidateFull.Substring($rootFull.Length).TrimStart('\').Split('\'))
  }
  if (Test-Path -LiteralPath $current) {
    $rootItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label path contains a reparse point: $current"
    }
  }
  foreach ($component in $components) {
    $current = Join-Path $current $component
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "$Label path contains a reparse point: $current"
      }
    }
  }
  return $candidateFull
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "File is missing: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BytesSha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-ObjectSha256 {
  param([Parameter(Mandatory = $true)][object]$Value)
  $json = ConvertTo-Json $Value -Depth 12 -Compress
  return Get-BytesSha256 ((New-Object Text.UTF8Encoding($false)).GetBytes($json))
}

function Write-Utf8NoBomCreateNew {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $Path -Label 'Evidence output'
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Evidence parent is missing: $parent"
  }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
}

function Write-JsonCreateNew {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
  Write-Utf8NoBomCreateNew -Path $Path -Value "$(ConvertTo-Json $Value -Depth 12)`n"
}

function Write-AtomicJson {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $Path -Label 'Atomic JSON output'
  $temporary = "$Path.$PID-$([Guid]::NewGuid().ToString('N')).partial"
  try {
    [IO.File]::WriteAllText(
      $temporary,
      "$(ConvertTo-Json $Value -Depth 12)`n",
      (New-Object Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
  catch { throw "$Label is not valid JSON: $($_.Exception.Message)" }
}

function Assert-ExactJsonProperties {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
  $missing = @($Expected | Where-Object { -not ($actual -ccontains $_) })
  $unexpected = @($actual | Where-Object { -not ($Expected -ccontains $_) })
  if ($missing.Count -ne 0 -or $unexpected.Count -ne 0 -or $actual.Count -ne $Expected.Count) {
    throw "$Label property set mismatch; missing=$($missing -join ','); unexpected=$($unexpected -join ',')"
  }
}

function ConvertFrom-StrictBase64 {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  if (
    -not $Value -or
    $Value.Length % 4 -ne 0 -or
    $Value -cnotmatch '^[A-Za-z0-9+/]+={0,2}$'
  ) { throw "$Label is not canonical Base64" }
  try { $bytes = [Convert]::FromBase64String($Value) }
  catch { throw "$Label is invalid Base64: $($_.Exception.Message)" }
  if ([Convert]::ToBase64String($bytes) -cne $Value) { throw "$Label is not canonical Base64" }
  return $bytes
}

function Read-SignedOffhostVerificationReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][string]$ReceiptSha256,
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$PublicKeyPath,
    [Parameter(Mandatory = $true)][string]$PublicKeySha256
  )
  $ReceiptPath = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot `
    -Candidate $ReceiptPath -Label 'Signed off-host receipt'
  $PublicKeyPath = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot `
    -Candidate $PublicKeyPath -Label 'Trusted receipt public key'
  if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
    throw "Trusted receipt public key is missing: $PublicKeyPath"
  }
  if ($ReceiptSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'OffhostVerificationReceiptSha256 is invalid' }
  if ($PublicKeySha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'TrustedPublicKeySha256 is invalid' }
  $receiptBytes = [IO.File]::ReadAllBytes($ReceiptPath)
  if ((Get-BytesSha256 $receiptBytes) -cne $ReceiptSha256) {
    throw 'Signed off-host receipt SHA256 mismatch'
  }
  $publicKeyBytes = [IO.File]::ReadAllBytes($PublicKeyPath)
  if ((Get-BytesSha256 $publicKeyBytes) -cne $PublicKeySha256) {
    throw 'Trusted receipt public key SHA256 mismatch'
  }

  $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
  try { $envelopeText = $strictUtf8.GetString($receiptBytes) }
  catch { throw "Signed off-host receipt envelope is not valid UTF-8: $($_.Exception.Message)" }
  try { $envelope = $envelopeText | ConvertFrom-Json }
  catch { throw "Signed off-host receipt envelope is not valid JSON: $($_.Exception.Message)" }
  Assert-ExactJsonProperties -Object $envelope -Expected @(
    'format',
    'signatureAlgorithm',
    'publicKeySha256',
    'signedPayloadSha256',
    'signedPayloadUtf8Base64',
    'signatureBase64'
  ) -Label 'Signed off-host receipt envelope'
  if (
    $envelope.format -cne 'task-distribution-v2-windows-stopped-backup-offhost-signed-envelope/v2' -or
    $envelope.signatureAlgorithm -cne 'RSA-SHA256-PKCS1-v1_5' -or
    $envelope.publicKeySha256 -cne $PublicKeySha256 -or
    [string]$envelope.signedPayloadSha256 -cnotmatch '^[0-9a-f]{64}$'
  ) { throw 'Signed off-host receipt envelope identity, algorithm, or public key mismatch' }

  $payloadBytes = ConvertFrom-StrictBase64 ([string]$envelope.signedPayloadUtf8Base64) 'Signed receipt payload'
  $signatureBytes = ConvertFrom-StrictBase64 ([string]$envelope.signatureBase64) 'Signed receipt signature'
  if ((Get-BytesSha256 $payloadBytes) -cne [string]$envelope.signedPayloadSha256) {
    throw 'Signed receipt payload SHA256 mismatch'
  }

  $publicKey = New-Object Security.Cryptography.RSACryptoServiceProvider
  try {
    $publicKey.PersistKeyInCsp = $false
    try { $publicKeyText = $strictUtf8.GetString($publicKeyBytes) }
    catch { throw "Trusted receipt public key is not valid UTF-8: $($_.Exception.Message)" }
    $publicKey.FromXmlString($publicKeyText)
    if (-not $publicKey.PublicOnly -or $publicKey.KeySize -ne 3072) {
      throw 'Trusted receipt public key must be a public-only RSA-3072 key'
    }
    $hashOid = [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
    if (-not $publicKey.VerifyData($payloadBytes, $hashOid, $signatureBytes)) {
      throw 'Signed off-host receipt RSA-SHA256 verification failed'
    }
  }
  finally { $publicKey.Dispose() }

  try { $payloadText = $strictUtf8.GetString($payloadBytes) }
  catch { throw "Signed receipt payload is not valid UTF-8: $($_.Exception.Message)" }
  try { return $payloadText | ConvertFrom-Json }
  catch { throw "Signed receipt payload is not valid JSON: $($_.Exception.Message)" }
}

function Encode-Utf8State {
  param([bool]$Exists, [string]$Value)
  if (-not $Exists) { return $null }
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

function Restore-FileState {
  param([string]$Path, [bool]$Existed, [string]$Value)
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $Path -Label 'Runtime state path'
  if ($Existed) {
    $temporary = "$Path.restore-$PID-$([Guid]::NewGuid().ToString('N')).partial"
    try {
      [IO.File]::WriteAllText($temporary, $Value, (New-Object Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
      if (Test-Path -LiteralPath $temporary -PathType Leaf) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
      }
    }
  }
  elseif (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }
}

function Get-TaskState {
  param([Parameter(Mandatory = $true)][string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  if (@($task.Actions).Count -ne 1) { throw "$TaskName must have exactly one action" }
  return [pscustomobject]@{
    name = $TaskName
    state = [string]$task.State
    enabled = [bool]$task.Settings.Enabled
    execute = [string]$task.Actions[0].Execute
    arguments = [string]$task.Actions[0].Arguments
    workingDirectory = [string]$task.Actions[0].WorkingDirectory
    lastRunTimeUtc = $info.LastRunTime.ToUniversalTime().ToString('o')
    lastTaskResult = [int64]$info.LastTaskResult
  }
}

function Assert-TaskRunning {
  param([Parameter(Mandatory = $true)][string]$TaskName)
  $state = Get-TaskState $TaskName
  if ($state.state -ne 'Running') { throw "$TaskName must be Running, got $($state.state)" }
  return $state
}

function Set-TaskActionState {
  param([Parameter(Mandatory = $true)][object]$State)
  if ($State.workingDirectory) {
    $action = New-ScheduledTaskAction -Execute $State.execute -Argument $State.arguments `
      -WorkingDirectory $State.workingDirectory
  }
  else {
    $action = New-ScheduledTaskAction -Execute $State.execute -Argument $State.arguments
  }
  Set-ScheduledTask -TaskName $State.name -Action $action | Out-Null
  if ($State.enabled) {
    Enable-ScheduledTask -TaskName $State.name -ErrorAction Stop | Out-Null
  }
  else {
    Disable-ScheduledTask -TaskName $State.name -ErrorAction Stop | Out-Null
  }
}

function Set-TaskRunner {
  param([string]$TaskName, [string]$ScriptPath)
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
  Set-ScheduledTask -TaskName $TaskName -Action $action | Out-Null
}

function Wait-TaskNotRunning {
  param([Parameter(Mandatory = $true)][string]$TaskName)
  for ($index = 0; $index -lt 45; $index++) {
    if ((Get-TaskState $TaskName).state -ne 'Running') { return }
    Start-Sleep -Seconds 1
  }
  throw "$TaskName did not stop"
}

function Stop-RecoveryTask {
  param([Parameter(Mandatory = $true)][string]$TaskName, [int]$Port = 0)
  $failures = New-Object 'Collections.Generic.List[string]'
  try { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
  catch { $failures.Add("disable: $($_.Exception.Message)") }
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  catch { $failures.Add("stop: $($_.Exception.Message)") }
  try { Wait-TaskNotRunning $TaskName }
  catch { $failures.Add("wait-not-running: $($_.Exception.Message)") }
  if ($Port -gt 0) {
    try {
      $released = $false
      for ($index = 0; $index -lt 45; $index++) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
          $released = $true
          break
        }
        Start-Sleep -Seconds 1
      }
      if (-not $released) { throw "$TaskName did not release port $Port" }
    }
    catch { $failures.Add("release-port-${Port}: $($_.Exception.Message)") }
  }
  try {
    $held = Get-TaskState $TaskName
    if ($held.enabled -or $held.state -ne 'Disabled') {
      throw "$TaskName was not disabled after it stopped"
    }
  }
  catch { $failures.Add("verify-disabled: $($_.Exception.Message)") }
  if ($failures.Count -ne 0) {
    throw "$TaskName stop/disable failed: $($failures -join '; ')"
  }
}

function Stop-BusinessSurface {
  $failures = New-Object 'Collections.Generic.List[object]'
  $steps = @(
    [pscustomobject]@{ name = $businessTunnelTask; port = 0 },
    [pscustomobject]@{ name = $webTask; port = 18130 },
    [pscustomobject]@{ name = $apiTask; port = 18120 }
  )
  foreach ($step in $steps) {
    try { Stop-RecoveryTask -TaskName $step.name -Port $step.port }
    catch {
      $failures.Add([pscustomobject]@{
        step = "stop-$($step.name)"
        message = $_.Exception.Message
      })
    }
  }

  foreach ($step in $steps) {
    try {
      $held = Get-TaskState $step.name
      if ($held.enabled -ne $false -or $held.state -ne 'Disabled') {
        throw "$($step.name) must be Disabled after the business-surface hold"
      }
      if ($step.name -eq $businessTunnelTask -and $held.state -eq 'Running') {
        throw 'Business tunnel task must not be running after the business-surface hold'
      }
    }
    catch {
      $failures.Add([pscustomobject]@{
        step = "verify-$($step.name)"
        message = $_.Exception.Message
      })
    }
  }
  foreach ($port in @(18120, 18130)) {
    try {
      if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Business listener unexpectedly exists on port $port"
      }
    }
    catch {
      $failures.Add([pscustomobject]@{
        step = "verify-port-$port"
        message = $_.Exception.Message
      })
    }
  }
  if ($failures.Count -ne 0) {
    throw "BUSINESS_SURFACE_HOLD_INCOMPLETE: $(@($failures | ForEach-Object { '{0}: {1}' -f $_.step, $_.message }) -join '; ')"
  }
  return [pscustomobject]@{
    businessSurfaceHeldStopped = $true
    verifiedTasks = @($steps | ForEach-Object { $_.name })
    verifiedAbsentListeners = @(18120, 18130)
  }
}

function Get-Http {
  param([Parameter(Mandatory = $true)][string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $Url `
      -Headers @{ 'Cache-Control' = 'no-cache' }
    return [pscustomobject]@{ url = $Url; status = [int]$response.StatusCode; body = [string]$response.Content }
  }
  catch { return [pscustomobject]@{ url = $Url; status = 0; body = [string]$_.Exception.Message } }
}

function Test-RecoveryHealth {
  param([object]$State)
  if ($null -eq $State -or $State.status -ne 200) { return $false }
  try { $payload = $State.body | ConvertFrom-Json }
  catch { return $false }
  return $payload.status -eq 'ok' -and $payload.instance -eq $expectedInstance
}

function Assert-RecoveryHealth {
  param([object]$State, [string]$Label)
  if (-not (Test-RecoveryHealth $State)) { throw "$Label did not return the expected recovery health JSON" }
}

function Test-LoginTeams {
  param([object]$State)
  if ($null -eq $State -or $State.status -ne 200) { return $false }
  try { $null = $State.body | ConvertFrom-Json }
  catch { return $false }
  return $State.body.Contains('ENGINE_LOGISTICS') -and $State.body.Contains('GEARBOX_LOGISTICS')
}

function Get-ListenerProcess {
  param([Parameter(Mandatory = $true)][int]$Port)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
  if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -ne '127.0.0.1') {
    throw "Port $Port must have exactly one 127.0.0.1 listener"
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)" -ErrorAction Stop
  return [pscustomobject]@{
    port = $Port
    address = [string]$listeners[0].LocalAddress
    pid = [int]$listeners[0].OwningProcess
    commandLine = [string]$process.CommandLine
  }
}

function Assert-ReleaseListener {
  param([int]$Port, [string]$ExpectedReleaseId)
  $process = Get-ListenerProcess $Port
  if (-not $process.commandLine.Contains($ExpectedReleaseId)) {
    throw "Listener on port $Port does not identify $ExpectedReleaseId"
  }
  return $process
}

function Start-HealthTask {
  param([string]$TaskName, [int]$Port, [string]$HealthUrl, [string]$ExpectedReleaseId)
  Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  for ($index = 0; $index -lt 90; $index++) {
    $health = Get-Http $HealthUrl
    if (Test-RecoveryHealth $health) {
      return Assert-ReleaseListener -Port $Port -ExpectedReleaseId $ExpectedReleaseId
    }
    Start-Sleep -Seconds 1
  }
  throw "$TaskName did not become healthy"
}

function Start-BusinessTunnel {
  Enable-ScheduledTask -TaskName $businessTunnelTask -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $businessTunnelTask
  for ($index = 0; $index -lt 90; $index++) {
    $task = Get-TaskState $businessTunnelTask
    if ($task.state -eq 'Running') {
      $health = Get-Http 'https://v2-test.horselink.cn/health'
      if (Test-RecoveryHealth $health) { return $health }
    }
    Start-Sleep -Seconds 1
  }
  throw 'Business tunnel did not restore public V2 health'
}

function Assert-TunnelBoundary {
  $task = Get-TaskState $businessTunnelTask
  if ($task.execute -ne $powershell) { throw 'Business tunnel task does not use Windows PowerShell' }
  $runnerMatch = [regex]::Match($task.arguments, '(?i)-File\s+"([^"]+)"')
  if (-not $runnerMatch.Success) { throw 'Business tunnel task does not expose a quoted runner path' }
  $expectedRunner = Get-FullPath (Join-Path $RecoveryRoot 'ops\run-v2-recovery-tunnel.ps1')
  $actualRunner = Get-FullPath $runnerMatch.Groups[1].Value
  if ($actualRunner -ne $expectedRunner) { throw 'Business tunnel task runner path is not the isolated recovery runner' }
  $runner = [IO.File]::ReadAllText($actualRunner)
  foreach ($required in @(
    "-R '127.0.0.1:38130:127.0.0.1:18130'",
    'StrictHostKeyChecking=yes',
    'ExitOnForwardFailure=yes',
    'BatchMode=yes'
  )) {
    if (-not $runner.Contains($required)) { throw "Business tunnel runner is missing: $required" }
  }
  if ($runner.Contains('38080') -or $runner.Contains('8099')) {
    throw 'Business tunnel runner references a legacy production port'
  }
  return [pscustomobject]@{ task = $task; runner = $actualRunner; runnerSha256 = Get-Sha256 $actualRunner }
}

function Assert-NoRecoveryDatabaseWriters {
  $rootToken = (Get-FullPath $RecoveryRoot).ToLowerInvariant()
  $candidateWriters = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $name = ([string]$_.Name).ToLowerInvariant()
    $command = ([string]$_.CommandLine).ToLowerInvariant()
    $name -in @('node.exe', 'mongosh.exe', 'mongoimport.exe', 'mongorestore.exe') -and
    ($command.Contains($rootToken) -or $command.Contains($expectedDatabase))
  })
  if ($candidateWriters.Count -ne 0) {
    throw "Recovery database writer process remains after stop: $($candidateWriters[0].Name) pid=$($candidateWriters[0].ProcessId)"
  }
}

function Assert-NoBusinessListeners {
  foreach ($port in @(18120, 18130)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
      throw "Business listener unexpectedly exists on 127.0.0.1:$port"
    }
  }
}

function New-HandoffNonce {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) }
  finally { $generator.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Assert-HeldTaskContinuity {
  param([Parameter(Mandatory = $true)][object]$Handoff)
  foreach ($expected in @($Handoff.heldTasks)) {
    $actual = Get-TaskState ([string]$expected.name)
    if (
      $actual.enabled -ne $false -or
      $actual.state -ne 'Disabled' -or
      $actual.execute -ne $expected.execute -or
      $actual.arguments -ne $expected.arguments -or
      $actual.workingDirectory -ne $expected.workingDirectory -or
      $actual.lastRunTimeUtc -ne $expected.lastRunTimeUtc -or
      $actual.lastTaskResult -ne $expected.lastTaskResult
    ) { throw "Held task changed or ran after handoff: $($expected.name)" }
  }
  Assert-NoBusinessListeners
}

function Assert-CandidateManifest {
  param([object]$Staged, [string]$Candidate)
  $reparse = @(Get-ChildItem -LiteralPath $Candidate -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($reparse.Count -ne 0) { throw "Candidate contains a reparse point: $($reparse[0].FullName)" }
  $metadata = Read-JsonFile (Join-Path $Candidate 'deploy\RELEASE.json') 'Candidate release metadata'
  $schemaCapabilities = @($metadata.schemaCapabilities)
  if (
    $metadata.format -ne 'task-distribution-v2-release/v1' -or
    $metadata.releaseId -ne $ReleaseId -or
    $metadata.commit -ne $SourceCommit -or
    $metadata.database -ne $expectedDatabase -or
    [int]$metadata.apiPort -ne 18120 -or
    [int]$metadata.innerWebPort -ne 18130 -or
    [int]$metadata.mongoPort -ne 27150 -or
    $schemaCapabilities.Count -ne 1 -or
    [string]$schemaCapabilities[0] -cne $expectedSchemaCapability -or
    [string]$metadata.trustedOffhostReceiptPublicKeyPath -cne $trustedPublicKeyRelativePath -or
    [string]$metadata.trustedOffhostReceiptPublicKeySha256 -cnotmatch '^[0-9a-f]{64}$'
  ) { throw 'Candidate release metadata identity mismatch' }

  $trustedPublicKey = [IO.Path]::GetFullPath((Join-Path $Candidate `
    ($trustedPublicKeyRelativePath -replace '/', '\')))
  if ((Get-Sha256 $trustedPublicKey) -cne [string]$metadata.trustedOffhostReceiptPublicKeySha256) {
    throw 'Candidate trusted receipt public key differs from release metadata'
  }

  $manifestPath = Join-Path $Candidate 'deploy\FILE-MANIFEST.json'
  if ((Get-Sha256 $manifestPath) -ne ([string]$Staged.fileManifestSha256).ToLowerInvariant()) {
    throw 'Candidate file manifest hash differs from staged evidence'
  }
  $manifest = Read-JsonFile $manifestPath 'Candidate file manifest'
  if (
    $manifest.format -ne 'task-distribution-v2-release-files/v1' -or
    $manifest.releaseId -ne $ReleaseId -or
    $manifest.commit -ne $SourceCommit -or
    $manifest.pathComparison -cne 'windows-ordinal-ignore-case' -or
    $manifest.setSemantics -cne 'exact-package-files-excluding-manifest' -or
    $manifest.selfPath -cne 'deploy/FILE-MANIFEST.json' -or
    [int]$manifest.fileCount -ne @($manifest.files).Count
  ) { throw 'Candidate file manifest contract mismatch' }
  $prefix = (Get-FullPath $Candidate) + '\'
  $declared = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($manifest.files)) {
    $relative = ([string]$entry.file).Replace('\', '/')
    if (
      -not $relative -or
      $relative -cne [string]$entry.file -or
      [IO.Path]::IsPathRooted($relative) -or
      @($relative.Split('/')) -contains '..' -or
      @($relative.Split('/')) -contains '.' -or
      -not $declared.Add($relative)
    ) {
      throw "Invalid candidate manifest path: $relative"
    }
    $path = [IO.Path]::GetFullPath((Join-Path $Candidate ($relative -replace '/', '\')))
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Candidate manifest path escaped its root: $relative"
    }
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    if ($item.PSIsContainer -or [int64]$item.Length -ne [int64]$entry.bytes) {
      throw "Candidate file size mismatch: $relative"
    }
    if ((Get-Sha256 $path) -ne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Candidate file hash mismatch: $relative"
    }
  }
  $actual = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @(Get-ChildItem -LiteralPath $Candidate -Recurse -Force -File)) {
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    $injectedByStaging = (
      $relative.StartsWith('runtime-node/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('app/node_modules/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative -in @(
        'serve-v2-recovery.cjs',
        'run-v2-recovery-api.ps1',
        'run-v2-recovery-web.ps1'
      )
    )
    if ($injectedByStaging -or $relative.Equals(
      'deploy/FILE-MANIFEST.json',
      [StringComparison]::OrdinalIgnoreCase
    )) { continue }
    if (-not $actual.Add($relative)) {
      throw "Duplicate Windows-insensitive candidate file path: $relative"
    }
  }
  $unexpected = @($actual | Where-Object { -not $declared.Contains($_) })
  $missing = @($declared | Where-Object { -not $actual.Contains($_) })
  if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) {
    throw "Candidate exact file set mismatch: unexpected=$($unexpected.Count) missing=$($missing.Count)"
  }
  return [pscustomobject]@{
    metadata = $metadata
    manifest = $manifest
    trustedPublicKeyPath = $trustedPublicKey
    trustedPublicKeySha256 = [string]$metadata.trustedOffhostReceiptPublicKeySha256
  }
}

function Assert-PreviousReleaseTree {
  param([object]$Staged, [string]$Previous)
  $metadataPath = Join-Path $Previous 'deploy\RELEASE.json'
  $manifestPath = Join-Path $Previous 'deploy\FILE-MANIFEST.json'
  if (
    (Get-Sha256 $metadataPath) -cne [string]$Staged.previousRelease.metadataSha256 -or
    (Get-Sha256 $manifestPath) -cne [string]$Staged.previousRelease.manifestSha256
  ) { throw 'Previous release metadata or file manifest differs from staged evidence' }
  $metadata = Read-JsonFile $metadataPath 'Previous release metadata'
  $manifest = Read-JsonFile $manifestPath 'Previous release file manifest'
  $propertyNames = @($manifest.PSObject.Properties | ForEach-Object { [string]$_.Name })
  $isLegacyManifest = (
    $propertyNames.Count -eq 5 -and
    $propertyNames[0] -ceq 'format' -and
    $propertyNames[1] -ceq 'releaseId' -and
    $propertyNames[2] -ceq 'commit' -and
    $propertyNames[3] -ceq 'generatedAt' -and
    $propertyNames[4] -ceq 'files'
  )
  $isCurrentManifest = (
    $propertyNames.Count -eq 9 -and
    $propertyNames[0] -ceq 'format' -and
    $propertyNames[1] -ceq 'releaseId' -and
    $propertyNames[2] -ceq 'commit' -and
    $propertyNames[3] -ceq 'generatedAt' -and
    $propertyNames[4] -ceq 'pathComparison' -and
    $propertyNames[5] -ceq 'setSemantics' -and
    $propertyNames[6] -ceq 'selfPath' -and
    $propertyNames[7] -ceq 'fileCount' -and
    $propertyNames[8] -ceq 'files'
  )
  if (
    (-not $isLegacyManifest -and -not $isCurrentManifest) -or
    $metadata.releaseId -cne $PreviousReleaseId -or
    $metadata.commit -cne $PreviousCommit -or
    $manifest.format -cne 'task-distribution-v2-release-files/v1' -or
    $manifest.releaseId -cne $PreviousReleaseId -or
    $manifest.commit -cne $PreviousCommit -or
    [bool]$Staged.previousRelease.legacyManifestAccepted -ne $isLegacyManifest -or
    @($manifest.files).Count -ne [int]$Staged.previousRelease.manifestFileCount -or
    (
      $isCurrentManifest -and (
        $manifest.pathComparison -cne 'windows-ordinal-ignore-case' -or
        $manifest.setSemantics -cne 'exact-package-files-excluding-manifest' -or
        $manifest.selfPath -cne 'deploy/FILE-MANIFEST.json' -or
        [int]$manifest.fileCount -ne @($manifest.files).Count
      )
    )
  ) { throw 'Previous release manifest identity mismatch' }
  $prefix = (Get-FullPath $Previous) + '\'
  $declared = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($manifest.files)) {
    $relative = ([string]$entry.file).Replace('\', '/')
    if (
      -not $relative -or
      $relative -cne [string]$entry.file -or
      [IO.Path]::IsPathRooted($relative) -or
      @($relative.Split('/')) -contains '..' -or
      @($relative.Split('/')) -contains '.' -or
      -not $declared.Add($relative)
    ) { throw "Invalid previous release manifest path: $relative" }
    $path = [IO.Path]::GetFullPath((Join-Path $Previous ($relative -replace '/', '\')))
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Previous release manifest path escaped root: $relative" }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or [int64]$item.Length -ne [int64]$entry.bytes -or (Get-Sha256 $path) -cne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Previous release file identity mismatch: $relative"
    }
  }
  $actual = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @(Get-ChildItem -LiteralPath $Previous -Recurse -Force -File)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Previous release contains a reparse point: $($item.FullName)" }
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    $injected = $relative.StartsWith('runtime-node/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('app/node_modules/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative -in @('serve-v2-recovery.cjs', 'run-v2-recovery-api.ps1', 'run-v2-recovery-web.ps1')
    if ($injected -or $relative.Equals('deploy/FILE-MANIFEST.json', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not $actual.Add($relative)) { throw "Previous release contains a duplicate file path: $relative" }
  }
  $unexpected = @($actual | Where-Object { -not $declared.Contains($_) })
  $missing = @($declared | Where-Object { -not $actual.Contains($_) })
  if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) {
    throw "Previous release exact file set mismatch: unexpected=$($unexpected.Count) missing=$($missing.Count)"
  }
}

function Get-DirectoryTreeIdentity {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "$Label is missing: $Root" }
  $rootFull = Get-FullPath $Root
  $prefix = "$rootFull\"
  $byRelativePath = @{}
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Recurse -Force)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$Label contains a reparse point: $($item.FullName)"
    }
    if ($item.PSIsContainer) { continue }
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    $key = $relative.ToLowerInvariant()
    if ($byRelativePath.ContainsKey($key)) { throw "$Label contains a duplicate Windows path: $relative" }
    $byRelativePath[$key] = [pscustomobject]@{ Relative = $relative; File = $item }
  }
  if ($byRelativePath.Count -eq 0) { throw "$Label is empty" }
  [string[]]$keys = @($byRelativePath.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  $lines = New-Object Text.StringBuilder
  [int64]$totalBytes = 0
  foreach ($key in $keys) {
    $entry = $byRelativePath[$key]
    $totalBytes += [int64]$entry.File.Length
    [void]$lines.Append($entry.Relative).Append("`t").Append([int64]$entry.File.Length).
      Append("`t").Append((Get-Sha256 $entry.File.FullName)).Append("`n")
  }
  return [pscustomobject][ordered]@{
    fileCount = [int]$byRelativePath.Count
    bytes = $totalBytes
    sha256 = Get-BytesSha256 ((New-Object Text.UTF8Encoding($false)).GetBytes($lines.ToString()))
  }
}

function Assert-InjectedRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][object]$Expected
  )
  Assert-ExactJsonProperties $Expected @(
    'nodeVersion', 'runtimeNodeFileCount', 'runtimeNodeBytes', 'runtimeNodeSha256',
    'appNodeModulesFileCount', 'appNodeModulesBytes', 'appNodeModulesSha256',
    'webProxySha256', 'apiRunnerSha256', 'webRunnerSha256'
  ) 'Staged injected runtime'
  $runtimeRoot = Join-Path $Candidate 'runtime-node'
  $nodePath = Join-Path $runtimeRoot 'node.exe'
  $npmPath = Join-Path $runtimeRoot 'npm.cmd'
  $nodeModulesRoot = Join-Path $Candidate 'app\node_modules'
  $proxyPath = Join-Path $Candidate 'serve-v2-recovery.cjs'
  $apiRunnerPath = Join-Path $Candidate 'run-v2-recovery-api.ps1'
  $webRunnerPath = Join-Path $Candidate 'run-v2-recovery-web.ps1'
  foreach ($path in @(
    $nodePath, $npmPath, (Join-Path $nodeModulesRoot '.package-lock.json'),
    (Join-Path $nodeModulesRoot 'dotenv\package.json'),
    (Join-Path $nodeModulesRoot 'express\package.json'),
    (Join-Path $nodeModulesRoot 'mongoose\package.json'),
    $proxyPath, $apiRunnerPath, $webRunnerPath
  )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Candidate dependency injection is incomplete: $path"
    }
  }
  $nodeVersion = ([string](& $nodePath --version)).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne 'v22.23.1') {
    throw 'Candidate Node version must be v22.23.1'
  }
  & $nodePath --check $proxyPath
  if ($LASTEXITCODE -ne 0) { throw 'Candidate Web proxy syntax check failed' }
  foreach ($runner in @($apiRunnerPath, $webRunnerPath)) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -ne 0) { throw "Candidate runner syntax error: $runner" }
  }
  $runtimeTree = Get-DirectoryTreeIdentity -Root $runtimeRoot -Label 'Candidate Node runtime'
  $nodeModulesTree = Get-DirectoryTreeIdentity -Root $nodeModulesRoot -Label 'Candidate app dependencies'
  $actual = [pscustomobject][ordered]@{
    nodeVersion = $nodeVersion
    runtimeNodeFileCount = [int]$runtimeTree.fileCount
    runtimeNodeBytes = [int64]$runtimeTree.bytes
    runtimeNodeSha256 = [string]$runtimeTree.sha256
    appNodeModulesFileCount = [int]$nodeModulesTree.fileCount
    appNodeModulesBytes = [int64]$nodeModulesTree.bytes
    appNodeModulesSha256 = [string]$nodeModulesTree.sha256
    webProxySha256 = Get-Sha256 $proxyPath
    apiRunnerSha256 = Get-Sha256 $apiRunnerPath
    webRunnerSha256 = Get-Sha256 $webRunnerPath
  }
  if (
    (ConvertTo-Json $actual -Depth 12 -Compress) -cne
    (ConvertTo-Json $Expected -Depth 12 -Compress)
  ) { throw 'Candidate injected runtime differs from staged evidence' }
  return $actual
}

function Assert-IndexBeforeState {
  param([object]$State, [string]$Label)
  if (
    $null -eq $State -or
    $State.indexes.desiredPresent -ne $false -or
    @($State.indexes.legacy).Count -ne 1 -or
    [string]$State.indexes.legacy[0].name -ne 'uq_equipment_category_team_name' -or
    @($State.indexes.unknownTeamWideUnique).Count -ne 0 -or
    @($State.blockers).Count -ne 0
  ) { throw "$Label does not prove the exact pre-migration index state" }
}

function Assert-IndexAfterState {
  param([object]$State, [string]$Label)
  if (
    $null -eq $State -or
    $State.indexes.desiredPresent -ne $true -or
    @($State.indexes.legacy).Count -ne 0 -or
    @($State.indexes.unknownTeamWideUnique).Count -ne 0 -or
    @($State.blockers).Count -ne 0
  ) { throw "$Label does not prove the exact post-migration index state" }
}

function Assert-DryRunReady {
  param([object]$Report, [string]$Label)
  if (
    $Report.format -ne 'equipment-category-parent-name-index-migration/v1' -or
    $Report.status -ne 'DRY_RUN_READY' -or
    $Report.mode -ne 'dry-run' -or
    $Report.database.name -ne $expectedDatabase -or
    $Report.writePerformed -ne $false
  ) { throw "$Label identity or status mismatch" }
  Assert-IndexBeforeState $Report.before $Label
}

function Assert-ExecuteCompleted {
  param([object]$Report, [string]$Label)
  if (
    $Report.format -ne 'equipment-category-parent-name-index-migration/v1' -or
    $Report.status -ne 'EXECUTED' -or
    $Report.mode -ne 'execute' -or
    $Report.database.name -ne $expectedDatabase -or
    $Report.writePerformed -ne $true -or
    $Report.backup.backupId -ne $BackupId -or
    $Report.backup.manifestSha256 -ne $BackupManifestSha256
  ) { throw "$Label identity or status mismatch" }
  Assert-IndexBeforeState $Report.before $Label
  Assert-IndexAfterState $Report.after $Label
}

function Assert-IdempotencyCompleted {
  param([object]$Report, [string]$Label)
  if (
    $Report.format -ne 'equipment-category-parent-name-index-migration/v1' -or
    $Report.status -ne 'ALREADY_APPLIED' -or
    $Report.mode -ne 'execute' -or
    $Report.database.name -ne $expectedDatabase -or
    $Report.writePerformed -ne $false -or
    $Report.backup.backupId -ne $BackupId -or
    $Report.backup.manifestSha256 -ne $BackupManifestSha256
  ) { throw "$Label identity or status mismatch" }
  Assert-IndexAfterState $Report.before $Label
  Assert-IndexAfterState $Report.after $Label
}

function Invoke-MigrationCli {
  param([ValidateSet('dry-run', 'execute')][string]$Mode, [string]$ReportPath)
  Assert-RuntimeInputsUnchanged
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $ReportPath -Label 'Migration report path'
  if (Test-Path -LiteralPath $ReportPath) { throw "Migration report path already exists: $ReportPath" }
  $node = Join-Path $candidate 'runtime-node\node.exe'
  $cli = Join-Path $candidate 'app\script\migrateEquipmentCategoryIndex.js'
  $appEnvPath = Join-Path $RecoveryRoot 'config\app.env'
  foreach ($path in @($node, $cli, $appEnvPath, $ReportPath)) {
    $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
      -Candidate $path -Label 'Migration execution path'
  }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Candidate Node runtime is missing' }
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Candidate equipment category migration CLI is missing' }
  $previousEnvFile = $env:ENV_FILE
  $hadEnvFile = Test-Path Env:ENV_FILE
  try {
    $env:ENV_FILE = $appEnvPath
    if ($Mode -eq 'execute') {
      $output = @(& $node $cli --execute --confirm-database $expectedDatabase `
        --backup-directory $BackupDirectory --report $ReportPath 2>&1)
    }
    else {
      $output = @(& $node $cli --dry-run --report $ReportPath 2>&1)
    }
    if ($LASTEXITCODE -ne 0) {
      throw "Migration CLI $Mode failed: $($output -join ' ')"
    }
  }
  finally {
    if ($hadEnvFile) { $env:ENV_FILE = $previousEnvFile }
    else { Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue }
  }
  return Read-JsonFile $ReportPath "Migration $Mode report"
}

function Invoke-MongoAnchorCli {
  param(
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [string]$CompareTo = ''
  )
  Assert-RuntimeInputsUnchanged
  $node = Join-Path $candidate 'runtime-node\node.exe'
  $cli = Join-Path $candidate 'app\script\captureReleaseMongoAnchor.js'
  foreach ($path in @($node, $cli, $appEnvPath, $ReportPath)) {
    $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
      -Candidate $path -Label 'Mongo write-anchor execution path'
  }
  if (Test-Path -LiteralPath $ReportPath) {
    throw "Mongo write-anchor report path already exists: $ReportPath"
  }
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Candidate Node runtime is missing' }
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Candidate Mongo write-anchor CLI is missing' }
  $arguments = @(
    $cli,
    '--release-id', $ReleaseId,
    '--handoff-nonce', $HandoffNonce,
    '--confirm-database', $expectedDatabase,
    '--report', $ReportPath
  )
  if ($CompareTo) {
    $CompareTo = Assert-PathBelow $evidence $CompareTo 'Mongo write-anchor comparison report'
    $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
      -Candidate $CompareTo -Label 'Mongo write-anchor comparison report'
    $arguments += @('--compare-to', $CompareTo)
  }
  $previousEnvFile = $env:ENV_FILE
  $hadEnvFile = Test-Path Env:ENV_FILE
  try {
    $env:ENV_FILE = $appEnvPath
    $output = @(& $node @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
      throw "Mongo write-anchor CLI failed: $($output -join ' ')"
    }
  }
  finally {
    if ($hadEnvFile) { $env:ENV_FILE = $previousEnvFile }
    else { Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue }
  }
  $report = Read-JsonFile $ReportPath 'Mongo write-anchor report'
  Assert-MongoAnchorReport -Report $report -Label 'Mongo write-anchor report'
  return $report
}

function Assert-MongoAnchorReport {
  param(
    [Parameter(Mandatory = $true)][object]$Report,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (
    $Report.format -ne 'task-distribution-v2-replica-write-anchor/v2' -or
    $Report.status -ne 'REPLICA_WRITE_ANCHOR_CAPTURED' -or
    $Report.releaseId -ne $ReleaseId -or
    $Report.handoffNonce -ne $HandoffNonce -or
    [string]$Report.writeAnchorSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $Report.anchor.database -ne $expectedDatabase -or
    $Report.anchor.replicaSet -ne 'customer_acceptance_v2_rs'
  ) { throw "$Label identity mismatch" }
}

function Invoke-BackupVerification {
  $node = Join-Path $candidate 'runtime-node\node.exe'
  $backupCore = Join-Path $candidate 'ops\lib\backupCore.js'
  foreach ($path in @($node, $backupCore)) {
    $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
      -Candidate $path -Label 'Backup verification tool'
  }
  $null = Assert-NoReparsePointPath -TrustedRoot $ApprovedBackupRoot `
    -Candidate $BackupDirectory -Label 'Backup verification directory'
  $program = @'
const { verifyBackupSet } = require(process.argv[1]);
verifyBackupSet(process.argv[2], { verifyFiles: true }).then((result) => {
  process.stdout.write(JSON.stringify({
    backupDirectory: result.backupDirectory,
    backupId: result.manifest.backupId,
    database: result.manifest.database && result.manifest.database.name,
    manifestSha256: result.manifestSha256,
    createdAt: result.manifest.createdAt,
    completedAt: result.manifest.completedAt,
    captureMode: result.manifest.consistency && result.manifest.consistency.captureMode,
    databaseAndUploadsAtomic: result.manifest.consistency && result.manifest.consistency.databaseAndUploadsAtomic,
    collectionNames: (result.manifest.database && result.manifest.database.collections || []).map((x) => x.name),
    fileNames: (result.manifest.files || []).map((x) => x.file)
  }));
}).catch((error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
'@
  $output = @(& $node -e $program $backupCore $BackupDirectory 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Full backup verification failed: $($output -join ' ')" }
  try { $verified = ($output -join "`n") | ConvertFrom-Json }
  catch { throw "Backup verification output is invalid JSON: $($_.Exception.Message)" }
  $expectedDump = "database/$expectedDatabase/equipmentcategories.bson"
  if (
    $verified.backupId -ne $BackupId -or
    $verified.database -ne $expectedDatabase -or
    $verified.manifestSha256 -ne $BackupManifestSha256 -or
    -not (@($verified.collectionNames) -contains 'equipmentcategories') -or
    -not (@($verified.fileNames) -contains $expectedDump)
  ) { throw 'Verified backup identity or equipment category dump mismatch' }
  return $verified
}

function Assert-OffhostVerificationReceipt {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][object]$Handoff,
    [Parameter(Mandatory = $true)][object]$VerifiedBackup
  )
  Assert-ExactJsonProperties -Object $Receipt -Expected @(
    'format', 'status', 'verifiedAt', 'releaseId', 'sourceCommit',
    'previousReleaseId', 'previousCommit', 'database', 'databaseTarget',
    'backupId', 'manifestSha256', 'manifestCreatedAt', 'manifestCompletedAt',
    'stoppedHandoffSha256', 'handoffNonce', 'sourceHost', 'independentHost',
    'independentCopyRoot', 'independentWorkstationVerified', 'archiveFileName',
    'archivePath', 'archiveSha256', 'archiveBytes', 'extractedBackupPath',
    'checks', 'consistency', 'verification'
  ) -Label 'Signed off-host receipt payload'
  Assert-ExactJsonProperties -Object $Receipt.databaseTarget `
    -Expected @('hosts', 'servers', 'replicaSet') -Label 'Signed receipt databaseTarget'
  Assert-ExactJsonProperties -Object $Receipt.checks -Expected @(
    'archiveSha256MatchesSource', 'archiveBytesMatchSource', 'manifestSha256Valid',
    'exactFileSetValid', 'everyDeclaredFileSha256Valid', 'requiredCollectionDumpsPresent',
    'requiredMetadataPresent', 'uploadsManifestVerified', 'fileAssetReferencesVerified'
  ) -Label 'Signed receipt checks'
  Assert-ExactJsonProperties -Object $Receipt.consistency `
    -Expected @('captureMode', 'databaseAndUploadsAtomic') -Label 'Signed receipt consistency'
  Assert-ExactJsonProperties -Object $Receipt.verification -Expected @(
    'nodeVersion', 'nodeSha256', 'backupCoreSha256', 'receiptGeneratorSha256',
    'trustedPublicKeySha256', 'zipEntryCount', 'declaredFileCount', 'uploadFileCount',
    'fileAssetReferences'
  ) -Label 'Signed receipt verification'
  Assert-ExactJsonProperties -Object $Receipt.verification.fileAssetReferences `
    -Expected @('referenced', 'verified') -Label 'Signed receipt FileAsset references'

  $receiptNodePath = Join-Path $candidate 'runtime-node\node.exe'
  $receiptBackupCorePath = Join-Path $candidate 'ops\lib\backupCore.js'
  $receiptGeneratorPath = Join-Path $candidate 'ops\windows\New-V2RecoveryStoppedBackupOffhostReceipt.ps1'
  foreach ($path in @($receiptNodePath, $receiptBackupCorePath, $receiptGeneratorPath)) {
    $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
      -Candidate $path -Label 'Signed receipt verification tool'
  }

  if (
    $Receipt.format -ne 'task-distribution-v2-windows-stopped-backup-offhost-verification/v1' -or
    $Receipt.status -ne 'STOPPED_BACKUP_OFFHOST_VERIFIED' -or
    $Receipt.releaseId -ne $ReleaseId -or
    $Receipt.sourceCommit -ne $SourceCommit -or
    $Receipt.previousReleaseId -ne $PreviousReleaseId -or
    $Receipt.previousCommit -ne $PreviousCommit -or
    $Receipt.database -ne $expectedDatabase -or
    @($Receipt.databaseTarget.hosts).Count -ne 1 -or
    $Receipt.databaseTarget.hosts[0] -ne '127.0.0.1' -or
    @($Receipt.databaseTarget.servers).Count -ne 1 -or
    $Receipt.databaseTarget.servers[0] -ne '127.0.0.1:27150' -or
    $Receipt.databaseTarget.replicaSet -ne 'customer_acceptance_v2_rs' -or
    $Receipt.backupId -ne $BackupId -or
    $Receipt.manifestSha256 -ne $BackupManifestSha256 -or
    $Receipt.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
    $Receipt.handoffNonce -ne $HandoffNonce -or
    $Receipt.sourceHost -ne $Handoff.sourceHost -or
    $Receipt.sourceHost -ne $env:COMPUTERNAME -or
    $Receipt.manifestCreatedAt -ne $VerifiedBackup.createdAt -or
    $Receipt.manifestCompletedAt -ne $VerifiedBackup.completedAt -or
    $Receipt.independentWorkstationVerified -ne $true -or
    $Receipt.archiveFileName -ne "$BackupId.zip" -or
    [string]$Receipt.archiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    [int64]$Receipt.archiveBytes -le 0 -or
    -not ([string]$Receipt.independentCopyRoot).StartsWith('E:\', [StringComparison]::OrdinalIgnoreCase) -or
    $Receipt.checks.archiveSha256MatchesSource -ne $true -or
    $Receipt.checks.archiveBytesMatchSource -ne $true -or
    $Receipt.checks.manifestSha256Valid -ne $true -or
    $Receipt.checks.exactFileSetValid -ne $true -or
    $Receipt.checks.everyDeclaredFileSha256Valid -ne $true -or
    $Receipt.checks.requiredCollectionDumpsPresent -ne $true -or
    $Receipt.checks.requiredMetadataPresent -ne $true -or
    $Receipt.checks.uploadsManifestVerified -ne $true -or
    $Receipt.checks.fileAssetReferencesVerified -ne $true -or
    $Receipt.consistency.captureMode -ne 'BEST_EFFORT_ONLINE_MONGODUMP' -or
    $Receipt.consistency.databaseAndUploadsAtomic -ne $false -or
    $Receipt.verification.nodeVersion -ne 'v22.23.1' -or
    $Receipt.verification.nodeSha256 -ne (Get-Sha256 $receiptNodePath) -or
    $Receipt.verification.backupCoreSha256 -ne (Get-Sha256 $receiptBackupCorePath) -or
    $Receipt.verification.receiptGeneratorSha256 -ne (Get-Sha256 $receiptGeneratorPath) -or
    $Receipt.verification.trustedPublicKeySha256 -cne $TrustedPublicKeySha256 -or
    [int64]$Receipt.verification.zipEntryCount -lt 2 -or
    [int64]$Receipt.verification.declaredFileCount -lt 2 -or
    [int64]$Receipt.verification.uploadFileCount -lt 0 -or
    [int64]$Receipt.verification.declaredFileCount -lt `
      ([int64]$Receipt.verification.uploadFileCount + 2) -or
    [int64]$Receipt.verification.zipEntryCount -lt `
      ([int64]$Receipt.verification.declaredFileCount + 2) -or
    [int64]$Receipt.verification.fileAssetReferences.referenced -lt 0 -or
    [int64]$Receipt.verification.fileAssetReferences.referenced -ne `
      [int64]$Receipt.verification.fileAssetReferences.verified
  ) { throw 'Off-host stopped-backup verification receipt identity or checks mismatch' }

  $independentCopyRoot = Get-FullPath ([string]$Receipt.independentCopyRoot)
  if ([IO.Path]::GetPathRoot($independentCopyRoot).TrimEnd('\') -ne 'E:') {
    throw 'Off-host receipt independentCopyRoot must be on E:'
  }
  $archivePath = Assert-PathBelow $independentCopyRoot ([string]$Receipt.archivePath) 'Signed receipt archivePath'
  $extractedBackupPath = Assert-PathBelow $independentCopyRoot `
    ([string]$Receipt.extractedBackupPath) 'Signed receipt extractedBackupPath'
  if (
    [IO.Path]::GetFileName($archivePath) -ne "$BackupId.zip" -or
    [IO.Path]::GetFileName($extractedBackupPath) -ne $BackupId
  ) { throw 'Off-host receipt archive or extracted backup path identity mismatch' }
  $verifiedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Receipt.verifiedAt, [ref]$verifiedAt)) {
    throw 'Off-host stopped-backup verification receipt verifiedAt is invalid'
  }
  $completedAt = [DateTimeOffset]::Parse([string]$VerifiedBackup.completedAt)
  if ($verifiedAt -lt $completedAt) {
    throw 'Off-host verification predates backup completion'
  }
  if (
    -not ([string]$Receipt.independentHost).Trim() -or
    ([string]$Receipt.independentHost).Equals([string]$Receipt.sourceHost, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'Off-host verification receipt does not identify an independent workstation'
  }
}

function Read-LogSuffix {
  param([string]$Path, [int64]$Offset)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    if ($Offset -lt 0 -or $Offset -gt $stream.Length) { return '' }
    [void]$stream.Seek($Offset, [IO.SeekOrigin]::Begin)
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose() }
  }
  finally { $stream.Dispose() }
}

$RecoveryRoot = Get-FullPath $RecoveryRoot
$expectedRecoveryRoot = Get-FullPath 'C:\TaskDistribution-V2\Recovery'
if ($RecoveryRoot -ne $expectedRecoveryRoot) {
  throw "RecoveryRoot must exactly equal $expectedRecoveryRoot for this Windows recovery topology"
}
$recoveryDriveRoot = [IO.Path]::GetPathRoot($RecoveryRoot)
$null = Assert-NoReparsePointPath -TrustedRoot $recoveryDriveRoot `
  -Candidate $RecoveryRoot -Label 'RecoveryRoot'
$ApprovedBackupRoot = Get-FullPath $ApprovedBackupRoot
$approvedBackupDriveRoot = [IO.Path]::GetPathRoot($ApprovedBackupRoot)
$null = Assert-NoReparsePointPath -TrustedRoot $approvedBackupDriveRoot `
  -Candidate $ApprovedBackupRoot -Label 'ApprovedBackupRoot'
$candidate = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'releases') $ReleaseId) 'Candidate release'
$previous = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'releases') $PreviousReleaseId) 'Previous release'
$evidence = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'evidence') "release-$ReleaseId") 'Evidence directory'
$MigrationDryRunReport = Assert-PathBelow $evidence $MigrationDryRunReport 'MigrationDryRunReport'
$activeMarker = Join-Path $RecoveryRoot 'active-release.json'
$stableApiRunner = Join-Path $RecoveryRoot 'ops\run-active-release-api.ps1'
$stableWebRunner = Join-Path $RecoveryRoot 'ops\run-active-release-web.ps1'
$stagedPath = Join-Path $evidence 'staged.json'
$rollbackStatePath = Join-Path $evidence 'migration-rollback-state.json'
$stoppedHandoffEvidencePath = Join-Path $evidence 'equipment-category-index-stopped-handoff.json'
$backupVerificationPath = Join-Path $evidence 'backup-verification-before-index-migration.json'
$stoppedDryRunPath = Join-Path $evidence 'equipment-category-index-stopped-dry-run.json'
$executeDryRunPath = Join-Path $evidence 'equipment-category-index-execute-dry-run.json'
$executeClaimPath = Join-Path $evidence 'equipment-category-index-execute-claim.json'
$migrationStartedPath = Join-Path $evidence 'migration-started.json'
$executeReportPath = Join-Path $evidence 'equipment-category-index-execute.json'
$idempotencyReportPath = Join-Path $evidence 'equipment-category-index-idempotency.json'
$migrationCompletedPath = Join-Path $evidence 'migration-completed.json'
$activeEvidencePath = Join-Path $evidence 'active.json'
$activationCommitPath = Join-Path $evidence 'activation-commit.json'
$failureEvidencePath = Join-Path $evidence 'migration-or-activation-failed.json'
$holdMongoAnchorPath = Join-Path $evidence 'mongo-write-anchor-hold.json'
$executeMongoAnchorPath = Join-Path $evidence 'mongo-write-anchor-execute.json'
$appEnvPath = Join-Path $RecoveryRoot 'config\app.env'
$OperationsEnvPath = Get-FullPath $OperationsEnvPath
$operationsEnvDriveRoot = [IO.Path]::GetPathRoot($OperationsEnvPath)
if ($operationsEnvDriveRoot -cnotmatch '^[A-Za-z]:\\$') {
  throw 'OperationsEnvPath must be a local Windows drive path'
}
$null = Assert-NoReparsePointPath -TrustedRoot $operationsEnvDriveRoot `
  -Candidate $OperationsEnvPath -Label 'Operations environment file'
$null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
  -Candidate $appEnvPath -Label 'Application environment file'
if ((Get-Sha256 $appEnvPath) -cne $AppEnvSha256) {
  throw 'Application environment file SHA256 mismatch'
}
if ((Get-Sha256 $OperationsEnvPath) -cne $OperationsEnvSha256) {
  throw 'Operations environment file SHA256 mismatch'
}

foreach ($directory in @($candidate, $previous, $evidence)) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Required directory is missing: $directory" }
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $directory -Label 'Required directory'
  $nestedReparse = @(Get-ChildItem -LiteralPath $directory -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($nestedReparse.Count -ne 0) {
    throw "Required directory tree contains a reparse point: $($nestedReparse[0].FullName)"
  }
}
foreach ($path in @(
  $MigrationDryRunReport,
  $activeMarker,
  $stableApiRunner,
  $stableWebRunner,
  $stagedPath,
  $rollbackStatePath,
  $stoppedHandoffEvidencePath,
  $backupVerificationPath,
  $stoppedDryRunPath,
  $executeDryRunPath,
  $executeClaimPath,
  $migrationStartedPath,
  $executeReportPath,
  $idempotencyReportPath,
  $migrationCompletedPath,
  $activeEvidencePath,
  $activationCommitPath,
  $failureEvidencePath,
  $holdMongoAnchorPath,
  $executeMongoAnchorPath
)) {
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $path -Label 'Release path'
}
if ((Get-Sha256 $stagedPath) -ne $StagedEvidenceSha256) { throw 'Staged evidence SHA256 mismatch' }
if ((Get-Sha256 $MigrationDryRunReport) -ne $MigrationDryRunReportSha256) {
  throw 'Migration dry-run report SHA256 mismatch'
}

$staged = Read-JsonFile $stagedPath 'Staged evidence'
if (
  $staged.status -ne 'WINDOWS_RECOVERY_CANDIDATE_STAGED' -or
  $staged.releaseId -ne $ReleaseId -or
  $staged.sourceCommit -ne $SourceCommit -or
  $staged.previousReleaseId -ne $PreviousReleaseId -or
  $staged.previousCommit -ne $PreviousCommit
) { throw 'Staged evidence release identity mismatch' }
if (
  [string]$staged.predeployBackup.backupId -cnotmatch '^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$' -or
  [string]$staged.predeployBackup.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
  $staged.predeployBackup.independentWorkstationVerified -ne $true -or
  $staged.predeployBackup.databaseAndUploadsAtomic -ne $false
) { throw 'Staged evidence predeploy backup identity or limitation mismatch' }
$candidateIdentity = Assert-CandidateManifest -Staged $staged -Candidate $candidate
$null = Assert-PreviousReleaseTree -Staged $staged -Previous $previous
$injectedRuntime = Assert-InjectedRuntime -Candidate $candidate -Expected $staged.injectedRuntime
$mongoTargetGuardPath = Join-Path $candidate 'ops\lib\v2TestMongoTargetGuard.js'
$mongoTargetGuardSha256 = Get-Sha256 $mongoTargetGuardPath
$runtimeInputs = [ordered]@{
  appEnvPath = $appEnvPath
  appEnvSha256 = $AppEnvSha256
  operationsEnvPath = $OperationsEnvPath
  operationsEnvSha256 = $OperationsEnvSha256
  mongoTargetGuardPath = 'ops/lib/v2TestMongoTargetGuard.js'
  mongoTargetGuardSha256 = $mongoTargetGuardSha256
  trustedPublicKeyPath = $trustedPublicKeyRelativePath
  trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
  schemaCapabilities = @($expectedSchemaCapability)
}
$runtimeInputsSha256 = Get-ObjectSha256 $runtimeInputs

function Assert-RuntimeInputsUnchanged {
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
    -Candidate $appEnvPath -Label 'Application environment file'
  $null = Assert-NoReparsePointPath -TrustedRoot $operationsEnvDriveRoot `
    -Candidate $OperationsEnvPath -Label 'Operations environment file'
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
    -Candidate $mongoTargetGuardPath -Label 'Mongo target guard'
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
    -Candidate ([string]$candidateIdentity.trustedPublicKeyPath) `
    -Label 'Candidate trusted receipt public key'
  if ((Get-Sha256 $appEnvPath) -cne $AppEnvSha256) {
    throw 'Application environment file changed after runtime inputs were sealed'
  }
  if ((Get-Sha256 $OperationsEnvPath) -cne $OperationsEnvSha256) {
    throw 'Operations environment file changed after runtime inputs were sealed'
  }
  if ((Get-Sha256 $mongoTargetGuardPath) -cne $mongoTargetGuardSha256) {
    throw 'Mongo target guard changed after runtime inputs were sealed'
  }
  if ((Get-Sha256 ([string]$candidateIdentity.trustedPublicKeyPath)) -cne `
    [string]$candidateIdentity.trustedPublicKeySha256) {
    throw 'Candidate trusted receipt public key changed after runtime inputs were sealed'
  }
  if ((Get-ObjectSha256 $runtimeInputs) -cne $runtimeInputsSha256) {
    throw 'Runtime input object changed after it was sealed'
  }
  $null = Assert-InjectedRuntime -Candidate $candidate -Expected $staged.injectedRuntime
  $null = Assert-PreviousReleaseTree -Staged $staged -Previous $previous
}
Assert-ExactJsonProperties $staged.runtimeInputs @(
  'appEnvPath', 'appEnvSha256', 'operationsEnvPath', 'operationsEnvSha256',
  'mongoTargetGuardPath', 'mongoTargetGuardSha256', 'trustedPublicKeyPath',
  'trustedPublicKeySha256', 'schemaCapabilities'
) 'Staged runtime inputs'
if (
  $staged.runtimeInputs.appEnvPath -cne $runtimeInputs.appEnvPath -or
  $staged.runtimeInputs.appEnvSha256 -cne $runtimeInputs.appEnvSha256 -or
  $staged.runtimeInputs.operationsEnvPath -cne $runtimeInputs.operationsEnvPath -or
  $staged.runtimeInputs.operationsEnvSha256 -cne $runtimeInputs.operationsEnvSha256 -or
  $staged.runtimeInputs.mongoTargetGuardPath -cne $runtimeInputs.mongoTargetGuardPath -or
  $staged.runtimeInputs.mongoTargetGuardSha256 -cne $runtimeInputs.mongoTargetGuardSha256 -or
  $staged.runtimeInputs.trustedPublicKeyPath -cne $runtimeInputs.trustedPublicKeyPath -or
  $staged.runtimeInputs.trustedPublicKeySha256 -cne $runtimeInputs.trustedPublicKeySha256 -or
  @($staged.runtimeInputs.schemaCapabilities).Count -ne 1 -or
  [string]$staged.runtimeInputs.schemaCapabilities[0] -cne $expectedSchemaCapability -or
  [string]$staged.runtimeInputsSha256 -cne $runtimeInputsSha256
) { throw 'Staged runtime input identity mismatch' }
$approvedDryRun = Read-JsonFile $MigrationDryRunReport 'Approved migration dry-run report'
Assert-DryRunReady $approvedDryRun 'Approved migration dry-run report'
$tunnelBoundary = Assert-TunnelBoundary

$plan = [ordered]@{
  format = 'task-distribution-v2-windows-equipment-category-index-release-plan/v2'
  status = 'TWO_PHASE_PLAN_READY'
  mode = $Mode
  action = 'hold-then-backup-offhost-verify-then-migrate-and-activate'
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  previousReleaseId = $PreviousReleaseId
  previousCommit = $PreviousCommit
  database = $expectedDatabase
  stagedPredeployBackupId = [string]$staged.predeployBackup.backupId
  executeBackupMustDifferFromStaged = $true
  executeBackupMustStartAndCompleteAfterStoppedAt = $true
  offhostPerFileVerificationRequired = $true
  offhostReceiptSignatureRequired = $true
  offhostReceiptSignatureAlgorithm = 'RSA-SHA256-PKCS1-v1_5'
  stagedEvidenceSha256 = $StagedEvidenceSha256
  migrationDryRunReportSha256 = $MigrationDryRunReportSha256
  runtimeInputs = $runtimeInputs
  runtimeInputsSha256 = $runtimeInputsSha256
  stopOrder = @($businessTunnelTask, $webTask, $apiTask)
  preservedTasks = @($managementTunnelTask, $mongoTask)
  phases = @('Plan', 'Hold', 'Execute')
  stoppedHandoff = $stoppedHandoffEvidencePath
  codeOnlyRollbackAllowedAfterMigrationStarts = $false
  rollbackReadyAfterMigrationStarts = $false
  requiredRecoveryAfterMigrationStarts = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
  postMigrationFailureBehavior = 'BUSINESS_SURFACE_HELD_STOPPED'
  stabilitySeconds = $StabilitySeconds
  workerStabilitySeconds = $WorkerStabilitySeconds
  tunnelBoundary = $tunnelBoundary
}
if ($Mode -eq 'Plan') {
  $plan | ConvertTo-Json -Depth 8
  return
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "$Mode mode requires an elevated Windows administrator session"
}
if ($ConfirmInstance -ne $expectedConfirmationInstance) {
  throw "ConfirmInstance must exactly equal $expectedConfirmationInstance"
}
if ($ConfirmDatabase -ne $expectedDatabase) { throw "ConfirmDatabase must exactly equal $expectedDatabase" }
if ($ConfirmReleaseId -ne $ReleaseId) { throw 'ConfirmReleaseId must exactly equal ReleaseId' }
if ($ConfirmPreviousReleaseId -ne $PreviousReleaseId) {
  throw 'ConfirmPreviousReleaseId must exactly equal PreviousReleaseId'
}
if ($Mode -eq 'Execute') {
  if ($BackupId -cnotmatch '^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$') { throw 'BackupId is invalid' }
  if ($BackupManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'BackupManifestSha256 is invalid' }
  if ($StoppedHandoffSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'StoppedHandoffSha256 is invalid' }
  if ($HandoffNonce -cnotmatch '^[0-9a-f]{64}$') { throw 'HandoffNonce is invalid' }
  if ($OffhostVerificationReceiptSha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'OffhostVerificationReceiptSha256 is invalid'
  }
  if ($TrustedPublicKeySha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'TrustedPublicKeySha256 is invalid'
  }
  $TrustedPublicKeyPath = Assert-PathBelow $RecoveryRoot $TrustedPublicKeyPath 'TrustedPublicKeyPath'
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
    -Candidate $TrustedPublicKeyPath -Label 'Trusted receipt public key'
  if (-not $TrustedPublicKeyPath.Equals(
    [string]$candidateIdentity.trustedPublicKeyPath,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'TrustedPublicKeyPath must exactly equal the public key embedded in the candidate release'
  }
  if ($TrustedPublicKeySha256 -cne [string]$candidateIdentity.trustedPublicKeySha256) {
    throw 'TrustedPublicKeySha256 must exactly equal the candidate release public key SHA256'
  }
  if (-not (Test-Path -LiteralPath $TrustedPublicKeyPath -PathType Leaf)) {
    throw "Trusted receipt public key is missing: $TrustedPublicKeyPath"
  }
  if ((Get-Sha256 $TrustedPublicKeyPath) -cne $TrustedPublicKeySha256) {
    throw 'Trusted receipt public key SHA256 mismatch'
  }
  if ($ConfirmBackupId -ne $BackupId) { throw 'ConfirmBackupId must exactly equal BackupId' }
  if ($ConfirmHandoffNonce -ne $HandoffNonce) { throw 'ConfirmHandoffNonce must exactly equal HandoffNonce' }
}
$shouldProcessAction = if ($Mode -eq 'Hold') {
  'Stop and disable the V2 business surface, then seal a one-time stopped handoff'
}
else {
  'Consume the stopped handoff, verify a new stopped backup off host, migrate the index, and activate the candidate'
}
if (-not $PSCmdlet.ShouldProcess($ReleaseId, $shouldProcessAction)) {
  return
}

$holdProtectedPaths = @(
  $rollbackStatePath,
  $stoppedHandoffEvidencePath,
  $stoppedDryRunPath,
  $executeDryRunPath,
  $executeClaimPath,
  $backupVerificationPath,
  $migrationStartedPath,
  $executeReportPath,
  $idempotencyReportPath,
  $migrationCompletedPath,
  $activeEvidencePath,
  $activationCommitPath,
  $failureEvidencePath,
  $holdMongoAnchorPath,
  $executeMongoAnchorPath
)

$apiBefore = $null
$webBefore = $null
$businessTunnelBefore = $null
$managementTunnelBefore = $null
$mongoBefore = $null
$apiProcessBefore = $null
$webProcessBefore = $null
$markerBeforeExists = $false
$markerBeforeRaw = ''
$stableApiBeforeExists = $false
$stableWebBeforeExists = $false
$stableApiBeforeRaw = ''
$stableWebBeforeRaw = ''
$rollbackState = $null
$stoppedHandoff = $null
$holdMongoAnchorSha256 = $null
$executeMongoAnchorSha256 = $null

if ($Mode -eq 'Hold') {
  foreach ($path in $holdProtectedPaths) {
    if (Test-Path -LiteralPath $path) { throw "Protected release evidence already exists: $path" }
  }
  $apiBefore = Assert-TaskRunning $apiTask
  $webBefore = Assert-TaskRunning $webTask
  $businessTunnelBefore = Assert-TaskRunning $businessTunnelTask
  $managementTunnelBefore = Assert-TaskRunning $managementTunnelTask
  $mongoBefore = Assert-TaskRunning $mongoTask
  $apiProcessBefore = Assert-ReleaseListener 18120 $PreviousReleaseId
  $webProcessBefore = Assert-ReleaseListener 18130 $PreviousReleaseId
  $prePublicHealth = Get-Http 'https://v2-test.horselink.cn/health'
  Assert-RecoveryHealth $prePublicHealth 'Pre-hold public V2'

  $markerBeforeExists = Test-Path -LiteralPath $activeMarker -PathType Leaf
  $markerBeforeRaw = if ($markerBeforeExists) { [IO.File]::ReadAllText($activeMarker) } else { '' }
  if ($markerBeforeExists) {
    $markerBefore = $markerBeforeRaw | ConvertFrom-Json
    if ($markerBefore.releaseId -ne $PreviousReleaseId -or $markerBefore.sourceCommit -ne $PreviousCommit) {
      throw 'Active marker does not identify the previous release and commit'
    }
  }
  $stableApiBeforeExists = Test-Path -LiteralPath $stableApiRunner -PathType Leaf
  $stableWebBeforeExists = Test-Path -LiteralPath $stableWebRunner -PathType Leaf
  $stableApiBeforeRaw = if ($stableApiBeforeExists) { [IO.File]::ReadAllText($stableApiRunner) } else { '' }
  $stableWebBeforeRaw = if ($stableWebBeforeExists) { [IO.File]::ReadAllText($stableWebRunner) } else { '' }

  $rollbackState = [ordered]@{
    format = 'task-distribution-v2-windows-index-migration-rollback-state/v2'
    status = 'PRE_MIGRATION_RUNTIME_STATE_CAPTURED'
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    apiTask = $apiBefore
    webTask = $webBefore
    businessTunnelTask = $businessTunnelBefore
    managementTunnelTask = $managementTunnelBefore
    mongoTask = $mongoBefore
    apiProcess = $apiProcessBefore
    webProcess = $webProcessBefore
    activeMarkerExisted = $markerBeforeExists
    activeMarkerUtf8Base64 = Encode-Utf8State $markerBeforeExists $markerBeforeRaw
    stableApiRunnerExisted = $stableApiBeforeExists
    stableApiRunnerUtf8Base64 = Encode-Utf8State $stableApiBeforeExists $stableApiBeforeRaw
    stableWebRunnerExisted = $stableWebBeforeExists
    stableWebRunnerUtf8Base64 = Encode-Utf8State $stableWebBeforeExists $stableWebBeforeRaw
    runtimeInputsSha256 = $runtimeInputsSha256
    databaseMigrationPerformed = $false
    rollbackReady = $false
    codeOnlyRollbackAllowed = $true
    requiredRecovery = 'VERIFY_INDEX_UNCHANGED_THEN_RESTORE_PREVIOUS_RUNTIME'
  }
  Write-JsonCreateNew $rollbackStatePath $rollbackState
}
else {
  if ($StoppedHandoffPath -ne $stoppedHandoffEvidencePath) {
    throw 'StoppedHandoffPath must exactly equal the release evidence handoff path'
  }
  if ((Get-Sha256 $StoppedHandoffPath) -ne $StoppedHandoffSha256) {
    throw 'Stopped handoff SHA256 mismatch'
  }
  $stoppedHandoff = Read-JsonFile $StoppedHandoffPath 'Stopped handoff'
  $rollbackState = Read-JsonFile $rollbackStatePath 'Migration rollback state'
  if (
    $stoppedHandoff.format -ne 'task-distribution-v2-windows-equipment-category-index-stopped-handoff/v1' -or
    $stoppedHandoff.status -ne 'BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP' -or
    $stoppedHandoff.releaseId -ne $ReleaseId -or
    $stoppedHandoff.sourceCommit -ne $SourceCommit -or
    $stoppedHandoff.previousReleaseId -ne $PreviousReleaseId -or
    $stoppedHandoff.previousCommit -ne $PreviousCommit -or
    $stoppedHandoff.database -ne $expectedDatabase -or
    $stoppedHandoff.sourceHost -ne $env:COMPUTERNAME -or
    $stoppedHandoff.stagedEvidenceSha256 -ne $StagedEvidenceSha256 -or
    $stoppedHandoff.approvedDryRunSha256 -ne $MigrationDryRunReportSha256 -or
    $stoppedHandoff.runtimeInputsSha256 -ne $runtimeInputsSha256 -or
    $stoppedHandoff.handoffNonce -ne $HandoffNonce -or
    $stoppedHandoff.rollbackStateSha256 -ne (Get-Sha256 $rollbackStatePath) -or
    $stoppedHandoff.holdMongoAnchorPath -ne $holdMongoAnchorPath -or
    $stoppedHandoff.holdMongoAnchorSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $stoppedHandoff.stagedPredeployBackupId -ne [string]$staged.predeployBackup.backupId
  ) { throw 'Stopped handoff identity, nonce, or evidence chain mismatch' }
  if (
    $rollbackState.format -ne 'task-distribution-v2-windows-index-migration-rollback-state/v2' -or
    $rollbackState.status -ne 'PRE_MIGRATION_RUNTIME_STATE_CAPTURED' -or
    $rollbackState.releaseId -ne $ReleaseId -or
    $rollbackState.sourceCommit -ne $SourceCommit -or
    $rollbackState.previousReleaseId -ne $PreviousReleaseId -or
    $rollbackState.previousCommit -ne $PreviousCommit -or
    $rollbackState.database -ne $expectedDatabase -or
    $rollbackState.runtimeInputsSha256 -ne $runtimeInputsSha256
  ) { throw 'Migration rollback state identity mismatch' }
  $holdMongoAnchorSha256 = Get-Sha256 $holdMongoAnchorPath
  if ($holdMongoAnchorSha256 -cne [string]$stoppedHandoff.holdMongoAnchorSha256) {
    throw 'Hold Mongo write-anchor SHA256 differs from the sealed handoff'
  }
  $holdMongoAnchor = Read-JsonFile $holdMongoAnchorPath 'Hold Mongo write-anchor report'
  Assert-MongoAnchorReport -Report $holdMongoAnchor -Label 'Hold Mongo write-anchor report'
  foreach ($path in @(
    $executeDryRunPath,
    $executeClaimPath,
    $backupVerificationPath,
    $migrationStartedPath,
    $executeReportPath,
    $idempotencyReportPath,
    $migrationCompletedPath,
    $activeEvidencePath,
    $activationCommitPath,
    $failureEvidencePath,
    $executeMongoAnchorPath
  )) {
    if (Test-Path -LiteralPath $path) { throw "Protected execute evidence already exists or nonce was consumed: $path" }
  }
  $apiBefore = $rollbackState.apiTask
  $webBefore = $rollbackState.webTask
  $businessTunnelBefore = $rollbackState.businessTunnelTask
  $managementTunnelBefore = $rollbackState.managementTunnelTask
  $mongoBefore = $rollbackState.mongoTask
  $apiProcessBefore = $rollbackState.apiProcess
  $webProcessBefore = $rollbackState.webProcess
  $markerBeforeExists = [bool]$rollbackState.activeMarkerExisted
  $markerBeforeRaw = if ($markerBeforeExists) {
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$rollbackState.activeMarkerUtf8Base64))
  } else { '' }
  $stableApiBeforeExists = [bool]$rollbackState.stableApiRunnerExisted
  $stableWebBeforeExists = [bool]$rollbackState.stableWebRunnerExisted
  $stableApiBeforeRaw = if ($stableApiBeforeExists) {
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$rollbackState.stableApiRunnerUtf8Base64))
  } else { '' }
  $stableWebBeforeRaw = if ($stableWebBeforeExists) {
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$rollbackState.stableWebRunnerUtf8Base64))
  } else { '' }
}

$stableApi = @'
$ErrorActionPreference = 'Stop'
$root = 'C:\TaskDistribution-V2\Recovery'
$expectedDatabase = 'customer_acceptance_v2_test'
$expectedCapability = 'equipment-category-parent-name-index-v1'
$expectedPublicKeyRelativePath = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required runtime file is missing: $Path" }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-ObjectSha256 {
  param([Parameter(Mandatory = $true)][object]$Value)
  $json = ConvertTo-Json $Value -Depth 12 -Compress
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  }
  finally { $algorithm.Dispose() }
}
$marker = Get-Content -LiteralPath (Join-Path $root 'active-release.json') -Raw | ConvertFrom-Json
$allowedStatuses = @(
  'WINDOWS_RECOVERY_RELEASE_SELECTED_AFTER_MIGRATION',
  'WINDOWS_RECOVERY_RELEASE_ACTIVE'
)
if ([string]$marker.status -notin $allowedStatuses) { throw 'Active recovery marker is not startable' }
$releaseId = [string]$marker.releaseId
if ($releaseId -notmatch '^v2-\d{8}-[0-9a-f]{7}$') { throw 'Active recovery release id is invalid' }
$sourceCommit = [string]$marker.sourceCommit
if ($sourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Active recovery source commit is invalid' }
if (
  [string]$marker.runtimeInputsSha256 -cnotmatch '^[0-9a-f]{64}$' -or
  [string]$marker.stagedEvidenceSha256 -cnotmatch '^[0-9a-f]{64}$' -or
  [string]$marker.appEnvSha256 -cnotmatch '^[0-9a-f]{64}$' -or
  [string]$marker.database -cne $expectedDatabase -or
  [string]$marker.trustedPublicKeyPath -cne $expectedPublicKeyRelativePath -or
  [string]$marker.trustedPublicKeySha256 -cnotmatch '^[0-9a-f]{64}$' -or
  @($marker.schemaCapabilities).Count -ne 1 -or
  [string]$marker.schemaCapabilities[0] -cne $expectedCapability
) { throw 'Active recovery marker runtime-input contract is invalid' }
$stagedPath = Join-Path $root "evidence\release-$releaseId\staged.json"
if ((Get-Sha256 $stagedPath) -cne [string]$marker.stagedEvidenceSha256) {
  throw 'Active API staged evidence SHA256 mismatch'
}
$staged = Get-Content -LiteralPath $stagedPath -Raw | ConvertFrom-Json
if (
  $staged.status -cne 'WINDOWS_RECOVERY_CANDIDATE_STAGED' -or
  $staged.releaseId -cne $releaseId -or
  $staged.sourceCommit -cne $sourceCommit -or
  [string]$staged.runtimeInputsSha256 -cne [string]$marker.runtimeInputsSha256 -or
  [string]$staged.runtimeInputs.appEnvPath -cne (Join-Path $root 'config\app.env') -or
  [string]$staged.runtimeInputs.appEnvSha256 -cne [string]$marker.appEnvSha256 -or
  [string]$staged.runtimeInputs.trustedPublicKeyPath -cne $expectedPublicKeyRelativePath -or
  [string]$staged.runtimeInputs.trustedPublicKeySha256 -cne [string]$marker.trustedPublicKeySha256 -or
  @($staged.runtimeInputs.schemaCapabilities).Count -ne 1 -or
  [string]$staged.runtimeInputs.schemaCapabilities[0] -cne $expectedCapability
) { throw 'Active API staged runtime inputs do not match the selected marker' }
if ((Get-ObjectSha256 $staged.runtimeInputs) -cne [string]$marker.runtimeInputsSha256) {
  throw 'Active API staged runtime input object SHA256 mismatch'
}
$releaseRoot = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'releases') $releaseId))
$approved = [IO.Path]::GetFullPath((Join-Path $root 'releases')).TrimEnd('\') + '\'
if (-not $releaseRoot.StartsWith($approved, [StringComparison]::OrdinalIgnoreCase)) { throw 'Active API release escaped the releases root' }
function Get-InjectedTreeSha256 {
  param([Parameter(Mandatory = $true)][string]$Root)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $prefix = "$rootFull\"
  $entries = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Injected runtime contains a reparse point: $($file.FullName)" }
    $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/')
    $key = $relative.ToLowerInvariant()
    if ($entries.ContainsKey($key)) { throw "Injected runtime contains a duplicate path: $relative" }
    $entries[$key] = $file
  }
  [string[]]$keys = @($entries.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  $builder = New-Object Text.StringBuilder
  foreach ($key in $keys) {
    $file = $entries[$key]
    [void]$builder.Append($file.FullName.Substring($prefix.Length).Replace('\', '/')).Append("`t").Append([int64]$file.Length).
      Append("`t").Append((Get-Sha256 $file.FullName)).Append("`n")
  }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($builder.ToString())))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Assert-InjectedRuntime([string]$Candidate, [object]$StagedRuntime) {
  $runtimeRoot = Join-Path $Candidate 'runtime-node'
  $nodePath = Join-Path $runtimeRoot 'node.exe'
  $nodeModulesRoot = Join-Path $Candidate 'app\node_modules'
  $proxyPath = Join-Path $Candidate 'serve-v2-recovery.cjs'
  $apiRunnerPath = Join-Path $Candidate 'run-v2-recovery-api.ps1'
  $webRunnerPath = Join-Path $Candidate 'run-v2-recovery-web.ps1'
  foreach ($path in @($nodePath, (Join-Path $runtimeRoot 'npm.cmd'), $proxyPath, $apiRunnerPath, $webRunnerPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Injected runtime file is missing: $path" }
  }
  $nodeVersion = ([string](& $nodePath --version)).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne 'v22.23.1') { throw 'Injected runtime Node version mismatch' }
  if ((Get-InjectedTreeSha256 $runtimeRoot) -cne [string]$StagedRuntime.runtimeNodeSha256) { throw 'Injected runtime Node tree hash mismatch' }
  if ((Get-InjectedTreeSha256 $nodeModulesRoot) -cne [string]$StagedRuntime.appNodeModulesSha256) { throw 'Injected app dependency tree hash mismatch' }
  if ((Get-Sha256 $proxyPath) -cne [string]$StagedRuntime.webProxySha256) { throw 'Injected Web proxy hash mismatch' }
  if ((Get-Sha256 $apiRunnerPath) -cne [string]$StagedRuntime.apiRunnerSha256) { throw 'Injected API runner hash mismatch' }
  if ((Get-Sha256 $webRunnerPath) -cne [string]$StagedRuntime.webRunnerSha256) { throw 'Injected Web runner hash mismatch' }
}
$null = Assert-InjectedRuntime $releaseRoot $staged.injectedRuntime
$metadataPath = Join-Path $releaseRoot 'deploy\RELEASE.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$metadataCapabilities = @($metadata.schemaCapabilities)
if (
  $metadata.format -cne 'task-distribution-v2-release/v1' -or
  $metadata.releaseId -cne $releaseId -or
  $metadata.commit -cne $sourceCommit -or
  $metadata.environment -cne 'customer-test' -or
  $metadata.database -cne $expectedDatabase -or
  [int]$metadata.apiPort -ne 18120 -or
  $metadataCapabilities.Count -ne 1 -or
  [string]$metadataCapabilities[0] -cne $expectedCapability -or
  [string]$metadata.trustedOffhostReceiptPublicKeyPath -cne $expectedPublicKeyRelativePath -or
  [string]$metadata.trustedOffhostReceiptPublicKeySha256 -cne [string]$marker.trustedPublicKeySha256
) { throw 'Active API release metadata does not match the selected marker' }
$publicKeyPath = [IO.Path]::GetFullPath((Join-Path $releaseRoot `
  ($expectedPublicKeyRelativePath -replace '/', '\')))
$releasePrefix = $releaseRoot.TrimEnd('\') + '\'
if (-not $publicKeyPath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Active API trusted public key escaped the release root'
}
if ((Get-Sha256 $publicKeyPath) -cne [string]$marker.trustedPublicKeySha256) {
  throw 'Active API trusted public key SHA256 mismatch'
}
$appEnvPath = Join-Path $root 'config\app.env'
if ((Get-Sha256 $appEnvPath) -cne [string]$marker.appEnvSha256) {
  throw 'Active API application environment SHA256 mismatch'
}
$runner = Join-Path $releaseRoot 'run-v2-recovery-api.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Active API runner is missing' }
$env:ENV_FILE = $appEnvPath
$env:REQUIRED_SCHEMA_CAPABILITIES = $expectedCapability
$env:EQUIPMENT_ROUTINE_WORKER_ENABLED = if ($marker.workerEnabled -eq $true) { 'true' } else { 'false' }
& $runner
exit $LASTEXITCODE
'@
$stableWeb = @'
$ErrorActionPreference = 'Stop'
$root = 'C:\TaskDistribution-V2\Recovery'
$expectedNodeVersion = 'v22.23.1'
function Get-Sha256 { param([string]$Path); if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required runtime file is missing: $Path" }; return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-InjectedTreeSha256 {
  param([string]$Root)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\'); $prefix = "$rootFull\"; $entries = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Injected runtime contains a reparse point: $($file.FullName)" }
    $relative = $file.FullName.Substring($prefix.Length).Replace('\', '/'); $key = $relative.ToLowerInvariant()
    if ($entries.ContainsKey($key)) { throw "Injected runtime contains a duplicate path: $relative" }; $entries[$key] = $file
  }
  [string[]]$keys = @($entries.Keys); [Array]::Sort($keys, [StringComparer]::Ordinal); $builder = New-Object Text.StringBuilder
  foreach ($key in $keys) { $file = $entries[$key]; [void]$builder.Append($file.FullName.Substring($prefix.Length).Replace('\', '/')).Append("`t").Append([int64]$file.Length).Append("`t").Append((Get-Sha256 $file.FullName)).Append("`n") }
  $algorithm = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($algorithm.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($builder.ToString())))).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
}
function Assert-InjectedRuntime([string]$Candidate, [object]$Expected) {
  $node = Join-Path $Candidate 'runtime-node\node.exe'; $nodeModules = Join-Path $Candidate 'app\node_modules'
  $proxy = Join-Path $Candidate 'serve-v2-recovery.cjs'; $api = Join-Path $Candidate 'run-v2-recovery-api.ps1'; $web = Join-Path $Candidate 'run-v2-recovery-web.ps1'
  foreach ($path in @($node, (Join-Path $Candidate 'runtime-node\npm.cmd'), $proxy, $api, $web)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Injected runtime file is missing: $path" } }
  if (([string](& $node --version)).Trim() -cne $expectedNodeVersion) { throw 'Injected runtime Node version mismatch' }
  if ((Get-InjectedTreeSha256 (Join-Path $Candidate 'runtime-node')) -cne [string]$Expected.runtimeNodeSha256) { throw 'Injected runtime Node tree hash mismatch' }
  if ((Get-InjectedTreeSha256 $nodeModules) -cne [string]$Expected.appNodeModulesSha256) { throw 'Injected app dependency tree hash mismatch' }
  if ((Get-Sha256 $proxy) -cne [string]$Expected.webProxySha256 -or (Get-Sha256 $api) -cne [string]$Expected.apiRunnerSha256 -or (Get-Sha256 $web) -cne [string]$Expected.webRunnerSha256) { throw 'Injected runner or proxy hash mismatch' }
}
$marker = Get-Content -LiteralPath (Join-Path $root 'active-release.json') -Raw | ConvertFrom-Json
$allowedStatuses = @(
  'WINDOWS_RECOVERY_RELEASE_SELECTED_AFTER_MIGRATION',
  'WINDOWS_RECOVERY_RELEASE_ACTIVE'
)
if ([string]$marker.status -notin $allowedStatuses) { throw 'Active recovery marker is not startable' }
$releaseId = [string]$marker.releaseId
if ($releaseId -notmatch '^v2-\d{8}-[0-9a-f]{7}$') { throw 'Active recovery release id is invalid' }
$sourceCommit = [string]$marker.sourceCommit
if ($sourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Active recovery source commit is invalid' }
$stagedPath = Join-Path $root "evidence\release-$releaseId\staged.json"
$staged = Get-Content -LiteralPath $stagedPath -Raw | ConvertFrom-Json
$releaseRoot = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'releases') $releaseId))
$approved = [IO.Path]::GetFullPath((Join-Path $root 'releases')).TrimEnd('\') + '\'
if (-not $releaseRoot.StartsWith($approved, [StringComparison]::OrdinalIgnoreCase)) { throw 'Active Web release escaped the releases root' }
$null = Assert-InjectedRuntime $releaseRoot $staged.injectedRuntime
$metadata = Get-Content -LiteralPath (Join-Path $releaseRoot 'deploy\RELEASE.json') -Raw | ConvertFrom-Json
if ($metadata.releaseId -cne $releaseId -or $metadata.commit -cne $sourceCommit) {
  throw 'Active Web release metadata does not match the selected marker'
}
$runner = Join-Path $releaseRoot 'run-v2-recovery-web.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Active Web runner is missing' }
& $runner
exit $LASTEXITCODE
'@

$surfaceStopped = $false
$surfaceStopAttempted = $false
$taskActionsChanged = $false
$migrationStarted = $false

function Restore-PreMigrationRuntime {
  param([string]$Failure)
  $recoveryFailures = New-Object 'Collections.Generic.List[object]'
  $steps = @(
    [pscustomobject]@{ name = 'stop-business-surface'; action = { $null = Stop-BusinessSurface } },
    [pscustomobject]@{ name = 'restore-api-task-action'; action = { Set-TaskActionState $apiBefore } },
    [pscustomobject]@{ name = 'restore-web-task-action'; action = { Set-TaskActionState $webBefore } },
    [pscustomobject]@{ name = 'restore-active-marker'; action = { Restore-FileState $activeMarker $markerBeforeExists $markerBeforeRaw } },
    [pscustomobject]@{ name = 'restore-stable-api-runner'; action = { Restore-FileState $stableApiRunner $stableApiBeforeExists $stableApiBeforeRaw } },
    [pscustomobject]@{ name = 'restore-stable-web-runner'; action = { Restore-FileState $stableWebRunner $stableWebBeforeExists $stableWebBeforeRaw } },
    [pscustomobject]@{ name = 'start-previous-api'; action = { $null = Start-HealthTask $apiTask 18120 'http://127.0.0.1:18120/health' $PreviousReleaseId } },
    [pscustomobject]@{ name = 'start-previous-web'; action = { $null = Start-HealthTask $webTask 18130 'http://127.0.0.1:18130/health' $PreviousReleaseId } },
    [pscustomobject]@{ name = 'start-business-tunnel'; action = { $null = Start-BusinessTunnel } }
  )
  foreach ($step in $steps) {
    try { & $step.action }
    catch { $recoveryFailures.Add([pscustomobject]@{ step = $step.name; message = $_.Exception.Message }) }
  }
  $result = [ordered]@{
    format = 'task-distribution-v2-windows-pre-migration-recovery/v1'
    status = if ($recoveryFailures.Count -eq 0) { 'PRE_MIGRATION_RUNTIME_RECOVERED' } else { 'PRE_MIGRATION_RUNTIME_RECOVERY_INCOMPLETE' }
    recoveredAt = (Get-Date).ToUniversalTime().ToString('o')
    failedReleaseId = $ReleaseId
    previousReleaseId = $PreviousReleaseId
    failure = $Failure
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = if (Test-Path -LiteralPath $holdMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $holdMongoAnchorPath
    } else { $null }
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = if (Test-Path -LiteralPath $executeMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $executeMongoAnchorPath
    } else { $null }
    databaseMigrationMayHaveStarted = $false
    rollbackReady = $false
    codeOnlyRollbackAllowed = $true
    requiredRecovery = 'VERIFY_INDEX_UNCHANGED_THEN_RESTORE_PREVIOUS_RUNTIME'
    failures = $recoveryFailures.ToArray()
  }
  $path = Join-Path $evidence 'pre-migration-automatic-recovery.json'
  if (-not (Test-Path -LiteralPath $path)) { Write-JsonCreateNew $path $result }
  if ($recoveryFailures.Count -ne 0) {
    throw "PRE_MIGRATION_RUNTIME_RECOVERY_INCOMPLETE: $(@($recoveryFailures | ForEach-Object { '{0}: {1}' -f $_.step, $_.message }) -join '; ')"
  }
}

function Hold-ExecuteFailure {
  param([string]$Failure, [bool]$MigrationMayHaveStarted)
  $holdFailures = New-Object 'Collections.Generic.List[object]'
  $businessSurfaceHeldStopped = $false
  try {
    $surfaceHold = Stop-BusinessSurface
    $businessSurfaceHeldStopped = $surfaceHold.businessSurfaceHeldStopped -eq $true
    if (-not $businessSurfaceHeldStopped) { throw 'Business surface final hold verification did not pass' }
  }
  catch { $holdFailures.Add([pscustomobject]@{ step = 'stop-business-surface'; message = $_.Exception.Message }) }
  foreach ($protectedTask in @($managementTunnelTask, $mongoTask)) {
    try { $null = Assert-TaskRunning $protectedTask }
    catch { $holdFailures.Add([pscustomobject]@{ step = "verify-$protectedTask"; message = $_.Exception.Message }) }
  }
  $codeOnlyRollbackAllowed = -not $MigrationMayHaveStarted
  $requiredRecovery = if ($MigrationMayHaveStarted) {
    'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
  }
  else {
    'VERIFY_INDEX_UNCHANGED_THEN_RESTORE_PREVIOUS_RUNTIME'
  }
  $holdComplete = $businessSurfaceHeldStopped -and $holdFailures.Count -eq 0
  $holdMarker = [ordered]@{
    status = if (-not $holdComplete) {
      'WINDOWS_RECOVERY_EXECUTE_FAILURE_HOLD_INCOMPLETE'
    } elseif ($MigrationMayHaveStarted) {
      'WINDOWS_RECOVERY_MIGRATION_FAILED_STOPPED'
    } else {
      'WINDOWS_RECOVERY_PRE_MIGRATION_EXECUTE_FAILED_STOPPED'
    }
    heldAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    appEnvSha256 = $AppEnvSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
    schemaCapabilities = @($expectedSchemaCapability)
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = if (Test-Path -LiteralPath $holdMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $holdMongoAnchorPath
    } else { $null }
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = if (Test-Path -LiteralPath $executeMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $executeMongoAnchorPath
    } else { $null }
    migrationStartedSha256 = if (Test-Path -LiteralPath $migrationStartedPath) { Get-Sha256 $migrationStartedPath } else { $null }
    migrationCompletedSha256 = if (Test-Path -LiteralPath $migrationCompletedPath) { Get-Sha256 $migrationCompletedPath } else { $null }
    workerEnabled = $false
    businessSurfaceHeldStopped = $holdComplete
    databaseMigrationMayHaveStarted = $MigrationMayHaveStarted
    rollbackReady = $false
    codeOnlyRollbackAllowed = $codeOnlyRollbackAllowed
    requiredRecovery = $requiredRecovery
  }
  try { Write-AtomicJson $activeMarker $holdMarker }
  catch { $holdFailures.Add([pscustomobject]@{ step = 'write-hold-marker'; message = $_.Exception.Message }) }
  $holdComplete = $businessSurfaceHeldStopped -and $holdFailures.Count -eq 0
  $failureState = [ordered]@{
    format = 'task-distribution-v2-windows-index-migration-failure/v1'
    status = if (-not $holdComplete) {
      'EXECUTE_FAILURE_HOLD_INCOMPLETE'
    } elseif ($MigrationMayHaveStarted) {
      'POST_MIGRATION_FAILURE_HELD_STOPPED'
    } else {
      'PRE_MIGRATION_EXECUTE_FAILURE_HELD_STOPPED'
    }
    failedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    failure = $Failure
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = if (Test-Path -LiteralPath $holdMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $holdMongoAnchorPath
    } else { $null }
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = if (Test-Path -LiteralPath $executeMongoAnchorPath -PathType Leaf) {
      Get-Sha256 $executeMongoAnchorPath
    } else { $null }
    databaseMigrationMayHaveStarted = $MigrationMayHaveStarted
    rollbackReady = $false
    codeOnlyRollbackAllowed = $codeOnlyRollbackAllowed
    businessSurfaceHeldStopped = $holdComplete
    requiredRecovery = $requiredRecovery
    failures = $holdFailures.ToArray()
  }
  if (-not (Test-Path -LiteralPath $failureEvidencePath)) { Write-JsonCreateNew $failureEvidencePath $failureState }
  if (-not $holdComplete) {
    throw "EXECUTE_FAILURE_HOLD_INCOMPLETE: $(@($holdFailures | ForEach-Object { '{0}: {1}' -f $_.step, $_.message }) -join '; ')"
  }
}

try {
  if ($Mode -eq 'Hold') {
    $surfaceStopAttempted = $true
    $surfaceHold = Stop-BusinessSurface
    if ($surfaceHold.businessSurfaceHeldStopped -ne $true) {
      throw 'Business surface final hold verification did not pass'
    }
    $surfaceStopped = $true
    $null = Assert-TaskRunning $managementTunnelTask
    $null = Assert-TaskRunning $mongoTask
    Assert-NoBusinessListeners
    Assert-NoRecoveryDatabaseWriters

    $stoppedDryRun = Invoke-MigrationCli -Mode dry-run -ReportPath $stoppedDryRunPath
    Assert-DryRunReady $stoppedDryRun 'Stopped-state migration dry-run report'
    $heldTasks = @(
      Get-TaskState $businessTunnelTask
      Get-TaskState $webTask
      Get-TaskState $apiTask
    )
    if (@($heldTasks | Where-Object { $_.enabled -ne $false -or $_.state -ne 'Disabled' }).Count -ne 0) {
      throw 'Business tasks were not all disabled after the stopped-state dry-run'
    }
    $stoppedAt = (Get-Date).ToUniversalTime().ToString('o')
    $handoffNonceValue = New-HandoffNonce
    $HandoffNonce = $handoffNonceValue
    $holdMongoAnchor = Invoke-MongoAnchorCli -ReportPath $holdMongoAnchorPath
    $holdMongoAnchorSha256 = Get-Sha256 $holdMongoAnchorPath
    Assert-NoRecoveryDatabaseWriters
    $stoppedHandoffEvidence = [ordered]@{
      format = 'task-distribution-v2-windows-equipment-category-index-stopped-handoff/v1'
      status = 'BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP'
      stoppedAt = $stoppedAt
      releaseId = $ReleaseId
      sourceCommit = $SourceCommit
      previousReleaseId = $PreviousReleaseId
      previousCommit = $PreviousCommit
      database = $expectedDatabase
      sourceHost = [string]$env:COMPUTERNAME
      handoffNonce = $handoffNonceValue
      stagedEvidenceSha256 = $StagedEvidenceSha256
      approvedDryRunPath = $MigrationDryRunReport
      approvedDryRunSha256 = $MigrationDryRunReportSha256
      stoppedDryRunPath = $stoppedDryRunPath
      stoppedDryRunSha256 = Get-Sha256 $stoppedDryRunPath
      runtimeInputsSha256 = $runtimeInputsSha256
      holdMongoAnchorPath = $holdMongoAnchorPath
      holdMongoAnchorSha256 = $holdMongoAnchorSha256
      rollbackStatePath = $rollbackStatePath
      rollbackStateSha256 = Get-Sha256 $rollbackStatePath
      stagedPredeployBackupId = [string]$staged.predeployBackup.backupId
      requiredNewBackup = [ordered]@{
        mustDifferFromStagedPredeployBackup = $true
        manifestCreatedAtNotBeforeStoppedAt = $true
        manifestCompletedAtNotBeforeStoppedAt = $true
        database = $expectedDatabase
        requiredDump = "database/$expectedDatabase/equipmentcategories.bson"
        fullFileVerificationRequired = $true
        independentOffhostReceiptRequired = $true
      }
      heldTasks = $heldTasks
      preservedTasks = @(
        Get-TaskState $managementTunnelTask
        Get-TaskState $mongoTask
      )
      businessListenersAbsent = $true
      databaseMigrationPerformed = $false
      rollbackReady = $false
      codeOnlyRollbackAllowed = $true
      requiredRecovery = 'VERIFY_INDEX_UNCHANGED_THEN_RESTORE_PREVIOUS_RUNTIME'
    }
    Write-JsonCreateNew $stoppedHandoffEvidencePath $stoppedHandoffEvidence
    [ordered]@{
      status = 'BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP'
      stoppedAt = $stoppedAt
      sourceHost = [string]$env:COMPUTERNAME
      stoppedHandoffPath = $stoppedHandoffEvidencePath
      stoppedHandoffSha256 = Get-Sha256 $stoppedHandoffEvidencePath
      handoffNonce = $handoffNonceValue
      runtimeInputsSha256 = $runtimeInputsSha256
      holdMongoAnchorPath = $holdMongoAnchorPath
      holdMongoAnchorSha256 = $holdMongoAnchorSha256
      nextAction = 'CREATE_NEW_STOPPED_BACKUP_AND_VERIFY_IT_ON_AN_INDEPENDENT_WORKSTATION'
      businessSurfaceHeldStopped = $true
      rollbackReady = $false
      codeOnlyRollbackAllowed = $true
    } | ConvertTo-Json -Depth 10
    return
  }

  Assert-HeldTaskContinuity $stoppedHandoff
  $null = Assert-TaskRunning $managementTunnelTask
  $null = Assert-TaskRunning $mongoTask
  Assert-NoRecoveryDatabaseWriters
  if ((Get-Sha256 $stoppedDryRunPath) -ne $stoppedHandoff.stoppedDryRunSha256) {
    throw 'Stopped-state dry-run SHA256 differs from the sealed handoff'
  }
  $stoppedDryRun = Read-JsonFile $stoppedDryRunPath 'Stopped-state migration dry-run report'
  Assert-DryRunReady $stoppedDryRun 'Stopped-state migration dry-run report'
  $stoppedDryRunSha256 = Get-Sha256 $stoppedDryRunPath

  $BackupDirectory = Assert-PathBelow $ApprovedBackupRoot $BackupDirectory 'BackupDirectory'
  $null = Assert-NoReparsePointPath -TrustedRoot $ApprovedBackupRoot `
    -Candidate $BackupDirectory -Label 'Stopped backup directory'
  if (-not (Test-Path -LiteralPath $BackupDirectory -PathType Container)) {
    throw "Stopped backup directory is missing: $BackupDirectory"
  }
  $backupReparse = @(Get-ChildItem -LiteralPath $BackupDirectory -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($backupReparse.Count -ne 0) {
    throw "Stopped backup contains a reparse point: $($backupReparse[0].FullName)"
  }
  if ([IO.Path]::GetFileName($BackupDirectory) -ne $BackupId) {
    throw 'BackupDirectory leaf must exactly equal BackupId'
  }
  if ($BackupId -eq [string]$staged.predeployBackup.backupId) {
    throw 'Execute backup must be newer than and different from the staged predeploy backup'
  }
  $backupManifestPath = Join-Path $BackupDirectory 'manifest.json'
  $null = Assert-NoReparsePointPath -TrustedRoot $ApprovedBackupRoot `
    -Candidate $backupManifestPath -Label 'Stopped backup manifest'
  if ((Get-Sha256 $backupManifestPath) -ne $BackupManifestSha256) {
    throw 'Backup manifest SHA256 mismatch'
  }
  $expectedReceiptPath = Join-Path $evidence "offhost-verification-$BackupId.json"
  if ((Get-FullPath $OffhostVerificationReceipt) -ne (Get-FullPath $expectedReceiptPath)) {
    throw 'OffhostVerificationReceipt must use the fixed release evidence path'
  }
  $OffhostVerificationReceipt = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot `
    -Candidate $OffhostVerificationReceipt -Label 'Signed off-host verification receipt'
  if ((Get-Sha256 $OffhostVerificationReceipt) -ne $OffhostVerificationReceiptSha256) {
    throw 'Off-host stopped-backup verification receipt SHA256 mismatch'
  }

  $backupVerified = Invoke-BackupVerification
  $stoppedAtValue = [DateTimeOffset]::MinValue
  $backupCreatedAt = [DateTimeOffset]::MinValue
  $backupCompletedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$stoppedHandoff.stoppedAt, [ref]$stoppedAtValue)) {
    throw 'Stopped handoff stoppedAt is invalid'
  }
  if (
    -not [DateTimeOffset]::TryParse([string]$backupVerified.createdAt, [ref]$backupCreatedAt) -or
    -not [DateTimeOffset]::TryParse([string]$backupVerified.completedAt, [ref]$backupCompletedAt)
  ) { throw 'Stopped backup manifest timestamps are invalid' }
  if ($backupCreatedAt -lt $stoppedAtValue -or $backupCompletedAt -lt $stoppedAtValue) {
    throw 'Stopped backup was created or completed before the sealed stoppedAt timestamp'
  }
  if ($backupCompletedAt -lt $backupCreatedAt) { throw 'Stopped backup completedAt predates createdAt' }
  if (
    $backupVerified.captureMode -ne 'BEST_EFFORT_ONLINE_MONGODUMP' -or
    $backupVerified.databaseAndUploadsAtomic -ne $false
  ) { throw 'Stopped backup consistency limitations are missing or unexpected' }

  $offhostReceipt = Read-SignedOffhostVerificationReceipt `
    -ReceiptPath $OffhostVerificationReceipt `
    -ReceiptSha256 $OffhostVerificationReceiptSha256 `
    -TrustedRoot $RecoveryRoot `
    -PublicKeyPath $TrustedPublicKeyPath `
    -PublicKeySha256 $TrustedPublicKeySha256
  Assert-OffhostVerificationReceipt -Receipt $offhostReceipt -Handoff $stoppedHandoff -VerifiedBackup $backupVerified
  Assert-HeldTaskContinuity $stoppedHandoff
  $null = Assert-TaskRunning $managementTunnelTask
  $null = Assert-TaskRunning $mongoTask

  $executeDryRun = Invoke-MigrationCli -Mode dry-run -ReportPath $executeDryRunPath
  Assert-DryRunReady $executeDryRun 'Execute-bound stopped-state migration dry-run report'
  $executeDryRunSha256 = Get-Sha256 $executeDryRunPath
  Assert-HeldTaskContinuity $stoppedHandoff

  $executeMongoAnchor = Invoke-MongoAnchorCli -ReportPath $executeMongoAnchorPath `
    -CompareTo $holdMongoAnchorPath
  $executeMongoAnchorSha256 = Get-Sha256 $executeMongoAnchorPath
  Assert-HeldTaskContinuity $stoppedHandoff
  Assert-NoRecoveryDatabaseWriters
  $null = Assert-TaskRunning $managementTunnelTask
  $null = Assert-TaskRunning $mongoTask

  $backupVerification = [ordered]@{
    format = 'task-distribution-v2-windows-backup-verification-before-index-migration/v2'
    status = 'STOPPED_BACKUP_AND_OFFHOST_RECEIPT_VERIFIED_BEFORE_INDEX_MIGRATION'
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    stoppedHandoffPath = $StoppedHandoffPath
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    backupId = $BackupId
    backupDirectory = $BackupDirectory
    manifestSha256 = $BackupManifestSha256
    manifestCreatedAt = $backupVerified.createdAt
    manifestCompletedAt = $backupVerified.completedAt
    offhostVerificationReceipt = $OffhostVerificationReceipt
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $TrustedPublicKeySha256
    equipmentCategoriesDumpPresent = $true
    fullFileVerificationPassed = $true
    independentWorkstationVerified = $true
    servicesHeldStopped = $true
    consistency = [ordered]@{
      captureMode = $backupVerified.captureMode
      databaseAndUploadsAtomic = $false
      limitation = 'BUSINESS_WRITES_BLOCKED_BUT_NOT_AN_ATOMIC_DATABASE_AND_UPLOAD_SNAPSHOT'
    }
    verification = $backupVerified
  }
  Write-JsonCreateNew $backupVerificationPath $backupVerification
  $backupVerificationSha256 = Get-Sha256 $backupVerificationPath

  $executeClaim = [ordered]@{
    format = 'task-distribution-v2-windows-equipment-category-index-execute-claim/v1'
    status = 'HANDOFF_NONCE_CONSUMED'
    consumedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    stoppedAt = $stoppedHandoff.stoppedAt
    stoppedHandoffPath = $StoppedHandoffPath
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    backupId = $BackupId
    backupDirectory = $BackupDirectory
    backupManifestSha256 = $BackupManifestSha256
    offhostVerificationReceipt = $OffhostVerificationReceipt
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $TrustedPublicKeySha256
    stagedEvidenceSha256 = $StagedEvidenceSha256
    approvedDryRunPath = $MigrationDryRunReport
    approvedDryRunSha256 = $MigrationDryRunReportSha256
    stoppedDryRunPath = $stoppedDryRunPath
    stoppedDryRunSha256 = $stoppedDryRunSha256
    executeDryRunPath = $executeDryRunPath
    executeDryRunSha256 = $executeDryRunSha256
    backupVerificationPath = $backupVerificationPath
    backupVerificationSha256 = $backupVerificationSha256
    executeReportPath = $executeReportPath
    idempotencyReportPath = $idempotencyReportPath
    databaseMigrationPerformed = $false
    rollbackReady = $false
    codeOnlyRollbackAllowed = $true
    requiredRecovery = 'VERIFY_INDEX_UNCHANGED_THEN_RESTORE_PREVIOUS_RUNTIME'
  }
  Write-JsonCreateNew $executeClaimPath $executeClaim
  $executeClaimSha256 = Get-Sha256 $executeClaimPath

  $migrationStartedEvidence = [ordered]@{
    format = 'task-distribution-v2-windows-equipment-category-index-migration-started/v1'
    status = 'MIGRATION_STARTED'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupDirectory = $BackupDirectory
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffPath = $StoppedHandoffPath
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceipt = $OffhostVerificationReceipt
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    stagedEvidenceSha256 = $StagedEvidenceSha256
    approvedDryRunSha256 = $MigrationDryRunReportSha256
    stoppedDryRunSha256 = $stoppedDryRunSha256
    executeDryRunSha256 = $executeDryRunSha256
    backupVerificationSha256 = $backupVerificationSha256
    servicesHeldStopped = $true
    businessTunnelStopped = $true
    webStopped = $true
    apiStopped = $true
    managementTunnelPreserved = $true
    mongoPreserved = $true
    databaseMigrationMayHaveStarted = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
    approvedDryRunReport = [IO.Path]::GetFileName($MigrationDryRunReport)
  }
  Write-JsonCreateNew $migrationStartedPath $migrationStartedEvidence
  $migrationStarted = $true
  $migrationStartedSha256 = Get-Sha256 $migrationStartedPath

  Assert-RuntimeInputsUnchanged
  Assert-HeldTaskContinuity $stoppedHandoff
  Assert-NoRecoveryDatabaseWriters
  $null = Assert-TaskRunning $managementTunnelTask
  $null = Assert-TaskRunning $mongoTask
  $executeReport = Invoke-MigrationCli -Mode execute -ReportPath $executeReportPath
  Assert-ExecuteCompleted $executeReport 'Migration execute report'
  $executeReportSha256 = Get-Sha256 $executeReportPath

  $idempotencyReport = Invoke-MigrationCli -Mode execute -ReportPath $idempotencyReportPath
  Assert-IdempotencyCompleted $idempotencyReport 'Migration idempotency report'
  $idempotencyReportSha256 = Get-Sha256 $idempotencyReportPath

  $migrationCompleted = [ordered]@{
    format = 'task-distribution-v2-windows-equipment-category-index-migration-completed/v1'
    status = 'MIGRATION_EXECUTED_AND_IDEMPOTENCY_VERIFIED'
    completedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    migrationStartedSha256 = $migrationStartedSha256
    approvedDryRunSha256 = $MigrationDryRunReportSha256
    stoppedDryRunSha256 = $stoppedDryRunSha256
    executeDryRunSha256 = $executeDryRunSha256
    executeReportSha256 = $executeReportSha256
    idempotencyReportSha256 = $idempotencyReportSha256
    desiredIndex = 'uq_equipment_category_team_parent_name'
    legacyIndexRemoved = 'uq_equipment_category_team_name'
    databaseMigrationPerformed = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
  }
  Write-JsonCreateNew $migrationCompletedPath $migrationCompleted
  $migrationCompletedSha256 = Get-Sha256 $migrationCompletedPath

  [IO.File]::WriteAllText($stableApiRunner, $stableApi, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($stableWebRunner, $stableWeb, (New-Object Text.UTF8Encoding($false)))
  foreach ($runner in @($stableApiRunner, $stableWebRunner)) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -ne 0) { throw "Stable runner syntax error: $runner" }
  }
  Set-TaskRunner $apiTask $stableApiRunner
  Set-TaskRunner $webTask $stableWebRunner
  $taskActionsChanged = $true
  $stableRunnerHashes = [ordered]@{
    api = Get-Sha256 $stableApiRunner
    web = Get-Sha256 $stableWebRunner
  }

  $selectedMarker = [ordered]@{
    status = 'WINDOWS_RECOVERY_RELEASE_SELECTED_AFTER_MIGRATION'
    selectedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    stagedEvidenceSha256 = $StagedEvidenceSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    appEnvSha256 = $AppEnvSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
    schemaCapabilities = @($expectedSchemaCapability)
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    migrationStartedSha256 = $migrationStartedSha256
    migrationCompletedSha256 = $migrationCompletedSha256
    executeReportSha256 = $executeReportSha256
    idempotencyReportSha256 = $idempotencyReportSha256
    databaseMigrationPerformed = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
    workerEnabled = $false
    businessTunnelRestored = $false
  }
  Write-AtomicJson $activeMarker $selectedMarker

  $apiProcess = Start-HealthTask $apiTask 18120 'http://127.0.0.1:18120/health' $ReleaseId
  $webProcess = Start-HealthTask $webTask 18130 'http://127.0.0.1:18130/health' $ReleaseId
  $localTeams = Get-Http 'http://127.0.0.1:18130/api/auth/login-teams'
  if (-not (Test-LoginTeams $localTeams)) { throw 'Candidate local login-teams gate failed' }

  $stabilitySamples = @()
  for ($elapsed = 0; $elapsed -le $StabilitySeconds; $elapsed += 30) {
    if ($elapsed -gt 0) { Start-Sleep -Seconds ([Math]::Min(30, $StabilitySeconds - ($elapsed - 30))) }
    $localApi = Get-Http 'http://127.0.0.1:18120/health'
    $localWeb = Get-Http 'http://127.0.0.1:18130/health'
    Assert-RecoveryHealth $localApi 'Candidate stability API'
    Assert-RecoveryHealth $localWeb 'Candidate stability Web'
    $apiNow = Assert-ReleaseListener 18120 $ReleaseId
    $webNow = Assert-ReleaseListener 18130 $ReleaseId
    if ($apiNow.pid -ne $apiProcess.pid -or $webNow.pid -ne $webProcess.pid) {
      throw 'Candidate process restarted during the local stability gate'
    }
    $stabilitySamples += [pscustomobject]@{
      elapsedSeconds = $elapsed
      checkedAt = (Get-Date).ToUniversalTime().ToString('o')
      apiPid = $apiNow.pid
      webPid = $webNow.pid
    }
  }

  $publicHealth = Start-BusinessTunnel
  $selectedMarker.businessTunnelRestored = $true
  Write-AtomicJson $activeMarker $selectedMarker
  $publicTeams = Get-Http 'https://v2-test.horselink.cn/api/auth/login-teams'
  if (-not (Test-LoginTeams $publicTeams)) { throw 'Candidate public login-teams gate failed' }

  $apiStdoutPath = Join-Path $RecoveryRoot 'logs\api.stdout.log'
  $apiStderrPath = Join-Path $RecoveryRoot 'logs\api.stderr.log'
  $apiStdoutOffset = if (Test-Path -LiteralPath $apiStdoutPath) { [int64](Get-Item $apiStdoutPath).Length } else { 0 }
  $apiStderrOffset = if (Test-Path -LiteralPath $apiStderrPath) { [int64](Get-Item $apiStderrPath).Length } else { 0 }
  $selectedMarker.workerEnabled = $true
  $selectedMarker.workerEnabledAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-AtomicJson $activeMarker $selectedMarker
  Stop-RecoveryTask $apiTask 18120
  $apiProcess = Start-HealthTask $apiTask 18120 'http://127.0.0.1:18120/health' $ReleaseId

  $workerSamples = @()
  for ($elapsed = 0; $elapsed -le $WorkerStabilitySeconds; $elapsed += 15) {
    if ($elapsed -gt 0) { Start-Sleep -Seconds ([Math]::Min(15, $WorkerStabilitySeconds - ($elapsed - 15))) }
    $localWorkerHealth = Get-Http 'http://127.0.0.1:18120/health'
    $publicWorkerHealth = Get-Http 'https://v2-test.horselink.cn/health'
    Assert-RecoveryHealth $localWorkerHealth 'Worker-enabled candidate API'
    Assert-RecoveryHealth $publicWorkerHealth 'Worker-enabled candidate public API'
    $apiNow = Assert-ReleaseListener 18120 $ReleaseId
    if ($apiNow.pid -ne $apiProcess.pid) { throw 'Worker-enabled API restarted during its stability gate' }
    $workerSamples += [pscustomobject]@{
      elapsedSeconds = $elapsed
      checkedAt = (Get-Date).ToUniversalTime().ToString('o')
      apiPid = $apiNow.pid
    }
  }
  $workerLog = "$(Read-LogSuffix $apiStdoutPath $apiStdoutOffset)`n$(Read-LogSuffix $apiStderrPath $apiStderrOffset)"
  if ($workerLog -match '(?i)Equipment routine worker failed:') {
    throw 'Equipment routine worker logged a failure during its stability gate'
  }

  $apiProcess = Assert-ReleaseListener 18120 $ReleaseId
  $webProcess = Assert-ReleaseListener 18130 $ReleaseId
  $null = Assert-TaskRunning $businessTunnelTask
  $null = Assert-TaskRunning $managementTunnelTask
  $null = Assert-TaskRunning $mongoTask
  $active = [ordered]@{
    format = 'task-distribution-v2-windows-migration-aware-active/v1'
    status = 'WINDOWS_RECOVERY_RELEASE_ACTIVE'
    activatedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    stagedEvidenceSha256 = $StagedEvidenceSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    appEnvSha256 = $AppEnvSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
    schemaCapabilities = @($expectedSchemaCapability)
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    approvedDryRunSha256 = $MigrationDryRunReportSha256
    stoppedDryRunSha256 = $stoppedDryRunSha256
    executeDryRunSha256 = $executeDryRunSha256
    migrationStartedSha256 = $migrationStartedSha256
    executeReportSha256 = $executeReportSha256
    idempotencyReportSha256 = $idempotencyReportSha256
    migrationCompletedSha256 = $migrationCompletedSha256
    databaseMigrationPerformed = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
    workerEnabled = $true
    businessTunnelRestored = $true
    stableRunnerHashes = $stableRunnerHashes
    apiPid = $apiProcess.pid
    webPid = $webProcess.pid
    stabilitySamples = $stabilitySamples
    workerStabilitySamples = $workerSamples
    publicHealth = $publicHealth
    publicLoginTeams = $publicTeams
  }
  Write-JsonCreateNew $activeEvidencePath $active
  $activeEvidenceSha256 = Get-Sha256 $activeEvidencePath

  $activeMarkerState = [ordered]@{
    status = 'WINDOWS_RECOVERY_RELEASE_ACTIVE'
    activatedAt = $active.activatedAt
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    stagedEvidenceSha256 = $StagedEvidenceSha256
    runtimeInputsSha256 = $runtimeInputsSha256
    appEnvSha256 = $AppEnvSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
    schemaCapabilities = @($expectedSchemaCapability)
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    migrationStartedSha256 = $migrationStartedSha256
    executeReportSha256 = $executeReportSha256
    idempotencyReportSha256 = $idempotencyReportSha256
    migrationCompletedSha256 = $migrationCompletedSha256
    activeEvidenceSha256 = $activeEvidenceSha256
    databaseMigrationPerformed = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
    workerEnabled = $true
    businessTunnelRestored = $true
    stableRunnerHashes = $stableRunnerHashes
    apiPid = $apiProcess.pid
    webPid = $webProcess.pid
    apiAddress = '127.0.0.1'
    webAddress = '127.0.0.1'
  }
  Write-AtomicJson $activeMarker $activeMarkerState
  $activeMarkerSha256 = Get-Sha256 $activeMarker

  $commit = [ordered]@{
    format = 'task-distribution-v2-windows-migration-aware-activation-commit/v1'
    status = 'ACTIVATION_COMMITTED'
    committedAt = (Get-Date).ToUniversalTime().ToString('o')
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    database = $expectedDatabase
    backupId = $BackupId
    backupManifestSha256 = $BackupManifestSha256
    stoppedHandoffSha256 = $StoppedHandoffSha256
    handoffNonce = $HandoffNonce
    runtimeInputsSha256 = $runtimeInputsSha256
    appEnvSha256 = $AppEnvSha256
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
    schemaCapabilities = @($expectedSchemaCapability)
    holdMongoAnchorPath = $holdMongoAnchorPath
    holdMongoAnchorSha256 = $holdMongoAnchorSha256
    executeMongoAnchorPath = $executeMongoAnchorPath
    executeMongoAnchorSha256 = $executeMongoAnchorSha256
    executeClaimSha256 = $executeClaimSha256
    offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
    migrationStartedSha256 = $migrationStartedSha256
    executeReportSha256 = $executeReportSha256
    idempotencyReportSha256 = $idempotencyReportSha256
    migrationCompletedSha256 = $migrationCompletedSha256
    activeEvidenceSha256 = $activeEvidenceSha256
    activeMarkerSha256 = $activeMarkerSha256
    databaseMigrationPerformed = $true
    rollbackReady = $false
    codeOnlyRollbackAllowed = $false
    requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
    workerEnabled = $true
    businessTunnelRestored = $true
    apiPid = $apiProcess.pid
    webPid = $webProcess.pid
    stableRunnerHashes = $stableRunnerHashes
  }
  Write-JsonCreateNew $activationCommitPath $commit
  $active | ConvertTo-Json -Depth 12
}
catch {
  $originalError = $_
  $migrationMayHaveStarted = $migrationStarted -or (Test-Path -LiteralPath $migrationStartedPath -PathType Leaf)
  try {
    if ($Mode -eq 'Execute') {
      Hold-ExecuteFailure -Failure $originalError.Exception.Message -MigrationMayHaveStarted $migrationMayHaveStarted
    }
    elseif ($surfaceStopAttempted -or $surfaceStopped -or $taskActionsChanged) {
      Restore-PreMigrationRuntime $originalError.Exception.Message
    }
  }
  catch {
    throw "$($originalError.Exception.Message); RECOVERY_FAILURE: $($_.Exception.Message)"
  }
  throw $originalError
}
