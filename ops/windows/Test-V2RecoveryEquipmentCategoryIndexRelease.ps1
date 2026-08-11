[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$ReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^v2-\d{8}-[0-9a-f]{7}$')][string]$PreviousReleaseId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$PreviousCommit,
  [Parameter(Mandatory = $true)][ValidatePattern('^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$')][string]$BackupId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$BackupManifestSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$StagedEvidenceSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$StoppedHandoffSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$HandoffNonce,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$OffhostVerificationReceiptSha256,
  [Parameter(Mandatory = $true)][string]$TrustedPublicKeyPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$TrustedPublicKeySha256,
  [Parameter(Mandatory = $true)][string]$OperationsEnvPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$AppEnvSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$OperationsEnvSha256,
  [string]$RecoveryRoot = 'C:\TaskDistribution-V2\Recovery',
  [string]$IndexAuditReport = '',
  [string]$BusinessAuditReport = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$expectedDatabase = 'customer_acceptance_v2_test'
$expectedInstance = 'task-distribution-v2-customer-test-recovery'
$expectedSchemaCapability = 'equipment-category-parent-name-index-v1'
$trustedPublicKeyRelativePath = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
$leadAcidForkliftPrimaryName = '"\u7535\u52a8\u53c9\u8f66\uff08\u5206\u7c7b\uff1a\u94c5\u9178\u7535\u6c60\uff09"' |
  ConvertFrom-Json
$lithiumForkliftPrimaryName = '"\u7535\u52a8\u53c9\u8f66\uff08\u5206\u7c7b\uff1a\u9502\u79bb\u5b50\u7535\u6c60\uff09"' |
  ConvertFrom-Json
$rollerConveyorPrimaryName = '"\u8f8a\u5b50\u8f93\u9001\u673a"' | ConvertFrom-Json
$expectedPrimaryInUseCounts = [ordered]@{}
$expectedPrimaryInUseCounts[$leadAcidForkliftPrimaryName] = 6
$expectedPrimaryInUseCounts[$lithiumForkliftPrimaryName] = 5
$expectedPrimaryInUseCounts[$rollerConveyorPrimaryName] = 1
$apiTask = 'TaskDistribution-V2-Recovery-API'
$webTask = 'TaskDistribution-V2-Recovery-Web'
$businessTunnelTask = 'TaskDistribution-V2-Recovery-Tunnel'
$managementTunnelTask = 'TaskDistribution-V2-Recovery-Management-Tunnel'
$mongoTask = 'TaskDistribution-V2-Recovery-MongoDB'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Get-FullPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
  return $full.TrimEnd('\')
}

function Assert-PathBelow([string]$Root, [string]$Candidate, [string]$Label) {
  $rootFull = Get-FullPath $Root
  $candidateFull = Get-FullPath $Candidate
  $rootPrefix = if ($rootFull.EndsWith('\')) { $rootFull } else { "$rootFull\" }
  if (-not $candidateFull.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be below $rootFull"
  }
  return $candidateFull
}

function Assert-NoReparsePointPath([string]$TrustedRoot, [string]$Candidate, [string]$Label) {
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

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BytesSha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-ObjectSha256([object]$Value) {
  $json = ConvertTo-Json $Value -Depth 12 -Compress
  return Get-BytesSha256 ((New-Object Text.UTF8Encoding($false)).GetBytes($json))
}

function Write-Utf8NoBomCreateNew([string]$Path, [string]$Value) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $Path 'Evidence output'
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "Evidence parent is missing: $parent"
  }
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  }
  finally { $stream.Dispose() }
}

function Read-Json([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
  catch { throw "$Label is invalid JSON: $($_.Exception.Message)" }
}

function Assert-ExactJsonProperties([object]$Object, [string[]]$Expected, [string]$Label) {
  $actual = @($Object.PSObject.Properties | ForEach-Object { [string]$_.Name })
  $missing = @($Expected | Where-Object { -not ($actual -ccontains $_) })
  $unexpected = @($actual | Where-Object { -not ($Expected -ccontains $_) })
  if ($missing.Count -ne 0 -or $unexpected.Count -ne 0 -or $actual.Count -ne $Expected.Count) {
    throw "$Label property set mismatch; missing=$($missing -join ','); unexpected=$($unexpected -join ',')"
  }
}

function ConvertFrom-StrictBase64([string]$Value, [string]$Label) {
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

function Read-SignedOffhostVerificationReceipt(
  [string]$ReceiptPath,
  [string]$ReceiptSha256,
  [string]$TrustedRoot,
  [string]$PublicKeyPath,
  [string]$PublicKeySha256
) {
  $ReceiptPath = Assert-NoReparsePointPath $TrustedRoot $ReceiptPath 'Signed off-host receipt'
  $PublicKeyPath = Assert-NoReparsePointPath $TrustedRoot $PublicKeyPath 'Trusted receipt public key'
  if (-not (Test-Path -LiteralPath $PublicKeyPath -PathType Leaf)) {
    throw "Trusted receipt public key is missing: $PublicKeyPath"
  }
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
  Assert-ExactJsonProperties $envelope @(
    'format',
    'signatureAlgorithm',
    'publicKeySha256',
    'signedPayloadSha256',
    'signedPayloadUtf8Base64',
    'signatureBase64'
  ) 'Signed off-host receipt envelope'
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

function Get-Http([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri $Url `
      -Headers @{ 'Cache-Control' = 'no-cache' }
    return [pscustomobject]@{
      url = $Url
      status = [int]$response.StatusCode
      contentType = [string]$response.Headers['Content-Type']
      body = [string]$response.Content
    }
  }
  catch {
    return [pscustomobject]@{
      url = $Url
      status = 0
      contentType = $null
      body = [string]$_.Exception.Message
    }
  }
}

function Select-Health([object]$Response) {
  $payload = $null
  try { $payload = $Response.body | ConvertFrom-Json }
  catch { $payload = $null }
  return [pscustomobject]@{
    url = $Response.url
    httpStatus = $Response.status
    contentType = $Response.contentType
    payloadStatus = if ($payload) { [string]$payload.status } else { $null }
    instance = if ($payload) { [string]$payload.instance } else { $null }
  }
}

function Test-RecoveryHealth([object]$State) {
  return (
    $null -ne $State -and
    $State.httpStatus -eq 200 -and
    $State.payloadStatus -eq 'ok' -and
    $State.instance -eq $expectedInstance
  )
}

function Get-TaskState([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  return [pscustomobject]@{
    name = $TaskName
    state = [string]$task.State
    actionCount = @($task.Actions).Count
    execute = if (@($task.Actions).Count -eq 1) { [string]$task.Actions[0].Execute } else { $null }
    arguments = if (@($task.Actions).Count -eq 1) { [string]$task.Actions[0].Arguments } else { $null }
    workingDirectory = if (@($task.Actions).Count -eq 1) { [string]$task.Actions[0].WorkingDirectory } else { $null }
    lastTaskResult = [int64]$info.LastTaskResult
  }
}

function Get-Listener([int]$Port) {
  $rows = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($rows.Count -ne 1) {
    return [pscustomobject]@{ port = $Port; count = $rows.Count; address = $null; pid = $null; commandLine = $null; release = $false }
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($rows[0].OwningProcess)" -ErrorAction SilentlyContinue
  $command = [string]$process.CommandLine
  return [pscustomobject]@{
    port = $Port
    count = 1
    address = [string]$rows[0].LocalAddress
    pid = [int]$rows[0].OwningProcess
    commandLine = $command
    release = $command.Contains($ReleaseId)
  }
}

function Add-Failure([string]$Code) {
  $script:failures += $Code
}

function Test-AfterIndexState([object]$State) {
  return (
    $null -ne $State -and
    $State.indexes.desiredPresent -eq $true -and
    @($State.indexes.legacy).Count -eq 0 -and
    @($State.indexes.unknownTeamWideUnique).Count -eq 0 -and
    @($State.blockers).Count -eq 0
  )
}

function Assert-CandidateManifest([object]$Staged, [string]$Candidate) {
  $reparse = @(Get-ChildItem -LiteralPath $Candidate -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  })
  if ($reparse.Count -ne 0) {
    throw "Candidate contains a reparse point: $($reparse[0].FullName)"
  }

  $metadataPath = Join-Path $Candidate 'deploy\RELEASE.json'
  $metadata = Read-Json $metadataPath 'Candidate release metadata'
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
  $manifest = Read-Json $manifestPath 'Candidate file manifest'
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
    ) { throw "Invalid candidate manifest path: $relative" }
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
    metadataSha256 = Get-Sha256 $metadataPath
    manifestSha256 = Get-Sha256 $manifestPath
    trustedPublicKeyPath = $trustedPublicKey
    trustedPublicKeySha256 = [string]$metadata.trustedOffhostReceiptPublicKeySha256
  }
}

function Assert-PreviousReleaseTree([object]$Staged, [string]$Previous) {
  $metadataPath = Join-Path $Previous 'deploy\RELEASE.json'
  $manifestPath = Join-Path $Previous 'deploy\FILE-MANIFEST.json'
  if (
    (Get-Sha256 $metadataPath) -cne [string]$Staged.previousRelease.metadataSha256 -or
    (Get-Sha256 $manifestPath) -cne [string]$Staged.previousRelease.manifestSha256
  ) { throw 'Previous release metadata or file manifest differs from staged evidence' }
  $metadata = Read-Json $metadataPath 'Previous release metadata'
  $manifest = Read-Json $manifestPath 'Previous release file manifest'
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
      -not $relative -or $relative -cne [string]$entry.file -or
      [IO.Path]::IsPathRooted($relative) -or
      @($relative.Split('/')) -contains '..' -or @($relative.Split('/')) -contains '.' -or
      -not $declared.Add($relative)
    ) { throw "Invalid previous release manifest path: $relative" }
    $path = [IO.Path]::GetFullPath((Join-Path $Previous ($relative -replace '/', '\')))
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (
      -not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
      $item.PSIsContainer -or [int64]$item.Length -ne [int64]$entry.bytes -or
      (Get-Sha256 $path) -cne ([string]$entry.sha256).ToLowerInvariant()
    ) { throw "Previous release file identity mismatch: $relative" }
  }
  $actual = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in @(Get-ChildItem -LiteralPath $Previous -Recurse -Force -File)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Previous release contains a reparse point: $($item.FullName)" }
    $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
    $injected = $relative.StartsWith('runtime-node/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('app/node_modules/', [StringComparison]::OrdinalIgnoreCase) -or
      $relative -in @('serve-v2-recovery.cjs', 'run-v2-recovery-api.ps1', 'run-v2-recovery-web.ps1')
    if ($injected -or $relative.Equals('deploy/FILE-MANIFEST.json', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $null = $actual.Add($relative)
  }
  $unexpected = @($actual | Where-Object { -not $declared.Contains($_) })
  $missing = @($declared | Where-Object { -not $actual.Contains($_) })
  if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) { throw 'Previous release exact file set mismatch' }
}

function Get-DirectoryTreeIdentity([string]$Root, [string]$Label) {
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

function Assert-InjectedRuntime([string]$Candidate, [object]$Expected) {
  Assert-ExactJsonProperties $Expected @(
    'nodeVersion', 'runtimeNodeFileCount', 'runtimeNodeBytes', 'runtimeNodeSha256',
    'appNodeModulesFileCount', 'appNodeModulesBytes', 'appNodeModulesSha256',
    'webProxySha256', 'apiRunnerSha256', 'webRunnerSha256'
  ) 'Staged injected runtime'
  $runtimeRoot = Join-Path $Candidate 'runtime-node'
  $nodePath = Join-Path $runtimeRoot 'node.exe'
  $nodeModulesRoot = Join-Path $Candidate 'app\node_modules'
  $proxyPath = Join-Path $Candidate 'serve-v2-recovery.cjs'
  $apiRunnerPath = Join-Path $Candidate 'run-v2-recovery-api.ps1'
  $webRunnerPath = Join-Path $Candidate 'run-v2-recovery-web.ps1'
  foreach ($path in @(
    $nodePath, (Join-Path $runtimeRoot 'npm.cmd'),
    (Join-Path $nodeModulesRoot '.package-lock.json'),
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
  $runtimeTree = Get-DirectoryTreeIdentity $runtimeRoot 'Candidate Node runtime'
  $nodeModulesTree = Get-DirectoryTreeIdentity $nodeModulesRoot 'Candidate app dependencies'
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

function Test-MongoAnchorReport([object]$Report) {
  return (
    $null -ne $Report -and
    $Report.format -eq 'task-distribution-v2-replica-write-anchor/v2' -and
    $Report.status -eq 'REPLICA_WRITE_ANCHOR_CAPTURED' -and
    $Report.releaseId -eq $ReleaseId -and
    $Report.handoffNonce -eq $HandoffNonce -and
    [string]$Report.writeAnchorSha256 -cmatch '^[0-9a-f]{64}$' -and
    (Get-ObjectSha256 $Report.anchor) -ceq [string]$Report.writeAnchorSha256
  )
}

function Assert-TunnelBoundary([object]$Task) {
  if ($Task.actionCount -ne 1 -or $Task.execute -ne $powershell) {
    throw 'Business tunnel scheduled task action mismatch'
  }
  $match = [regex]::Match($Task.arguments, '(?i)-File\s+"([^"]+)"')
  if (-not $match.Success) { throw 'Business tunnel runner path is absent' }
  $expectedRunner = Get-FullPath (Join-Path $RecoveryRoot 'ops\run-v2-recovery-tunnel.ps1')
  $runner = Get-FullPath $match.Groups[1].Value
  if ($runner -ne $expectedRunner) { throw 'Business tunnel runner path mismatch' }
  $text = [IO.File]::ReadAllText($runner)
  foreach ($required in @(
    "-R '127.0.0.1:38130:127.0.0.1:18130'",
    'StrictHostKeyChecking=yes',
    'ExitOnForwardFailure=yes',
    'BatchMode=yes'
  )) {
    if (-not $text.Contains($required)) { throw "Business tunnel runner is missing $required" }
  }
  if ($text.Contains('38080') -or $text.Contains('8099')) {
    throw 'Business tunnel runner references a legacy production port'
  }
  return [pscustomobject]@{ runner = $runner; sha256 = Get-Sha256 $runner }
}

$RecoveryRoot = Get-FullPath $RecoveryRoot
$expectedRecoveryRoot = Get-FullPath 'C:\TaskDistribution-V2\Recovery'
if ($RecoveryRoot -ne $expectedRecoveryRoot) {
  throw "RecoveryRoot must exactly equal $expectedRecoveryRoot for this Windows recovery topology"
}
$recoveryDriveRoot = [IO.Path]::GetPathRoot($RecoveryRoot)
$null = Assert-NoReparsePointPath $recoveryDriveRoot $RecoveryRoot 'RecoveryRoot'
$candidate = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'releases') $ReleaseId) 'Candidate release'
$previous = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'releases') $PreviousReleaseId) 'Previous release'
$evidence = Assert-PathBelow $RecoveryRoot (Join-Path (Join-Path $RecoveryRoot 'evidence') "release-$ReleaseId") 'Evidence directory'
$appEnvPath = Join-Path $RecoveryRoot 'config\app.env'
$OperationsEnvPath = Get-FullPath $OperationsEnvPath
$operationsEnvDriveRoot = [IO.Path]::GetPathRoot($OperationsEnvPath)
if ($operationsEnvDriveRoot -cnotmatch '^[A-Za-z]:\\$') {
  throw 'OperationsEnvPath must be a local Windows drive path'
}
$null = Assert-NoReparsePointPath $operationsEnvDriveRoot $OperationsEnvPath 'Operations environment file'
$null = Assert-NoReparsePointPath $RecoveryRoot $appEnvPath 'Application environment file'
if ((Get-Sha256 $appEnvPath) -cne $AppEnvSha256) {
  throw 'Application environment file SHA256 mismatch'
}
if ((Get-Sha256 $OperationsEnvPath) -cne $OperationsEnvSha256) {
  throw 'Operations environment file SHA256 mismatch'
}

$TrustedPublicKeyPath = Assert-PathBelow $RecoveryRoot $TrustedPublicKeyPath 'TrustedPublicKeyPath'
$expectedTrustedPublicKeyPath = Get-FullPath (Join-Path $candidate `
  ($trustedPublicKeyRelativePath -replace '/', '\'))
if ((Get-FullPath $TrustedPublicKeyPath) -cne $expectedTrustedPublicKeyPath) {
  throw 'TrustedPublicKeyPath must identify the fixed public key inside the candidate release'
}
$null = Assert-NoReparsePointPath $RecoveryRoot $TrustedPublicKeyPath 'Trusted receipt public key'
if (-not (Test-Path -LiteralPath $TrustedPublicKeyPath -PathType Leaf)) {
  throw "Trusted receipt public key is missing: $TrustedPublicKeyPath"
}
if ((Get-Sha256 $TrustedPublicKeyPath) -cne $TrustedPublicKeySha256) {
  throw 'Trusted receipt public key SHA256 mismatch'
}
$activeMarkerPath = Join-Path $RecoveryRoot 'active-release.json'
$stagedPath = Join-Path $evidence 'staged.json'
$rollbackStatePath = Join-Path $evidence 'migration-rollback-state.json'
$stoppedHandoffPath = Join-Path $evidence 'equipment-category-index-stopped-handoff.json'
$migrationStartedPath = Join-Path $evidence 'migration-started.json'
$executeClaimPath = Join-Path $evidence 'equipment-category-index-execute-claim.json'
$executeReportPath = Join-Path $evidence 'equipment-category-index-execute.json'
$idempotencyReportPath = Join-Path $evidence 'equipment-category-index-idempotency.json'
$migrationCompletedPath = Join-Path $evidence 'migration-completed.json'
$activeEvidencePath = Join-Path $evidence 'active.json'
$activationCommitPath = Join-Path $evidence 'activation-commit.json'
$failureEvidencePath = Join-Path $evidence 'migration-or-activation-failed.json'
$backupVerificationPath = Join-Path $evidence 'backup-verification-before-index-migration.json'
$stoppedDryRunPath = Join-Path $evidence 'equipment-category-index-stopped-dry-run.json'
$executeDryRunPath = Join-Path $evidence 'equipment-category-index-execute-dry-run.json'
$holdMongoAnchorPath = Join-Path $evidence 'mongo-write-anchor-hold.json'
$executeMongoAnchorPath = Join-Path $evidence 'mongo-write-anchor-execute.json'
$stableApiRunner = Join-Path $RecoveryRoot 'ops\run-active-release-api.ps1'
$stableWebRunner = Join-Path $RecoveryRoot 'ops\run-active-release-web.ps1'

foreach ($path in @(
  $candidate, $previous, $evidence, $activeMarkerPath, $stagedPath, $rollbackStatePath,
  $stoppedHandoffPath, $migrationStartedPath, $executeClaimPath, $executeReportPath,
  $idempotencyReportPath, $migrationCompletedPath, $activeEvidencePath,
  $activationCommitPath, $failureEvidencePath, $backupVerificationPath,
  $stoppedDryRunPath, $executeDryRunPath, $holdMongoAnchorPath,
  $executeMongoAnchorPath, $stableApiRunner, $stableWebRunner, $appEnvPath
)) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $path 'Postdeploy audit path'
}

if (-not $IndexAuditReport) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $IndexAuditReport = Join-Path $evidence "equipment-category-index-postaudit-$stamp-$([Guid]::NewGuid().ToString('N')).json"
}
$IndexAuditReport = Assert-PathBelow $evidence $IndexAuditReport 'IndexAuditReport'
$null = Assert-NoReparsePointPath $RecoveryRoot $IndexAuditReport 'IndexAuditReport'
if (Test-Path -LiteralPath $IndexAuditReport) { throw 'IndexAuditReport must be a new path' }

if (-not $BusinessAuditReport) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $BusinessAuditReport = Join-Path $evidence `
    "equipment-routine-business-postaudit-$stamp-$([Guid]::NewGuid().ToString('N')).json"
}
$BusinessAuditReport = Assert-PathBelow $evidence $BusinessAuditReport 'BusinessAuditReport'
$null = Assert-NoReparsePointPath $RecoveryRoot $BusinessAuditReport 'BusinessAuditReport'
if (Test-Path -LiteralPath $BusinessAuditReport) { throw 'BusinessAuditReport must be a new path' }

$failures = @()
foreach ($directory in @($candidate, $previous, $evidence)) {
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { Add-Failure "missing_directory:$directory" }
  else {
    $nestedReparse = @(Get-ChildItem -LiteralPath $directory -Recurse -Force | Where-Object {
      $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    })
    if ($nestedReparse.Count -ne 0) {
      throw "Postdeploy audit directory tree contains a reparse point: $($nestedReparse[0].FullName)"
    }
  }
}
if (Test-Path -LiteralPath $failureEvidencePath) {
  Add-Failure 'failure_evidence_present_for_committed_release'
}

$staged = Read-Json $stagedPath 'Staged evidence'
$rollbackState = Read-Json $rollbackStatePath 'Migration rollback state'
$handoff = Read-Json $stoppedHandoffPath 'Stopped handoff'
$started = Read-Json $migrationStartedPath 'Migration-started evidence'
$executeClaim = Read-Json $executeClaimPath 'Execute claim'
$backupVerification = Read-Json $backupVerificationPath 'Backup verification evidence'
$stoppedDryRun = Read-Json $stoppedDryRunPath 'Stopped-state migration dry-run report'
$executeDryRun = Read-Json $executeDryRunPath 'Execute-bound migration dry-run report'
$executeReport = Read-Json $executeReportPath 'Migration execute report'
$idempotencyReport = Read-Json $idempotencyReportPath 'Migration idempotency report'
$completed = Read-Json $migrationCompletedPath 'Migration-completed evidence'
$marker = Read-Json $activeMarkerPath 'Active marker'
$active = Read-Json $activeEvidencePath 'Active evidence'
$commit = Read-Json $activationCommitPath 'Activation commit'
$holdMongoAnchor = Read-Json $holdMongoAnchorPath 'Hold Mongo write-anchor report'
$executeMongoAnchor = Read-Json $executeMongoAnchorPath 'Execute Mongo write-anchor report'

$candidateIdentity = Assert-CandidateManifest -Staged $staged -Candidate $candidate
try { $null = Assert-PreviousReleaseTree -Staged $staged -Previous $previous }
catch { Add-Failure "previous_release_tree_mismatch:$($_.Exception.Message)" }
try { $injectedRuntime = Assert-InjectedRuntime -Candidate $candidate -Expected $staged.injectedRuntime }
catch { Add-Failure "candidate_injected_runtime_mismatch:$($_.Exception.Message)" }
if (
  $candidateIdentity.trustedPublicKeyPath -cne $TrustedPublicKeyPath -or
  $candidateIdentity.trustedPublicKeySha256 -cne $TrustedPublicKeySha256
) { throw 'Trusted receipt public key does not match the candidate release identity' }
$mongoTargetGuardPath = Join-Path $candidate 'ops\lib\v2TestMongoTargetGuard.js'
$null = Assert-NoReparsePointPath $RecoveryRoot $mongoTargetGuardPath 'Mongo target guard'
$runtimeInputs = [ordered]@{
  appEnvPath = $appEnvPath
  appEnvSha256 = $AppEnvSha256
  operationsEnvPath = $OperationsEnvPath
  operationsEnvSha256 = $OperationsEnvSha256
  mongoTargetGuardPath = 'ops/lib/v2TestMongoTargetGuard.js'
  mongoTargetGuardSha256 = Get-Sha256 $mongoTargetGuardPath
  trustedPublicKeyPath = $trustedPublicKeyRelativePath
  trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
  schemaCapabilities = @($expectedSchemaCapability)
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
  [string]$staged.runtimeInputs.schemaCapabilities[0] -cne $expectedSchemaCapability
) { Add-Failure 'staged_runtime_inputs_mismatch' }
$runtimeInputsSha256 = Get-ObjectSha256 $runtimeInputs

$hashes = [ordered]@{
  staged = Get-Sha256 $stagedPath
  rollbackState = Get-Sha256 $rollbackStatePath
  stoppedHandoff = Get-Sha256 $stoppedHandoffPath
  approvedDryRun = $null
  backupVerification = Get-Sha256 $backupVerificationPath
  stoppedDryRun = Get-Sha256 $stoppedDryRunPath
  executeDryRun = Get-Sha256 $executeDryRunPath
  executeClaim = Get-Sha256 $executeClaimPath
  migrationStarted = Get-Sha256 $migrationStartedPath
  executeReport = Get-Sha256 $executeReportPath
  idempotencyReport = Get-Sha256 $idempotencyReportPath
  migrationCompleted = Get-Sha256 $migrationCompletedPath
  activeEvidence = Get-Sha256 $activeEvidencePath
  activeMarker = Get-Sha256 $activeMarkerPath
  activationCommit = Get-Sha256 $activationCommitPath
  holdMongoAnchor = Get-Sha256 $holdMongoAnchorPath
  executeMongoAnchor = Get-Sha256 $executeMongoAnchorPath
  candidateReleaseMetadata = $candidateIdentity.metadataSha256
  candidateFileManifest = $candidateIdentity.manifestSha256
}
if (-not (Test-MongoAnchorReport $holdMongoAnchor)) {
  Add-Failure 'hold_mongo_write_anchor_report_invalid'
}
if (-not (Test-MongoAnchorReport $executeMongoAnchor)) {
  Add-Failure 'execute_mongo_write_anchor_report_invalid'
}
if (
  [string]$holdMongoAnchor.writeAnchorSha256 -cne [string]$executeMongoAnchor.writeAnchorSha256 -or
  (Get-ObjectSha256 $holdMongoAnchor.anchor) -cne (Get-ObjectSha256 $executeMongoAnchor.anchor)
) { Add-Failure 'mongo_write_anchor_changed_during_stopped_backup_window' }

$approvedDryRunPath = $null
if ([string]$started.approvedDryRunReport) {
  $approvedDryRunPath = Assert-PathBelow $evidence `
    (Join-Path $evidence ([string]$started.approvedDryRunReport)) 'Approved dry-run report'
  $hashes['approvedDryRun'] = Get-Sha256 $approvedDryRunPath
}
$offhostReceiptPath = Assert-PathBelow $evidence `
  ([string]$started.offhostVerificationReceipt) 'Off-host verification receipt'
$null = Assert-NoReparsePointPath $RecoveryRoot $offhostReceiptPath 'Signed off-host verification receipt'
if ([IO.Path]::GetFileName($offhostReceiptPath) -ne "offhost-verification-$BackupId.json") {
  Add-Failure 'offhost_receipt_path_mismatch'
}
$offhostReceipt = Read-SignedOffhostVerificationReceipt `
  $offhostReceiptPath $OffhostVerificationReceiptSha256 `
  $RecoveryRoot $TrustedPublicKeyPath $TrustedPublicKeySha256
$hashes['offhostVerificationReceipt'] = Get-Sha256 $offhostReceiptPath

if ($hashes.staged -ne $StagedEvidenceSha256) { Add-Failure 'staged_sha256_mismatch' }
if (
  $staged.status -ne 'WINDOWS_RECOVERY_CANDIDATE_STAGED' -or
  $staged.releaseId -ne $ReleaseId -or
  $staged.sourceCommit -ne $SourceCommit -or
  $staged.previousReleaseId -ne $PreviousReleaseId -or
  $staged.previousCommit -ne $PreviousCommit -or
  $staged.runtimeInputsSha256 -cne $runtimeInputsSha256
) { Add-Failure 'staged_identity_mismatch' }

if ($hashes.stoppedHandoff -ne $StoppedHandoffSha256) { Add-Failure 'stopped_handoff_sha256_mismatch' }
if (
  $rollbackState.format -ne 'task-distribution-v2-windows-index-migration-rollback-state/v2' -or
  $rollbackState.status -ne 'PRE_MIGRATION_RUNTIME_STATE_CAPTURED' -or
  $rollbackState.releaseId -ne $ReleaseId -or
  $rollbackState.sourceCommit -ne $SourceCommit -or
  $rollbackState.previousReleaseId -ne $PreviousReleaseId -or
  $rollbackState.previousCommit -ne $PreviousCommit -or
  $rollbackState.database -ne $expectedDatabase -or
  $rollbackState.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $rollbackState.rollbackReady -ne $false
) { Add-Failure 'rollback_state_identity_mismatch' }
if (
  $handoff.format -ne 'task-distribution-v2-windows-equipment-category-index-stopped-handoff/v1' -or
  $handoff.status -ne 'BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP' -or
  $handoff.releaseId -ne $ReleaseId -or
  $handoff.sourceCommit -ne $SourceCommit -or
  $handoff.previousReleaseId -ne $PreviousReleaseId -or
  $handoff.previousCommit -ne $PreviousCommit -or
  $handoff.database -ne $expectedDatabase -or
  $handoff.sourceHost -ne $env:COMPUTERNAME -or
  $handoff.handoffNonce -ne $HandoffNonce -or
  $handoff.stagedEvidenceSha256 -ne $StagedEvidenceSha256 -or
  $handoff.approvedDryRunSha256 -ne $hashes.approvedDryRun -or
  $handoff.stoppedDryRunSha256 -ne $hashes.stoppedDryRun -or
  $handoff.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $handoff.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
  $handoff.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
  $handoff.rollbackStateSha256 -ne $hashes.rollbackState -or
  $handoff.stagedPredeployBackupId -ne $staged.predeployBackup.backupId -or
  $handoff.stagedPredeployBackupId -eq $BackupId -or
  @($handoff.heldTasks).Count -ne 3 -or
  $handoff.businessListenersAbsent -ne $true -or
  $handoff.rollbackReady -ne $false
) { Add-Failure 'stopped_handoff_identity_mismatch' }
if (
  $executeClaim.format -ne 'task-distribution-v2-windows-equipment-category-index-execute-claim/v1' -or
  $executeClaim.status -ne 'HANDOFF_NONCE_CONSUMED' -or
  $executeClaim.releaseId -ne $ReleaseId -or
  $executeClaim.sourceCommit -ne $SourceCommit -or
  $executeClaim.previousReleaseId -ne $PreviousReleaseId -or
  $executeClaim.previousCommit -ne $PreviousCommit -or
  $executeClaim.database -ne $expectedDatabase -or
  $executeClaim.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
  $executeClaim.handoffNonce -ne $HandoffNonce -or
  $executeClaim.backupId -ne $BackupId -or
  $executeClaim.backupManifestSha256 -ne $BackupManifestSha256 -or
  $executeClaim.offhostVerificationReceiptSha256 -ne $OffhostVerificationReceiptSha256 -or
  $executeClaim.trustedPublicKeySha256 -cne $TrustedPublicKeySha256 -or
  $executeClaim.trustedPublicKeyPath -cne $trustedPublicKeyRelativePath -or
  $executeClaim.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $executeClaim.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
  $executeClaim.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
  $executeClaim.executeMongoAnchorPath -cne $executeMongoAnchorPath -or
  $executeClaim.executeMongoAnchorSha256 -cne $hashes.executeMongoAnchor -or
  $executeClaim.approvedDryRunSha256 -ne $hashes.approvedDryRun -or
  $executeClaim.stoppedDryRunSha256 -ne $hashes.stoppedDryRun -or
  $executeClaim.executeDryRunSha256 -ne $hashes.executeDryRun -or
  $executeClaim.backupVerificationSha256 -ne $hashes.backupVerification -or
  $executeClaim.rollbackReady -ne $false
) { Add-Failure 'execute_claim_identity_mismatch' }
Assert-ExactJsonProperties $offhostReceipt @(
  'format', 'status', 'verifiedAt', 'releaseId', 'sourceCommit',
  'previousReleaseId', 'previousCommit', 'database', 'databaseTarget',
  'backupId', 'manifestSha256', 'manifestCreatedAt', 'manifestCompletedAt',
  'stoppedHandoffSha256', 'handoffNonce', 'sourceHost', 'independentHost',
  'independentCopyRoot', 'independentWorkstationVerified', 'archiveFileName',
  'archivePath', 'archiveSha256', 'archiveBytes', 'extractedBackupPath',
  'checks', 'consistency', 'verification'
) 'Signed off-host receipt payload'
Assert-ExactJsonProperties $offhostReceipt.databaseTarget `
  @('hosts', 'servers', 'replicaSet') 'Signed receipt databaseTarget'
Assert-ExactJsonProperties $offhostReceipt.checks @(
  'archiveSha256MatchesSource', 'archiveBytesMatchSource', 'manifestSha256Valid',
  'exactFileSetValid', 'everyDeclaredFileSha256Valid', 'requiredCollectionDumpsPresent',
  'requiredMetadataPresent', 'uploadsManifestVerified', 'fileAssetReferencesVerified'
) 'Signed receipt checks'
Assert-ExactJsonProperties $offhostReceipt.consistency `
  @('captureMode', 'databaseAndUploadsAtomic') 'Signed receipt consistency'
Assert-ExactJsonProperties $offhostReceipt.verification @(
  'nodeVersion', 'nodeSha256', 'backupCoreSha256', 'receiptGeneratorSha256',
  'trustedPublicKeySha256', 'zipEntryCount', 'declaredFileCount', 'uploadFileCount',
  'fileAssetReferences'
) 'Signed receipt verification'
Assert-ExactJsonProperties $offhostReceipt.verification.fileAssetReferences `
  @('referenced', 'verified') 'Signed receipt FileAsset references'

$receiptNodePath = Join-Path $candidate 'runtime-node\node.exe'
$receiptBackupCorePath = Join-Path $candidate 'ops\lib\backupCore.js'
$receiptGeneratorPath = Join-Path $candidate 'ops\windows\New-V2RecoveryStoppedBackupOffhostReceipt.ps1'
foreach ($path in @($receiptNodePath, $receiptBackupCorePath, $receiptGeneratorPath)) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $path 'Signed receipt verification tool'
}

if (
  $offhostReceipt.format -ne 'task-distribution-v2-windows-stopped-backup-offhost-verification/v1' -or
  $offhostReceipt.status -ne 'STOPPED_BACKUP_OFFHOST_VERIFIED' -or
  $offhostReceipt.releaseId -ne $ReleaseId -or
  $offhostReceipt.sourceCommit -ne $SourceCommit -or
  $offhostReceipt.previousReleaseId -ne $PreviousReleaseId -or
  $offhostReceipt.previousCommit -ne $PreviousCommit -or
  $offhostReceipt.database -ne $expectedDatabase -or
  @($offhostReceipt.databaseTarget.hosts).Count -ne 1 -or
  $offhostReceipt.databaseTarget.hosts[0] -ne '127.0.0.1' -or
  @($offhostReceipt.databaseTarget.servers).Count -ne 1 -or
  $offhostReceipt.databaseTarget.servers[0] -ne '127.0.0.1:27150' -or
  $offhostReceipt.databaseTarget.replicaSet -ne 'customer_acceptance_v2_rs' -or
  $offhostReceipt.backupId -ne $BackupId -or
  $offhostReceipt.manifestSha256 -ne $BackupManifestSha256 -or
  $offhostReceipt.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
  $offhostReceipt.handoffNonce -ne $HandoffNonce -or
  $offhostReceipt.sourceHost -ne $handoff.sourceHost -or
  $offhostReceipt.sourceHost -ne $env:COMPUTERNAME -or
  $offhostReceipt.independentWorkstationVerified -ne $true -or
  $offhostReceipt.archiveFileName -ne "$BackupId.zip" -or
  [string]$offhostReceipt.archiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or
  [int64]$offhostReceipt.archiveBytes -le 0 -or
  -not ([string]$offhostReceipt.independentCopyRoot).StartsWith('E:\', [StringComparison]::OrdinalIgnoreCase) -or
  $offhostReceipt.checks.archiveSha256MatchesSource -ne $true -or
  $offhostReceipt.checks.archiveBytesMatchSource -ne $true -or
  $offhostReceipt.checks.manifestSha256Valid -ne $true -or
  $offhostReceipt.checks.exactFileSetValid -ne $true -or
  $offhostReceipt.checks.everyDeclaredFileSha256Valid -ne $true -or
  $offhostReceipt.checks.requiredCollectionDumpsPresent -ne $true -or
  $offhostReceipt.checks.requiredMetadataPresent -ne $true -or
  $offhostReceipt.checks.uploadsManifestVerified -ne $true -or
  $offhostReceipt.checks.fileAssetReferencesVerified -ne $true -or
  $offhostReceipt.consistency.captureMode -ne 'BEST_EFFORT_ONLINE_MONGODUMP' -or
  $offhostReceipt.consistency.databaseAndUploadsAtomic -ne $false -or
  $offhostReceipt.verification.nodeVersion -ne 'v22.23.1' -or
  $offhostReceipt.verification.nodeSha256 -ne (Get-Sha256 $receiptNodePath) -or
  $offhostReceipt.verification.backupCoreSha256 -ne (Get-Sha256 $receiptBackupCorePath) -or
  $offhostReceipt.verification.receiptGeneratorSha256 -ne (Get-Sha256 $receiptGeneratorPath) -or
  $offhostReceipt.verification.trustedPublicKeySha256 -cne $TrustedPublicKeySha256 -or
  [int64]$offhostReceipt.verification.zipEntryCount -lt 2 -or
  [int64]$offhostReceipt.verification.declaredFileCount -lt 2 -or
  [int64]$offhostReceipt.verification.uploadFileCount -lt 0 -or
  [int64]$offhostReceipt.verification.declaredFileCount -lt `
    ([int64]$offhostReceipt.verification.uploadFileCount + 2) -or
  [int64]$offhostReceipt.verification.zipEntryCount -lt `
    ([int64]$offhostReceipt.verification.declaredFileCount + 2) -or
  [int64]$offhostReceipt.verification.fileAssetReferences.referenced -lt 0 -or
  [int64]$offhostReceipt.verification.fileAssetReferences.referenced -ne `
    [int64]$offhostReceipt.verification.fileAssetReferences.verified -or
  $hashes.offhostVerificationReceipt -ne $OffhostVerificationReceiptSha256
) { Add-Failure 'offhost_receipt_identity_mismatch' }

$independentCopyRoot = Get-FullPath ([string]$offhostReceipt.independentCopyRoot)
if ([IO.Path]::GetPathRoot($independentCopyRoot).TrimEnd('\') -ne 'E:') {
  Add-Failure 'offhost_receipt_independent_root_mismatch'
}
try {
  $archivePath = Assert-PathBelow $independentCopyRoot `
    ([string]$offhostReceipt.archivePath) 'Signed receipt archivePath'
  $extractedBackupPath = Assert-PathBelow $independentCopyRoot `
    ([string]$offhostReceipt.extractedBackupPath) 'Signed receipt extractedBackupPath'
  if (
    [IO.Path]::GetFileName($archivePath) -ne "$BackupId.zip" -or
    [IO.Path]::GetFileName($extractedBackupPath) -ne $BackupId
  ) { Add-Failure 'offhost_receipt_archive_path_mismatch' }
}
catch { Add-Failure 'offhost_receipt_archive_path_mismatch' }
if (
  -not ([string]$offhostReceipt.independentHost).Trim() -or
  ([string]$offhostReceipt.independentHost).Equals(
    [string]$offhostReceipt.sourceHost,
    [StringComparison]::OrdinalIgnoreCase
  )
) { Add-Failure 'offhost_receipt_independent_host_mismatch' }

if (
  $started.format -ne 'task-distribution-v2-windows-equipment-category-index-migration-started/v1' -or
  $started.status -ne 'MIGRATION_STARTED' -or
  $started.releaseId -ne $ReleaseId -or
  $started.sourceCommit -ne $SourceCommit -or
  $started.previousReleaseId -ne $PreviousReleaseId -or
  $started.previousCommit -ne $PreviousCommit -or
  $started.database -ne $expectedDatabase -or
  $started.backupId -ne $BackupId -or
  $started.backupManifestSha256 -ne $BackupManifestSha256 -or
  $started.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
  $started.handoffNonce -ne $HandoffNonce -or
  $started.executeClaimSha256 -ne $hashes.executeClaim -or
  $started.offhostVerificationReceiptSha256 -ne $OffhostVerificationReceiptSha256 -or
  $started.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $started.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
  $started.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
  $started.executeMongoAnchorPath -cne $executeMongoAnchorPath -or
  $started.executeMongoAnchorSha256 -cne $hashes.executeMongoAnchor -or
  $started.stagedEvidenceSha256 -ne $StagedEvidenceSha256 -or
  $started.approvedDryRunSha256 -ne $hashes.approvedDryRun -or
  $started.stoppedDryRunSha256 -ne $hashes.stoppedDryRun -or
  $started.executeDryRunSha256 -ne $hashes.executeDryRun -or
  $started.backupVerificationSha256 -ne $hashes.backupVerification -or
  $started.servicesHeldStopped -ne $true -or
  $started.rollbackReady -ne $false -or
  $started.codeOnlyRollbackAllowed -ne $false -or
  $started.requiredRecovery -ne 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
) { Add-Failure 'migration_started_identity_mismatch' }
if (
  $backupVerification.format -ne 'task-distribution-v2-windows-backup-verification-before-index-migration/v2' -or
  $backupVerification.status -ne 'STOPPED_BACKUP_AND_OFFHOST_RECEIPT_VERIFIED_BEFORE_INDEX_MIGRATION' -or
  $backupVerification.releaseId -ne $ReleaseId -or
  $backupVerification.sourceCommit -ne $SourceCommit -or
  $backupVerification.previousReleaseId -ne $PreviousReleaseId -or
  $backupVerification.previousCommit -ne $PreviousCommit -or
  $backupVerification.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
  $backupVerification.handoffNonce -ne $HandoffNonce -or
  $backupVerification.backupId -ne $BackupId -or
  $backupVerification.manifestSha256 -ne $BackupManifestSha256 -or
  $backupVerification.offhostVerificationReceiptSha256 -ne $OffhostVerificationReceiptSha256 -or
  $backupVerification.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $backupVerification.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
  $backupVerification.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
  $backupVerification.executeMongoAnchorPath -cne $executeMongoAnchorPath -or
  $backupVerification.executeMongoAnchorSha256 -cne $hashes.executeMongoAnchor -or
  $backupVerification.trustedPublicKeyPath -cne $trustedPublicKeyRelativePath -or
  $backupVerification.trustedPublicKeySha256 -cne $TrustedPublicKeySha256 -or
  $backupVerification.database -ne $expectedDatabase -or
  $backupVerification.equipmentCategoriesDumpPresent -ne $true -or
  $backupVerification.fullFileVerificationPassed -ne $true -or
  $backupVerification.independentWorkstationVerified -ne $true -or
  $backupVerification.servicesHeldStopped -ne $true
) { Add-Failure 'backup_verification_evidence_mismatch' }
$handoffStoppedAt = [DateTimeOffset]::MinValue
$manifestCreatedAt = [DateTimeOffset]::MinValue
$manifestCompletedAt = [DateTimeOffset]::MinValue
$receiptVerifiedAt = [DateTimeOffset]::MinValue
if (
  -not [DateTimeOffset]::TryParse([string]$handoff.stoppedAt, [ref]$handoffStoppedAt) -or
  -not [DateTimeOffset]::TryParse([string]$backupVerification.manifestCreatedAt, [ref]$manifestCreatedAt) -or
  -not [DateTimeOffset]::TryParse([string]$backupVerification.manifestCompletedAt, [ref]$manifestCompletedAt) -or
  -not [DateTimeOffset]::TryParse([string]$offhostReceipt.verifiedAt, [ref]$receiptVerifiedAt) -or
  $manifestCreatedAt -lt $handoffStoppedAt -or
  $manifestCompletedAt -lt $handoffStoppedAt -or
  $manifestCompletedAt -lt $manifestCreatedAt -or
  $receiptVerifiedAt -lt $manifestCompletedAt -or
  $offhostReceipt.manifestCreatedAt -ne $backupVerification.manifestCreatedAt -or
  $offhostReceipt.manifestCompletedAt -ne $backupVerification.manifestCompletedAt
) { Add-Failure 'stopped_backup_timestamp_chain_mismatch' }
if (
  $stoppedDryRun.format -ne 'equipment-category-parent-name-index-migration/v1' -or
  $stoppedDryRun.status -ne 'DRY_RUN_READY' -or
  $stoppedDryRun.mode -ne 'dry-run' -or
  $stoppedDryRun.database.name -ne $expectedDatabase -or
  $stoppedDryRun.writePerformed -ne $false -or
  $stoppedDryRun.before.indexes.desiredPresent -ne $false -or
  @($stoppedDryRun.before.indexes.legacy).Count -ne 1 -or
  @($stoppedDryRun.before.indexes.unknownTeamWideUnique).Count -ne 0 -or
  @($stoppedDryRun.before.blockers).Count -ne 0
) { Add-Failure 'stopped_dry_run_report_mismatch' }
if (
  $executeDryRun.format -ne 'equipment-category-parent-name-index-migration/v1' -or
  $executeDryRun.status -ne 'DRY_RUN_READY' -or
  $executeDryRun.mode -ne 'dry-run' -or
  $executeDryRun.database.name -ne $expectedDatabase -or
  $executeDryRun.writePerformed -ne $false -or
  $executeDryRun.before.indexes.desiredPresent -ne $false -or
  @($executeDryRun.before.indexes.legacy).Count -ne 1 -or
  @($executeDryRun.before.indexes.unknownTeamWideUnique).Count -ne 0 -or
  @($executeDryRun.before.blockers).Count -ne 0
) { Add-Failure 'execute_dry_run_report_mismatch' }

if (
  $executeReport.format -ne 'equipment-category-parent-name-index-migration/v1' -or
  $executeReport.status -ne 'EXECUTED' -or
  $executeReport.mode -ne 'execute' -or
  $executeReport.database.name -ne $expectedDatabase -or
  $executeReport.backup.backupId -ne $BackupId -or
  $executeReport.backup.manifestSha256 -ne $BackupManifestSha256 -or
  $executeReport.writePerformed -ne $true -or
  -not (Test-AfterIndexState $executeReport.after)
) { Add-Failure 'migration_execute_report_mismatch' }

if (
  $idempotencyReport.format -ne 'equipment-category-parent-name-index-migration/v1' -or
  $idempotencyReport.status -ne 'ALREADY_APPLIED' -or
  $idempotencyReport.mode -ne 'execute' -or
  $idempotencyReport.database.name -ne $expectedDatabase -or
  $idempotencyReport.backup.backupId -ne $BackupId -or
  $idempotencyReport.backup.manifestSha256 -ne $BackupManifestSha256 -or
  $idempotencyReport.writePerformed -ne $false -or
  -not (Test-AfterIndexState $idempotencyReport.before) -or
  -not (Test-AfterIndexState $idempotencyReport.after)
) { Add-Failure 'migration_idempotency_report_mismatch' }

if (
  $completed.format -ne 'task-distribution-v2-windows-equipment-category-index-migration-completed/v1' -or
  $completed.status -ne 'MIGRATION_EXECUTED_AND_IDEMPOTENCY_VERIFIED' -or
  $completed.releaseId -ne $ReleaseId -or
  $completed.sourceCommit -ne $SourceCommit -or
  $completed.backupId -ne $BackupId -or
  $completed.backupManifestSha256 -ne $BackupManifestSha256 -or
  $completed.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
  $completed.handoffNonce -ne $HandoffNonce -or
  $completed.executeClaimSha256 -ne $hashes.executeClaim -or
  $completed.offhostVerificationReceiptSha256 -ne $OffhostVerificationReceiptSha256 -or
  $completed.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
  $completed.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
  $completed.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
  $completed.executeMongoAnchorPath -cne $executeMongoAnchorPath -or
  $completed.executeMongoAnchorSha256 -cne $hashes.executeMongoAnchor -or
  $completed.migrationStartedSha256 -ne $hashes.migrationStarted -or
  $completed.approvedDryRunSha256 -ne $hashes.approvedDryRun -or
  $completed.stoppedDryRunSha256 -ne $hashes.stoppedDryRun -or
  $completed.executeDryRunSha256 -ne $hashes.executeDryRun -or
  $completed.executeReportSha256 -ne $hashes.executeReport -or
  $completed.idempotencyReportSha256 -ne $hashes.idempotencyReport -or
  $completed.databaseMigrationPerformed -ne $true -or
  $completed.rollbackReady -ne $false -or
  $completed.codeOnlyRollbackAllowed -ne $false -or
  $completed.requiredRecovery -ne 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
) { Add-Failure 'migration_completed_evidence_mismatch' }

foreach ($state in @($marker, $active, $commit)) {
  if (
    $state.releaseId -ne $ReleaseId -or
    $state.sourceCommit -ne $SourceCommit -or
    $state.previousReleaseId -ne $PreviousReleaseId -or
    $state.previousCommit -ne $PreviousCommit -or
    $state.database -ne $expectedDatabase -or
    $state.backupId -ne $BackupId -or
    $state.backupManifestSha256 -ne $BackupManifestSha256 -or
    $state.stoppedHandoffSha256 -ne $StoppedHandoffSha256 -or
    $state.handoffNonce -ne $HandoffNonce -or
    $state.runtimeInputsSha256 -cne $runtimeInputsSha256 -or
    $state.appEnvSha256 -cne $AppEnvSha256 -or
    $state.trustedPublicKeyPath -cne $trustedPublicKeyRelativePath -or
    $state.trustedPublicKeySha256 -cne $TrustedPublicKeySha256 -or
    @($state.schemaCapabilities).Count -ne 1 -or
    [string]$state.schemaCapabilities[0] -cne $expectedSchemaCapability -or
    $state.holdMongoAnchorPath -cne $holdMongoAnchorPath -or
    $state.holdMongoAnchorSha256 -cne $hashes.holdMongoAnchor -or
    $state.executeMongoAnchorPath -cne $executeMongoAnchorPath -or
    $state.executeMongoAnchorSha256 -cne $hashes.executeMongoAnchor -or
    $state.executeClaimSha256 -ne $hashes.executeClaim -or
    $state.offhostVerificationReceiptSha256 -ne $OffhostVerificationReceiptSha256 -or
    $state.migrationStartedSha256 -ne $hashes.migrationStarted -or
    $state.executeReportSha256 -ne $hashes.executeReport -or
    $state.idempotencyReportSha256 -ne $hashes.idempotencyReport -or
    $state.migrationCompletedSha256 -ne $hashes.migrationCompleted -or
    $state.databaseMigrationPerformed -ne $true -or
    $state.rollbackReady -ne $false -or
    $state.codeOnlyRollbackAllowed -ne $false -or
    $state.requiredRecovery -ne 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE' -or
    $state.workerEnabled -ne $true -or
    $state.businessTunnelRestored -ne $true
  ) { Add-Failure "active_chain_identity_mismatch:$($state.status)" }
}
if ($marker.status -ne 'WINDOWS_RECOVERY_RELEASE_ACTIVE') { Add-Failure 'active_marker_status_mismatch' }
if ($active.status -ne 'WINDOWS_RECOVERY_RELEASE_ACTIVE') { Add-Failure 'active_evidence_status_mismatch' }
if ($commit.status -ne 'ACTIVATION_COMMITTED') { Add-Failure 'activation_commit_status_mismatch' }
if (
  $marker.stagedEvidenceSha256 -cne $StagedEvidenceSha256 -or
  $active.stagedEvidenceSha256 -cne $StagedEvidenceSha256
) { Add-Failure 'active_staged_evidence_hash_mismatch' }
if ($marker.activeEvidenceSha256 -ne $hashes.activeEvidence) { Add-Failure 'active_marker_evidence_hash_mismatch' }
if ($commit.activeEvidenceSha256 -ne $hashes.activeEvidence) { Add-Failure 'commit_active_evidence_hash_mismatch' }
if ($commit.activeMarkerSha256 -ne $hashes.activeMarker) { Add-Failure 'commit_active_marker_hash_mismatch' }
$stableApiRunnerSha256 = Get-Sha256 $stableApiRunner
$stableWebRunnerSha256 = Get-Sha256 $stableWebRunner
foreach ($state in @($marker, $active, $commit)) {
  if (
    $state.stableRunnerHashes.api -cne $stableApiRunnerSha256 -or
    $state.stableRunnerHashes.web -cne $stableWebRunnerSha256
  ) { Add-Failure "stable_runner_hash_chain_mismatch:$($state.status)" }
}
$stableApiText = [IO.File]::ReadAllText($stableApiRunner)
foreach ($required in @(
  'equipment-category-parent-name-index-v1',
  'deploy\RELEASE.json',
  'trusted-offhost-receipt-public-key.xml',
  'config\app.env',
  'REQUIRED_SCHEMA_CAPABILITIES',
  'runtimeInputsSha256',
  'stagedEvidenceSha256'
)) {
  if (-not $stableApiText.Contains($required)) {
    Add-Failure "stable_api_runtime_gate_missing:$required"
  }
}

$tasks = @(
  Get-TaskState $apiTask
  Get-TaskState $webTask
  Get-TaskState $businessTunnelTask
  Get-TaskState $managementTunnelTask
  Get-TaskState $mongoTask
)
if (@($tasks | Where-Object state -ne 'Running').Count -ne 0) { Add-Failure 'recovery_task_not_running' }
$expectedApiArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$stableApiRunner`""
$expectedWebArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$stableWebRunner`""
if (
  $tasks[0].actionCount -ne 1 -or $tasks[0].execute -ne $powershell -or
  $tasks[0].arguments -ne $expectedApiArguments -or $tasks[0].workingDirectory -ne '' -or
  $tasks[1].actionCount -ne 1 -or $tasks[1].execute -ne $powershell -or
  $tasks[1].arguments -ne $expectedWebArguments -or $tasks[1].workingDirectory -ne ''
) { Add-Failure 'stable_task_action_mismatch' }

$tunnelBoundary = $null
try { $tunnelBoundary = Assert-TunnelBoundary $tasks[2] }
catch { Add-Failure "business_tunnel_boundary_mismatch:$($_.Exception.Message)" }
$listeners = @(
  Get-Listener 18120
  Get-Listener 18130
)
if (@($listeners | Where-Object { $_.count -ne 1 -or $_.address -ne '127.0.0.1' -or -not $_.release }).Count -ne 0) {
  Add-Failure 'listener_or_process_identity_mismatch'
}

$localApi = Select-Health (Get-Http 'http://127.0.0.1:18120/health')
$localWeb = Select-Health (Get-Http 'http://127.0.0.1:18130/health')
$publicV2 = Select-Health (Get-Http 'https://v2-test.horselink.cn/health')
$teamsResponse = Get-Http 'https://v2-test.horselink.cn/api/auth/login-teams'
$teamCodes = @([regex]::Matches($teamsResponse.body, '"code"\s*:\s*"([^"]+)"') | ForEach-Object {
  $_.Groups[1].Value
} | Sort-Object -Unique)
if (-not (Test-RecoveryHealth $localApi)) { Add-Failure 'local_api_health_failed' }
if (-not (Test-RecoveryHealth $localWeb)) { Add-Failure 'local_web_health_failed' }
if (-not (Test-RecoveryHealth $publicV2)) { Add-Failure 'public_v2_health_failed' }
if (
  $teamsResponse.status -ne 200 -or
  -not ($teamCodes -contains 'ENGINE_LOGISTICS') -or
  -not ($teamCodes -contains 'GEARBOX_LOGISTICS')
) { Add-Failure 'public_login_teams_failed' }

$node = Join-Path $candidate 'runtime-node\node.exe'
$cli = Join-Path $candidate 'app\script\migrateEquipmentCategoryIndex.js'
$businessAuditCli = Join-Path $candidate 'app\script\auditEquipmentRoutineBusiness.js'
foreach ($path in @(
  $node,
  $cli,
  $businessAuditCli,
  $appEnvPath,
  $IndexAuditReport,
  $BusinessAuditReport
)) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $path 'Postdeploy index audit execution path'
}
$previousEnvFile = $env:ENV_FILE
$hadEnvFile = Test-Path Env:ENV_FILE
$previousRequiredSchemaCapabilities = $env:REQUIRED_SCHEMA_CAPABILITIES
$hadRequiredSchemaCapabilities = Test-Path Env:REQUIRED_SCHEMA_CAPABILITIES
$businessAuditOutput = @()
$businessAuditExitCode = $null
try {
  $env:ENV_FILE = $appEnvPath
  $env:REQUIRED_SCHEMA_CAPABILITIES = $expectedSchemaCapability
  $cliOutput = @(& $node $cli --dry-run --report $IndexAuditReport 2>&1)
  if ($LASTEXITCODE -ne 0) { Add-Failure "postdeploy_index_cli_failed:$($cliOutput -join ' ')" }

  $businessAuditOutput = @(& $node $businessAuditCli `
    --team-code 'GEARBOX_LOGISTICS' `
    --expect-primary "$leadAcidForkliftPrimaryName=6" `
    --expect-primary "$lithiumForkliftPrimaryName=5" `
    --expect-primary "$rollerConveyorPrimaryName=1" 2>&1)
  $businessAuditExitCode = $LASTEXITCODE
  $businessAuditText = @($businessAuditOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  Write-Utf8NoBomCreateNew $BusinessAuditReport "$businessAuditText`n"
  if ($businessAuditExitCode -ne 0) {
    Add-Failure "postdeploy_business_audit_cli_failed:$($businessAuditOutput -join ' ')"
  }
}
finally {
  if ($hadEnvFile) { $env:ENV_FILE = $previousEnvFile }
  else { Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue }
  if ($hadRequiredSchemaCapabilities) {
    $env:REQUIRED_SCHEMA_CAPABILITIES = $previousRequiredSchemaCapabilities
  }
  else { Remove-Item Env:REQUIRED_SCHEMA_CAPABILITIES -ErrorAction SilentlyContinue }
}
$indexAudit = $null
if (Test-Path -LiteralPath $IndexAuditReport -PathType Leaf) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $IndexAuditReport 'Postdeploy index audit report'
  $indexAudit = Read-Json $IndexAuditReport 'Postdeploy index audit report'
  if (
    $indexAudit.format -ne 'equipment-category-parent-name-index-migration/v1' -or
    $indexAudit.status -ne 'DRY_RUN_ALREADY_APPLIED' -or
    $indexAudit.mode -ne 'dry-run' -or
    $indexAudit.database.name -ne $expectedDatabase -or
    $indexAudit.writePerformed -ne $false -or
    -not (Test-AfterIndexState $indexAudit.before)
  ) { Add-Failure 'postdeploy_index_state_mismatch' }
}
else { Add-Failure 'postdeploy_index_report_missing' }

$businessAudit = $null
if (Test-Path -LiteralPath $BusinessAuditReport -PathType Leaf) {
  $null = Assert-NoReparsePointPath $RecoveryRoot $BusinessAuditReport `
    'Postdeploy equipment routine business audit report'
  try { $businessAudit = Read-Json $BusinessAuditReport 'Postdeploy equipment routine business audit report' }
  catch { Add-Failure "postdeploy_business_audit_report_invalid:$($_.Exception.Message)" }
  if ($businessAudit) {
    $reportedPrimaryCounts = @{}
    foreach ($target in @($businessAudit.targetPrimaries)) {
      $reportedPrimaryCounts[[string]$target.requestedName] = $target
    }
    $primaryCoverageValid = @($businessAudit.targetPrimaries).Count -eq $expectedPrimaryInUseCounts.Count
    foreach ($entry in $expectedPrimaryInUseCounts.GetEnumerator()) {
      $target = $reportedPrimaryCounts[[string]$entry.Key]
      if (
        $null -eq $target -or
        $target.status -ne 'PASSED' -or
        [int]$target.expectedInUseEquipmentCount -ne [int]$entry.Value -or
        [int]$target.inUseEquipmentCount -ne [int]$entry.Value -or
        [int]$target.equipmentWithOpenPlanCount -ne [int]$entry.Value -or
        $target.gates.expectedInUseMatches -ne $true -or
        $target.gates.hasActiveRules -ne $true -or
        $target.gates.completeOpenPlanCoverage -ne $true
      ) { $primaryCoverageValid = $false }
    }
    if (
      $businessAudit.format -ne 'taskdistribution-v2-equipment-routine-business-audit-v1' -or
      $businessAudit.status -ne 'PASSED' -or
      $businessAudit.mode -ne 'read-only' -or
      $businessAudit.writePerformed -ne $false -or
      $businessAudit.database.name -ne $expectedDatabase -or
      $businessAudit.filters.teamCode -ne 'GEARBOX_LOGISTICS' -or
      [int]$businessAudit.summary.violationCount -ne 0 -or
      @($businessAudit.violations).Count -ne 0 -or
      -not $primaryCoverageValid
    ) { Add-Failure 'postdeploy_equipment_routine_business_gate_failed' }
  }
}
else { Add-Failure 'postdeploy_business_audit_report_missing' }

if ((Get-Sha256 $appEnvPath) -cne $AppEnvSha256) {
  Add-Failure 'application_environment_changed_during_postaudit'
}
if ((Get-Sha256 $OperationsEnvPath) -cne $OperationsEnvSha256) {
  Add-Failure 'operations_environment_changed_during_postaudit'
}

$result = [ordered]@{
  format = 'task-distribution-v2-windows-equipment-category-index-postaudit/v1'
  status = if ($failures.Count -eq 0) { 'POSTDEPLOY_AUDIT_PASSED' } else { 'POSTDEPLOY_AUDIT_FAILED' }
  observedAt = (Get-Date).ToUniversalTime().ToString('o')
  releaseId = $ReleaseId
  sourceCommit = $SourceCommit
  previousReleaseId = $PreviousReleaseId
  previousCommit = $PreviousCommit
  database = $expectedDatabase
  backupId = $BackupId
  backupManifestSha256 = $BackupManifestSha256
  stoppedHandoffSha256 = $StoppedHandoffSha256
  handoffNonce = $HandoffNonce
  offhostVerificationReceiptSha256 = $OffhostVerificationReceiptSha256
  trustedPublicKeySha256 = $TrustedPublicKeySha256
  runtimeInputs = $runtimeInputs
  runtimeInputsSha256 = $runtimeInputsSha256
  rollbackReady = $false
  codeOnlyRollbackAllowed = $false
  requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'
  evidenceHashes = $hashes
  candidate = [ordered]@{
    releaseMetadataSha256 = $candidateIdentity.metadataSha256
    fileManifestSha256 = $candidateIdentity.manifestSha256
    schemaCapabilities = @($candidateIdentity.metadata.schemaCapabilities)
    trustedPublicKeyPath = $trustedPublicKeyRelativePath
    trustedPublicKeySha256 = $candidateIdentity.trustedPublicKeySha256
  }
  mongoWriteAnchors = [ordered]@{
    holdPath = $holdMongoAnchorPath
    holdSha256 = $hashes.holdMongoAnchor
    executePath = $executeMongoAnchorPath
    executeSha256 = $hashes.executeMongoAnchor
    holdWriteAnchorSha256 = $holdMongoAnchor.writeAnchorSha256
    executeWriteAnchorSha256 = $executeMongoAnchor.writeAnchorSha256
    unchangedDuringStoppedBackupWindow = (
      [string]$holdMongoAnchor.writeAnchorSha256 -ceq [string]$executeMongoAnchor.writeAnchorSha256
    )
  }
  active = [ordered]@{
    markerStatus = $marker.status
    evidenceStatus = $active.status
    commitStatus = $commit.status
    databaseMigrationPerformed = $marker.databaseMigrationPerformed
    rollbackReady = $marker.rollbackReady
    codeOnlyRollbackAllowed = $marker.codeOnlyRollbackAllowed
    requiredRecovery = $marker.requiredRecovery
    workerEnabled = $marker.workerEnabled
    businessTunnelRestored = $marker.businessTunnelRestored
  }
  index = [ordered]@{
    desired = 'uq_equipment_category_team_parent_name'
    legacy = 'uq_equipment_category_team_name'
    report = $IndexAuditReport
    reportSha256 = Get-Sha256 $IndexAuditReport
    status = if ($indexAudit) { $indexAudit.status } else { $null }
    writePerformed = if ($indexAudit) { $indexAudit.writePerformed } else { $null }
  }
  equipmentRoutineBusiness = [ordered]@{
    report = $BusinessAuditReport
    reportSha256 = Get-Sha256 $BusinessAuditReport
    status = if ($businessAudit) { $businessAudit.status } else { $null }
    writePerformed = if ($businessAudit) { $businessAudit.writePerformed } else { $null }
    teamCode = if ($businessAudit) { $businessAudit.filters.teamCode } else { $null }
    expectedPrimaryInUseCounts = $expectedPrimaryInUseCounts
    targetPrimaries = if ($businessAudit) { @($businessAudit.targetPrimaries) } else { @() }
    violationCount = if ($businessAudit) { [int]$businessAudit.summary.violationCount } else { $null }
  }
  tasks = $tasks
  tunnelBoundary = $tunnelBoundary
  listeners = $listeners
  health = [ordered]@{
    localApi = $localApi
    localWeb = $localWeb
    publicV2 = $publicV2
    publicLoginTeamsHttpStatus = $teamsResponse.status
    publicLoginTeamCodes = $teamCodes
  }
  gate = [ordered]@{
    passed = ($failures.Count -eq 0)
    failures = $failures
  }
}
$json = $result | ConvertTo-Json -Depth 12
$json
if ($failures.Count -ne 0) { throw "POSTDEPLOY_AUDIT_FAILED: $($failures -join ', ')" }
