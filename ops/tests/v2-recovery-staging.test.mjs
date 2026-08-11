import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const stagingScript = path.join(
  repositoryRoot,
  'ops/windows/New-V2RecoveryEquipmentCategoryIndexStage.ps1'
)
const releasePackageBuilder = path.join(
  repositoryRoot,
  'ops/windows/New-V2TestReleasePackage.ps1'
)
const releaseRunbook = path.join(
  repositoryRoot,
  'docs/RELEASE_DEPLOYMENT_AND_ROLLBACK.md'
)
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const fixedNode = path.join(
  repositoryRoot,
  'tools/runtime/node-v22.23.1-win-x64/node.exe'
)

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function makeHardLinkOrCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try {
    fs.linkSync(source, destination)
  } catch {
    fs.copyFileSync(source, destination)
  }
}

function invokePowerShell(args, { expectFailure = false } = {}) {
  const invocation = [stagingScript, ...args].map((argument) => {
    if (argument.startsWith('-')) return argument
    return `'${argument.replaceAll("'", "''")}'`
  }).join(' ')
  const result = spawnSync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `& ${invocation}`
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  })
  if (expectFailure) {
    assert.notEqual(result.status, 0, `command unexpectedly succeeded: ${result.stdout}`)
    return result
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  return JSON.parse(result.stdout)
}

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing section marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing section marker: ${endMarker}`)
  return source.slice(start, end)
}

function assertPowerShellParses(source, label) {
  const workRoot = path.join(repositoryRoot, 'work')
  fs.mkdirSync(workRoot, { recursive: true })
  const fixtureRoot = fs.mkdtempSync(path.join(workRoot, '.recovery-runbook-parse-'))
  const scriptPath = path.join(fixtureRoot, 'snippet.ps1')
  try {
    writeFile(scriptPath, source)
    const escapedPath = scriptPath.replaceAll("'", "''")
    const command = [
      '$tokens = $null',
      '$parseErrors = $null',
      `[void][Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$parseErrors)`,
      "if (@($parseErrors).Count -ne 0) { @($parseErrors) | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }"
    ].join('; ')
    const result = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function buildFixture(root) {
  const releaseId = 'v2-20260811-abcdef0'
  const sourceCommit = 'a'.repeat(40)
  const previousReleaseId = 'v2-20260810-1234567'
  const previousCommit = 'b'.repeat(40)
  const candidate = path.join(root, 'releases', releaseId)
  const previous = path.join(root, 'releases', previousReleaseId)
  const packages = path.join(root, 'packages')
  const config = path.join(root, 'config')
  const receipts = path.join(root, 'receipts')
  const builtAt = new Date(Date.now() - 60_000).toISOString()
  const publicKeyRelative = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
  const publicKeyPath = path.join(candidate, ...publicKeyRelative.split('/'))
  writeFile(
    publicKeyPath,
    '<RSAKeyValue><Modulus>AQ==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>\n'
  )

  const releaseMetadata = {
    format: 'task-distribution-v2-release/v1',
    releaseId,
    commit: sourceCommit,
    commitTime: builtAt,
    builtAt,
    environment: 'customer-test',
    apiPort: 18120,
    innerWebPort: 18130,
    mongoPort: 27150,
    replicaSet: 'customer_acceptance_v2_rs',
    database: 'customer_acceptance_v2_test',
    webApiBaseUrl: '/api',
    trustedOffhostReceiptPublicKeyPath: publicKeyRelative,
    trustedOffhostReceiptPublicKeySha256: sha256File(publicKeyPath),
    schemaCapabilities: ['equipment-category-parent-name-index-v1'],
    node: 'v22.23.1',
    npm: '10.9.8'
  }
  writeJson(path.join(candidate, 'deploy/RELEASE.json'), releaseMetadata)

  const guard = String.raw`'use strict';
const fs = require('node:fs');
const file = process.argv[process.argv.indexOf('--env-file') + 1];
const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('MONGODB_URI='));
const uri = new URL(line.slice('MONGODB_URI='.length));
const target = {
  protocol: uri.protocol,
  hostname: uri.hostname,
  port: uri.port,
  database: decodeURIComponent(uri.pathname.slice(1)),
  replicaSet: uri.searchParams.get('replicaSet')
};
if (target.protocol !== 'mongodb:' || target.hostname !== '127.0.0.1' || target.port !== '27150' ||
    target.database !== 'customer_acceptance_v2_test' || target.replicaSet !== 'customer_acceptance_v2_rs') {
  process.exit(2);
}
process.stdout.write(JSON.stringify({ status: 'V2_TEST_MONGODB_TARGET_OK', target }) + '\n');
`
  writeFile(path.join(candidate, 'ops/lib/v2TestMongoTargetGuard.js'), guard)
  writeFile(
    path.join(candidate, 'ops/windows/New-V2RecoveryEquipmentCategoryIndexStage.ps1'),
    "$ErrorActionPreference = 'Stop'\n"
  )
  writeFile(path.join(candidate, 'app/package.json'), '{"name":"fixture"}\n')
  writeFile(path.join(candidate, 'app/package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n')
  writeFile(path.join(candidate, 'app/frontend/dist/index.html'), '<!doctype html><title>fixture</title>\n')

  const manifestPath = path.join(candidate, 'deploy/FILE-MANIFEST.json')
  const declaredFiles = []
  for (const file of fs.readdirSync(candidate, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const fullPath = path.join(file.parentPath, file.name)
    if (path.resolve(fullPath) === path.resolve(manifestPath)) continue
    const relative = path.relative(candidate, fullPath).replaceAll('\\', '/')
    declaredFiles.push({
      file: relative,
      bytes: fs.statSync(fullPath).size,
      sha256: sha256File(fullPath)
    })
  }
  declaredFiles.sort((left, right) => left.file.localeCompare(right.file, 'en'))
  const fileManifest = {
    format: 'task-distribution-v2-release-files/v1',
    releaseId,
    commit: sourceCommit,
    generatedAt: builtAt,
    pathComparison: 'windows-ordinal-ignore-case',
    setSemantics: 'exact-package-files-excluding-manifest',
    selfPath: 'deploy/FILE-MANIFEST.json',
    fileCount: declaredFiles.length,
    files: declaredFiles
  }
  writeJson(manifestPath, fileManifest)

  const nodeRoot = path.join(candidate, 'runtime-node')
  makeHardLinkOrCopy(fixedNode, path.join(nodeRoot, 'node.exe'))
  writeFile(path.join(nodeRoot, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n')
  for (const dependency of ['dotenv', 'express', 'mongoose']) {
    writeJson(path.join(candidate, 'app/node_modules', dependency, 'package.json'), {
      name: dependency,
      version: '1.0.0'
    })
  }
  writeJson(path.join(candidate, 'app/node_modules/.package-lock.json'), {
    name: 'fixture',
    lockfileVersion: 3
  })
  writeFile(path.join(candidate, 'serve-v2-recovery.cjs'), "'use strict';\n")
  writeFile(path.join(candidate, 'run-v2-recovery-api.ps1'), "$ErrorActionPreference = 'Stop'\n")
  writeFile(path.join(candidate, 'run-v2-recovery-web.ps1'), "$ErrorActionPreference = 'Stop'\n")

  const previousMetadataPath = path.join(previous, 'deploy/RELEASE.json')
  writeJson(previousMetadataPath, {
    format: 'task-distribution-v2-release/v1',
    releaseId: previousReleaseId,
    commit: previousCommit,
    database: 'customer_acceptance_v2_test',
    apiPort: 18120,
    innerWebPort: 18130,
    mongoPort: 27150
  })
  const previousRelativeMetadata = 'deploy/RELEASE.json'
  const previousManifestPath = path.join(previous, 'deploy/FILE-MANIFEST.json')
  writeJson(previousManifestPath, {
    format: 'task-distribution-v2-release-files/v1',
    releaseId: previousReleaseId,
    commit: previousCommit,
    generatedAt: builtAt,
    pathComparison: 'windows-ordinal-ignore-case',
    setSemantics: 'exact-package-files-excluding-manifest',
    selfPath: 'deploy/FILE-MANIFEST.json',
    fileCount: 1,
    files: [{
      file: previousRelativeMetadata,
      bytes: fs.statSync(previousMetadataPath).size,
      sha256: sha256File(previousMetadataPath)
    }]
  })
  writeJson(path.join(root, 'active-release.json'), {
    status: 'WINDOWS_RECOVERY_RELEASE_ACTIVE',
    releaseId: previousReleaseId,
    sourceCommit: previousCommit
  })

  const mongoUri = 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs'
  const appEnv = path.join(config, 'app.env')
  const operationsEnv = path.join(config, 'operations.env')
  writeFile(appEnv, `MONGODB_URI=${mongoUri}\n`)
  writeFile(operationsEnv, `MONGODB_URI=${mongoUri}\nBACKUP_ROOT=E:\\fixture\n`)

  const archive = path.join(packages, `${releaseId}.tar.gz`)
  writeFile(archive, 'immutable release archive fixture\n')
  const artifactManifest = path.join(packages, `${releaseId}.artifact-manifest.json`)
  writeJson(artifactManifest, {
    format: 'task-distribution-v2-release-artifact/v1',
    releaseId,
    commit: sourceCommit,
    builtAt,
    environment: 'customer-test',
    archive: {
      file: path.basename(archive),
      bytes: fs.statSync(archive).size,
      sha256: sha256File(archive)
    },
    fileManifestSha256: sha256File(manifestPath),
    fileCount: declaredFiles.length + 1
  })

  const predeployReceipt = path.join(receipts, 'deployment-backup-receipt.json')
  writeJson(predeployReceipt, {
    status: 'DEPLOYMENT_BACKUP_RECEIPT_VERIFIED',
    releaseId,
    sourceCommit,
    backupId: 'backup-20260811T010203Z-deadbeef',
    remoteArchiveBytes: 123456,
    remoteArchiveSha256: 'c'.repeat(64),
    localArchiveBytes: 123456,
    localArchiveSha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    offhostVerificationSha256: 'e'.repeat(64),
    archiveMatchesRemote: true,
    independentWorkstationVerified: true,
    consistencyMode: 'BEST_EFFORT_ONLINE_MONGODUMP',
    databaseAndUploadsAtomic: false,
    verifiedAt: builtAt
  })

  return {
    releaseId,
    sourceCommit,
    previousReleaseId,
    previousCommit,
    previous,
    builtAt,
    archive,
    artifactManifest,
    predeployReceipt,
    operationsEnv
  }
}

test('Windows Recovery staging is deterministic, fail closed, and never overwrites evidence', {
  timeout: 120_000
}, () => {
  assert.equal(fs.existsSync(fixedNode), true, `fixed Node runtime missing: ${fixedNode}`)
  const workRoot = path.join(repositoryRoot, 'work')
  fs.mkdirSync(workRoot, { recursive: true })
  const fixtureRoot = fs.mkdtempSync(path.join(workRoot, '.recovery-stage-test-'))
  try {
    const fixture = buildFixture(fixtureRoot)
    const common = [
      '-ReleaseId', fixture.releaseId,
      '-SourceCommit', fixture.sourceCommit,
      '-PreviousReleaseId', fixture.previousReleaseId,
      '-PreviousCommit', fixture.previousCommit,
      '-ReleaseArchivePath', fixture.archive,
      '-ExpectedReleaseArchiveSha256', sha256File(fixture.archive),
      '-ArtifactManifestPath', fixture.artifactManifest,
      '-ExpectedArtifactManifestSha256', sha256File(fixture.artifactManifest),
      '-PredeployBackupReceiptPath', fixture.predeployReceipt,
      '-ExpectedPredeployBackupReceiptSha256', sha256File(fixture.predeployReceipt),
      '-OperationsEnvPath', fixture.operationsEnv,
      '-RecoveryRoot', fixtureRoot
    ]

    const plan = invokePowerShell(common)
    assert.equal(plan.status, 'WINDOWS_RECOVERY_CANDIDATE_STAGE_PLAN_READY')
    assert.deepEqual(Object.keys(plan.runtimeInputs), [
      'appEnvPath',
      'appEnvSha256',
      'operationsEnvPath',
      'operationsEnvSha256',
      'mongoTargetGuardPath',
      'mongoTargetGuardSha256',
      'trustedPublicKeyPath',
      'trustedPublicKeySha256',
      'schemaCapabilities'
    ])

    const evidenceDirectory = path.join(
      fixtureRoot,
      'evidence',
      `release-${fixture.releaseId}`
    )
    fs.mkdirSync(evidenceDirectory, { recursive: true })
    const orphanEvidence = invokePowerShell(common, { expectFailure: true })
    assert.match(
      `${orphanEvidence.stderr}\n${orphanEvidence.stdout}`,
      /Evidence directory already exists without staged evidence/
    )
    assert.equal(
      fs.existsSync(path.join(evidenceDirectory, 'staged.json')),
      false,
      'orphan evidence must never be populated'
    )
    fs.rmdirSync(evidenceDirectory)

    const created = invokePowerShell([
      ...common,
      '-ConfirmInstance', 'task-distribution-v2-customer-test',
      '-ConfirmReleaseId', fixture.releaseId,
      '-ConfirmPreviousReleaseId', fixture.previousReleaseId,
      '-Apply',
      '-Confirm:$false'
    ])
    assert.equal(created.status, 'WINDOWS_RECOVERY_CANDIDATE_STAGED')
    assert.equal(created.reusedEvidence, false)
    const stagedPath = path.join(fixtureRoot, 'evidence', `release-${fixture.releaseId}`, 'staged.json')
    const stagedBytes = fs.readFileSync(stagedPath)
    assert.notEqual(stagedBytes[0], 0xef, 'staged evidence must not have a UTF-8 BOM')
    const staged = JSON.parse(stagedBytes.toString('utf8'))
    assert.equal(staged.runtimeInputsSha256, plan.runtimeInputsSha256)
    assert.equal(staged.predeployBackup.databaseAndUploadsAtomic, false)
    assert.equal(staged.predeployBackupReceipt.validationScope, 'TRANSFER_SHA256_AND_SCHEMA_ONLY')
    assert.equal(staged.predeployBackupReceipt.trustBoundary, 'APPROVED_EXTERNAL_OFFHOST_HANDOFF')

    const stagedPathLiteral = stagedPath.replaceAll("'", "''")
    const hashCommand = [
      `$stage = [IO.File]::ReadAllText('${stagedPathLiteral}') | ConvertFrom-Json`,
      '$json = ConvertTo-Json $stage.runtimeInputs -Depth 12 -Compress',
      '$sha = [Security.Cryptography.SHA256]::Create()',
      'try {',
      '  ([BitConverter]::ToString($sha.ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes($json)))).Replace("-", "").ToLowerInvariant()',
      '} finally { $sha.Dispose() }'
    ].join('; ')
    const powershellHash = execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-Command', hashCommand
    ], { encoding: 'utf8', windowsHide: true }).trim()
    assert.equal(powershellHash, staged.runtimeInputsSha256)

    const stagedSha256 = sha256File(stagedPath)
    const reverified = invokePowerShell(common)
    assert.equal(reverified.status, 'WINDOWS_RECOVERY_CANDIDATE_STAGE_REVERIFIED')
    assert.equal(reverified.reusedEvidence, true)
    assert.equal(sha256File(stagedPath), stagedSha256)

    fs.appendFileSync(fixture.operationsEnv, '# drift\n')
    const conflict = invokePowerShell(common, { expectFailure: true })
    assert.match(`${conflict.stderr}\n${conflict.stdout}`, /conflicts with the validated staging inputs/)
    assert.equal(sha256File(stagedPath), stagedSha256)
    fs.writeFileSync(
      fixture.operationsEnv,
      'MONGODB_URI=mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs\nBACKUP_ROOT=E:\\fixture\n'
    )

    fs.appendFileSync(
      path.join(fixtureRoot, 'releases', fixture.releaseId, 'ops/lib/v2TestMongoTargetGuard.js'),
      '\n// tampered\n'
    )
    const tampered = invokePowerShell(common, { expectFailure: true })
    assert.match(`${tampered.stderr}\n${tampered.stdout}`, /Candidate file (size|hash) mismatch/)
    assert.equal(sha256File(stagedPath), stagedSha256)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('Windows Recovery staging strictly accepts the deployed legacy previous manifest shape', {
  timeout: 120_000
}, () => {
  assert.equal(fs.existsSync(fixedNode), true, `fixed Node runtime missing: ${fixedNode}`)
  const workRoot = path.join(repositoryRoot, 'work')
  fs.mkdirSync(workRoot, { recursive: true })
  const fixtureRoot = fs.mkdtempSync(path.join(workRoot, '.recovery-legacy-stage-test-'))
  try {
    const fixture = buildFixture(fixtureRoot)
    const previousMetadataPath = path.join(fixture.previous, 'deploy/RELEASE.json')
    const previousManifestPath = path.join(fixture.previous, 'deploy/FILE-MANIFEST.json')
    const legacyManifest = {
      format: 'task-distribution-v2-release-files/v1',
      releaseId: fixture.previousReleaseId,
      commit: fixture.previousCommit,
      generatedAt: fixture.builtAt,
      files: [{
        file: 'deploy/RELEASE.json',
        bytes: fs.statSync(previousMetadataPath).size,
        sha256: sha256File(previousMetadataPath)
      }]
    }
    writeJson(previousManifestPath, legacyManifest)

    const common = [
      '-ReleaseId', fixture.releaseId,
      '-SourceCommit', fixture.sourceCommit,
      '-PreviousReleaseId', fixture.previousReleaseId,
      '-PreviousCommit', fixture.previousCommit,
      '-ReleaseArchivePath', fixture.archive,
      '-ExpectedReleaseArchiveSha256', sha256File(fixture.archive),
      '-ArtifactManifestPath', fixture.artifactManifest,
      '-ExpectedArtifactManifestSha256', sha256File(fixture.artifactManifest),
      '-PredeployBackupReceiptPath', fixture.predeployReceipt,
      '-ExpectedPredeployBackupReceiptSha256', sha256File(fixture.predeployReceipt),
      '-OperationsEnvPath', fixture.operationsEnv,
      '-RecoveryRoot', fixtureRoot
    ]
    const plan = invokePowerShell(common)
    assert.equal(plan.status, 'WINDOWS_RECOVERY_CANDIDATE_STAGE_PLAN_READY')
    const created = invokePowerShell([
      ...common,
      '-ConfirmInstance', 'task-distribution-v2-customer-test',
      '-ConfirmReleaseId', fixture.releaseId,
      '-ConfirmPreviousReleaseId', fixture.previousReleaseId,
      '-Apply',
      '-Confirm:$false'
    ])
    assert.equal(created.status, 'WINDOWS_RECOVERY_CANDIDATE_STAGED')
    const staged = JSON.parse(fs.readFileSync(
      path.join(fixtureRoot, 'evidence', `release-${fixture.releaseId}`, 'staged.json'),
      'utf8'
    ))
    assert.equal(staged.previousRelease.legacyManifestAccepted, true)
    assert.equal(staged.previousRelease.manifestFileCount, 1)

    writeJson(previousManifestPath, { ...legacyManifest, unexpected: true })
    const rejected = invokePowerShell(common, { expectFailure: true })
    assert.match(
      `${rejected.stderr}\n${rejected.stdout}`,
      /Previous release file manifest property count mismatch/
    )
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('release packaging and the Windows Recovery runbook retain the staging contract', () => {
  const builder = fs.readFileSync(releasePackageBuilder, 'utf8')
  const stagePath = 'New-V2RecoveryEquipmentCategoryIndexStage.ps1'
  const releaseOps = sectionBetween(builder, '$releaseOpsPaths = @(', '$releaseArchivePaths = @(')
  const requiredCommitted = sectionBetween(
    builder,
    '$requiredCommittedPaths = @(',
    'foreach ($required in $requiredCommittedPaths)'
  )
  const parserGate = sectionBetween(
    builder,
    'foreach ($script in @(',
    'Invoke-NativeChecked -FilePath $tar'
  )
  assert.match(releaseOps, new RegExp(stagePath.replaceAll('.', '\\.')))
  assert.match(requiredCommitted, new RegExp(stagePath.replaceAll('.', '\\.')))
  assert.match(parserGate, new RegExp(stagePath.replaceAll('.', '\\.')))

  const runbook = fs.readFileSync(releaseRunbook, 'utf8')
  const preparation = sectionBetween(runbook, '#### 4.5.1', '#### 4.5.2')
  assert.match(preparation, /Candidate.*Incoming.*Evidence.*任一已存在都必须停止/s)
  assert.match(preparation, /refusing overwrite/)
  assert.doesNotMatch(preparation, /TrimStart\('\.\/'\)/)
  for (const variable of ['WEB_ROOT', 'WEB_PORT', 'API_UPSTREAM']) {
    assert.match(preparation, new RegExp(variable))
  }

  const independentWorkstation = sectionBetween(runbook, '#### 4.5.4', '#### 4.5.5')
  assert.match(independentWorkstation, /\$IndependentTrustedPublicKeyPath\s*=/)
  assert.match(independentWorkstation, /\$IndependentTrustedPublicKeySha256\s*=/)
  assert.doesNotMatch(independentWorkstation, /\$TrustedPublicKeyPath\s*=/)
  assert.doesNotMatch(independentWorkstation, /\$TrustedPublicKeySha256\s*=/)

  const postAudit = sectionBetween(runbook, '#### 4.5.6', '#### 4.5.7')
  for (const parameter of [
    'TrustedPublicKeyPath',
    'TrustedPublicKeySha256',
    'OperationsEnvPath',
    'AppEnvSha256',
    'OperationsEnvSha256',
    'BusinessAuditReport'
  ]) {
    assert.match(postAudit, new RegExp(`-${parameter}\\b`))
  }
  assert.match(postAudit, /runtimeInputsSha256/)
  assert.match(postAudit, /Mongo write anchor/)
  assert.match(postAudit, /writePerformed=false/)
  assert.match(postAudit, /`6`.*`5`.*`1`/s)

  const evidence = sectionBetween(runbook, '#### 4.5.7', '### 4.6')
  assert.match(evidence, /runtimeInputsSha256/)
  assert.match(evidence, /mongo-write-anchor-hold\.json.*SHA256/s)
  assert.match(evidence, /mongo-write-anchor-execute\.json.*SHA256/s)
  assert.match(evidence, /equipment-routine business.*SHA256/s)

  const reviewedSections = sectionBetween(runbook, '#### 4.5.1', '#### 4.5.7')
  const powershellBlocks = [...reviewedSections.matchAll(/```powershell\r?\n([\s\S]*?)```/g)]
  assert.ok(powershellBlocks.length >= 7, 'expected the complete Recovery PowerShell workflow')
  for (const [index, match] of powershellBlocks.entries()) {
    assertPowerShellParses(match[1], `Recovery runbook PowerShell block ${index + 1}`)
  }
})
