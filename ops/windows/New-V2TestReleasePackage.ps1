[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseId,
  [string]$SourceCommit = 'HEAD',
  [string]$RepositoryRoot = '',
  [string]$OutputDirectory = '',
  [string]$ConfirmCommit = '',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ExpectedNodeVersion = 'v22.23.1'
$ExpectedNpmVersion = '10.9.8'
$allowedTrackedRasterPaths = @(
  'app/frontend/src/assets/1.jpg',
  'app/frontend/src/assets/2.png',
  'app/frontend/src/assets/login-logistics.jpg',
  'miniprogram/static/logo.png'
)
$trackedRasterExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff')
$releaseOpsPaths = @(
  'ops/backup.js',
  'ops/verify-backup.js',
  'ops/restore.js',
  'ops/lib/backupCore.js',
  'ops/lib/customerRepairReleaseInvariant.js',
  'ops/lib/operationsConfig.js',
  'ops/lib/transportReleaseInvariant.js',
  'ops/lib/v2TestMongoTargetGuard.js',
  'ops/lib/v2MigrationPreviewInvariant.js',
  'ops/linux/v2-test-release-common.sh',
  'ops/linux/prepare-v2-test-candidate.sh',
  'ops/linux/create-v2-test-release-backup.sh',
  'ops/linux/activate-v2-test-candidate.sh',
  'ops/linux/activate-v2-test-transport-repair.sh',
  'ops/linux/resume-v2-test-candidate-activation.sh',
  'ops/linux/verify-v2-test-release.sh',
  'ops/linux/restore-v2-test-backup.sh',
  'ops/linux/activate-v2-test-restored-rollback.sh'
)
$releaseArchivePaths = @(
  'app',
  'deploy/v2-test/RELEASE.template.json',
  'deploy/v2-test/linux/staging-server.cjs'
) + $releaseOpsPaths

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-PathBelow {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Description
  )
  $rootFull = Get-FullPath $Root
  $candidateFull = Get-FullPath $Candidate
  if (-not $candidateFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description must be below $rootFull"
  }
  return $candidateFull
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
  }
}

function Get-RelativePackagePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$FullName
  )
  $rootFull = Get-FullPath $Root
  $fileFull = [IO.Path]::GetFullPath($FullName)
  if (-not $fileFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package file escaped staging root: $fileFull"
  }
  return $fileFull.Substring($rootFull.Length + 1).Replace('\', '/')
}

function Convert-ShellScriptsToLf {
  param([Parameter(Mandatory = $true)][string]$Root)

  foreach ($script in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File -Filter '*.sh')) {
    $source = [IO.File]::ReadAllBytes($script.FullName)
    $normalized = New-Object IO.MemoryStream
    try {
      for ($index = 0; $index -lt $source.Length; $index++) {
        if (
          $source[$index] -eq 13 -and
          $index + 1 -lt $source.Length -and
          $source[$index + 1] -eq 10
        ) {
          $normalized.WriteByte(10)
          $index++
        }
        else {
          $normalized.WriteByte($source[$index])
        }
      }
      $result = $normalized.ToArray()
    }
    finally {
      $normalized.Dispose()
    }
    if ($result.Length -ne $source.Length) {
      [IO.File]::WriteAllBytes($script.FullName, $result)
    }
  }
}

function Assert-ShellScriptsUseLf {
  param([Parameter(Mandatory = $true)][string]$Root)

  foreach ($script in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File -Filter '*.sh')) {
    $bytes = [IO.File]::ReadAllBytes($script.FullName)
    for ($index = 0; $index + 1 -lt $bytes.Length; $index++) {
      if ($bytes[$index] -eq 13 -and $bytes[$index + 1] -eq 10) {
        $relativePath = Get-RelativePackagePath -Root $Root -FullName $script.FullName
        throw "Packaged shell script contains CRLF line endings: $relativePath"
      }
    }
  }
}

if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$') {
  throw 'ReleaseId must be 6-96 safe ASCII characters'
}
if (-not $RepositoryRoot) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..\..'
}
$RepositoryRoot = Get-FullPath $RepositoryRoot
$git = (Get-Command git.exe -ErrorAction Stop).Source
$tar = (Get-Command tar.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

$gitRoot = (& $git -C $RepositoryRoot rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or -not $gitRoot) { throw 'RepositoryRoot is not a Git worktree' }
if ((Get-FullPath ([string]$gitRoot)) -ne $RepositoryRoot) {
  throw 'RepositoryRoot must be the Git worktree root'
}
$resolvedCommit = ([string](& $git -C $RepositoryRoot rev-parse "$SourceCommit^{commit}")).Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -notmatch '^[a-f0-9]{40}$') {
  throw 'SourceCommit does not resolve to a full commit SHA'
}
$worktreeStatus = @(& $git -C $RepositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Git worktree status' }
if ($worktreeStatus.Count -ne 0) {
  throw 'The Git worktree must be completely clean before building a release'
}

$trackedPaths = @(& $git -c core.quotePath=false -C $RepositoryRoot `
  ls-tree -r --name-only $resolvedCommit)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect SourceCommit paths' }
$forbiddenTrackedPaths = @($trackedPaths | Where-Object {
  $relativePath = ([string]$_).Replace('\', '/')
  $name = [IO.Path]::GetFileName($relativePath)
  $extension = [IO.Path]::GetExtension($relativePath).ToLowerInvariant()
  $isEnvironmentFile = (
    $name -eq '.env' -or $name -like '.env.*' -or
    $name -like '*.env' -or $name -like '*.env.*'
  ) -and $name -notmatch '\.(example|template)$'
  $isUnexpectedRaster = $extension -in $trackedRasterExtensions -and
    $relativePath -notin $allowedTrackedRasterPaths
  $relativePath -match '(^|/)(\.test-data|test-data|work|customer-data|references|attachments|screenshots|uploads|logs|backups?|dumps?|node_modules|dist|build|out|coverage|unpackage|test-results|playwright-report)(/|$)' -or
    $extension -in @(
      '.xls', '.xlsx', '.xlsm', '.xlsb', '.log', '.bson', '.wt', '.sqlite',
      '.sqlite3', '.pem', '.key', '.pfx', '.p12', '.ppk', '.zip', '.tar',
      '.tgz', '.gz', '.7z', '.bak', '.backup', '.dump'
    ) -or
    $name -in @('id_rsa', 'id_ed25519', 'known_hosts', 'authorized_keys') -or
    $name -like 'id_rsa_*' -or $name -like 'id_ed25519_*' -or
    $isEnvironmentFile -or $isUnexpectedRaster
})
if ($forbiddenTrackedPaths.Count -ne 0) {
  throw "SourceCommit contains forbidden tracked release material: $($forbiddenTrackedPaths[0])"
}

$requiredCommittedPaths = @(
  'app/package.json',
  'app/package-lock.json',
  'app/server.js',
  'app/frontend/package.json',
  'app/frontend/package-lock.json',
  'app/script/migratePositionLevels.js',
  'app/script/backfillTransportMasterData.js',
  'app/script/backfillCustomerEquipmentOwnership.js',
  'app/services/equipmentOwnershipBackfillService.js',
  'app/script/repairAcceptanceJuly2026Data.js',
  'app/script/repairAcceptanceTransportJuly2026.js',
  'app/services/acceptanceJuly2026DataRepairService.js',
  'ops/backup.js',
  'ops/verify-backup.js',
  'ops/restore.js',
  'ops/lib/backupCore.js',
  'ops/lib/customerRepairReleaseInvariant.js',
  'ops/lib/operationsConfig.js',
  'ops/lib/transportReleaseInvariant.js',
  'ops/lib/v2TestMongoTargetGuard.js',
  'deploy/v2-test/RELEASE.template.json',
  'deploy/v2-test/linux/staging-server.cjs'
) + $releaseOpsPaths
foreach ($required in $requiredCommittedPaths) {
  & $git -C $RepositoryRoot cat-file -e "${resolvedCommit}:$required" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Required release file is absent from commit: $required" }
}

$nodeVersion = ([string](& $node --version)).Trim()
$npmVersion = ([string](& $npm --version)).Trim()
if ($nodeVersion -ne $ExpectedNodeVersion) { throw "Node version must be $ExpectedNodeVersion, got $nodeVersion" }
if ($npmVersion -ne $ExpectedNpmVersion) { throw "npm version must be $ExpectedNpmVersion, got $npmVersion" }

$releaseWorkspace = Join-Path $RepositoryRoot 'work\release'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $releaseWorkspace 'out' }
$OutputDirectory = Assert-PathBelow -Root $releaseWorkspace -Candidate $OutputDirectory -Description 'OutputDirectory'
$archiveName = "$ReleaseId.tar.gz"
$archivePath = Join-Path $OutputDirectory $archiveName
$shaPath = "$archivePath.sha256"
$artifactManifestPath = Join-Path $OutputDirectory "$ReleaseId.artifact-manifest.json"
$commitTime = ([string](& $git -C $RepositoryRoot show -s --format=%cI $resolvedCommit)).Trim()
if ($LASTEXITCODE -ne 0 -or -not $commitTime) { throw 'Unable to read commit timestamp' }

$plan = [ordered]@{
  status = 'DRY_RUN_READY'
  action = 'build-v2-test-release-package'
  releaseId = $ReleaseId
  commit = $resolvedCommit
  commitTime = $commitTime
  repository = $RepositoryRoot
  outputArchive = $archivePath
  outputSha256 = $shaPath
  outputManifest = $artifactManifestPath
  node = $nodeVersion
  npm = $npmVersion
  source = 'clean committed app + allowlisted V2 test operations + deploy/v2-test'
  webApiBaseUrl = '/api'
}
if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 5
  return
}
if ($ConfirmCommit.ToLowerInvariant() -ne $resolvedCommit) {
  throw "ConfirmCommit must exactly equal $resolvedCommit"
}
foreach ($output in @($archivePath, $shaPath, $artifactManifestPath)) {
  if (Test-Path -LiteralPath $output) { throw "Release output already exists: $output" }
}

if (-not $PSCmdlet.ShouldProcess($resolvedCommit, "Build immutable V2 test release $ReleaseId")) {
  return
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$buildRoot = Join-Path $releaseWorkspace ".build-$ReleaseId-$([guid]::NewGuid().ToString('N'))"
$buildRoot = Assert-PathBelow -Root $releaseWorkspace -Candidate $buildRoot -Description 'Build directory'
$packageRoot = Join-Path $buildRoot 'package'
$sourceTar = Join-Path $buildRoot 'source.tar'
$temporaryArchive = Join-Path $buildRoot $archiveName
$temporarySha = "$temporaryArchive.sha256"
$temporaryArtifactManifest = Join-Path $buildRoot "$ReleaseId.artifact-manifest.json"

try {
  New-Item -ItemType Directory -Path $buildRoot, $packageRoot | Out-Null
  $archiveArguments = @(
    '-C', $RepositoryRoot, 'archive', '--format=tar', "--output=$sourceTar",
    $resolvedCommit
  ) + $releaseArchivePaths
  Invoke-NativeChecked -FilePath $git -Arguments $archiveArguments
  Invoke-NativeChecked -FilePath $tar -Arguments @('-xf', $sourceTar, '-C', $packageRoot)
  Convert-ShellScriptsToLf -Root $packageRoot
  Assert-ShellScriptsUseLf -Root $packageRoot

  $deployLinux = Join-Path $packageRoot 'deploy\linux'
  New-Item -ItemType Directory -Force -Path $deployLinux | Out-Null
  Copy-Item -LiteralPath (Join-Path $packageRoot 'deploy\v2-test\linux\staging-server.cjs') `
    -Destination (Join-Path $deployLinux 'staging-server.cjs')

  $templatePath = Join-Path $packageRoot 'deploy\v2-test\RELEASE.template.json'
  $template = [IO.File]::ReadAllText($templatePath) | ConvertFrom-Json
  if (
    $template.environment -ne 'customer-test' -or
    [int]$template.apiPort -ne 18120 -or
    [int]$template.innerWebPort -ne 18130 -or
    [int]$template.mongoPort -ne 27150 -or
    $template.replicaSet -ne 'customer_acceptance_v2_rs' -or
    $template.database -ne 'customer_acceptance_v2_test' -or
    $template.webApiBaseUrl -ne '/api'
  ) {
    throw 'Committed RELEASE template does not match the isolated V2 test environment'
  }
  $builtAt = (Get-Date).ToUniversalTime().ToString('o')
  $releaseMetadata = [ordered]@{
    format = 'task-distribution-v2-release/v1'
    releaseId = $ReleaseId
    commit = $resolvedCommit
    commitTime = $commitTime
    builtAt = $builtAt
    environment = 'customer-test'
    apiPort = 18120
    innerWebPort = 18130
    mongoPort = 27150
    replicaSet = 'customer_acceptance_v2_rs'
    database = 'customer_acceptance_v2_test'
    webApiBaseUrl = '/api'
    node = $nodeVersion
    npm = $npmVersion
  }
  Write-Utf8NoBom -Path (Join-Path $packageRoot 'deploy\RELEASE.json') `
    -Value "$(ConvertTo-Json $releaseMetadata -Depth 5)`n"

  $frontendRoot = Join-Path $packageRoot 'app\frontend'
  $frontendDist = Join-Path $frontendRoot 'dist'
  if (Test-Path -LiteralPath $frontendDist) {
    Remove-Item -LiteralPath $frontendDist -Recurse -Force
  }
  Push-Location $frontendRoot
  $previousApiBase = $env:VITE_API_BASE_URL
  $hadApiBase = Test-Path Env:VITE_API_BASE_URL
  try {
    $env:VITE_API_BASE_URL = '/api'
    Invoke-NativeChecked -FilePath $npm -Arguments @('ci', '--no-audit', '--no-fund')
    Invoke-NativeChecked -FilePath $npm -Arguments @('run', 'build', '--', '--mode', 'production')
  }
  finally {
    if ($hadApiBase) { $env:VITE_API_BASE_URL = $previousApiBase }
    else { Remove-Item Env:VITE_API_BASE_URL -ErrorAction SilentlyContinue }
    Pop-Location
  }
  $frontendModules = Join-Path $frontendRoot 'node_modules'
  if (Test-Path -LiteralPath $frontendModules) {
    Remove-Item -LiteralPath $frontendModules -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'dist\index.html') -PathType Leaf)) {
    throw 'Frontend build did not produce dist/index.html'
  }

  Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -File |
    Where-Object {
      $_.Name -eq '.env' -or $_.Name -like '.env.*' -or
      $_.Name -like '*.env' -or $_.Name -like '*.env.*'
    } |
    Remove-Item -Force

  $forbiddenDirectoryNames = @(
    '.git', '.test-data', 'test-data', 'work', 'customer-data', 'references',
    'attachments', 'screenshots', 'uploads', 'logs', 'backups', 'backup',
    'dump', 'dumps', 'node_modules', 'unpackage', 'coverage', 'build',
    'test-results', 'playwright-report'
  )
  $forbiddenFileExtensions = @(
    '.pem', '.key', '.pfx', '.p12', '.ppk', '.log', '.xls', '.xlsx',
    '.xlsm', '.xlsb', '.bson', '.wt', '.sqlite', '.sqlite3', '.zip', '.tar',
    '.tgz', '.gz', '.7z', '.bak', '.backup', '.dump'
  )
  $allowedRasterSources = @(
    'app/frontend/src/assets/1.jpg',
    'app/frontend/src/assets/2.png',
    'app/frontend/src/assets/login-logistics.jpg'
  )
  $rasterExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff')
  $forbidden = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force | Where-Object {
    $relativePath = Get-RelativePackagePath -Root $packageRoot -FullName $_.FullName
    $extension = $_.Extension.ToLowerInvariant()
    $unexpectedRaster = -not $_.PSIsContainer -and $extension -in $rasterExtensions -and
      $relativePath -notlike 'app/frontend/dist/*' -and
      $relativePath -notin $allowedRasterSources
    ($_.PSIsContainer -and $_.Name -in $forbiddenDirectoryNames) -or
    (-not $_.PSIsContainer -and (
      $_.Name -eq '.env' -or $_.Name -like '.env.*' -or
      $_.Name -like '*.env' -or $_.Name -like '*.env.*' -or
      $extension -in $forbiddenFileExtensions -or
      $_.Name -in @('id_rsa', 'id_ed25519', 'known_hosts', 'authorized_keys') -or
      $unexpectedRaster
    )) -or
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
  })
  if ($forbidden.Count -ne 0) {
    throw "Forbidden release artifact found: $($forbidden[0].FullName)"
  }

  $fileManifestPath = Join-Path $packageRoot 'deploy\FILE-MANIFEST.json'
  $fileEntries = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -File | Where-Object {
    $_.FullName -ne $fileManifestPath
  } | ForEach-Object {
    [pscustomobject][ordered]@{
      file = Get-RelativePackagePath -Root $packageRoot -FullName $_.FullName
      bytes = [int64]$_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } | Sort-Object file)
  $fileManifest = [ordered]@{
    format = 'task-distribution-v2-release-files/v1'
    releaseId = $ReleaseId
    commit = $resolvedCommit
    generatedAt = $builtAt
    files = $fileEntries
  }
  Write-Utf8NoBom -Path $fileManifestPath -Value "$(ConvertTo-Json $fileManifest -Depth 8)`n"

  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $deployLinux 'staging-server.cjs'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'ops\lib\transportReleaseInvariant.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'ops\lib\customerRepairReleaseInvariant.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'ops\lib\v2TestMongoTargetGuard.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\script\migratePositionLevels.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\script\backfillTransportMasterData.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\script\backfillCustomerEquipmentOwnership.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\services\equipmentOwnershipBackfillService.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\script\repairAcceptanceJuly2026Data.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\script\repairAcceptanceTransportJuly2026.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'app\services\acceptanceJuly2026DataRepairService.js'))
  Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot 'ops\lib\v2MigrationPreviewInvariant.js'))
  Invoke-NativeChecked -FilePath $tar -Arguments @('-czf', $temporaryArchive, '-C', $packageRoot, '.')

  $archiveInfo = Get-Item -LiteralPath $temporaryArchive
  $archiveSha256 = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $fileManifestSha256 = (Get-FileHash -LiteralPath $fileManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Utf8NoBom -Path $temporarySha -Value "$archiveSha256  $archiveName`n"
  $artifactManifest = [ordered]@{
    format = 'task-distribution-v2-release-artifact/v1'
    releaseId = $ReleaseId
    commit = $resolvedCommit
    builtAt = $builtAt
    environment = 'customer-test'
    archive = [ordered]@{
      file = $archiveName
      bytes = [int64]$archiveInfo.Length
      sha256 = $archiveSha256
    }
    fileManifestSha256 = $fileManifestSha256
    fileCount = $fileEntries.Count + 1
  }
  Write-Utf8NoBom -Path $temporaryArtifactManifest `
    -Value "$(ConvertTo-Json $artifactManifest -Depth 8)`n"

  Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
  Move-Item -LiteralPath $temporarySha -Destination $shaPath
  Move-Item -LiteralPath $temporaryArtifactManifest -Destination $artifactManifestPath

  [ordered]@{
    status = 'RELEASE_PACKAGE_BUILT'
    releaseId = $ReleaseId
    commit = $resolvedCommit
    archive = $archivePath
    archiveSha256 = $archiveSha256
    sha256File = $shaPath
    artifactManifest = $artifactManifestPath
    packagedFiles = $fileEntries.Count + 1
  } | ConvertTo-Json -Depth 5
}
finally {
  if (Test-Path -LiteralPath $buildRoot) {
    $verifiedBuildRoot = Assert-PathBelow -Root $releaseWorkspace -Candidate $buildRoot -Description 'Cleanup path'
    if ([IO.Path]::GetFileName($verifiedBuildRoot) -notlike '.build-*') {
      throw 'Refusing to remove an unexpected release build path'
    }
    Remove-Item -LiteralPath $verifiedBuildRoot -Recurse -Force
  }
}
