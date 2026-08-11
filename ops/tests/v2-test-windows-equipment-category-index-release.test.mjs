import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

const activate = read('ops/windows/Invoke-V2RecoveryEquipmentCategoryIndexRelease.ps1')
const audit = read('ops/windows/Test-V2RecoveryEquipmentCategoryIndexRelease.ps1')
const offhostReceipt = read('ops/windows/New-V2RecoveryStoppedBackupOffhostReceipt.ps1')
const packageBuilder = read('ops/windows/New-V2TestReleasePackage.ps1')
const releaseTemplate = JSON.parse(read('deploy/v2-test/RELEASE.template.json'))
const signingKey = read('ops/windows/New-V2RecoveryOffhostReceiptSigningKey.ps1')
const windowsPowerShell = path.join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')

test('Windows index release is an explicit Plan Hold Execute state machine', () => {
  assert.match(activate, /\[ValidateSet\('Plan', 'Hold', 'Execute'\)\]\[string\]\$Mode = 'Plan'/)
  assert.match(activate, /status = 'TWO_PHASE_PLAN_READY'/)
  assert.match(activate, /if \(\$Mode -eq 'Plan'\)[\s\S]*?return/)
  assert.match(activate, /if \(\$Mode -eq 'Hold'\)/)
  assert.match(activate, /if \(\$Mode -eq 'Execute'\)/)
  for (const confirmation of [
    'ConfirmInstance',
    'ConfirmDatabase',
    'ConfirmReleaseId',
    'ConfirmPreviousReleaseId',
    'ConfirmBackupId',
    'ConfirmHandoffNonce'
  ]) {
    assert.match(activate, new RegExp(`\\$${confirmation} -ne`), confirmation)
  }
  assert.match(activate, /SupportsShouldProcess = \$true/)
  assert.match(activate, /ConfirmImpact = 'High'/)
})

test('Hold freezes only the business surface in Tunnel Web API order and seals a nonce handoff', () => {
  const start = activate.indexOf('function Stop-BusinessSurface')
  const end = activate.indexOf('function Get-Http', start)
  const body = activate.slice(start, end)
  const tunnel = body.indexOf('name = $businessTunnelTask; port = 0')
  const web = body.indexOf('name = $webTask; port = 18130')
  const api = body.indexOf('name = $apiTask; port = 18120')
  assert.ok(tunnel >= 0 && tunnel < web && web < api)
  assert.match(activate, /Disable-ScheduledTask -TaskName \$TaskName/)
  assert.doesNotMatch(activate, /Stop-RecoveryTask \$managementTunnelTask/)
  assert.doesNotMatch(activate, /Stop-RecoveryTask \$mongoTask/)
  assert.match(activate, /preservedTasks = @\(\$managementTunnelTask, \$mongoTask\)/)
  assert.match(activate, /New-HandoffNonce/)
  assert.match(activate, /RandomNumberGenerator/)
  assert.match(activate, /equipment-category-index-stopped-handoff\.json/)
  assert.match(activate, /BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP/)
  assert.match(activate, /lastRunTimeUtc/)
  assert.match(activate, /heldTasks = \$heldTasks/)
  assert.match(body, /foreach \(\$step in \$steps\)[\s\S]*?Stop-RecoveryTask -TaskName \$step\.name -Port \$step\.port/)
  assert.match(body, /foreach \(\$port in @\(18120, 18130\)\)/)
  assert.match(body, /businessSurfaceHeldStopped = \$true/)
  const stoppedDryRun = activate.indexOf('$stoppedDryRun = Invoke-MigrationCli -Mode dry-run')
  const handoffWrite = activate.indexOf('Write-JsonCreateNew $stoppedHandoffEvidencePath')
  assert.ok(stoppedDryRun >= 0 && stoppedDryRun < handoffWrite)
})

test('business-surface hold still attempts Web and API after the first stop fails', () => {
  const start = activate.indexOf('function Stop-BusinessSurface')
  const end = activate.indexOf('function Get-Http', start)
  const functionSource = activate.slice(start, end)
  const harness = `
$businessTunnelTask = 'TaskDistribution-V2-Recovery-Tunnel'
$webTask = 'TaskDistribution-V2-Recovery-Web'
$apiTask = 'TaskDistribution-V2-Recovery-API'
$script:calls = @()
function Stop-RecoveryTask {
  param([string]$TaskName, [int]$Port)
  $script:calls += $TaskName
  if ($TaskName -eq $businessTunnelTask) { throw 'fixture first stop failure' }
}
function Get-TaskState {
  param([string]$TaskName)
  return [pscustomobject]@{ name = $TaskName; enabled = $false; state = 'Disabled' }
}
function Get-NetTCPConnection {
  param([string]$State, [int]$LocalPort, [object]$ErrorAction)
  return $null
}
${functionSource}
try {
  $null = Stop-BusinessSurface
  $result = [ordered]@{ unexpectedlySucceeded = $true; calls = $script:calls; error = $null }
}
catch {
  $result = [ordered]@{ unexpectedlySucceeded = $false; calls = $script:calls; error = $_.Exception.Message }
}
$result | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(harness, 'utf16le').toString('base64')
  const result = spawnSync(windowsPowerShell, ['-NoProfile', '-EncodedCommand', encoded], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const observed = JSON.parse(result.stdout.trim())
  assert.equal(observed.unexpectedlySucceeded, false)
  assert.deepEqual(observed.calls, [
    'TaskDistribution-V2-Recovery-Tunnel',
    'TaskDistribution-V2-Recovery-Web',
    'TaskDistribution-V2-Recovery-API'
  ])
  assert.match(observed.error, /BUSINESS_SURFACE_HOLD_INCOMPLETE/)
  assert.match(observed.error, /fixture first stop failure/)
})

test('Execute accepts only a fresh stopped backup and a final offhost archive receipt', () => {
  assert.match(activate, /\$BackupId -eq \[string\]\$staged\.predeployBackup\.backupId/)
  assert.match(activate, /backupCreatedAt -lt \$stoppedAtValue/)
  assert.match(activate, /backupCompletedAt -lt \$stoppedAtValue/)
  assert.match(activate, /equipmentcategories\.bson/)
  assert.match(activate, /verifyBackupSet\(process\.argv\[2\], \{ verifyFiles: true \}\)/)
  assert.match(activate, /offhost-verification-\$BackupId\.json/)
  assert.match(activate, /archiveFileName -ne "\$BackupId\.zip"/)
  assert.match(activate, /archiveSha256[\s\S]*?\^\[0-9a-f\]\{64\}\$/)
  assert.match(activate, /archiveBytes -le 0/)
  assert.match(activate, /independentCopyRoot[\s\S]*?StartsWith\('E:\\'/)
  assert.match(activate, /archiveSha256MatchesSource -ne \$true/)
  assert.match(activate, /manifestSha256Valid -ne \$true/)
  assert.match(activate, /everyDeclaredFileSha256Valid -ne \$true/)
  assert.match(activate, /databaseAndUploadsAtomic -ne \$false/)
  assert.match(activate, /requiredMetadataPresent -ne \$true/)
  assert.match(activate, /uploadsManifestVerified -ne \$true/)
  assert.match(activate, /fileAssetReferencesVerified -ne \$true/)
  for (const consumer of [activate, audit]) {
    assert.match(consumer, /TrustedPublicKeyPath/)
    assert.match(consumer, /TrustedPublicKeySha256/)
    assert.match(consumer, /task-distribution-v2-windows-stopped-backup-offhost-signed-envelope\/v2/)
    assert.match(consumer, /signatureAlgorithm -cne 'RSA-SHA256-PKCS1-v1_5'/)
    assert.match(consumer, /signedPayloadSha256/)
    assert.match(consumer, /ConvertFrom-StrictBase64/)
    assert.match(consumer, /UTF8Encoding\(\$false, \$true\)/)
    assert.match(consumer, /VerifyData\(\$payloadBytes, \$hashOid, \$signatureBytes\)/)
    assert.match(consumer, /Assert-ExactJsonProperties/)
  }
})

test('independent workstation receipt generator performs real ZIP and backup verification', () => {
  assert.match(offhostReceipt, /IndependentCopyRoot must be on the independent workstation E: drive/)
  assert.match(offhostReceipt, /The receipt generator must run on a workstation independent from SourceHost/)
  assert.match(offhostReceipt, /ZipFile]::OpenRead/)
  assert.match(offhostReceipt, /verifyBackupSet\(process\.argv\[2\], \{ verifyFiles: true \}\)/)
  assert.match(offhostReceipt, /equipmentcategories\.bson/)
  assert.match(offhostReceipt, /equipmentcategories\.metadata\.json/)
  assert.match(offhostReceipt, /FileMode]::CreateNew/)
  assert.match(offhostReceipt, /archiveSha256MatchesSource = \$true/)
  assert.match(offhostReceipt, /everyDeclaredFileSha256Valid = \$true/)
  assert.match(offhostReceipt, /fileAssetReferencesVerified = \$true/)
  assert.match(offhostReceipt, /signed-envelope\/v2/)
  assert.match(offhostReceipt, /SignData\(\$payloadBytes, \$hashOid\)/)
})

test('all release, receipt, and key paths reject reparse points throughout existing parent chains', () => {
  for (const script of [activate, audit, offhostReceipt, signingKey]) {
    assert.match(script, /function Assert-NoReparsePointPath/)
    assert.match(script, /path contains a reparse point/)
    assert.match(script, /foreach \(\$component in \$components\)/)
  }
  assert.match(offhostReceipt, /Receipt parent/)
  assert.match(offhostReceipt, /ZIP extraction parent/)
  assert.match(signingKey, /Signing key parent/)
  assert.match(activate, /Evidence output/)
  assert.match(activate, /Atomic JSON output/)
  assert.match(audit, /IndexAuditReport/)
})

test('Execute rejects task restarts index drift nonce reuse and report overwrite before writing', () => {
  const continuityStart = activate.indexOf('function Assert-HeldTaskContinuity')
  const continuityEnd = activate.indexOf('function Assert-CandidateManifest', continuityStart)
  const continuity = activate.slice(continuityStart, continuityEnd)
  assert.match(continuity, /enabled -ne \$false/)
  assert.match(continuity, /state -ne 'Disabled'/)
  assert.match(continuity, /lastRunTimeUtc -ne \$expected\.lastRunTimeUtc/)
  assert.match(continuity, /lastTaskResult -ne \$expected\.lastTaskResult/)
  assert.match(activate, /Assert-NoBusinessListeners/)

  const executeDryRun = activate.indexOf('$executeDryRun = Invoke-MigrationCli -Mode dry-run')
  const claim = activate.indexOf('Write-JsonCreateNew $executeClaimPath')
  const started = activate.indexOf('Write-JsonCreateNew $migrationStartedPath')
  const execute = activate.indexOf('$executeReport = Invoke-MigrationCli -Mode execute')
  const idempotent = activate.indexOf('$idempotencyReport = Invoke-MigrationCli -Mode execute')
  assert.ok(executeDryRun >= 0 && executeDryRun < claim && claim < started && started < execute && execute < idempotent)
  assert.match(activate, /HANDOFF_NONCE_CONSUMED/)
  assert.match(activate, /Protected execute evidence already exists or nonce was consumed/)
  assert.match(activate, /Migration report path already exists/)
  assert.match(activate, /Assert-DryRunReady \$executeDryRun/)
  assert.match(activate, /status -ne 'EXECUTED'/)
  assert.match(activate, /status -ne 'ALREADY_APPLIED'/)
  assert.match(activate, /writePerformed -ne \$true/)
  assert.match(activate, /writePerformed -ne \$false/)
})

test('migration and activation evidence states declare the unaccepted rollback boundary', () => {
  for (const evidenceName of [
    'migrationStartedEvidence',
    'migrationCompleted',
    'selectedMarker',
    'active',
    'activeMarkerState',
    'commit',
    'failureState'
  ]) {
    const start = activate.indexOf(`$${evidenceName} = [ordered]@{`)
    assert.ok(start >= 0, evidenceName)
    const body = activate.slice(start, activate.indexOf('\n  }', start) + 4)
    assert.match(body, /rollbackReady = \$false/, evidenceName)
  }
  assert.match(activate, /requiredRecovery = 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'/)
  assert.match(activate, /codeOnlyRollbackAllowed = \$false/)
  assert.match(activate, /POST_MIGRATION_FAILURE_HELD_STOPPED/)
  assert.match(activate, /EXECUTE_FAILURE_HOLD_INCOMPLETE/)
  assert.match(activate, /businessSurfaceHeldStopped = \$holdComplete/)
  assert.match(activate, /Hold-ExecuteFailure[\s\S]*?Stop-BusinessSurface/)
  assert.match(activate, /if \(\$Mode -eq 'Execute'\)[\s\S]*?Hold-ExecuteFailure/)
})

test('candidate activation restores the tunnel only after local stability then enables the worker', () => {
  const localGate = activate.indexOf('$stabilitySamples = @()')
  const tunnelStart = activate.indexOf('$publicHealth = Start-BusinessTunnel')
  const workerEnable = activate.indexOf('$selectedMarker.workerEnabled = $true')
  assert.ok(localGate >= 0 && localGate < tunnelStart && tunnelStart < workerEnable)
  assert.match(activate, /-R '127\.0\.0\.1:38130:127\.0\.0\.1:18130'/)
  assert.match(activate, /StrictHostKeyChecking=yes/)
  assert.match(activate, /ExitOnForwardFailure=yes/)
  assert.match(activate, /Business tunnel runner references a legacy production port/)
  assert.match(activate, /Equipment routine worker logged a failure/)
})

test('postdeploy audit proves the two-phase evidence chain index state and all five tasks', () => {
  for (const evidence of [
    'equipment-category-index-stopped-handoff.json',
    'equipment-category-index-execute-claim.json',
    'equipment-category-index-execute-dry-run.json',
    'backup-verification-before-index-migration.json',
    'migration-started.json',
    'equipment-category-index-execute.json',
    'equipment-category-index-idempotency.json',
    'migration-completed.json',
    'active.json',
    'activation-commit.json'
  ]) {
    assert.ok(audit.includes(evidence), evidence)
  }
  assert.match(audit, /migration-or-activation-failed\.json/)
  assert.match(audit, /failure_evidence_present_for_committed_release/)
  for (const taskName of [
    'TaskDistribution-V2-Recovery-API',
    'TaskDistribution-V2-Recovery-Web',
    'TaskDistribution-V2-Recovery-Tunnel',
    'TaskDistribution-V2-Recovery-Management-Tunnel',
    'TaskDistribution-V2-Recovery-MongoDB'
  ]) {
    assert.ok(audit.includes(taskName), taskName)
  }
  assert.match(audit, /stopped_backup_timestamp_chain_mismatch/)
  assert.match(audit, /status -ne 'DRY_RUN_ALREADY_APPLIED'/)
  assert.match(audit, /indexes\.desiredPresent -eq \$true/)
  assert.match(audit, /@\(\$State\.indexes\.legacy\)\.Count -eq 0/)
  assert.match(audit, /rollbackReady -ne \$false/)
  assert.match(audit, /requiredRecovery -ne 'FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE'/)
  assert.match(audit, /businessTunnelRestored -ne \$true/)
})

test('runtime inputs schema capability and the fixed candidate public key are hash-bound end to end', () => {
  for (const consumer of [activate, audit]) {
    for (const parameter of [
      'OperationsEnvPath',
      'AppEnvSha256',
      'OperationsEnvSha256'
    ]) {
      assert.ok(consumer.includes(`$${parameter}`), `${parameter} missing from release consumer`)
    }
    assert.match(consumer, /function Get-ObjectSha256/)
    assert.match(consumer, /runtimeInputsSha256/)
    assert.match(consumer, /equipment-category-parent-name-index-v1/)
    assert.match(consumer, /deploy\/v2-test\/trusted-offhost-receipt-public-key\.xml/)
    assert.match(consumer, /pathComparison -cne 'windows-ordinal-ignore-case'/)
    assert.match(consumer, /setSemantics -cne 'exact-package-files-excluding-manifest'/)
    assert.match(consumer, /Candidate exact file set mismatch/)
  }
  assert.match(activate, /TrustedPublicKeyPath must exactly equal the public key embedded in the candidate release/)
  assert.match(activate, /\$env:REQUIRED_SCHEMA_CAPABILITIES = \$expectedCapability/)
  assert.match(activate, /Active API application environment SHA256 mismatch/)
  assert.match(audit, /staged_runtime_inputs_mismatch/)
  assert.match(audit, /stable_api_runtime_gate_missing/)
})

test('Hold and Execute seal an unchanged Mongo write anchor before the migration claim', () => {
  const holdCapture = activate.indexOf('$holdMongoAnchor = Invoke-MongoAnchorCli')
  const handoffWrite = activate.indexOf('Write-JsonCreateNew $stoppedHandoffEvidencePath')
  const executeCapture = activate.indexOf('$executeMongoAnchor = Invoke-MongoAnchorCli')
  const backupVerificationWrite = activate.indexOf('Write-JsonCreateNew $backupVerificationPath')
  const executeClaimWrite = activate.indexOf('Write-JsonCreateNew $executeClaimPath')
  const migrationStartedWrite = activate.indexOf('Write-JsonCreateNew $migrationStartedPath')
  assert.ok(holdCapture >= 0 && holdCapture < handoffWrite)
  assert.ok(
    executeCapture >= 0 &&
    executeCapture < backupVerificationWrite &&
    backupVerificationWrite < executeClaimWrite &&
    executeClaimWrite < migrationStartedWrite
  )
  assert.match(activate, /-CompareTo \$holdMongoAnchorPath/)
  assert.match(activate, /holdMongoAnchorSha256/)
  assert.match(activate, /executeMongoAnchorSha256/)
  assert.match(audit, /Test-MongoAnchorReport/)
  assert.match(audit, /mongo_write_anchor_changed_during_stopped_backup_window/)
  assert.match(audit, /holdMongoAnchorPath -cne \$holdMongoAnchorPath/)
  assert.match(audit, /executeMongoAnchorPath -cne \$executeMongoAnchorPath/)
})

test('postdeploy audit runs the exact 6 5 1 equipment routine business gate read only', () => {
  assert.match(audit, /app\\script\\auditEquipmentRoutineBusiness\.js/)
  assert.match(audit, /--team-code 'GEARBOX_LOGISTICS'/)
  assert.match(audit, /\$leadAcidForkliftPrimaryName=6/)
  assert.match(audit, /\$lithiumForkliftPrimaryName=5/)
  assert.match(audit, /\$rollerConveyorPrimaryName=1/)
  assert.match(audit, /taskdistribution-v2-equipment-routine-business-audit-v1/)
  assert.match(audit, /postdeploy_equipment_routine_business_gate_failed/)
  assert.match(audit, /equipmentRoutineBusiness = \[ordered\]@\{/)
  assert.match(audit, /reportSha256 = Get-Sha256 \$BusinessAuditReport/)
  assert.match(audit, /writePerformed -ne \$false/)
})

test('release packaging includes and syntax-checks migration and Windows safety tools', () => {
  for (const relativePath of [
    'app/controllers/contractController.js',
    'app/models/Supplier.js',
    'app/models/SupplierContractRecord.js',
    'app/models/SupplierSettlementFee.js',
    'app/routes/contracts.js',
    'app/services/contractIndexService.js',
    'app/services/contractManagementService.js',
    'app/services/contractWorkbookService.js',
    'app/frontend/src/api/contract.js',
    'app/frontend/src/utils/contract.js',
    'app/frontend/src/views/contracts/ContractExpiryAlerts.vue',
    'app/frontend/src/views/contracts/SupplierContractDetail.vue',
    'app/frontend/src/views/contracts/SupplierContracts.vue',
    'app/frontend/src/views/contracts/SupplierSettlementFees.vue',
    'app/frontend/src/views/contracts/components/ContractFileUpload.vue',
    'app/script/migrateEquipmentCategoryIndex.js',
    'app/services/equipmentCategoryIndexMigrationService.js',
    'app/script/captureReleaseMongoAnchor.js',
    'app/services/releaseMongoAnchorService.js',
    'app/script/auditEquipmentRoutineBusiness.js',
    'app/services/equipmentRoutineBusinessAuditService.js',
    'ops/windows/New-V2RecoveryEquipmentCategoryIndexStage.ps1',
    'ops/windows/New-V2RecoveryStoppedBackupOffhostReceipt.ps1',
    'ops/windows/New-V2RecoveryOffhostReceiptSigningKey.ps1',
    'ops/windows/Invoke-V2RecoveryEquipmentCategoryIndexRelease.ps1',
    'ops/windows/Test-V2RecoveryEquipmentCategoryIndexRelease.ps1'
  ]) {
    assert.ok(packageBuilder.includes(relativePath.replaceAll('/', '\\')) || packageBuilder.includes(relativePath), relativePath)
  }
  for (const relativePath of [
    'app/controllers/contractController.js',
    'app/models/Supplier.js',
    'app/models/SupplierContractRecord.js',
    'app/models/SupplierSettlementFee.js',
    'app/routes/contracts.js',
    'app/services/contractIndexService.js',
    'app/services/contractManagementService.js',
    'app/services/contractWorkbookService.js',
    'app/script/migrateEquipmentCategoryIndex.js',
    'app/services/equipmentCategoryIndexMigrationService.js',
    'app/script/captureReleaseMongoAnchor.js',
    'app/services/releaseMongoAnchorService.js',
    'app/script/auditEquipmentRoutineBusiness.js',
    'app/services/equipmentRoutineBusinessAuditService.js'
  ]) {
    const packagedPath = relativePath.replaceAll('/', '\\')
    const expectedCheck = `Invoke-NativeChecked -FilePath $node -Arguments @('--check', (Join-Path $packageRoot '${packagedPath}'))`
    assert.ok(packageBuilder.includes(expectedCheck), `missing exact node --check: ${relativePath}`)
  }
  assert.match(packageBuilder, /Packaged PowerShell syntax error/)
  assert.match(packageBuilder, /Test-PrivateKeyXmlFile/)
  assert.match(packageBuilder, /RSAKeyValue[\s\S]*local-name\(\)="D"/)
  assert.match(packageBuilder, /private\|secret\|signing/)
})

test('offhost key generation rejects repository-local private key roots', () => {
  assert.match(signingKey, /function Find-RepositoryRoot/)
  assert.match(signingKey, /IndependentKeyRoot must be outside the Git repository/)
  assert.match(signingKey, /StartsWith\(\$repositoryPrefix, \[StringComparison\]::OrdinalIgnoreCase\)/)
})

test('release metadata declares the required schema and an exact Windows manifest contract', () => {
  assert.deepEqual(releaseTemplate.schemaCapabilities, [
    'equipment-category-parent-name-index-v1'
  ])
  assert.match(packageBuilder, /equipment-category-parent-name-index-v1/)
  assert.match(packageBuilder, /schemaCapabilities = @\(\$ExpectedSchemaCapabilities\)/)
  assert.match(packageBuilder, /task-distribution-v2-release-files\/v1/)
  assert.match(packageBuilder, /\^v2-\\d\{8\}-\[0-9a-f\]\{7\}\$/)
  assert.match(packageBuilder, /template\.releaseId -cne '__RELEASE_ID__'/)
  assert.match(packageBuilder, /app\\server\.js/)
  assert.match(packageBuilder, /ops\\backup\.js/)
  assert.match(packageBuilder, /pathComparison = \$FileManifestPathComparison/)
  assert.match(packageBuilder, /setSemantics = \$FileManifestSetSemantics/)
  assert.match(packageBuilder, /selfPath = \$FileManifestSelfPath/)
  assert.match(packageBuilder, /fileCount = \$fileEntries\.Count/)
  assert.match(packageBuilder, /Get-ChildItem -LiteralPath \$packageRoot -Recurse -Force -File/)
  assert.match(packageBuilder, /HashSet\[string\][\s\S]*StringComparer\]::OrdinalIgnoreCase/)
  assert.match(packageBuilder, /Duplicate Windows-insensitive package manifest path/)
})

test('Execute PostAudit and stable runners rebind every staged injected runtime input', () => {
  for (const consumer of [activate, audit]) {
    assert.match(consumer, /function Assert-InjectedRuntime/)
    assert.match(consumer, /Candidate injected runtime differs from staged evidence/)
    for (const identity of [
      'runtimeNodeSha256',
      'appNodeModulesSha256',
      'webProxySha256',
      'apiRunnerSha256',
      'webRunnerSha256'
    ]) {
      assert.ok(consumer.includes(identity), `${identity} missing from runtime consumer`)
    }
  }
  const stableApiStart = activate.indexOf("$stableApi = @'")
  const stableWebStart = activate.indexOf("$stableWeb = @'")
  const stableApi = activate.slice(stableApiStart, stableWebStart)
  const stableWeb = activate.slice(stableWebStart, activate.indexOf("'@", stableWebStart))
  for (const stableRunner of [stableApi, stableWeb]) {
    assert.match(stableRunner, /Assert-InjectedRuntime/)
    assert.match(stableRunner, /Get-InjectedTreeSha256/)
    assert.match(stableRunner, /staged\.injectedRuntime/)
  }
})

test('staging Execute and PostAudit verify the previous release exact manifest tree', () => {
  const staging = read('ops/windows/New-V2RecoveryEquipmentCategoryIndexStage.ps1')
  assert.match(staging, /function Assert-ReleaseFileManifest/)
  assert.match(staging, /\$Label exact file set mismatch/)
  assert.match(staging, /manifestSha256 = \[string\]\$previousIdentity\.manifestSha256/)
  for (const consumer of [activate, audit]) {
    assert.match(consumer, /function Assert-PreviousReleaseTree/)
    assert.match(consumer, /previousRelease\.manifestSha256/)
    assert.match(consumer, /Previous release exact file set mismatch/)
  }
})
