$ErrorActionPreference = 'Stop'

$testRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $testRoot '..\..'))
$packageScript = Join-Path $repositoryRoot 'ops\windows\New-V2TestReleasePackage.ps1'
$copyScript = Join-Path $repositoryRoot 'ops\windows\Copy-V2TestBackupOffHost.ps1'
$fixedNodeDirectory = Join-Path $repositoryRoot 'tools\runtime\node-v22.23.1-win-x64'

function Write-TestFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Value)
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-TestGit {
  param([Parameter(Mandatory = $true)][string]$WorkingDirectory, [Parameter(Mandatory = $true)][string[]]$Arguments)
  & git.exe -c core.autocrlf=false -C $WorkingDirectory @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "git failed: $($Arguments -join ' ')" }
}

function New-VerifiedBackupFixture {
  param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)][string]$BackupId)
  $database = 'customer_acceptance_v2_test'
  $collections = @(
    'projectteams',
    'orgunits',
    'users',
    'teammemberships',
    'transportrecords',
    'equipmentassets',
    'equipmentroutineplans',
    'authsessions',
    'productionschedules',
    'attendancesubmissions',
    'attendancedailyreviews',
    'generateddailyreports'
  )
  $files = @($collections | ForEach-Object {
    [pscustomobject]@{
      Relative = "database/$database/$_.bson"
      Content = "$_-v2-test"
    }
  })
  $entries = @()
  foreach ($file in $files) {
    $path = Join-Path $Directory ($file.Relative -replace '/', '\')
    Write-TestFile -Path $path -Value $file.Content
    $info = Get-Item -LiteralPath $path
    $entries += [ordered]@{
      file = $file.Relative
      bytes = [int64]$info.Length
      sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $manifest = [ordered]@{
    format = 'task-distribution-v2-backup/v1'
    backupId = $BackupId
    database = [ordered]@{ name = $database }
    files = $entries
  }
  $manifestPath = Join-Path $Directory 'manifest.json'
  Write-TestFile -Path $manifestPath -Value "$(ConvertTo-Json $manifest -Depth 8)`n"
  $manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-TestFile -Path (Join-Path $Directory 'manifest.sha256') `
    -Value "$manifestSha256  manifest.json`n"
  return $manifestSha256
}

Describe 'New-V2TestReleasePackage allowlist' {
  It 'packages only the V2 test operational dependency closure' {
    if (-not (Test-Path -LiteralPath (Join-Path $fixedNodeDirectory 'node.exe') -PathType Leaf)) {
      throw "Fixed Node runtime is missing: $fixedNodeDirectory"
    }
    $fixtureRoot = Join-Path $TestDrive 'release-fixture'
    $fakeBin = Join-Path $TestDrive 'fake-bin'
    New-Item -ItemType Directory -Force -Path $fixtureRoot, $fakeBin | Out-Null

    $validJavaScript = "'use strict';`n"
    foreach ($file in @(
      'app/package.json',
      'app/package-lock.json',
      'app/frontend/package.json',
      'app/frontend/package-lock.json'
    )) {
      Write-TestFile -Path (Join-Path $fixtureRoot $file) -Value "{}`n"
    }
    foreach ($file in @(
      'app/server.js',
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
      'ops/lib/v2TestMongoTargetGuard.js',
      'ops/lib/v2MigrationPreviewInvariant.js',
      'ops/lib/transportReleaseInvariant.js'
    )) {
      Write-TestFile -Path (Join-Path $fixtureRoot $file) -Value $validJavaScript
    }
    Write-TestFile -Path (Join-Path $fixtureRoot 'deploy/v2-test/linux/staging-server.cjs') `
      -Value $validJavaScript
    Write-TestFile -Path (Join-Path $fixtureRoot 'deploy/v2-test/operations.restore.env.template') `
      -Value "SECRET_MUST_NOT_SHIP=true`n"
    $releaseTemplate = [ordered]@{
      environment = 'customer-test'
      apiPort = 18120
      innerWebPort = 18130
      mongoPort = 27150
      replicaSet = 'customer_acceptance_v2_rs'
      database = 'customer_acceptance_v2_test'
      webApiBaseUrl = '/api'
    }
    Write-TestFile -Path (Join-Path $fixtureRoot 'deploy/v2-test/RELEASE.template.json') `
      -Value "$(ConvertTo-Json $releaseTemplate -Depth 4)`n"

    $expectedShellScripts = @(
      'v2-test-release-common.sh',
      'prepare-v2-test-candidate.sh',
      'create-v2-test-release-backup.sh',
      'activate-v2-test-candidate.sh',
      'activate-v2-test-transport-repair.sh',
      'resume-v2-test-candidate-activation.sh',
      'verify-v2-test-release.sh',
      'restore-v2-test-backup.sh',
      'activate-v2-test-restored-rollback.sh'
    )
    foreach ($script in $expectedShellScripts) {
      Write-TestFile -Path (Join-Path $fixtureRoot "ops/linux/$script") `
        -Value "#!/usr/bin/env bash`r`ntrue`r`n"
    }

    Write-TestFile -Path (Join-Path $fixtureRoot 'ops/linux/repair-v2-test-config-acl.sh') `
      -Value "#!/usr/bin/env bash`nexit 99`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'ops/linux/deploy-production.sh') `
      -Value "#!/usr/bin/env bash`nexit 99`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'ops/windows/production-maintenance.ps1') `
      -Value "throw 'must never be packaged'`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'ops/production-maintenance.js') `
      -Value "throw new Error('must never be packaged');`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'ops/lib/healthCore.js') `
      -Value "throw new Error('unrelated operational library must never be packaged');`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'app/frontend/stale.env.template') `
      -Value "SECRET_MUST_NOT_SHIP=true`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'app/frontend/src/assets/1.jpg') `
      -Value "approved application asset`n"

    $fakeNpm = @'
@echo off
if "%~1"=="--version" (
  echo 10.9.8
  exit /b 0
)
if "%~1"=="ci" exit /b 0
if "%~1"=="run" (
  if not exist dist mkdir dist
  > dist\index.html echo ^<!doctype html^>^<title^>fixture^</title^>
  exit /b 0
)
exit /b 91
'@
    Write-TestFile -Path (Join-Path $fakeBin 'npm.cmd') -Value $fakeNpm

    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('init', '--quiet')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('config', 'user.name', 'V2 Test')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('config', 'user.email', 'v2-test@example.invalid')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('add', '--all')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('commit', '--quiet', '-m', 'fixture')
    $commit = ([string](& git.exe -C $fixtureRoot rev-parse HEAD)).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve fixture commit' }

    $previousPath = $env:PATH
    try {
      $env:PATH = "$fakeBin;$fixedNodeDirectory;$previousPath"
      & $packageScript -ReleaseId 'allowlist-test-001' -RepositoryRoot $fixtureRoot `
        -ConfirmCommit $commit -Apply -Confirm:$false | Out-Null
    }
    finally {
      $env:PATH = $previousPath
    }

    $archive = Join-Path $fixtureRoot 'work/release/out/allowlist-test-001.tar.gz'
    Test-Path -LiteralPath $archive -PathType Leaf | Should Be $true
    $entries = @(& tar.exe -tf $archive | ForEach-Object { $_ -replace '^\./', '' })
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect generated fixture archive' }

    $packagedShellScripts = @($entries | Where-Object { $_ -match '^ops/linux/[^/]+\.sh$' })
    $packagedShellScripts.Count | Should Be $expectedShellScripts.Count
    foreach ($script in $expectedShellScripts) {
      ($packagedShellScripts -contains "ops/linux/$script") | Should Be $true
    }
    foreach ($library in @(
      'backupCore.js',
      'operationsConfig.js',
      'transportReleaseInvariant.js',
      'customerRepairReleaseInvariant.js',
      'v2TestMongoTargetGuard.js',
      'v2MigrationPreviewInvariant.js'
    )) {
      ($entries -contains "ops/lib/$library") | Should Be $true
    }
    ($entries -contains 'ops/lib/healthCore.js') | Should Be $false
    ($entries -contains 'ops/linux/repair-v2-test-config-acl.sh') | Should Be $false
    ($entries -contains 'ops/linux/deploy-production.sh') | Should Be $false
    ($entries -contains 'ops/windows/production-maintenance.ps1') | Should Be $false
    ($entries -contains 'ops/production-maintenance.js') | Should Be $false
    ($entries -contains 'deploy/v2-test/operations.restore.env.template') | Should Be $false
    ($entries -contains 'app/frontend/stale.env.template') | Should Be $false
    ($entries -contains 'app/frontend/src/assets/1.jpg') | Should Be $true
    foreach ($file in @(
      'app/script/backfillCustomerEquipmentOwnership.js',
      'app/services/equipmentOwnershipBackfillService.js',
      'app/script/repairAcceptanceJuly2026Data.js',
      'app/script/repairAcceptanceTransportJuly2026.js',
      'app/services/acceptanceJuly2026DataRepairService.js'
    )) {
      ($entries -contains $file) | Should Be $true
    }

    $installedToolRoot = Join-Path $TestDrive 'installed-tools/release-allowlist-test-001'
    New-Item -ItemType Directory -Force -Path $installedToolRoot | Out-Null
    & tar.exe -xzf $archive -C $installedToolRoot './ops/linux' './ops/lib'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the versioned operations tool fixture' }
    foreach ($library in @(
      'backupCore.js',
      'operationsConfig.js',
      'v2TestMongoTargetGuard.js',
      'v2MigrationPreviewInvariant.js'
    )) {
      Test-Path -LiteralPath (Join-Path $installedToolRoot "ops/linux/../lib/$library") -PathType Leaf |
        Should Be $true
    }
    foreach ($script in $expectedShellScripts) {
      $packagedScript = Join-Path $installedToolRoot "ops/linux/$script"
      $scriptText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($packagedScript))
      $scriptText.Contains("`r`n") | Should Be $false
      $scriptText.Contains("`n") | Should Be $true
    }

    Write-TestFile -Path (Join-Path $fixtureRoot 'app/should-not-package.env') `
      -Value "SECRET_MUST_NOT_ENTER_GIT=true`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'app/frontend/dist/stale-customer.png') `
      -Value "TRACKED BUILD OUTPUT MUST NOT ENTER GIT`n"
    Write-TestFile -Path (Join-Path $fixtureRoot '.test-data/local.env') `
      -Value "SECRET_MUST_NOT_ENTER_GIT=true`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'work/remote-access/id_ed25519') `
      -Value "PRIVATE KEY MUST NOT ENTER GIT`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'app/customer-data/customer.xlsx') `
      -Value "CUSTOMER DATA MUST BLOCK THE BUILD`n"
    Write-TestFile -Path (Join-Path $fixtureRoot 'screenshots/customer.png') `
      -Value "CUSTOMER SCREENSHOT MUST NOT ENTER GIT`n"
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('add', '--force', '--all')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('commit', '--quiet', '-m', 'forbidden fixture')
    $forbiddenCommit = ([string](& git.exe -C $fixtureRoot rev-parse HEAD)).Trim()
    try {
      $env:PATH = "$fakeBin;$fixedNodeDirectory;$previousPath"
      { & $packageScript -ReleaseId 'allowlist-test-002' -RepositoryRoot $fixtureRoot `
          -ConfirmCommit $forbiddenCommit -Apply -Confirm:$false } | Should Throw
    }
    finally {
      $env:PATH = $previousPath
    }
    Test-Path -LiteralPath (Join-Path $fixtureRoot 'work/release/out/allowlist-test-002.tar.gz') |
      Should Be $false

    foreach ($path in @(
      'app/should-not-package.env',
      'app/frontend/dist',
      '.test-data',
      'work',
      'app/customer-data',
      'screenshots'
    )) {
      $fullPath = Join-Path $fixtureRoot $path
      if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
      }
    }
    Write-TestFile -Path (Join-Path $fixtureRoot 'app/frontend/src/assets/customer-screenshot.png') `
      -Value "CUSTOMER SCREENSHOT MUST BLOCK THE BUILD`n"
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('add', '--force', '--all')
    Invoke-TestGit -WorkingDirectory $fixtureRoot -Arguments @('commit', '--quiet', '-m', 'forbidden raster fixture')
    $forbiddenRasterCommit = ([string](& git.exe -C $fixtureRoot rev-parse HEAD)).Trim()
    try {
      $env:PATH = "$fakeBin;$fixedNodeDirectory;$previousPath"
      { & $packageScript -ReleaseId 'allowlist-test-003' -RepositoryRoot $fixtureRoot `
          -ConfirmCommit $forbiddenRasterCommit -Apply -Confirm:$false } | Should Throw
    }
    finally {
      $env:PATH = $previousPath
    }
    Test-Path -LiteralPath (Join-Path $fixtureRoot 'work/release/out/allowlist-test-003.tar.gz') |
      Should Be $false
  }
}

Describe 'Copy-V2TestBackupOffHost receipt upload recovery' {
  It 'reverifies an existing final backup and retries only its receipt upload' {
    $backupId = 'backup-20260724T120000Z-a1b2c3d4'
    $releaseId = 'release-test-001'
    $destinationRoot = "D:\V2OffHostRecoveryTest-$([guid]::NewGuid().ToString('N'))"
    $finalDirectory = Join-Path $destinationRoot $backupId
    $identityFile = Join-Path $TestDrive 'identity'
    $knownHostsFile = Join-Path $TestDrive 'known_hosts'
    Write-TestFile -Path $identityFile -Value "fixture`n"
    Write-TestFile -Path $knownHostsFile -Value "fixture`n"
    New-Item -ItemType Directory -Force -Path $finalDirectory | Out-Null
    $manifestSha256 = New-VerifiedBackupFixture -Directory $finalDirectory -BackupId $backupId
    $receiptPath = Join-Path $destinationRoot "receipts/$backupId.json"
    Write-TestFile -Path $receiptPath -Value "{ invalid receipt }`n"

    Mock Get-PSDrive { [pscustomobject]@{ Root = 'D:\' } } -ParameterFilter { $Name -eq 'D' }
    Mock Get-Partition {
      if ([string]$DriveLetter -eq 'D') { return [pscustomobject]@{ DiskNumber = 7 } }
      return [pscustomobject]@{ DiskNumber = 0 }
    }
    Mock Get-Command { [pscustomobject]@{ Source = 'C:\fixture\scp.exe' } } `
      -ParameterFilter { $Name -eq 'C:\Windows\System32\OpenSSH\scp.exe' }
    $global:V2OffHostRecoveryMockState = [pscustomobject]@{
      UploadAttempt = 0
      CapturedScpArguments = @()
    }
    Mock Start-Process {
      $global:V2OffHostRecoveryMockState.UploadAttempt++
      $global:V2OffHostRecoveryMockState.CapturedScpArguments += ,@($ArgumentList)
      if ($global:V2OffHostRecoveryMockState.UploadAttempt -eq 1) {
        return [pscustomobject]@{ ExitCode = 1 }
      }
      return [pscustomobject]@{ ExitCode = 0 }
    }

    $parameters = @{
      BackupId = $backupId
      ExpectedManifestSha256 = $manifestSha256
      SourceReleaseId = $releaseId
      IdentityFile = $identityFile
      KnownHostsFile = $knownHostsFile
      DestinationRoot = $destinationRoot
      ConfirmInstance = 'task-distribution-v2-customer-test'
    }
    try {
      { & $copyScript @parameters -Apply -Confirm:$false } | Should Throw
      Test-Path -LiteralPath $receiptPath -PathType Leaf | Should Be $true
      { [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json } | Should Not Throw
      $receiptShaAfterFailure = (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash

      $resultText = & $copyScript @parameters -Apply -Confirm:$false
      $result = ($resultText -join "`n") | ConvertFrom-Json
      $result.Status | Should Be 'OFFHOST_BACKUP_VERIFIED'
      $result.DownloadPerformed | Should Be $false
      $result.ReceiptReused | Should Be $true
      (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash | Should Be $receiptShaAfterFailure
      $global:V2OffHostRecoveryMockState.CapturedScpArguments.Count | Should Be 2
      foreach ($arguments in $global:V2OffHostRecoveryMockState.CapturedScpArguments) {
        ($arguments -contains '-r') | Should Be $false
        $arguments[-2] | Should Be $receiptPath
      }

      $transportDump = Join-Path $finalDirectory `
        'database/customer_acceptance_v2_test/transportrecords.bson'
      [IO.File]::AppendAllText($transportDump, 'tampered')
      { & $copyScript @parameters -Apply -Confirm:$false } | Should Throw
      $global:V2OffHostRecoveryMockState.CapturedScpArguments.Count | Should Be 2
    }
    finally {
      Remove-Variable -Name V2OffHostRecoveryMockState -Scope Global -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $destinationRoot) {
        Remove-Item -LiteralPath $destinationRoot -Recurse -Force
      }
    }
  }
}
