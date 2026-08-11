import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../..')
const nodePath = path.join(repositoryRoot, 'tools/runtime/node-v22.23.1-win-x64/node.exe')
const backupCorePath = path.join(repositoryRoot, 'ops/lib/backupCore.js')
const receiptScript = path.join(repositoryRoot, 'ops/windows/New-V2RecoveryStoppedBackupOffhostReceipt.ps1')
const signingKeyScript = path.join(repositoryRoot, 'ops/windows/New-V2RecoveryOffhostReceiptSigningKey.ps1')
const releaseScript = path.join(repositoryRoot, 'ops/windows/Invoke-V2RecoveryEquipmentCategoryIndexRelease.ps1')
const windowsPowerShell = path.join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
// Codex-launched Node processes may omit COMPUTERNAME; pass the confirmed
// host identity explicitly to the PowerShell children used by this test.
const powershellEnvironment = {
  ...process.env,
  COMPUTERNAME: os.hostname()
}
const { serialize } = createRequire(import.meta.url)(path.join(repositoryRoot, 'app/node_modules/bson'))

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function psSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function writeFixtureBackup(root, backupId, {
  includeFileAssetsBson = true,
  includeUpload = true,
  declaredReferenceCount = 1,
  fileAssetSha256 = null
} = {}) {
  const databaseName = 'customer_acceptance_v2_test'
  const backupDirectory = path.join(root, backupId)
  const databaseDirectory = path.join(backupDirectory, 'database', databaseName)
  const uploadDirectory = path.join(backupDirectory, 'uploads', 'equipment')
  await fs.promises.mkdir(databaseDirectory, { recursive: true })
  await fs.promises.mkdir(uploadDirectory, { recursive: true })

  const bson = Buffer.from('fixture-equipment-category-bson')
  const metadata = Buffer.from('{"indexes":[]}\n')
  const upload = Buffer.from('fixture-photo-bytes')
  const fileAssetsBson = serialize({
    _id: 'fixture-file-asset-1',
    status: 'ACTIVE',
    storageKey: 'equipment/photo.jpg',
    size: upload.length,
    sha256: fileAssetSha256 || sha256(upload)
  })
  const files = [
    ['database/customer_acceptance_v2_test/equipmentcategories.bson', bson],
    ['database/customer_acceptance_v2_test/equipmentcategories.metadata.json', metadata]
  ]
  if (includeFileAssetsBson) {
    files.push(['database/customer_acceptance_v2_test/fileassets.bson', fileAssetsBson])
  }
  if (includeUpload) files.push(['uploads/equipment/photo.jpg', upload])
  for (const [relative, content] of files) {
    await fs.promises.writeFile(path.join(backupDirectory, ...relative.split('/')), content)
  }

  const manifest = {
    format: 'task-distribution-v2-backup/v1',
    backupId,
    createdAt: '2026-08-10T12:00:01.000Z',
    completedAt: '2026-08-10T12:00:02.000Z',
    retentionTags: ['daily'],
    database: {
      name: databaseName,
      hosts: ['127.0.0.1'],
      servers: ['127.0.0.1:27150'],
      replicaSet: 'customer_acceptance_v2_rs',
      remoteExplicitlyAuthorized: false,
      oplogCaptured: false,
      collectionCount: includeFileAssetsBson ? 2 : 1,
      collections: [{
        name: 'equipmentcategories',
        file: 'equipmentcategories.bson',
        documentCount: 1,
        bytes: bson.length,
        sha256: sha256(bson)
      }, ...(includeFileAssetsBson ? [{
        name: 'fileassets',
        file: 'fileassets.bson',
        documentCount: 1,
        bytes: fileAssetsBson.length,
        sha256: sha256(fileAssetsBson)
      }] : [])]
    },
    uploads: {
      sourceRootLabel: 'uploads',
      fileCount: includeUpload ? 1 : 0,
      bytes: includeUpload ? upload.length : 0,
      fileAssetReferences: {
        referenced: declaredReferenceCount,
        verified: declaredReferenceCount
      }
    },
    consistency: {
      restoreSet: 'database-and-uploads',
      databaseFileAssetsVerifiedAgainstUploadBytes: true,
      captureMode: 'BEST_EFFORT_ONLINE_MONGODUMP',
      databaseAndUploadsAtomic: false
    },
    files: files.map(([file, content]) => ({
      file,
      bytes: content.length,
      sha256: sha256(content)
    }))
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  await fs.promises.writeFile(path.join(backupDirectory, 'manifest.json'), serialized)
  await fs.promises.writeFile(
    path.join(backupDirectory, 'manifest.sha256'),
    `${sha256(serialized)}  manifest.json\n`
  )
  return { backupDirectory, manifestSha256: sha256(serialized) }
}

function createFixtureArchive(backupDirectory, archivePath) {
  const zipCommand = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory(${psSingleQuoted(backupDirectory)}, ${psSingleQuoted(archivePath)}, [IO.Compression.CompressionLevel]::Optimal, $true)`
  ].join('; ')
  const result = spawnSync(windowsPowerShell, ['-NoProfile', '-Command', zipCommand], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnvironment
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function invokeReceiptGenerator(parameters) {
  const values = [
    ['ReleaseId', parameters.releaseId],
    ['SourceCommit', parameters.sourceCommit],
    ['PreviousReleaseId', parameters.previousReleaseId],
    ['PreviousCommit', parameters.previousCommit],
    ['BackupId', parameters.backupId],
    ['BackupManifestSha256', parameters.manifestSha256],
    ['StoppedHandoffSha256', parameters.stoppedHandoffSha256],
    ['HandoffNonce', parameters.handoffNonce],
    ['ExpectedArchiveSha256', parameters.archiveSha256],
    ['ExpectedArchiveBytes', String(parameters.archiveBytes)],
    ['SourceHost', parameters.sourceHost],
    ['IndependentCopyRoot', parameters.root],
    ['ArchivePath', parameters.archivePath],
    ['ExtractionDirectory', parameters.extractionDirectory],
    ['ReceiptPath', parameters.receiptPath],
    ['SigningPrivateKeyPath', parameters.privateKeyPath],
    ['TrustedPublicKeyPath', parameters.publicKeyPath],
    ['TrustedPublicKeySha256', parameters.publicKeySha256],
    ['NodePath', nodePath],
    ['BackupCorePath', backupCorePath],
    ['ConfirmIndependentHost', os.hostname()]
  ]
  const invocation = [
    '&',
    psSingleQuoted(receiptScript),
    ...values.flatMap(([name, value]) => [`-${name}`, psSingleQuoted(value)]),
    ...(parameters.apply ? ['-Apply', '-Confirm:$false'] : [])
  ].join(' ')
  return spawnSync(windowsPowerShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', invocation], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnvironment
  })
}

async function invokeSignedEnvelopeConsumer({ root, receiptPath, publicKeyPath, publicKeySha256 }) {
  const releaseSource = await fs.promises.readFile(releaseScript, 'utf8')
  const helperStart = releaseSource.indexOf('function Get-FullPath')
  const helperEnd = releaseSource.indexOf('function Encode-Utf8State', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const receiptSha256 = sha256(await fs.promises.readFile(receiptPath))
  const harnessPath = path.join(root, `verify-envelope-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
  const harness = `${releaseSource.slice(helperStart, helperEnd)}
$payload = Read-SignedOffhostVerificationReceipt -ReceiptPath ${psSingleQuoted(receiptPath)} -ReceiptSha256 ${psSingleQuoted(receiptSha256)} -TrustedRoot ${psSingleQuoted(root)} -PublicKeyPath ${psSingleQuoted(publicKeyPath)} -PublicKeySha256 ${psSingleQuoted(publicKeySha256)}
$payload | ConvertTo-Json -Depth 12
`
  await fs.promises.writeFile(harnessPath, `\ufeff${harness}`, 'utf8')
  return spawnSync(
    windowsPowerShell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: powershellEnvironment
    }
  )
}

test('independent E-drive generator rejects source hash drift then creates a fully verified receipt', async (t) => {
  assert.equal(path.parse(repositoryRoot).root.toUpperCase(), 'E:\\')
  const root = await fs.promises.mkdtemp(path.join(path.dirname(repositoryRoot), '.test-data-offhost-receipt-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))

  const backupId = 'backup-20260810T120000Z-abcdef12'
  const privateKeyPath = path.join(root, 'keys', 'receipt-private.xml')
  const publicKeyPath = path.join(root, 'keys', 'receipt-public.xml')
  const repositoryKeyInvocation = [
    '&', psSingleQuoted(signingKeyScript),
    '-IndependentKeyRoot', psSingleQuoted(repositoryRoot),
    '-PrivateKeyPath', psSingleQuoted(path.join(repositoryRoot, 'receipt-private.xml')),
    '-PublicKeyPath', psSingleQuoted(path.join(repositoryRoot, 'receipt-public.xml')),
    '-ConfirmIndependentHost', psSingleQuoted(os.hostname())
  ].join(' ')
  const repositoryKey = spawnSync(
    windowsPowerShell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', repositoryKeyInvocation],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }
  )
  assert.notEqual(repositoryKey.status, 0)
  assert.match(`${repositoryKey.stderr}\n${repositoryKey.stdout}`, /must be outside the Git repository/)

  const keyInvocation = [
    '&', psSingleQuoted(signingKeyScript),
    '-IndependentKeyRoot', psSingleQuoted(root),
    '-PrivateKeyPath', psSingleQuoted(privateKeyPath),
    '-PublicKeyPath', psSingleQuoted(publicKeyPath),
    '-ConfirmIndependentHost', psSingleQuoted(os.hostname()),
    '-Apply', '-Confirm:$false'
  ].join(' ')
  const generatedKey = spawnSync(
    windowsPowerShell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', keyInvocation],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: powershellEnvironment
    }
  )
  assert.equal(generatedKey.status, 0, generatedKey.stderr || generatedKey.stdout)
  const keyResult = JSON.parse(generatedKey.stdout)
  assert.equal(keyResult.status, 'OFFHOST_RECEIPT_SIGNING_KEY_CREATED')
  assert.equal(keyResult.privateKeyAclProtected, true)

  const { backupDirectory, manifestSha256 } = await writeFixtureBackup(root, backupId)
  const archivePath = path.join(root, `${backupId}.zip`)
  const zipCommand = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[IO.Compression.ZipFile]::CreateFromDirectory(${psSingleQuoted(backupDirectory)}, ${psSingleQuoted(archivePath)}, [IO.Compression.CompressionLevel]::Optimal, $true)`
  ].join('; ')
  const zip = spawnSync(windowsPowerShell, ['-NoProfile', '-Command', zipCommand], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnvironment
  })
  assert.equal(zip.status, 0, zip.stderr || zip.stdout)

  const archive = await fs.promises.readFile(archivePath)
  const parameters = {
    releaseId: 'v2-20260810-abcdef0',
    sourceCommit: 'a'.repeat(40),
    previousReleaseId: 'v2-20260810-1234567',
    previousCommit: 'b'.repeat(40),
    backupId,
    manifestSha256,
    stoppedHandoffSha256: 'c'.repeat(64),
    handoffNonce: 'd'.repeat(64),
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    sourceHost: 'independent-source-host',
    root,
    archivePath,
    extractionDirectory: path.join(root, 'verified', backupId),
    receiptPath: path.join(root, 'receipts', `offhost-verification-${backupId}.json`),
    privateKeyPath,
    publicKeyPath,
    publicKeySha256: keyResult.publicKeySha256,
    apply: true
  }

  const drift = invokeReceiptGenerator({ ...parameters, archiveSha256: 'e'.repeat(64), apply: false })
  assert.notEqual(drift.status, 0)
  assert.match(`${drift.stderr}\n${drift.stdout}`, /ZIP SHA256 differs from the source evidence/)
  await assert.rejects(fs.promises.access(parameters.receiptPath))

  const reparseTarget = path.join(root, 'reparse-target')
  const reparseParent = path.join(root, 'reparse-parent')
  await fs.promises.mkdir(reparseTarget)
  await fs.promises.symlink(reparseTarget, reparseParent, 'junction')
  const reparseRejected = invokeReceiptGenerator({
    ...parameters,
    receiptPath: path.join(reparseParent, `offhost-verification-${backupId}.json`),
    apply: false
  })
  assert.notEqual(reparseRejected.status, 0)
  assert.match(`${reparseRejected.stderr}\n${reparseRejected.stdout}`, /path contains a reparse point/)

  const generated = invokeReceiptGenerator(parameters)
  assert.equal(generated.status, 0, generated.stderr || generated.stdout)
  const result = JSON.parse(generated.stdout)
  const envelope = JSON.parse(await fs.promises.readFile(parameters.receiptPath, 'utf8'))
  const receipt = JSON.parse(Buffer.from(envelope.signedPayloadUtf8Base64, 'base64').toString('utf8'))
  assert.equal(result.status, 'STOPPED_BACKUP_OFFHOST_RECEIPT_CREATED')
  assert.equal(result.receiptSha256, sha256(await fs.promises.readFile(parameters.receiptPath)))
  assert.equal(envelope.format, 'task-distribution-v2-windows-stopped-backup-offhost-signed-envelope/v2')
  assert.equal(envelope.signatureAlgorithm, 'RSA-SHA256-PKCS1-v1_5')
  assert.equal(envelope.publicKeySha256, parameters.publicKeySha256)
  assert.equal(envelope.signedPayloadSha256, sha256(Buffer.from(envelope.signedPayloadUtf8Base64, 'base64')))
  assert.match(envelope.signatureBase64, /^[A-Za-z0-9+/]+={0,2}$/)
  assert.equal(receipt.status, 'STOPPED_BACKUP_OFFHOST_VERIFIED')
  assert.equal(receipt.archiveSha256, parameters.archiveSha256)
  assert.equal(receipt.archiveBytes, parameters.archiveBytes)
  assert.equal(receipt.manifestSha256, manifestSha256)
  assert.deepEqual(receipt.databaseTarget, {
    hosts: ['127.0.0.1'],
    servers: ['127.0.0.1:27150'],
    replicaSet: 'customer_acceptance_v2_rs'
  })
  assert.equal(receipt.checks.exactFileSetValid, true)
  assert.equal(receipt.checks.everyDeclaredFileSha256Valid, true)
  assert.equal(receipt.checks.requiredMetadataPresent, true)
  assert.equal(receipt.checks.uploadsManifestVerified, true)
  assert.equal(receipt.checks.fileAssetReferencesVerified, true)

  const consumed = await invokeSignedEnvelopeConsumer({
    root,
    receiptPath: parameters.receiptPath,
    publicKeyPath,
    publicKeySha256: parameters.publicKeySha256
  })
  assert.equal(consumed.status, 0, consumed.stderr || consumed.stdout)
  assert.equal(JSON.parse(consumed.stdout).backupId, backupId)

  const tamperedPayload = Buffer.from(envelope.signedPayloadUtf8Base64, 'base64')
  const tamperedPayloadText = tamperedPayload.toString('utf8').replace(backupId, 'backup-20260810T120000Z-fedcba21')
  const tamperedPayloadBytes = Buffer.from(tamperedPayloadText, 'utf8')
  const tamperedPayloadEnvelope = {
    ...envelope,
    signedPayloadSha256: sha256(tamperedPayloadBytes),
    signedPayloadUtf8Base64: tamperedPayloadBytes.toString('base64')
  }
  const tamperedPayloadPath = path.join(root, 'receipts', 'tampered-payload.json')
  await fs.promises.writeFile(tamperedPayloadPath, `${JSON.stringify(tamperedPayloadEnvelope)}\n`)
  const rejectedPayload = await invokeSignedEnvelopeConsumer({
    root,
    receiptPath: tamperedPayloadPath,
    publicKeyPath,
    publicKeySha256: parameters.publicKeySha256
  })
  assert.notEqual(rejectedPayload.status, 0)
  assert.match(`${rejectedPayload.stderr}\n${rejectedPayload.stdout}`, /RSA-SHA256 verification failed/)

  const signatureBytes = Buffer.from(envelope.signatureBase64, 'base64')
  signatureBytes[0] ^= 0x01
  const tamperedSignaturePath = path.join(root, 'receipts', 'tampered-signature.json')
  await fs.promises.writeFile(tamperedSignaturePath, `${JSON.stringify({
    ...envelope,
    signatureBase64: signatureBytes.toString('base64')
  })}\n`)
  const rejectedSignature = await invokeSignedEnvelopeConsumer({
    root,
    receiptPath: tamperedSignaturePath,
    publicKeyPath,
    publicKeySha256: parameters.publicKeySha256
  })
  assert.notEqual(rejectedSignature.status, 0)
  assert.match(`${rejectedSignature.stderr}\n${rejectedSignature.stdout}`, /RSA-SHA256 verification failed/)

  const tamperedAlgorithmPath = path.join(root, 'receipts', 'tampered-algorithm.json')
  await fs.promises.writeFile(tamperedAlgorithmPath, `${JSON.stringify({
    ...envelope,
    signatureAlgorithm: 'RSA-SHA1-PKCS1-v1_5'
  })}\n`)
  const rejectedAlgorithm = await invokeSignedEnvelopeConsumer({
    root,
    receiptPath: tamperedAlgorithmPath,
    publicKeyPath,
    publicKeySha256: parameters.publicKeySha256
  })
  assert.notEqual(rejectedAlgorithm.status, 0)
  assert.match(`${rejectedAlgorithm.stderr}\n${rejectedAlgorithm.stdout}`, /identity, algorithm, or public key mismatch/)
})

test('offhost receipt rejects missing or forged FileAsset evidence', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(path.dirname(repositoryRoot), '.test-data-offhost-negative-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))

  const privateKeyPath = path.join(root, 'keys', 'receipt-private.xml')
  const publicKeyPath = path.join(root, 'keys', 'receipt-public.xml')
  const keyInvocation = [
    '&', psSingleQuoted(signingKeyScript),
    '-IndependentKeyRoot', psSingleQuoted(root),
    '-PrivateKeyPath', psSingleQuoted(privateKeyPath),
    '-PublicKeyPath', psSingleQuoted(publicKeyPath),
    '-ConfirmIndependentHost', psSingleQuoted(os.hostname()),
    '-Apply', '-Confirm:$false'
  ].join(' ')
  const generatedKey = spawnSync(
    windowsPowerShell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', keyInvocation],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: powershellEnvironment
    }
  )
  assert.equal(generatedKey.status, 0, generatedKey.stderr || generatedKey.stdout)
  const keyResult = JSON.parse(generatedKey.stdout)

  const cases = [
    {
      name: 'missing BSON collection',
      backupId: 'backup-20260810T120001Z-abcdef13',
      options: { includeFileAssetsBson: false },
      error: /must contain the fileassets BSON collection/
    },
    {
      name: 'forged reference counts',
      backupId: 'backup-20260810T120002Z-abcdef14',
      options: { declaredReferenceCount: 2 },
      error: /reference counts do not match/
    },
    {
      name: 'missing upload bytes',
      backupId: 'backup-20260810T120003Z-abcdef15',
      options: { includeUpload: false },
      error: /FileAsset records do not match the upload backup/
    },
    {
      name: 'tampered BSON reference hash',
      backupId: 'backup-20260810T120004Z-abcdef16',
      options: { fileAssetSha256: '0'.repeat(64) },
      error: /FileAsset records do not match the upload backup/
    }
  ]

  for (const fixtureCase of cases) {
    const { backupDirectory, manifestSha256 } = await writeFixtureBackup(
      root,
      fixtureCase.backupId,
      fixtureCase.options
    )
    const archivePath = path.join(root, `${fixtureCase.backupId}.zip`)
    createFixtureArchive(backupDirectory, archivePath)
    const archive = await fs.promises.readFile(archivePath)
    const result = invokeReceiptGenerator({
      releaseId: 'v2-20260810-abcdef0',
      sourceCommit: 'a'.repeat(40),
      previousReleaseId: 'v2-20260810-1234567',
      previousCommit: 'b'.repeat(40),
      backupId: fixtureCase.backupId,
      manifestSha256,
      stoppedHandoffSha256: 'c'.repeat(64),
      handoffNonce: 'd'.repeat(64),
      archiveSha256: sha256(archive),
      archiveBytes: archive.length,
      sourceHost: 'independent-source-host',
      root,
      archivePath,
      extractionDirectory: path.join(root, 'verified', fixtureCase.backupId),
      receiptPath: path.join(root, 'receipts', `offhost-verification-${fixtureCase.backupId}.json`),
      privateKeyPath,
      publicKeyPath,
      publicKeySha256: keyResult.publicKeySha256,
      apply: true
    })
    assert.notEqual(result.status, 0, fixtureCase.name)
    assert.match(`${result.stderr}\n${result.stdout}`, fixtureCase.error, fixtureCase.name)
  }
})
