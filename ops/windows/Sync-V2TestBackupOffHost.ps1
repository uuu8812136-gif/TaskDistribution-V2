[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [string]$CopyScript = 'C:\ProgramData\LinuxBackup\Copy-V2TestBackupOffHost.ps1',
  [string]$IdentityFile = 'C:\ProgramData\LinuxBackup\linux-backup-key-system',
  [string]$KnownHostsFile = 'C:\ProgramData\LinuxBackup\known_hosts',
  [string]$DestinationRoot = 'C:\ServerBackups\TaskDistribution-V2-Test',
  [string]$SourceVmRoot = 'E:\ServerVM',
  [ValidateRange(1, 65535)][int]$LinuxPort = 22022,
  [ValidateRange(1, 365)][int]$DailyKeep = 7,
  [ValidateRange(0, 104)][int]$WeeklyKeep = 4,
  [ValidateRange(1, 720)][int]$MaximumAgeHours = 26,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ExpectedInstance = 'task-distribution-v2-customer-test'
$ExpectedDatabase = 'customer_acceptance_v2_test'
$HandoffFormat = 'task-distribution-v2-scheduled-backup-handoff/v1'
$ReceiptFormat = 'task-distribution-v2-offhost-backup-receipt/v1'

trap {
  $failureRoot = 'C:\ProgramData\LinuxBackup\logs'
  New-Item -ItemType Directory -Force -Path $failureRoot -ErrorAction SilentlyContinue | Out-Null
  $failure = [ordered]@{
    Status = 'OFFHOST_SYNC_FAILED'
    FailedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Message = $_.Exception.Message
    Category = [string]$_.CategoryInfo.Category
    ScriptLine = $_.InvocationInfo.ScriptLineNumber
  }
  [IO.File]::AppendAllText(
    (Join-Path $failureRoot 'v2-offhost-sync-failures.jsonl'),
    "$(($failure | ConvertTo-Json -Compress))`n",
    (New-Object Text.UTF8Encoding($false))
  )
  Write-Error $_
  exit 1
}

function Write-JsonAtomic {
  param([string]$Path, [object]$Value)
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, "$json`n", (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Get-LocalVolumeIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute local path" }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $pathRoot = [IO.Path]::GetPathRoot($fullPath)
  if ($pathRoot -notmatch '^([A-Za-z]):\\$') { throw "$Label must use a local drive letter" }
  $driveLetter = $Matches[1].ToUpperInvariant()
  $drive = Get-PSDrive -Name $driveLetter -PSProvider FileSystem -ErrorAction Stop
  if (-not $drive.Root.Equals("${driveLetter}:\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must resolve to a local filesystem drive"
  }
  $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
  return [pscustomobject]@{
    FullPath = $fullPath
    DriveLetter = $driveLetter
    Volume = "${driveLetter}:"
    DiskNumber = [int]$partition.DiskNumber
  }
}

function Get-VerifiedOffHostRecord {
  param([IO.DirectoryInfo]$Directory)
  if ($Directory.Name -notmatch '^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$') { return $null }
  $manifestPath = Join-Path $Directory.FullName 'manifest.json'
  $digestPath = Join-Path $Directory.FullName 'manifest.sha256'
  $receiptPath = Join-Path (Join-Path $DestinationRoot 'receipts') "$($Directory.Name).json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $digestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $null }
  try {
    $actualSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $digest = ([IO.File]::ReadAllText($digestPath)).Trim()
    if ($digest -notmatch '^([a-fA-F0-9]{64})\s+manifest\.json$' -or
        $Matches[1].ToLowerInvariant() -ne $actualSha) { return $null }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $receipt = [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json
    $completedAt = [DateTimeOffset]::MinValue
    if ($manifest.format -ne 'task-distribution-v2-backup/v1' -or
        $manifest.backupId -ne $Directory.Name -or
        $manifest.database.name -ne $ExpectedDatabase -or
        -not [DateTimeOffset]::TryParse([string]$manifest.completedAt, [ref]$completedAt) -or
        $receipt.format -ne $ReceiptFormat -or
        $receipt.instance -ne $ExpectedInstance -or
        $receipt.database -ne $ExpectedDatabase -or
        $receipt.backupId -ne $Directory.Name -or
        [string]$receipt.manifestSha256 -cne $actualSha -or
        $receipt.destinationVolume -ne ([IO.Path]::GetPathRoot($Directory.FullName).TrimEnd('\')) -or
        -not ([IO.Path]::GetFullPath([string]$receipt.destinationDirectory)).Equals(
          [IO.Path]::GetFullPath($Directory.FullName),
          [StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$receipt.sourceVmVolume -notmatch '^[A-Z]:$' -or
        $receipt.sourceVmVolume -eq $receipt.destinationVolume -or
        $null -eq $receipt.destinationDiskNumber -or
        $null -eq $receipt.sourceVmDiskNumber -or
        [int]$receipt.destinationDiskNumber -eq [int]$receipt.sourceVmDiskNumber -or
        $receipt.physicalDiskSeparated -ne $true) { return $null }
    return [pscustomobject]@{
      BackupId = $Directory.Name
      Directory = $Directory.FullName
      CompletedAt = $completedAt
      ManifestSha256 = $actualSha
      RetentionTags = @($manifest.retentionTags)
    }
  }
  catch { return $null }
}

function Invoke-OffHostRetention {
  $records = @(Get-ChildItem -LiteralPath $DestinationRoot -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-VerifiedOffHostRecord -Directory $_ } |
    Where-Object { $null -ne $_ } |
    Sort-Object CompletedAt -Descending)
  $keep = @{}
  foreach ($record in @($records | Select-Object -First $DailyKeep)) {
    $keep[$record.BackupId] = $true
  }
  $weeklyCount = 0
  foreach ($record in $records) {
    if ($weeklyCount -ge $WeeklyKeep) { break }
    if ($record.RetentionTags -contains 'weekly') {
      $keep[$record.BackupId] = $true
      $weeklyCount++
    }
  }
  $deleted = @()
  $rootFull = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  foreach ($record in $records) {
    if ($keep.ContainsKey($record.BackupId)) { continue }
    $candidate = [IO.Path]::GetFullPath($record.Directory)
    if ([IO.Path]::GetDirectoryName($candidate) -ne $rootFull) {
      throw "Retention candidate escaped the backup root: $candidate"
    }
    Remove-Item -LiteralPath $candidate -Recurse -Force
    Remove-Item -LiteralPath (Join-Path (Join-Path $DestinationRoot 'receipts') "$($record.BackupId).json") -Force
    $deleted += $record.BackupId
  }
  return [pscustomobject]@{
    DailyKeep = $DailyKeep
    WeeklyKeep = $WeeklyKeep
    VerifiedRecords = $records.Count
    Kept = @($keep.Keys | Sort-Object)
    Deleted = $deleted
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }

foreach ($path in @($CopyScript, $IdentityFile, $KnownHostsFile)) {
  if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required absolute file is missing: $path"
  }
}
$destinationIdentity = Get-LocalVolumeIdentity -Path $DestinationRoot -Label 'DestinationRoot'
$sourceVmIdentity = Get-LocalVolumeIdentity -Path $SourceVmRoot -Label 'SourceVmRoot'
$destinationFull = $destinationIdentity.FullPath
if ($destinationIdentity.DiskNumber -eq $sourceVmIdentity.DiskNumber) {
  throw 'DestinationRoot must be on a different physical disk from SourceVmRoot'
}

$plan = [ordered]@{
  Status = 'DRY_RUN_READY'
  Action = 'discover-copy-verify-retain-v2-test-backup'
  DestinationRoot = $destinationFull
  DestinationVolume = $destinationIdentity.Volume
  DestinationDiskNumber = $destinationIdentity.DiskNumber
  SourceVmVolume = $sourceVmIdentity.Volume
  SourceVmDiskNumber = $sourceVmIdentity.DiskNumber
  PhysicalDiskSeparated = $true
  DailyKeep = $DailyKeep
  WeeklyKeep = $WeeklyKeep
  MaximumAgeHours = $MaximumAgeHours
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 4
  return
}
if (-not $PSCmdlet.ShouldProcess($DestinationRoot, 'Discover and synchronize the latest V2 test backup')) { return }

New-Item -ItemType Directory -Force -Path $destinationFull, (Join-Path $destinationFull 'logs') | Out-Null
$ssh = (Get-Command 'C:\Windows\System32\OpenSSH\ssh.exe' -ErrorAction Stop).Source
$remoteCommand = @'
set -eu
result="$(systemctl show taskdistribution-v2-test-backup.service -p Result --value)"
status="$(systemctl show taskdistribution-v2-test-backup.service -p ExecMainStatus --value)"
latest="$(find /mnt/taskdistribution-v2-test-backup/handoffs -maxdepth 1 -type f -name 'backup-*.json' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
test -n "$latest"
printf '%s|%s\n' "$result" "$status"
base64 -w0 "$latest"
printf '\n'
'@
$sshArguments = @(
  '-p', [string]$LinuxPort,
  '-i', $IdentityFile,
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', "UserKnownHostsFile=$KnownHostsFile",
  '-o', 'ConnectTimeout=20',
  'serveradmin@127.0.0.1',
  $remoteCommand
)
$stderrPath = Join-Path (Join-Path $destinationFull 'logs') 'scheduled-sync-ssh.stderr.log'
$discoveryOutput = @(& $ssh @sshArguments 2> $stderrPath)
if ($LASTEXITCODE -ne 0 -or $discoveryOutput.Count -lt 2) {
  $detail = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath).Trim() } else { '' }
  throw "Unable to discover the latest Linux backup handoff: $detail"
}
$serviceFields = [string]$discoveryOutput[0] -split '\|', 2
if ($serviceFields.Count -ne 2 -or $serviceFields[0] -ne 'success' -or $serviceFields[1] -ne '0') {
  throw "Latest Linux backup service did not succeed: $($discoveryOutput[0])"
}
try {
  $handoffJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$discoveryOutput[1]))
  $handoff = $handoffJson | ConvertFrom-Json
}
catch { throw 'Linux backup handoff is not valid base64 JSON' }

$completedAt = [DateTimeOffset]::MinValue
if ($handoff.format -ne $HandoffFormat -or
    $handoff.backupId -notmatch '^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$' -or
    $handoff.sourceReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$' -or
    $handoff.manifestSha256 -notmatch '^[a-f0-9]{64}$' -or
    $handoff.database -ne $ExpectedDatabase -or
    -not [DateTimeOffset]::TryParse([string]$handoff.completedAt, [ref]$completedAt)) {
  throw 'Linux backup handoff failed validation'
}
$age = [DateTimeOffset]::Now - $completedAt
if ($age.TotalMinutes -lt -5 -or $age.TotalHours -gt $MaximumAgeHours) {
  throw "Latest Linux backup is outside the freshness window: $([math]::Round($age.TotalHours, 2)) hours"
}
if ((Get-Date).Hour -ge 4 -and $completedAt.ToLocalTime().Date -ne (Get-Date).Date) {
  throw 'No Linux backup completed on the current local date'
}

$existingDirectory = Get-Item -LiteralPath (Join-Path $destinationFull $handoff.backupId) -ErrorAction SilentlyContinue
$existing = if ($existingDirectory -is [IO.DirectoryInfo]) {
  Get-VerifiedOffHostRecord -Directory $existingDirectory
} else { $null }
$downloadPerformed = $false
if ($existing -and $existing.ManifestSha256 -ceq [string]$handoff.manifestSha256) {
  $copyStatus = 'OFFHOST_BACKUP_CURRENT'
}
else {
  $copyResultText = & $CopyScript `
    -BackupId $handoff.backupId `
    -ExpectedManifestSha256 $handoff.manifestSha256 `
    -SourceReleaseId $handoff.sourceReleaseId `
    -IdentityFile $IdentityFile `
    -KnownHostsFile $KnownHostsFile `
    -DestinationRoot $destinationFull `
    -SourceVmRoot $sourceVmIdentity.FullPath `
    -RemoteReceiptPath "/tmp/v2-test-offhost-$($handoff.backupId).json" `
    -Apply `
    -ConfirmInstance $ExpectedInstance `
    -Confirm:$false
  $copyResult = ($copyResultText -join "`n") | ConvertFrom-Json
  if ($copyResult.Status -ne 'OFFHOST_BACKUP_VERIFIED') {
    throw "Unexpected off-host copy status: $($copyResult.Status)"
  }
  $downloadPerformed = [bool]$copyResult.DownloadPerformed
  $copyStatus = $copyResult.Status
}

$retention = Invoke-OffHostRetention
$result = [ordered]@{
  Status = 'OFFHOST_SYNC_VERIFIED'
  CompletedAt = [DateTimeOffset]::UtcNow.ToString('o')
  BackupId = [string]$handoff.backupId
  SourceReleaseId = [string]$handoff.sourceReleaseId
  ManifestSha256 = [string]$handoff.manifestSha256
  BackupCompletedAt = $completedAt.ToUniversalTime().ToString('o')
  CopyStatus = $copyStatus
  DownloadPerformed = $downloadPerformed
  Retention = $retention
}
$logPath = Join-Path (Join-Path $destinationFull 'logs') 'scheduled-sync-results.jsonl'
[IO.File]::AppendAllText($logPath, "$(($result | ConvertTo-Json -Depth 8 -Compress))`n", (New-Object Text.UTF8Encoding($false)))
Write-JsonAtomic -Path (Join-Path (Join-Path $destinationFull 'logs') 'scheduled-sync-latest.json') -Value $result
$result | ConvertTo-Json -Depth 8
