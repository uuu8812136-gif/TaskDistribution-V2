[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$BackupId,
  [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
  [Parameter(Mandatory = $true)][string]$SourceReleaseId,
  [Parameter(Mandatory = $true)][string]$IdentityFile,
  [Parameter(Mandatory = $true)][string]$KnownHostsFile,
  [string]$LinuxHost = '127.0.0.1',
  [ValidateRange(1, 65535)][int]$LinuxPort = 22022,
  [string]$LinuxUser = 'serveradmin',
  [string]$RemoteBackupRoot = '/mnt/taskdistribution-v2-test-backup/backups',
  [string]$DestinationRoot = 'D:\ServerBackups\TaskDistribution-V2-Test',
  [string]$RemoteReceiptPath = '',
  [string]$ConfirmInstance = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ExpectedInstance = 'task-distribution-v2-customer-test'
$ExpectedDatabase = 'customer_acceptance_v2_test'
$ReceiptFormat = 'task-distribution-v2-offhost-backup-receipt/v1'
$RequiredMigrationCollections = @(
  'projectteams',
  'orgunits',
  'users',
  'teammemberships',
  'transportrecords',
  'equipmentassets',
  'equipmentroutineplans',
  'productionschedules',
  'attendancesubmissions',
  'attendancedailyreviews',
  'generateddailyreports'
)

function Assert-SafeRelativePath {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Relative)
  if (
    [string]::IsNullOrWhiteSpace($Relative) -or
    $Relative.StartsWith('/') -or
    $Relative.StartsWith('\') -or
    $Relative.Contains('\')
  ) {
    throw "Unsafe manifest path: $Relative"
  }
  $segments = $Relative.Split('/')
  if ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) {
    throw "Unsafe manifest path: $Relative"
  }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $candidate = [IO.Path]::GetFullPath((Join-Path $rootFull ($Relative -replace '/', '\')))
  if (-not $candidate.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Manifest path escapes backup root: $Relative"
  }
  return $candidate
}

function Assert-BackupSet {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$ManifestSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedBackupId
  )
  $manifestPath = Join-Path $Directory 'manifest.json'
  $digestPath = Join-Path $Directory 'manifest.sha256'
  foreach ($required in @($manifestPath, $digestPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Backup file missing: $required" }
  }

  $digestLine = ([IO.File]::ReadAllText($digestPath)).Trim()
  if ($digestLine -notmatch '^([a-fA-F0-9]{64})\s+manifest\.json$') {
    throw 'manifest.sha256 has an invalid format'
  }
  $declaredManifestSha256 = $Matches[1].ToLowerInvariant()
  $actualManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($declaredManifestSha256 -ne $actualManifestSha256) { throw 'manifest.json SHA256 mismatch' }
  if ($actualManifestSha256 -ne $ManifestSha256.ToLowerInvariant()) {
    throw 'Manifest SHA256 does not match the Linux handoff'
  }

  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  if ($manifest.format -ne 'task-distribution-v2-backup/v1') { throw 'Unexpected backup manifest format' }
  if ($manifest.backupId -ne $ExpectedBackupId) { throw 'Backup id mismatch' }
  if ($manifest.database.name -ne $ExpectedDatabase) { throw 'Backup database mismatch' }
  if ($null -eq $manifest.files) { throw 'Backup manifest files are missing' }

  $declaredFiles = @{}
  foreach ($entry in @($manifest.files)) {
    $relative = [string]$entry.file
    if ($declaredFiles.ContainsKey($relative)) { throw "Duplicate manifest file: $relative" }
    if ([string]$entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Invalid file SHA256: $relative" }
    $artifact = Assert-SafeRelativePath -Root $Directory -Relative $relative
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Declared file missing: $relative" }
    $fileInfo = Get-Item -LiteralPath $artifact
    if ([int64]$fileInfo.Length -ne [int64]$entry.bytes) { throw "File size mismatch: $relative" }
    $actual = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne [string]$entry.sha256) { throw "File SHA256 mismatch: $relative" }
    $declaredFiles[$relative] = $true
  }

  $rootFull = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $actualFiles = @{}
  $reparsePoints = @(Get-ChildItem -LiteralPath $Directory -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($reparsePoints.Count) { throw "Backup contains a reparse point: $($reparsePoints[0].FullName)" }
  Get-ChildItem -LiteralPath $Directory -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
    if ($relative -notin @('manifest.json', 'manifest.sha256')) { $actualFiles[$relative] = $true }
  }
  $undeclared = @($actualFiles.Keys | Where-Object { -not $declaredFiles.ContainsKey($_) })
  $missing = @($declaredFiles.Keys | Where-Object { -not $actualFiles.ContainsKey($_) })
  if ($undeclared.Count -or $missing.Count) {
    throw "Backup file set mismatch; undeclared=$($undeclared.Count), missing=$($missing.Count)"
  }

  foreach ($collection in $RequiredMigrationCollections) {
    $requiredDump = "database/$ExpectedDatabase/$collection.bson"
    if (-not $declaredFiles.ContainsKey($requiredDump)) { throw "Required migration dump missing: $requiredDump" }
  }
  return [pscustomobject]@{
    Manifest = $manifest
    ManifestSha256 = $actualManifestSha256
    FileCount = $declaredFiles.Count
  }
}

function Test-OffHostReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$ExpectedBackupId,
    [Parameter(Mandatory = $true)][string]$ManifestSha256,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [Parameter(Mandatory = $true)][int]$FileCount
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $receipt = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $collections = @($receipt.requiredMigrationCollections)
    $verifiedAt = [DateTimeOffset]::MinValue
    $hasValidVerifiedAt = [DateTimeOffset]::TryParse([string]$receipt.verifiedAt, [ref]$verifiedAt) -and
      $verifiedAt -le [DateTimeOffset]::UtcNow.AddMinutes(5)
    if (
      $receipt.format -ne $ReceiptFormat -or
      -not $hasValidVerifiedAt -or
      $receipt.instance -ne $ExpectedInstance -or
      $receipt.database -ne $ExpectedDatabase -or
      $receipt.releaseId -ne $ReleaseId -or
      $receipt.backupId -ne $ExpectedBackupId -or
      [string]$receipt.manifestSha256 -cne $ManifestSha256 -or
      $receipt.destinationVolume -ne 'D:' -or
      -not ([IO.Path]::GetFullPath([string]$receipt.destinationDirectory)).Equals(
        [IO.Path]::GetFullPath($DestinationDirectory),
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      [int]$receipt.fileCount -ne $FileCount -or
      $collections.Count -ne $RequiredMigrationCollections.Count -or
      (Compare-Object -ReferenceObject $RequiredMigrationCollections -DifferenceObject $collections -SyncWindow 0)
    ) {
      return $false
    }
    return $true
  }
  catch {
    return $false
  }
}

function Write-OffHostReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ReleaseId,
    [Parameter(Mandatory = $true)][string]$ExpectedBackupId,
    [Parameter(Mandatory = $true)][string]$ManifestSha256,
    [Parameter(Mandatory = $true)][string]$DestinationDirectory,
    [Parameter(Mandatory = $true)][int]$FileCount
  )
  $receipt = [ordered]@{
    format = $ReceiptFormat
    verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
    instance = $ExpectedInstance
    database = $ExpectedDatabase
    releaseId = $ReleaseId
    backupId = $ExpectedBackupId
    manifestSha256 = $ManifestSha256
    destinationVolume = 'D:'
    destinationDirectory = $DestinationDirectory
    fileCount = $FileCount
    requiredMigrationCollections = @($RequiredMigrationCollections)
  }
  $temporaryPath = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $receipt | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($temporaryPath, "$json`n", (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

if ($BackupId -notmatch '^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$') { throw 'BackupId is invalid' }
if ($ExpectedManifestSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'ExpectedManifestSha256 is invalid' }
if ($SourceReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$') { throw 'SourceReleaseId is invalid' }
if (-not [IO.Path]::IsPathRooted($IdentityFile)) { throw 'IdentityFile must be absolute' }
if (-not [IO.Path]::IsPathRooted($KnownHostsFile)) { throw 'KnownHostsFile must be absolute' }
if (-not [IO.Path]::IsPathRooted($DestinationRoot)) { throw 'DestinationRoot must be absolute' }
$destinationFull = [IO.Path]::GetFullPath($DestinationRoot)
if (-not $destinationFull.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'DestinationRoot must be on the physical-host D: backup disk'
}
if ($RemoteBackupRoot -notmatch '^/mnt/taskdistribution-v2-test-backup/backups$') {
  throw 'RemoteBackupRoot must be the isolated V2 backup mount'
}
if ($LinuxHost -ne '127.0.0.1') {
  throw 'LinuxHost must remain 127.0.0.1 so the copy uses the physical host local VM port'
}
if (-not $RemoteReceiptPath) { $RemoteReceiptPath = "/tmp/v2-test-offhost-$BackupId.json" }
if ($RemoteReceiptPath -notmatch '^/tmp/v2-test-offhost-backup-[A-Za-z0-9._-]+\.json$' -and
    $RemoteReceiptPath -ne "/tmp/v2-test-offhost-$BackupId.json") {
  throw 'RemoteReceiptPath must be a dedicated /tmp V2 receipt path'
}

$plan = [pscustomobject]@{
  Status = 'DRY_RUN_READY'
  Action = 'copy-and-verify-v2-backup-off-host'
  BackupId = $BackupId
  Source = "${LinuxUser}@${LinuxHost}:$RemoteBackupRoot/$BackupId"
  Destination = (Join-Path $destinationFull $BackupId)
  ExpectedManifestSha256 = $ExpectedManifestSha256.ToLowerInvariant()
  RemoteReceiptPath = $RemoteReceiptPath
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 4
  return
}
if ($ConfirmInstance -ne $ExpectedInstance) {
  throw "ConfirmInstance must equal $ExpectedInstance"
}
foreach ($file in @($IdentityFile, $KnownHostsFile)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required SSH file missing: $file" }
}
$destinationDrive = Get-PSDrive -Name D -PSProvider FileSystem -ErrorAction Stop
if (-not $destinationDrive.Root.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The D: backup destination is not a local filesystem drive'
}
$systemDriveLetter = ([string]$env:SystemDrive).TrimEnd(':')
if ($systemDriveLetter -eq 'D') { throw 'D: is the Windows system drive and cannot be used' }
$destinationPartition = Get-Partition -DriveLetter D -ErrorAction Stop
$systemPartition = Get-Partition -DriveLetter $systemDriveLetter -ErrorAction Stop
if ($destinationPartition.DiskNumber -eq $systemPartition.DiskNumber) {
  throw 'D: must be a different physical disk from the Windows system volume'
}
$scp = (Get-Command 'C:\Windows\System32\OpenSSH\scp.exe' -ErrorAction Stop).Source
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$incomingParent = Join-Path $destinationFull ".incoming-$BackupId-$timestamp"
$finalDirectory = Join-Path $destinationFull $BackupId
$receiptRoot = Join-Path $destinationFull 'receipts'
$logRoot = Join-Path $destinationFull 'logs'
$finalBackupExists = Test-Path -LiteralPath $finalDirectory -PathType Container
if ((Test-Path -LiteralPath $finalDirectory) -and -not $finalBackupExists) {
  throw "Final backup path is not a directory: $finalDirectory"
}
if (-not $finalBackupExists -and (Test-Path -LiteralPath $incomingParent)) {
  throw "Incoming path already exists: $incomingParent"
}

if ($finalBackupExists) {
  $processDescription = "Reverify $finalDirectory and upload its off-host receipt"
}
else {
  $processDescription = "Copy to $finalDirectory, verify every declared file, and upload its off-host receipt"
}
if ($PSCmdlet.ShouldProcess($plan.Source, $processDescription)) {
  New-Item -ItemType Directory -Force -Path $destinationFull, $receiptRoot, $logRoot | Out-Null
  $downloadPerformed = $false
  if ($finalBackupExists) {
    $verified = Assert-BackupSet -Directory $finalDirectory `
      -ManifestSha256 $ExpectedManifestSha256 -ExpectedBackupId $BackupId
  }
  else {
    New-Item -ItemType Directory -Path $incomingParent | Out-Null
    $stdout = Join-Path $logRoot "scp-$BackupId-$timestamp.stdout.log"
    $stderr = Join-Path $logRoot "scp-$BackupId-$timestamp.stderr.log"
    $remoteSource = "${LinuxUser}@${LinuxHost}:$RemoteBackupRoot/$BackupId"
    $scpArgs = @(
      '-q', '-r', '-P', [string]$LinuxPort,
      '-i', $IdentityFile,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', "UserKnownHostsFile=$KnownHostsFile",
      '-o', 'ConnectTimeout=20',
      $remoteSource,
      $incomingParent
    )
    $copy = Start-Process -FilePath $scp -ArgumentList $scpArgs -Wait -PassThru -NoNewWindow `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($copy.ExitCode -ne 0) { throw "SCP failed; inspect $stderr" }

    $incomingBackup = Join-Path $incomingParent $BackupId
    if (-not (Test-Path -LiteralPath $incomingBackup -PathType Container)) {
      throw "Transferred backup directory missing: $incomingBackup"
    }
    $verified = Assert-BackupSet -Directory $incomingBackup `
      -ManifestSha256 $ExpectedManifestSha256 -ExpectedBackupId $BackupId
    Move-Item -LiteralPath $incomingBackup -Destination $finalDirectory
    Remove-Item -LiteralPath $incomingParent -Force
    $downloadPerformed = $true
  }

  $receiptPath = Join-Path $receiptRoot "$BackupId.json"
  $receiptReused = Test-OffHostReceipt -Path $receiptPath -ReleaseId $SourceReleaseId `
    -ExpectedBackupId $BackupId -ManifestSha256 $verified.ManifestSha256 `
    -DestinationDirectory $finalDirectory -FileCount $verified.FileCount
  if (-not $receiptReused) {
    Write-OffHostReceipt -Path $receiptPath -ReleaseId $SourceReleaseId `
      -ExpectedBackupId $BackupId -ManifestSha256 $verified.ManifestSha256 `
      -DestinationDirectory $finalDirectory -FileCount $verified.FileCount
  }

  $receiptStdout = Join-Path $logRoot "receipt-$BackupId-$timestamp.stdout.log"
  $receiptStderr = Join-Path $logRoot "receipt-$BackupId-$timestamp.stderr.log"
  $uploadArgs = @(
    '-q', '-P', [string]$LinuxPort,
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$KnownHostsFile",
    '-o', 'ConnectTimeout=20',
    $receiptPath,
    "${LinuxUser}@${LinuxHost}:$RemoteReceiptPath"
  )
  $upload = Start-Process -FilePath $scp -ArgumentList $uploadArgs -Wait -PassThru -NoNewWindow `
    -RedirectStandardOutput $receiptStdout -RedirectStandardError $receiptStderr
  if ($upload.ExitCode -ne 0) { throw "Receipt upload failed; inspect $receiptStderr" }

  [pscustomobject]@{
    Status = 'OFFHOST_BACKUP_VERIFIED'
    BackupId = $BackupId
    ManifestSha256 = $verified.ManifestSha256
    Destination = $finalDirectory
    Receipt = $receiptPath
    RemoteReceipt = $RemoteReceiptPath
    DownloadPerformed = $downloadPerformed
    ReceiptReused = $receiptReused
  } | ConvertTo-Json -Depth 4
}
