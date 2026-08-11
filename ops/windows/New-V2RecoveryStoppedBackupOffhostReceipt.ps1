[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$ReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$PreviousReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$')][string]$BackupId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$BackupManifestSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$StoppedHandoffSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$HandoffNonce,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArchiveSha256,
  [Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long]$ExpectedArchiveBytes,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$SourceHost,
  [Parameter(Mandatory = $true)][string]$IndependentCopyRoot,
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ExtractionDirectory,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][string]$SigningPrivateKeyPath,
  [Parameter(Mandatory = $true)][string]$TrustedPublicKeyPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$TrustedPublicKeySha256,
  [string]$NodePath = '',
  [string]$BackupCorePath = '',
  [string]$ConfirmIndependentHost = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedDatabase = 'customer_acceptance_v2_test'
$expectedNodeVersion = 'v22.23.1'

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

function Write-Utf8NoBomCreateNew {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  $parent = Split-Path -Parent $Path
  $null = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot -Candidate $parent -Label 'Receipt parent'
  [void][IO.Directory]::CreateDirectory($parent)
  $null = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot -Candidate $parent -Label 'Receipt parent'
  $null = Assert-NoReparsePointPath -TrustedRoot $TrustedRoot -Candidate $Path -Label 'Receipt output'
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
}

$IndependentCopyRoot = Get-FullPath $IndependentCopyRoot
if ([IO.Path]::GetPathRoot($IndependentCopyRoot).TrimEnd('\') -ne 'E:') {
  throw 'IndependentCopyRoot must be on the independent workstation E: drive'
}
if (-not (Test-Path -LiteralPath $IndependentCopyRoot -PathType Container)) {
  throw "IndependentCopyRoot is missing: $IndependentCopyRoot"
}
$independentDriveRoot = [IO.Path]::GetPathRoot($IndependentCopyRoot)
$null = Assert-NoReparsePointPath -TrustedRoot $independentDriveRoot `
  -Candidate $IndependentCopyRoot -Label 'IndependentCopyRoot'

$ArchivePath = Assert-PathBelow $IndependentCopyRoot $ArchivePath 'ArchivePath'
$ExtractionDirectory = Assert-PathBelow $IndependentCopyRoot $ExtractionDirectory 'ExtractionDirectory'
$ReceiptPath = Assert-PathBelow $IndependentCopyRoot $ReceiptPath 'ReceiptPath'
if ([IO.Path]::GetFileName($ArchivePath) -ne "$BackupId.zip") {
  throw "ArchivePath must end with the final archive name $BackupId.zip"
}
if ([IO.Path]::GetFileName($ReceiptPath) -ne "offhost-verification-$BackupId.json") {
  throw "ReceiptPath must end with offhost-verification-$BackupId.json"
}
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
  throw "Stopped backup ZIP is missing: $ArchivePath"
}
$null = Assert-NoReparsePointPath -TrustedRoot $IndependentCopyRoot `
  -Candidate $ArchivePath -Label 'Stopped backup ZIP'
$null = Assert-NoReparsePointPath -TrustedRoot $IndependentCopyRoot `
  -Candidate $ExtractionDirectory -Label 'ExtractionDirectory'
$null = Assert-NoReparsePointPath -TrustedRoot $IndependentCopyRoot `
  -Candidate $ReceiptPath -Label 'ReceiptPath'
if (Test-Path -LiteralPath $ExtractionDirectory) {
  throw "ExtractionDirectory must not already exist: $ExtractionDirectory"
}
if (Test-Path -LiteralPath $ReceiptPath) {
  throw "ReceiptPath must be a new path: $ReceiptPath"
}

$repositoryRoot = Get-FullPath (Join-Path $PSScriptRoot '..\..')
if (-not $NodePath) {
  $NodePath = Join-Path $repositoryRoot 'tools\runtime\node-v22.23.1-win-x64\node.exe'
}
if (-not $BackupCorePath) {
  $BackupCorePath = Join-Path $repositoryRoot 'ops\lib\backupCore.js'
}
$NodePath = Get-FullPath $NodePath
$BackupCorePath = Get-FullPath $BackupCorePath
$SigningPrivateKeyPath = Get-FullPath $SigningPrivateKeyPath
$TrustedPublicKeyPath = Get-FullPath $TrustedPublicKeyPath
foreach ($tool in @($NodePath, $BackupCorePath, $SigningPrivateKeyPath, $TrustedPublicKeyPath)) {
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Verification tool is missing: $tool" }
  $toolDriveRoot = [IO.Path]::GetPathRoot($tool)
  $null = Assert-NoReparsePointPath -TrustedRoot $toolDriveRoot -Candidate $tool -Label 'Verification tool'
}
if ([IO.Path]::GetPathRoot($SigningPrivateKeyPath).TrimEnd('\') -ne 'E:') {
  throw 'SigningPrivateKeyPath must be on the independent workstation E: drive'
}
if ([IO.Path]::GetPathRoot($TrustedPublicKeyPath).TrimEnd('\') -ne 'E:') {
  throw 'TrustedPublicKeyPath must be on the independent workstation E: drive'
}
if ((Get-Sha256 $TrustedPublicKeyPath) -ne $TrustedPublicKeySha256) {
  throw 'Trusted receipt-signing public key SHA256 mismatch'
}
$nodeVersion = [string](& $NodePath --version)
if ($LASTEXITCODE -ne 0 -or $nodeVersion.Trim() -ne $expectedNodeVersion) {
  throw "Node version must be $expectedNodeVersion"
}

$independentHost = [string]$env:COMPUTERNAME
if (-not $independentHost) { throw 'COMPUTERNAME is unavailable' }
if ($SourceHost.Equals($independentHost, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The receipt generator must run on a workstation independent from SourceHost'
}
if ($ConfirmIndependentHost -ne $independentHost) {
  throw "ConfirmIndependentHost must exactly equal $independentHost"
}

$archive = Get-Item -LiteralPath $ArchivePath -Force
$archiveSha256 = Get-Sha256 $ArchivePath
if ([int64]$archive.Length -ne $ExpectedArchiveBytes) { throw 'Stopped backup ZIP byte length differs from the source evidence' }
if ($archiveSha256 -ne $ExpectedArchiveSha256) { throw 'Stopped backup ZIP SHA256 differs from the source evidence' }

$plan = [ordered]@{
  status = 'OFFHOST_STOPPED_BACKUP_RECEIPT_PLAN_READY'
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  previousReleaseId = $PreviousReleaseId
  previousCommit = $PreviousCommit
  database = $expectedDatabase
  backupId = $BackupId
  independentHost = $independentHost
  sourceHost = $SourceHost
  independentCopyRoot = $IndependentCopyRoot
  archivePath = $ArchivePath
  archiveBytes = [int64]$archive.Length
  archiveSha256 = $archiveSha256
  extractionDirectory = $ExtractionDirectory
  receiptPath = $ReceiptPath
  trustedPublicKeySha256 = $TrustedPublicKeySha256
  writesRequested = [bool]$Apply
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 8
  return
}
if (-not $PSCmdlet.ShouldProcess($ReceiptPath, 'Extract and fully verify the stopped backup ZIP, then create the off-host receipt')) {
  return
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
$entryPlans = New-Object 'Collections.Generic.List[object]'
$seenEntries = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
try {
  foreach ($entry in @($zip.Entries)) {
    $relative = ([string]$entry.FullName).Replace('\', '/')
    if (-not $relative -or $relative.StartsWith('/') -or $relative.Contains(':') -or $relative.Contains([char]0)) {
      throw "Unsafe ZIP entry: $relative"
    }
    $trimmed = $relative.TrimEnd('/')
    if (-not $trimmed) { throw "Unsafe ZIP entry: $relative" }
    $segments = @($trimmed.Split('/'))
    if ($segments[0] -ne $BackupId -or @($segments | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
      throw "ZIP entry is outside the expected backup root: $relative"
    }
    if (-not $seenEntries.Add($relative)) { throw "Duplicate ZIP entry: $relative" }
    $unixType = ([int64]$entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixType -eq 0xA000) { throw "Symbolic-link ZIP entry is forbidden: $relative" }
    $isDirectory = $relative.EndsWith('/')
    $destination = [IO.Path]::GetFullPath((Join-Path $ExtractionDirectory ($trimmed -replace '/', '\')))
    $prefix = (Get-FullPath $ExtractionDirectory) + '\'
    if (-not $destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "ZIP entry escaped the extraction root: $relative"
    }
    $entryPlans.Add([pscustomobject]@{
      entry = $entry
      relative = $relative
      destination = $destination
      isDirectory = $isDirectory
    })
  }
  if ($entryPlans.Count -eq 0) { throw 'Stopped backup ZIP is empty' }
  foreach ($requiredEntry in @("$BackupId/manifest.json", "$BackupId/manifest.sha256")) {
    if (-not $seenEntries.Contains($requiredEntry)) { throw "Stopped backup ZIP is missing $requiredEntry" }
  }

  $null = Assert-NoReparsePointPath -TrustedRoot $IndependentCopyRoot `
    -Candidate $ExtractionDirectory -Label 'ExtractionDirectory'
  [void][IO.Directory]::CreateDirectory($ExtractionDirectory)
  $null = Assert-NoReparsePointPath -TrustedRoot $IndependentCopyRoot `
    -Candidate $ExtractionDirectory -Label 'ExtractionDirectory'
  foreach ($entryPlan in $entryPlans) {
    if ($entryPlan.isDirectory) {
      $null = Assert-NoReparsePointPath -TrustedRoot $ExtractionDirectory `
        -Candidate $entryPlan.destination -Label 'ZIP extraction directory'
      [void][IO.Directory]::CreateDirectory($entryPlan.destination)
      $null = Assert-NoReparsePointPath -TrustedRoot $ExtractionDirectory `
        -Candidate $entryPlan.destination -Label 'ZIP extraction directory'
      continue
    }
    $entryParent = Split-Path -Parent $entryPlan.destination
    $null = Assert-NoReparsePointPath -TrustedRoot $ExtractionDirectory `
      -Candidate $entryParent -Label 'ZIP extraction parent'
    [void][IO.Directory]::CreateDirectory($entryParent)
    $null = Assert-NoReparsePointPath -TrustedRoot $ExtractionDirectory `
      -Candidate $entryParent -Label 'ZIP extraction parent'
    $null = Assert-NoReparsePointPath -TrustedRoot $ExtractionDirectory `
      -Candidate $entryPlan.destination -Label 'ZIP extraction file'
    $inputStream = $entryPlan.entry.Open()
    $outputStream = [IO.File]::Open(
      $entryPlan.destination,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None
    )
    try { $inputStream.CopyTo($outputStream) }
    finally {
      $outputStream.Dispose()
      $inputStream.Dispose()
    }
  }
}
finally { $zip.Dispose() }

$reparse = @(Get-ChildItem -LiteralPath $ExtractionDirectory -Recurse -Force | Where-Object {
  $_.Attributes -band [IO.FileAttributes]::ReparsePoint
})
if ($reparse.Count -ne 0) { throw "Extracted backup contains a reparse point: $($reparse[0].FullName)" }

$extractedBackup = Assert-PathBelow $ExtractionDirectory (Join-Path $ExtractionDirectory $BackupId) 'Extracted backup'
$verifyProgram = @'
const path = require('node:path');
const { verifyBackupSet, verifyFileAssetReferences } = require(process.argv[1]);
verifyBackupSet(process.argv[2], { verifyFiles: true }).then((result) => {
  const manifest = result.manifest;
  const files = manifest.files || [];
  const databaseName = manifest.database && manifest.database.name;
  const fileAssetsCollection = (manifest.database && manifest.database.collections || [])
    .find((entry) => entry && entry.name === 'fileassets' && typeof entry.file === 'string');
  if (!fileAssetsCollection || !databaseName) {
    throw new Error('Backup must contain the fileassets BSON collection for independent FileAsset verification');
  }
  const fileAssetsBsonPath = path.join(
    process.argv[2],
    'database',
    databaseName,
    fileAssetsCollection.file
  );
  const uploadBackupRoot = path.join(process.argv[2], 'uploads');
  return verifyFileAssetReferences({ fileAssetsBsonPath, uploadBackupRoot }).then((fileAssetReferences) => {
    const declaredReferences = manifest.uploads && manifest.uploads.fileAssetReferences;
    if (
      !declaredReferences ||
      Number(declaredReferences.referenced) !== fileAssetReferences.referenced ||
      Number(declaredReferences.verified) !== fileAssetReferences.verified
    ) {
      throw new Error('Backup manifest FileAsset reference counts do not match the BSON/upload verification');
    }
    process.stdout.write(JSON.stringify({
      format: manifest.format,
      backupId: manifest.backupId,
      database: databaseName,
      databaseHosts: manifest.database && manifest.database.hosts,
      databaseServers: manifest.database && manifest.database.servers,
      databaseReplicaSet: manifest.database && manifest.database.replicaSet,
      manifestSha256: result.manifestSha256,
      createdAt: manifest.createdAt,
      completedAt: manifest.completedAt,
      consistency: manifest.consistency,
      uploads: { ...(manifest.uploads || {}), fileAssetReferences },
      fileAssetReferences,
      collectionNames: (manifest.database && manifest.database.collections || []).map((entry) => entry.name),
      fileNames: files.map((entry) => entry.file),
      declaredFileCount: files.length,
      uploadFileEntries: files.filter((entry) => entry.file.startsWith('uploads/')).length
    }));
  });
}).catch((error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
'@
$verificationOutput = @(& $NodePath -e $verifyProgram $BackupCorePath $extractedBackup 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Independent full backup verification failed: $($verificationOutput -join ' ')" }
try { $verified = ($verificationOutput -join "`n") | ConvertFrom-Json }
catch { throw "Independent verification output is invalid JSON: $($_.Exception.Message)" }

$requiredBson = "database/$expectedDatabase/equipmentcategories.bson"
$requiredMetadata = "database/$expectedDatabase/equipmentcategories.metadata.json"
$fileAssetReferencesVerified = (
  $null -ne $verified.fileAssetReferences -and
  [int64]$verified.fileAssetReferences.referenced -eq [int64]$verified.fileAssetReferences.verified
)
if (
  $verified.format -ne 'task-distribution-v2-backup/v1' -or
  $verified.backupId -ne $BackupId -or
  $verified.database -ne $expectedDatabase -or
  @($verified.databaseHosts).Count -ne 1 -or
  $verified.databaseHosts[0] -ne '127.0.0.1' -or
  @($verified.databaseServers).Count -ne 1 -or
  $verified.databaseServers[0] -ne '127.0.0.1:27150' -or
  $verified.databaseReplicaSet -ne 'customer_acceptance_v2_rs' -or
  $verified.manifestSha256 -ne $BackupManifestSha256 -or
  -not (@($verified.collectionNames) -contains 'equipmentcategories') -or
  -not (@($verified.fileNames) -contains $requiredBson) -or
  -not (@($verified.fileNames) -contains $requiredMetadata) -or
  [int64]$verified.uploadFileEntries -ne [int64]$verified.uploads.fileCount -or
  -not $fileAssetReferencesVerified -or
  $verified.consistency.captureMode -ne 'BEST_EFFORT_ONLINE_MONGODUMP' -or
  $verified.consistency.databaseAndUploadsAtomic -ne $false
) { throw 'Independent backup manifest identity, required files, uploads, or consistency contract mismatch' }

$receipt = [ordered]@{
  format = 'task-distribution-v2-windows-stopped-backup-offhost-verification/v1'
  status = 'STOPPED_BACKUP_OFFHOST_VERIFIED'
  verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  previousReleaseId = $PreviousReleaseId
  previousCommit = $PreviousCommit
  database = $expectedDatabase
  databaseTarget = [ordered]@{
    hosts = @($verified.databaseHosts)
    servers = @($verified.databaseServers)
    replicaSet = $verified.databaseReplicaSet
  }
  backupId = $BackupId
  manifestSha256 = $BackupManifestSha256
  manifestCreatedAt = $verified.createdAt
  manifestCompletedAt = $verified.completedAt
  stoppedHandoffSha256 = $StoppedHandoffSha256
  handoffNonce = $HandoffNonce
  sourceHost = $SourceHost
  independentHost = $independentHost
  independentCopyRoot = $IndependentCopyRoot
  independentWorkstationVerified = $true
  archiveFileName = [IO.Path]::GetFileName($ArchivePath)
  archivePath = $ArchivePath
  archiveSha256 = $archiveSha256
  archiveBytes = [int64]$archive.Length
  extractedBackupPath = $extractedBackup
  checks = [ordered]@{
    archiveSha256MatchesSource = $true
    archiveBytesMatchSource = $true
    manifestSha256Valid = $true
    exactFileSetValid = $true
    everyDeclaredFileSha256Valid = $true
    requiredCollectionDumpsPresent = $true
    requiredMetadataPresent = $true
    uploadsManifestVerified = $true
    fileAssetReferencesVerified = $true
  }
  consistency = [ordered]@{
    captureMode = $verified.consistency.captureMode
    databaseAndUploadsAtomic = $false
  }
  verification = [ordered]@{
    nodeVersion = $nodeVersion.Trim()
    nodeSha256 = Get-Sha256 $NodePath
    backupCoreSha256 = Get-Sha256 $BackupCorePath
    receiptGeneratorSha256 = Get-Sha256 $PSCommandPath
    trustedPublicKeySha256 = $TrustedPublicKeySha256
    zipEntryCount = $entryPlans.Count
    declaredFileCount = [int64]$verified.declaredFileCount
    uploadFileCount = [int64]$verified.uploads.fileCount
    fileAssetReferences = $verified.fileAssetReferences
  }
}
$payloadText = "$(ConvertTo-Json $receipt -Depth 12)`n"
$payloadBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($payloadText)
$privateKey = New-Object Security.Cryptography.RSACryptoServiceProvider
$publicKey = New-Object Security.Cryptography.RSACryptoServiceProvider
try {
  $privateKey.PersistKeyInCsp = $false
  $publicKey.PersistKeyInCsp = $false
  $privateKey.FromXmlString([IO.File]::ReadAllText($SigningPrivateKeyPath))
  $publicKey.FromXmlString([IO.File]::ReadAllText($TrustedPublicKeyPath))
  if ($privateKey.PublicOnly -or $privateKey.KeySize -ne 3072) {
    throw 'Signing private key must be an RSA-3072 private key'
  }
  if (-not $publicKey.PublicOnly -or $publicKey.KeySize -ne 3072) {
    throw 'Trusted receipt public key must be a public-only RSA-3072 key'
  }
  $hashOid = [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256')
  $signatureBytes = $privateKey.SignData($payloadBytes, $hashOid)
  if (-not $publicKey.VerifyData($payloadBytes, $hashOid, $signatureBytes)) {
    throw 'Receipt signing private key does not match the trusted public key'
  }
}
finally {
  $privateKey.Dispose()
  $publicKey.Dispose()
}
$envelope = [ordered]@{
  format = 'task-distribution-v2-windows-stopped-backup-offhost-signed-envelope/v2'
  signatureAlgorithm = 'RSA-SHA256-PKCS1-v1_5'
  publicKeySha256 = $TrustedPublicKeySha256
  signedPayloadSha256 = Get-BytesSha256 $payloadBytes
  signedPayloadUtf8Base64 = [Convert]::ToBase64String($payloadBytes)
  signatureBase64 = [Convert]::ToBase64String($signatureBytes)
}
Write-Utf8NoBomCreateNew -TrustedRoot $IndependentCopyRoot `
  -Path $ReceiptPath -Value "$(ConvertTo-Json $envelope -Depth 5)`n"
[ordered]@{
  status = 'STOPPED_BACKUP_OFFHOST_RECEIPT_CREATED'
  receiptPath = $ReceiptPath
  receiptSha256 = Get-Sha256 $ReceiptPath
  archiveSha256 = $archiveSha256
  archiveBytes = [int64]$archive.Length
  extractedBackupPath = $extractedBackup
  signedEnvelope = $envelope
  receipt = $receipt
} | ConvertTo-Json -Depth 12
