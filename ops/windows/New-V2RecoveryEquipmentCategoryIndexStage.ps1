[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$ReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$PreviousReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousCommit,
  [Parameter(Mandatory = $true)][string]$ReleaseArchivePath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedReleaseArchiveSha256,
  [Parameter(Mandatory = $true)][string]$ArtifactManifestPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedArtifactManifestSha256,
  [Parameter(Mandatory = $true)][string]$PredeployBackupReceiptPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPredeployBackupReceiptSha256,
  [Parameter(Mandatory = $true)][string]$OperationsEnvPath,
  [string]$RecoveryRoot = 'C:\TaskDistribution-V2\Recovery',
  [string]$ConfirmInstance = '',
  [string]$ConfirmReleaseId = '',
  [string]$ConfirmPreviousReleaseId = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$expectedConfirmationInstance = 'task-distribution-v2-customer-test'
$expectedDatabase = 'customer_acceptance_v2_test'
$expectedReplicaSet = 'customer_acceptance_v2_rs'
$expectedNodeVersion = 'v22.23.1'
$expectedNpmVersion = '10.9.8'
$expectedSchemaCapability = 'equipment-category-parent-name-index-v1'
$trustedPublicKeyRelativePath = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
$mongoTargetGuardRelativePath = 'ops/lib/v2TestMongoTargetGuard.js'
$stageFormat = 'task-distribution-v2-windows-recovery-stage/v1'

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
  $prefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
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
  $prefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (
    $candidateFull -ne $rootFull -and
    -not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
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

function Assert-LocalFilePath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path" }
  $full = Get-FullPath $Path
  $driveRoot = [IO.Path]::GetPathRoot($full)
  if ($driveRoot -cnotmatch '^[A-Za-z]:\\$') { throw "$Label must use a local Windows drive" }
  $null = Assert-NoReparsePointPath -TrustedRoot $driveRoot -Candidate $full -Label $Label
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$Label is missing: $full" }
  return $full
}

function Assert-NoReparsePointTree {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "$Label is missing: $Root" }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Label contains a reparse point: $Root"
  }
  $reparse = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($reparse.Count -ne 0) { throw "$Label contains a reparse point: $($reparse[0].FullName)" }
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

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
  catch { throw "$Label is not valid JSON: $($_.Exception.Message)" }
}

function Assert-ExactPropertyOrder {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
  if ($actual.Count -ne $Expected.Count) {
    throw "$Label property count mismatch: expected=$($Expected.Count) actual=$($actual.Count)"
  }
  for ($index = 0; $index -lt $Expected.Count; $index++) {
    if ($actual[$index] -cne $Expected[$index]) {
      throw "$Label property order mismatch at ${index}: expected=$($Expected[$index]) actual=$($actual[$index])"
    }
  }
}

function Assert-UtcTimestamp {
  param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Label)
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Value, [ref]$parsed)) { throw "$Label is invalid" }
  if ($parsed -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw "$Label is in the future" }
  return $parsed
}

function Get-RelativePath {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Path)
  $rootFull = Get-FullPath $Root
  $pathFull = Get-FullPath $Path
  $prefix = "$rootFull\"
  if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path escaped root: $pathFull"
  }
  return $pathFull.Substring($prefix.Length).Replace('\', '/')
}

function Get-DirectoryTreeIdentity {
  param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Label)
  Assert-NoReparsePointTree -Root $Root -Label $Label
  $byRelativePath = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)) {
    $relative = Get-RelativePath -Root $Root -Path $file.FullName
    $key = $relative.ToLowerInvariant()
    if ($byRelativePath.ContainsKey($key)) { throw "$Label contains a duplicate Windows path: $relative" }
    $byRelativePath[$key] = [pscustomobject]@{ Relative = $relative; File = $file }
  }
  if ($byRelativePath.Count -eq 0) { throw "$Label is empty" }
  [string[]]$keys = @($byRelativePath.Keys)
  [Array]::Sort($keys, [StringComparer]::Ordinal)
  $lines = New-Object Text.StringBuilder
  [int64]$totalBytes = 0
  foreach ($key in $keys) {
    $entry = $byRelativePath[$key]
    $totalBytes += [int64]$entry.File.Length
    $sha256 = Get-Sha256 $entry.File.FullName
    [void]$lines.Append($entry.Relative).Append("`t").Append([int64]$entry.File.Length).
      Append("`t").Append($sha256).Append("`n")
  }
  return [pscustomobject][ordered]@{
    fileCount = [int]$byRelativePath.Count
    bytes = $totalBytes
    sha256 = Get-BytesSha256 ((New-Object Text.UTF8Encoding($false)).GetBytes($lines.ToString()))
  }
}

function Assert-SafeManifestPath {
  param([Parameter(Mandatory = $true)][string]$Relative)
  if (
    [string]::IsNullOrWhiteSpace($Relative) -or
    $Relative.Contains('\') -or
    [IO.Path]::IsPathRooted($Relative)
  ) { throw "Invalid candidate manifest path: $Relative" }
  $segments = @($Relative.Split('/'))
  if ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) {
    throw "Invalid candidate manifest path: $Relative"
  }
}

function Assert-CandidateManifest {
  param([Parameter(Mandatory = $true)][string]$Candidate)
  Assert-NoReparsePointTree -Root $Candidate -Label 'Candidate release'

  $metadataPath = Join-Path $Candidate 'deploy\RELEASE.json'
  $metadata = Read-JsonFile $metadataPath 'Candidate release metadata'
  Assert-ExactPropertyOrder $metadata @(
    'format', 'releaseId', 'commit', 'commitTime', 'builtAt', 'environment',
    'apiPort', 'innerWebPort', 'mongoPort', 'replicaSet', 'database',
    'webApiBaseUrl', 'trustedOffhostReceiptPublicKeyPath',
    'trustedOffhostReceiptPublicKeySha256', 'schemaCapabilities', 'node', 'npm'
  ) 'Candidate release metadata'
  $schemaCapabilities = @($metadata.schemaCapabilities)
  if (
    $metadata.format -cne 'task-distribution-v2-release/v1' -or
    $metadata.releaseId -cne $ReleaseId -or
    $metadata.commit -cne $SourceCommit -or
    $metadata.environment -cne 'customer-test' -or
    [int]$metadata.apiPort -ne 18120 -or
    [int]$metadata.innerWebPort -ne 18130 -or
    [int]$metadata.mongoPort -ne 27150 -or
    $metadata.replicaSet -cne $expectedReplicaSet -or
    $metadata.database -cne $expectedDatabase -or
    $metadata.webApiBaseUrl -cne '/api' -or
    [string]$metadata.trustedOffhostReceiptPublicKeyPath -cne $trustedPublicKeyRelativePath -or
    [string]$metadata.trustedOffhostReceiptPublicKeySha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $schemaCapabilities.Count -ne 1 -or
    [string]$schemaCapabilities[0] -cne $expectedSchemaCapability -or
    $metadata.node -cne $expectedNodeVersion -or
    $metadata.npm -cne $expectedNpmVersion
  ) { throw 'Candidate release metadata identity mismatch' }
  $null = Assert-UtcTimestamp ([string]$metadata.builtAt) 'Candidate builtAt'

  $publicKeyPath = Join-Path $Candidate ($trustedPublicKeyRelativePath -replace '/', '\')
  if ((Get-Sha256 $publicKeyPath) -cne [string]$metadata.trustedOffhostReceiptPublicKeySha256) {
    throw 'Candidate trusted receipt public key differs from release metadata'
  }
  try { [xml]$publicKeyXml = [IO.File]::ReadAllText($publicKeyPath) }
  catch { throw "Candidate trusted receipt public key is not XML: $($_.Exception.Message)" }
  if (
    $publicKeyXml.DocumentElement.Name -cne 'RSAKeyValue' -or
    -not $publicKeyXml.RSAKeyValue.Modulus -or
    -not $publicKeyXml.RSAKeyValue.Exponent -or
    $publicKeyXml.RSAKeyValue.D -or
    $publicKeyXml.RSAKeyValue.P -or
    $publicKeyXml.RSAKeyValue.Q
  ) { throw 'Candidate trusted receipt public key is not a public RSA key' }

  $manifestPath = Join-Path $Candidate 'deploy\FILE-MANIFEST.json'
  $manifestSha256 = Get-Sha256 $manifestPath
  $manifest = Read-JsonFile $manifestPath 'Candidate file manifest'
  Assert-ExactPropertyOrder $manifest @(
    'format', 'releaseId', 'commit', 'generatedAt', 'pathComparison',
    'setSemantics', 'selfPath', 'fileCount', 'files'
  ) 'Candidate file manifest'
  if (
    $manifest.format -cne 'task-distribution-v2-release-files/v1' -or
    $manifest.releaseId -cne $ReleaseId -or
    $manifest.commit -cne $SourceCommit -or
    $manifest.pathComparison -cne 'windows-ordinal-ignore-case' -or
    $manifest.setSemantics -cne 'exact-package-files-excluding-manifest' -or
    $manifest.selfPath -cne 'deploy/FILE-MANIFEST.json' -or
    [int]$manifest.fileCount -ne @($manifest.files).Count
  ) { throw 'Candidate file manifest contract mismatch' }

  $candidatePrefix = (Get-FullPath $Candidate) + '\'
  $declared = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($manifest.files)) {
    Assert-ExactPropertyOrder $entry @('file', 'bytes', 'sha256') 'Candidate manifest file entry'
    $relative = [string]$entry.file
    Assert-SafeManifestPath $relative
    if (-not $declared.Add($relative)) { throw "Duplicate candidate manifest path: $relative" }
    if ([string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or [int64]$entry.bytes -lt 0) {
      throw "Invalid candidate manifest file identity: $relative"
    }
    $path = Get-FullPath (Join-Path $Candidate ($relative -replace '/', '\'))
    if (-not $path.StartsWith($candidatePrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Candidate manifest path escaped its root: $relative"
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or [int64]$item.Length -ne [int64]$entry.bytes) {
      throw "Candidate file size mismatch: $relative"
    }
    if ((Get-Sha256 $path) -cne [string]$entry.sha256) {
      throw "Candidate file hash mismatch: $relative"
    }
  }

  $actual = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in @(Get-ChildItem -LiteralPath $Candidate -Recurse -Force -File)) {
    $relative = $file.FullName.Substring($candidatePrefix.Length).Replace('\', '/')
    $injected = (
      $relative.StartsWith('runtime-node/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('app/node_modules/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative -in @('serve-v2-recovery.cjs', 'run-v2-recovery-api.ps1', 'run-v2-recovery-web.ps1')
    )
    if ($injected -or $relative.Equals('deploy/FILE-MANIFEST.json', [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if (-not $actual.Add($relative)) { throw "Duplicate Windows-insensitive candidate path: $relative" }
  }
  $unexpected = @($actual | Where-Object { -not $declared.Contains($_) })
  $missing = @($declared | Where-Object { -not $actual.Contains($_) })
  if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) {
    throw "Candidate exact file set mismatch: unexpected=$($unexpected.Count) missing=$($missing.Count)"
  }
  return [pscustomobject][ordered]@{
    metadataPath = $metadataPath
    metadataSha256 = Get-Sha256 $metadataPath
    metadata = $metadata
    manifestPath = $manifestPath
    manifestSha256 = $manifestSha256
    manifest = $manifest
    publicKeyPath = $publicKeyPath
    publicKeySha256 = [string]$metadata.trustedOffhostReceiptPublicKeySha256
  }
}

function Assert-ArtifactManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][object]$CandidateIdentity
  )
  $artifact = Read-JsonFile $Path 'Release artifact manifest'
  Assert-ExactPropertyOrder $artifact @(
    'format', 'releaseId', 'commit', 'builtAt', 'environment', 'archive',
    'fileManifestSha256', 'fileCount'
  ) 'Release artifact manifest'
  Assert-ExactPropertyOrder $artifact.archive @('file', 'bytes', 'sha256') 'Release artifact archive'
  $archive = Get-Item -LiteralPath $ArchivePath -Force
  if (
    $artifact.format -cne 'task-distribution-v2-release-artifact/v1' -or
    $artifact.releaseId -cne $ReleaseId -or
    $artifact.commit -cne $SourceCommit -or
    $artifact.environment -cne 'customer-test' -or
    [string]$artifact.archive.file -cne [IO.Path]::GetFileName($ArchivePath) -or
    [int64]$artifact.archive.bytes -ne [int64]$archive.Length -or
    [string]$artifact.archive.sha256 -cne $ExpectedReleaseArchiveSha256 -or
    [string]$artifact.fileManifestSha256 -cne [string]$CandidateIdentity.manifestSha256 -or
    [int]$artifact.fileCount -ne ([int]$CandidateIdentity.manifest.fileCount + 1) -or
    [string]$artifact.builtAt -cne [string]$CandidateIdentity.metadata.builtAt
  ) { throw 'Release artifact manifest identity mismatch' }
  return $artifact
}

function Assert-ReleaseFileManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$ExpectedReleaseId,
    [Parameter(Mandatory = $true)][string]$ExpectedCommit,
    [Parameter(Mandatory = $true)][string]$Label
  )
  Assert-NoReparsePointTree -Root $Root -Label $Label
  $manifestPath = Join-Path $Root 'deploy\FILE-MANIFEST.json'
  $manifest = Read-JsonFile $manifestPath "$Label file manifest"
  $propertyNames = @($manifest.PSObject.Properties | ForEach-Object { [string]$_.Name })
  $isLegacyManifest = (
    $propertyNames.Count -eq 5 -and
    $propertyNames[0] -ceq 'format' -and
    $propertyNames[1] -ceq 'releaseId' -and
    $propertyNames[2] -ceq 'commit' -and
    $propertyNames[3] -ceq 'generatedAt' -and
    $propertyNames[4] -ceq 'files'
  )
  if ($isLegacyManifest) {
    Assert-ExactPropertyOrder $manifest @(
      'format', 'releaseId', 'commit', 'generatedAt', 'files'
    ) "$Label legacy file manifest"
  }
  else {
    Assert-ExactPropertyOrder $manifest @(
      'format', 'releaseId', 'commit', 'generatedAt', 'pathComparison',
      'setSemantics', 'selfPath', 'fileCount', 'files'
    ) "$Label file manifest"
  }
  $null = Assert-UtcTimestamp ([string]$manifest.generatedAt) "$Label file manifest generatedAt"
  if (
    $manifest.format -cne 'task-distribution-v2-release-files/v1' -or
    $manifest.releaseId -cne $ExpectedReleaseId -or
    $manifest.commit -cne $ExpectedCommit -or
    (
      -not $isLegacyManifest -and (
        $manifest.pathComparison -cne 'windows-ordinal-ignore-case' -or
        $manifest.setSemantics -cne 'exact-package-files-excluding-manifest' -or
        $manifest.selfPath -cne 'deploy/FILE-MANIFEST.json' -or
        [int]$manifest.fileCount -ne @($manifest.files).Count
      )
    )
  ) { throw "$Label file manifest identity mismatch" }
  $prefix = (Get-FullPath $Root) + '\'
  $declared = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($manifest.files)) {
    Assert-ExactPropertyOrder $entry @('file', 'bytes', 'sha256') "$Label manifest file entry"
    $relative = [string]$entry.file
    $unsafeSegments = @($relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })
    if (
      [string]::IsNullOrWhiteSpace($relative) -or
      [IO.Path]::IsPathRooted($relative) -or
      $relative.Contains('\') -or
      $unsafeSegments.Count -ne 0 -or
      -not $declared.Add($relative) -or
      [string]$entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [int64]$entry.bytes -lt 0
    ) { throw "$Label manifest contains an invalid path or identity: $relative" }
    $path = Get-FullPath (Join-Path $Root ($relative -replace '/', '\'))
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label manifest path escaped root: $relative" }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or [int64]$item.Length -ne [int64]$entry.bytes -or (Get-Sha256 $path) -cne [string]$entry.sha256) {
      throw "$Label manifest file identity mismatch: $relative"
    }
  }
  $actual = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File)) {
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    $injected = (
      $relative.StartsWith('runtime-node/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('app/node_modules/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative -in @('serve-v2-recovery.cjs', 'run-v2-recovery-api.ps1', 'run-v2-recovery-web.ps1')
    )
    if ($injected -or $relative.Equals('deploy/FILE-MANIFEST.json', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not $actual.Add($relative)) { throw "$Label contains a duplicate file path: $relative" }
  }
  $unexpected = @($actual | Where-Object { -not $declared.Contains($_) })
  $missing = @($declared | Where-Object { -not $actual.Contains($_) })
  if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) {
    throw "$Label exact file set mismatch: unexpected=$($unexpected.Count) missing=$($missing.Count)"
  }
  return [pscustomobject][ordered]@{
    manifestPath = $manifestPath
    manifestSha256 = Get-Sha256 $manifestPath
    fileCount = [int]@($manifest.files).Count
    legacyManifestAccepted = $isLegacyManifest
  }
}

function Assert-PreviousRelease {
  param([Parameter(Mandatory = $true)][string]$Previous, [Parameter(Mandatory = $true)][string]$ActiveMarkerPath)
  Assert-NoReparsePointTree -Root $Previous -Label 'Previous release'
  $metadataPath = Join-Path $Previous 'deploy\RELEASE.json'
  $metadata = Read-JsonFile $metadataPath 'Previous release metadata'
  if (
    $metadata.format -cne 'task-distribution-v2-release/v1' -or
    $metadata.releaseId -cne $PreviousReleaseId -or
    $metadata.commit -cne $PreviousCommit -or
    $metadata.database -cne $expectedDatabase -or
    [int]$metadata.apiPort -ne 18120 -or
    [int]$metadata.innerWebPort -ne 18130 -or
    [int]$metadata.mongoPort -ne 27150
  ) { throw 'Previous release metadata identity mismatch' }
  $manifestIdentity = Assert-ReleaseFileManifest -Root $Previous `
    -ExpectedReleaseId $PreviousReleaseId -ExpectedCommit $PreviousCommit -Label 'Previous release'
  $active = Read-JsonFile $ActiveMarkerPath 'Active release marker'
  if (
    $active.status -cne 'WINDOWS_RECOVERY_RELEASE_ACTIVE' -or
    $active.releaseId -cne $PreviousReleaseId -or
    $active.sourceCommit -cne $PreviousCommit
  ) { throw 'The supplied previous release is not the active Recovery release' }
  return [pscustomobject][ordered]@{
    metadataPath = $metadataPath
    metadataSha256 = Get-Sha256 $metadataPath
    manifestPath = [string]$manifestIdentity.manifestPath
    manifestSha256 = [string]$manifestIdentity.manifestSha256
    manifestFileCount = [int]$manifestIdentity.fileCount
    legacyManifestAccepted = [bool]$manifestIdentity.legacyManifestAccepted
    activeMarkerPath = $ActiveMarkerPath
    activeMarkerSha256 = Get-Sha256 $ActiveMarkerPath
  }
}

function Assert-PredeployBackupReceipt {
  param([Parameter(Mandatory = $true)][string]$Path)
  $receipt = Read-JsonFile $Path 'Predeploy backup receipt'
  Assert-ExactPropertyOrder $receipt @(
    'status', 'releaseId', 'sourceCommit', 'backupId', 'remoteArchiveBytes',
    'remoteArchiveSha256', 'localArchiveBytes', 'localArchiveSha256',
    'manifestSha256', 'offhostVerificationSha256', 'archiveMatchesRemote',
    'independentWorkstationVerified', 'consistencyMode', 'databaseAndUploadsAtomic',
    'verifiedAt'
  ) 'Predeploy backup receipt'
  $null = Assert-UtcTimestamp ([string]$receipt.verifiedAt) 'Predeploy backup verifiedAt'
  if (
    $receipt.status -cne 'DEPLOYMENT_BACKUP_RECEIPT_VERIFIED' -or
    $receipt.releaseId -cne $ReleaseId -or
    $receipt.sourceCommit -cne $SourceCommit -or
    [string]$receipt.backupId -cnotmatch '^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$' -or
    [int64]$receipt.remoteArchiveBytes -le 0 -or
    [int64]$receipt.remoteArchiveBytes -ne [int64]$receipt.localArchiveBytes -or
    [string]$receipt.remoteArchiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    [string]$receipt.remoteArchiveSha256 -cne [string]$receipt.localArchiveSha256 -or
    [string]$receipt.manifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    [string]$receipt.offhostVerificationSha256 -cnotmatch '^[0-9a-f]{64}$' -or
    $receipt.archiveMatchesRemote -ne $true -or
    $receipt.independentWorkstationVerified -ne $true -or
    $receipt.consistencyMode -cne 'BEST_EFFORT_ONLINE_MONGODUMP' -or
    $receipt.databaseAndUploadsAtomic -ne $false
  ) { throw 'Predeploy backup receipt identity or limitation mismatch' }
  return $receipt
}

function Invoke-MongoTargetGuard {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$GuardPath,
    [Parameter(Mandatory = $true)][string]$EnvironmentPath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $output = @(& $NodePath $GuardPath --env-file $EnvironmentPath 2>&1)
  $exitCode = $LASTEXITCODE
  $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
  if ($exitCode -ne 0) { throw "$Label Mongo target guard failed: $text" }
  try { $report = $text | ConvertFrom-Json }
  catch { throw "$Label Mongo target guard did not return JSON" }
  if (
    $report.status -cne 'V2_TEST_MONGODB_TARGET_OK' -or
    $report.target.hostname -cne '127.0.0.1' -or
    [string]$report.target.port -cne '27150' -or
    $report.target.database -cne $expectedDatabase -or
    $report.target.replicaSet -cne $expectedReplicaSet
  ) { throw "$Label Mongo target guard identity mismatch" }
}

function Assert-InjectedRuntime {
  param([Parameter(Mandatory = $true)][string]$Candidate)
  $runtimeRoot = Join-Path $Candidate 'runtime-node'
  $nodePath = Join-Path $runtimeRoot 'node.exe'
  $npmPath = Join-Path $runtimeRoot 'npm.cmd'
  $nodeModulesRoot = Join-Path $Candidate 'app\node_modules'
  $proxyPath = Join-Path $Candidate 'serve-v2-recovery.cjs'
  $apiRunnerPath = Join-Path $Candidate 'run-v2-recovery-api.ps1'
  $webRunnerPath = Join-Path $Candidate 'run-v2-recovery-web.ps1'
  foreach ($path in @(
    $nodePath,
    $npmPath,
    (Join-Path $nodeModulesRoot '.package-lock.json'),
    (Join-Path $nodeModulesRoot 'dotenv\package.json'),
    (Join-Path $nodeModulesRoot 'express\package.json'),
    (Join-Path $nodeModulesRoot 'mongoose\package.json'),
    $proxyPath,
    $apiRunnerPath,
    $webRunnerPath
  )) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Candidate dependency injection is incomplete: $path"
    }
  }
  $nodeVersion = ([string](& $nodePath --version)).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne $expectedNodeVersion) {
    throw "Candidate Node version must be $expectedNodeVersion"
  }
  & $nodePath --check $proxyPath
  if ($LASTEXITCODE -ne 0) { throw 'Candidate Web proxy syntax check failed' }
  foreach ($runner in @($apiRunnerPath, $webRunnerPath)) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile(
      $runner,
      [ref]$tokens,
      [ref]$parseErrors
    )
    if (@($parseErrors).Count -ne 0) { throw "Candidate runner syntax error: $runner" }
  }
  $runtimeTree = Get-DirectoryTreeIdentity -Root $runtimeRoot -Label 'Candidate Node runtime'
  $nodeModulesTree = Get-DirectoryTreeIdentity -Root $nodeModulesRoot -Label 'Candidate app dependencies'
  return [pscustomobject][ordered]@{
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
}

function Write-Utf8NoBomCreateNew {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Value)
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
}

$RecoveryRoot = Get-FullPath $RecoveryRoot
$recoveryDriveRoot = [IO.Path]::GetPathRoot($RecoveryRoot)
if ($recoveryDriveRoot -cnotmatch '^[A-Za-z]:\\$') { throw 'RecoveryRoot must use a local Windows drive' }
$null = Assert-NoReparsePointPath -TrustedRoot $recoveryDriveRoot -Candidate $RecoveryRoot -Label 'RecoveryRoot'
if (-not (Test-Path -LiteralPath $RecoveryRoot -PathType Container)) { throw "RecoveryRoot is missing: $RecoveryRoot" }

$candidate = Assert-PathBelow $RecoveryRoot `
  (Join-Path (Join-Path $RecoveryRoot 'releases') $ReleaseId) 'Candidate release'
$previous = Assert-PathBelow $RecoveryRoot `
  (Join-Path (Join-Path $RecoveryRoot 'releases') $PreviousReleaseId) 'Previous release'
$evidenceParent = Assert-PathBelow $RecoveryRoot (Join-Path $RecoveryRoot 'evidence') 'Evidence root'
$evidence = Assert-PathBelow $RecoveryRoot (Join-Path $evidenceParent "release-$ReleaseId") 'Evidence directory'
$stagedPath = Join-Path $evidence 'staged.json'
$appEnvPath = Join-Path $RecoveryRoot 'config\app.env'
$activeMarkerPath = Join-Path $RecoveryRoot 'active-release.json'

foreach ($path in @($candidate, $previous, $appEnvPath, $activeMarkerPath, $evidenceParent, $evidence, $stagedPath)) {
  $null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $path -Label 'Recovery stage path'
}
$ReleaseArchivePath = Assert-LocalFilePath $ReleaseArchivePath 'Release archive'
$ArtifactManifestPath = Assert-LocalFilePath $ArtifactManifestPath 'Release artifact manifest'
$PredeployBackupReceiptPath = Assert-LocalFilePath $PredeployBackupReceiptPath 'Predeploy backup receipt'
$OperationsEnvPath = Assert-LocalFilePath $OperationsEnvPath 'Operations environment file'
$appEnvPath = Assert-LocalFilePath $appEnvPath 'Application environment file'
$activeMarkerPath = Assert-LocalFilePath $activeMarkerPath 'Active release marker'

if ([IO.Path]::GetFileName($ReleaseArchivePath) -cne "$ReleaseId.tar.gz") {
  throw 'Release archive file name does not match ReleaseId'
}
if ([IO.Path]::GetFileName($ArtifactManifestPath) -cne "$ReleaseId.artifact-manifest.json") {
  throw 'Artifact manifest file name does not match ReleaseId'
}
if ((Get-Sha256 $ReleaseArchivePath) -cne $ExpectedReleaseArchiveSha256) {
  throw 'Release archive SHA256 mismatch'
}
if ((Get-Sha256 $ArtifactManifestPath) -cne $ExpectedArtifactManifestSha256) {
  throw 'Release artifact manifest SHA256 mismatch'
}
if ((Get-Sha256 $PredeployBackupReceiptPath) -cne $ExpectedPredeployBackupReceiptSha256) {
  throw 'Predeploy backup receipt SHA256 mismatch'
}

$candidateIdentity = Assert-CandidateManifest $candidate
$artifactManifest = Assert-ArtifactManifest `
  -Path $ArtifactManifestPath -ArchivePath $ReleaseArchivePath -CandidateIdentity $candidateIdentity
$previousIdentity = Assert-PreviousRelease -Previous $previous -ActiveMarkerPath $activeMarkerPath
$predeployReceipt = Assert-PredeployBackupReceipt $PredeployBackupReceiptPath
$injectedRuntime = Assert-InjectedRuntime $candidate

$nodePath = Join-Path $candidate 'runtime-node\node.exe'
$guardPath = Join-Path $candidate ($mongoTargetGuardRelativePath -replace '/', '\')
Invoke-MongoTargetGuard -NodePath $nodePath -GuardPath $guardPath `
  -EnvironmentPath $appEnvPath -Label 'Application environment'
Invoke-MongoTargetGuard -NodePath $nodePath -GuardPath $guardPath `
  -EnvironmentPath $OperationsEnvPath -Label 'Operations environment'

$runtimeInputs = [ordered]@{
  appEnvPath = $appEnvPath
  appEnvSha256 = Get-Sha256 $appEnvPath
  operationsEnvPath = $OperationsEnvPath
  operationsEnvSha256 = Get-Sha256 $OperationsEnvPath
  mongoTargetGuardPath = $mongoTargetGuardRelativePath
  mongoTargetGuardSha256 = Get-Sha256 $guardPath
  trustedPublicKeyPath = $trustedPublicKeyRelativePath
  trustedPublicKeySha256 = [string]$candidateIdentity.publicKeySha256
  schemaCapabilities = @($expectedSchemaCapability)
}
$runtimeInputsSha256 = Get-ObjectSha256 $runtimeInputs

$archiveInfo = Get-Item -LiteralPath $ReleaseArchivePath
$predeployBackup = [ordered]@{
  backupId = [string]$predeployReceipt.backupId
  archiveBytes = [int64]$predeployReceipt.localArchiveBytes
  archiveSha256 = [string]$predeployReceipt.localArchiveSha256
  manifestSha256 = [string]$predeployReceipt.manifestSha256
  independentWorkstationVerified = $true
  consistencyMode = 'BEST_EFFORT_ONLINE_MONGODUMP'
  databaseAndUploadsAtomic = $false
}
$previousReleaseEvidence = [ordered]@{
  metadataPath = [string]$previousIdentity.metadataPath
  metadataSha256 = [string]$previousIdentity.metadataSha256
  manifestPath = [string]$previousIdentity.manifestPath
  manifestSha256 = [string]$previousIdentity.manifestSha256
  manifestFileCount = [int]$previousIdentity.manifestFileCount
  legacyManifestAccepted = [bool]$previousIdentity.legacyManifestAccepted
  activeMarkerPath = [string]$previousIdentity.activeMarkerPath
  activeMarkerSha256 = [string]$previousIdentity.activeMarkerSha256
}
$predeployReceiptEvidence = [ordered]@{
  path = $PredeployBackupReceiptPath
  sha256 = $ExpectedPredeployBackupReceiptSha256
  offhostVerificationSha256 = [string]$predeployReceipt.offhostVerificationSha256
  validationScope = 'TRANSFER_SHA256_AND_SCHEMA_ONLY'
  trustBoundary = 'APPROVED_EXTERNAL_OFFHOST_HANDOFF'
}

function New-StageEvidence {
  param([Parameter(Mandatory = $true)][string]$StagedAt)
  return [ordered]@{
    format = $stageFormat
    status = 'WINDOWS_RECOVERY_CANDIDATE_STAGED'
    stagedAt = $StagedAt
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    previousReleaseId = $PreviousReleaseId
    previousCommit = $PreviousCommit
    archiveFileName = [IO.Path]::GetFileName($ReleaseArchivePath)
    archiveBytes = [int64]$archiveInfo.Length
    archiveSha256 = $ExpectedReleaseArchiveSha256
    artifactManifestFileName = [IO.Path]::GetFileName($ArtifactManifestPath)
    artifactManifestSha256 = $ExpectedArtifactManifestSha256
    fileManifestSha256 = [string]$candidateIdentity.manifestSha256
    candidateRoot = $candidate
    evidenceRoot = $evidence
    previousRelease = $previousReleaseEvidence
    predeployBackupReceipt = $predeployReceiptEvidence
    predeployBackup = $predeployBackup
    injectedRuntime = $injectedRuntime
    runtimeInputs = $runtimeInputs
    runtimeInputsSha256 = $runtimeInputsSha256
  }
}

function Assert-StageInputsUnchanged {
  if ((Get-Sha256 $ReleaseArchivePath) -cne $ExpectedReleaseArchiveSha256) {
    throw 'Release archive changed during staging'
  }
  if ((Get-Sha256 $ArtifactManifestPath) -cne $ExpectedArtifactManifestSha256) {
    throw 'Release artifact manifest changed during staging'
  }
  if ((Get-Sha256 $PredeployBackupReceiptPath) -cne $ExpectedPredeployBackupReceiptSha256) {
    throw 'Predeploy backup receipt changed during staging'
  }
  if ((Get-Sha256 $appEnvPath) -cne [string]$runtimeInputs.appEnvSha256) {
    throw 'Application environment changed during staging'
  }
  if ((Get-Sha256 $OperationsEnvPath) -cne [string]$runtimeInputs.operationsEnvSha256) {
    throw 'Operations environment changed during staging'
  }
  if ((Get-Sha256 $activeMarkerPath) -cne [string]$previousReleaseEvidence.activeMarkerSha256) {
    throw 'Active release marker changed during staging'
  }
  if ((Get-Sha256 ([string]$previousReleaseEvidence.metadataPath)) -cne `
    [string]$previousReleaseEvidence.metadataSha256) {
    throw 'Previous release metadata changed during staging'
  }
  $currentPreviousManifest = Assert-ReleaseFileManifest -Root $previous `
    -ExpectedReleaseId $PreviousReleaseId -ExpectedCommit $PreviousCommit -Label 'Previous release'
  if (
    [string]$currentPreviousManifest.manifestSha256 -cne [string]$previousReleaseEvidence.manifestSha256 -or
    [int]$currentPreviousManifest.fileCount -ne [int]$previousReleaseEvidence.manifestFileCount -or
    [bool]$currentPreviousManifest.legacyManifestAccepted -ne
      [bool]$previousReleaseEvidence.legacyManifestAccepted
  ) { throw 'Previous release file tree changed during staging' }
  $currentCandidate = Assert-CandidateManifest $candidate
  if (
    [string]$currentCandidate.manifestSha256 -cne [string]$candidateIdentity.manifestSha256 -or
    [string]$currentCandidate.publicKeySha256 -cne [string]$candidateIdentity.publicKeySha256 -or
    [string]$currentCandidate.metadataSha256 -cne [string]$candidateIdentity.metadataSha256
  ) { throw 'Candidate identity changed during staging' }
  $currentInjectedRuntime = Assert-InjectedRuntime $candidate
  if (
    (ConvertTo-Json $currentInjectedRuntime -Depth 12 -Compress) -cne
    (ConvertTo-Json $injectedRuntime -Depth 12 -Compress)
  ) { throw 'Candidate injected runtime changed during staging' }
  if ((Get-ObjectSha256 $runtimeInputs) -cne $runtimeInputsSha256) {
    throw 'Runtime input object changed during staging'
  }
}

$topLevelProperties = @(
  'format', 'status', 'stagedAt', 'releaseId', 'sourceCommit',
  'previousReleaseId', 'previousCommit', 'archiveFileName', 'archiveBytes',
  'archiveSha256', 'artifactManifestFileName', 'artifactManifestSha256',
  'fileManifestSha256', 'candidateRoot', 'evidenceRoot', 'previousRelease',
  'predeployBackupReceipt', 'predeployBackup', 'injectedRuntime', 'runtimeInputs',
  'runtimeInputsSha256'
)
$runtimeInputProperties = @(
  'appEnvPath', 'appEnvSha256', 'operationsEnvPath', 'operationsEnvSha256',
  'mongoTargetGuardPath', 'mongoTargetGuardSha256', 'trustedPublicKeyPath',
  'trustedPublicKeySha256', 'schemaCapabilities'
)

Assert-StageInputsUnchanged
if ((Test-Path -LiteralPath $evidence) -and -not (Test-Path -LiteralPath $stagedPath)) {
  throw 'Evidence directory already exists without staged evidence; refusing to reuse this release ID'
}
if (Test-Path -LiteralPath $stagedPath) {
  if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf)) {
    throw "Staged evidence path is not a file: $stagedPath"
  }
  $existing = Read-JsonFile $stagedPath 'Existing staged evidence'
  Assert-ExactPropertyOrder $existing $topLevelProperties 'Existing staged evidence'
  Assert-ExactPropertyOrder $existing.runtimeInputs $runtimeInputProperties 'Existing staged runtime inputs'
  $null = Assert-UtcTimestamp ([string]$existing.stagedAt) 'Existing stagedAt'
  if ((Get-ObjectSha256 $existing.runtimeInputs) -cne [string]$existing.runtimeInputsSha256) {
    throw 'Existing staged runtime input hash is invalid'
  }
  $expectedExisting = New-StageEvidence -StagedAt ([string]$existing.stagedAt)
  if (
    (ConvertTo-Json $existing -Depth 12 -Compress) -cne
    (ConvertTo-Json $expectedExisting -Depth 12 -Compress)
  ) { throw 'Existing staged evidence conflicts with the validated staging inputs; refusing to overwrite' }
  Assert-StageInputsUnchanged
  [ordered]@{
    status = 'WINDOWS_RECOVERY_CANDIDATE_STAGE_REVERIFIED'
    releaseId = $ReleaseId
    sourceCommit = $SourceCommit
    stagedEvidence = $stagedPath
    stagedEvidenceSha256 = Get-Sha256 $stagedPath
    runtimeInputsSha256 = $runtimeInputsSha256
    reusedEvidence = $true
  } | ConvertTo-Json -Depth 12
  return
}

$plan = [ordered]@{
  status = 'WINDOWS_RECOVERY_CANDIDATE_STAGE_PLAN_READY'
  action = 'validate-immutable-candidate-and-create-staged-evidence'
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  previousReleaseId = $PreviousReleaseId
  previousCommit = $PreviousCommit
  candidateRoot = $candidate
  stagedEvidence = $stagedPath
  archiveSha256 = $ExpectedReleaseArchiveSha256
  artifactManifestSha256 = $ExpectedArtifactManifestSha256
  predeployBackupReceiptSha256 = $ExpectedPredeployBackupReceiptSha256
  runtimeInputs = $runtimeInputs
  runtimeInputsSha256 = $runtimeInputsSha256
  existingEvidenceWillNeverBeOverwritten = $true
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 12
  return
}
if ($ConfirmInstance -cne $expectedConfirmationInstance) {
  throw "ConfirmInstance must exactly equal $expectedConfirmationInstance"
}
if ($ConfirmReleaseId -cne $ReleaseId) { throw 'ConfirmReleaseId must exactly equal ReleaseId' }
if ($ConfirmPreviousReleaseId -cne $PreviousReleaseId) {
  throw 'ConfirmPreviousReleaseId must exactly equal PreviousReleaseId'
}
if (-not $PSCmdlet.ShouldProcess($stagedPath, 'Create immutable Windows Recovery staged evidence')) {
  return
}

if (-not (Test-Path -LiteralPath $evidenceParent -PathType Container)) {
  New-Item -ItemType Directory -Path $evidenceParent | Out-Null
}
if (Test-Path -LiteralPath $evidence) {
  throw 'Evidence directory appeared concurrently; refusing to reuse this release ID'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$null = Assert-NoReparsePointPath -TrustedRoot $RecoveryRoot -Candidate $evidence -Label 'Evidence directory'
if (Test-Path -LiteralPath $stagedPath) {
  throw 'Staged evidence appeared concurrently; rerun in verification mode'
}
Assert-StageInputsUnchanged
$stage = New-StageEvidence -StagedAt ((Get-Date).ToUniversalTime().ToString('o'))
Write-Utf8NoBomCreateNew -Path $stagedPath -Value "$(ConvertTo-Json $stage -Depth 12)`n"

$written = Read-JsonFile $stagedPath 'Written staged evidence'
Assert-ExactPropertyOrder $written $topLevelProperties 'Written staged evidence'
Assert-ExactPropertyOrder $written.runtimeInputs $runtimeInputProperties 'Written staged runtime inputs'
if ((Get-ObjectSha256 $written.runtimeInputs) -cne [string]$written.runtimeInputsSha256) {
  throw 'Written staged runtime input hash is invalid'
}
if (
  (ConvertTo-Json $written -Depth 12 -Compress) -cne
  (ConvertTo-Json $stage -Depth 12 -Compress)
) { throw 'Written staged evidence differs from the validated object' }
Assert-StageInputsUnchanged

[ordered]@{
  status = 'WINDOWS_RECOVERY_CANDIDATE_STAGED'
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  stagedEvidence = $stagedPath
  stagedEvidenceSha256 = Get-Sha256 $stagedPath
  runtimeInputsSha256 = $runtimeInputsSha256
  reusedEvidence = $false
} | ConvertTo-Json -Depth 12
