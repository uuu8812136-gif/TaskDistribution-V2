#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = Object.freeze({
  instance: 'task-distribution-v2-customer-test',
  database: 'customer_acceptance_v2_test',
  host: '127.0.0.1',
  port: 27150,
  replicaSet: 'customer_acceptance_v2_rs'
});
const PREVIEW_FORMAT = 'task-distribution-v2-migration-preview/v1';
const HANDOFF_FORMAT = 'task-distribution-v2-release-backup-handoff/v1';
const REPORT_FILES = Object.freeze({
  positionLevels: 'position-levels-dry-run.json',
  transportMasterData: 'transport-master-data-dry-run.json',
  equipmentOwnership: 'equipment-ownership-dry-run.json',
  acceptanceJuly2026: 'acceptance-july-2026-dry-run.json'
});

class MigrationPreviewInvariantError extends Error {
  constructor(message, mismatches = []) {
    super(message);
    this.name = 'MigrationPreviewInvariantError';
    this.code = 'V2_MIGRATION_PREVIEW_INVALID';
    this.mismatches = mismatches;
  }
}

function fail(message, mismatches = []) {
  throw new MigrationPreviewInvariantError(message, mismatches);
}

function assertRegularFile(file, label = path.basename(file)) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`Evidence file does not exist: ${label}`, [label]);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`Evidence path must be a regular file: ${label}`, [label]);
  }
  return file;
}

function readJson(file) {
  assertRegularFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Unable to read JSON evidence: ${path.basename(file)}`, [error.code || error.name]);
  }
}

function sha256File(file) {
  assertRegularFile(file);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertAbsoluteDirectory(directory, label) {
  if (!path.isAbsolute(directory)) fail(`${label} must be absolute`, [label]);
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    fail(`${label} does not exist`, [label]);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory`, [label]);
  }
  return path.resolve(directory);
}

function assertExactChild(root, file, expectedName, label) {
  const expected = path.join(root, expectedName);
  if (path.resolve(file) !== expected) fail(`${label} is outside the evidence directory`, [label]);
  return expected;
}

function reportPath(evidenceDir, key) {
  return path.join(evidenceDir, REPORT_FILES[key]);
}

function validateReportSet(evidenceDirectory) {
  const evidenceDir = assertAbsoluteDirectory(evidenceDirectory, 'evidenceDir');
  const position = readJson(reportPath(evidenceDir, 'positionLevels'));
  const transport = readJson(reportPath(evidenceDir, 'transportMasterData'));
  const equipment = readJson(reportPath(evidenceDir, 'equipmentOwnership'));
  const acceptance = readJson(reportPath(evidenceDir, 'acceptanceJuly2026'));
  const mismatches = [];
  const expect = (condition, code) => { if (!condition) mismatches.push(code); };

  expect(position.status === 'DRY_RUN_READY', 'position.status');
  expect(position.mode === 'dry-run', 'position.mode');
  expect(position.writePerformed === false, 'position.writePerformed');
  expect(position.database?.name === EXPECTED.database, 'position.database');
  expect(Array.isArray(position.before?.blockers) && position.before.blockers.length === 0,
    'position.blockers');

  expect(transport.status === 'DRY_RUN_READY', 'transport.status');
  expect(transport.mode === 'dry-run', 'transport.mode');
  expect(transport.writePerformed === false, 'transport.writePerformed');
  expect(transport.database?.name === EXPECTED.database, 'transport.database');
  expect(Array.isArray(transport.conflicts) && transport.conflicts.length === 0,
    'transport.conflicts');

  expect(equipment.status === 'DRY_RUN_READY', 'equipment.status');
  expect(equipment.mode === 'dry-run', 'equipment.mode');
  expect(equipment.writePerformed === false, 'equipment.writePerformed');
  expect(equipment.database?.name === EXPECTED.database, 'equipment.database');
  expect(equipment.target?.countMatchesExpected === true, 'equipment.expectedCount');
  for (const [field, expected] of Object.entries({
    assetsScanned: 141,
    orgUnitMatches: 86,
    custodianMatches: 20,
    assetsToUpdate: 86,
    routinePlansScanned: 684,
    routinePlansEligible: 630,
    routinePlansOutsideResolvedOwnership: 54,
    routinePlansToUpdate: 630,
    routinePlanOrgUnitConflicts: 0
  })) expect(equipment[field] === expected, `equipment.${field}`);

  expect(acceptance.status === 'DRY_RUN_READY', 'acceptance.status');
  expect(acceptance.mode === 'dry-run', 'acceptance.mode');
  expect(acceptance.writePerformed === false, 'acceptance.writePerformed');
  expect(acceptance.database?.name === EXPECTED.database, 'acceptance.database');
  expect(acceptance.before?.state === 'READY', 'acceptance.state');
  expect(acceptance.before?.plannedWriteCount === 3, 'acceptance.plannedWriteCount');
  expect(acceptance.before?.blockerCount === 0, 'acceptance.blockerCount');

  if (mismatches.length) fail('Migration preview report mismatch', mismatches);
  return Object.freeze({ position, transport, equipment, acceptance });
}

function readRelease(candidateDirectory) {
  const candidate = assertAbsoluteDirectory(candidateDirectory, 'candidate');
  const releasePath = path.join(candidate, 'deploy', 'RELEASE.json');
  const release = readJson(releasePath);
  const mismatches = [];
  if (release.format !== 'task-distribution-v2-release/v1') mismatches.push('release.format');
  if (release.environment !== 'customer-test') mismatches.push('release.environment');
  if (release.database !== EXPECTED.database) mismatches.push('release.database');
  if (release.mongoPort !== EXPECTED.port) mismatches.push('release.mongoPort');
  if (release.replicaSet !== EXPECTED.replicaSet) mismatches.push('release.replicaSet');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$/.test(release.releaseId || '')) {
    mismatches.push('release.releaseId');
  }
  if (!/^[a-f0-9]{40}$/.test(release.commit || '')) mismatches.push('release.commit');
  if (mismatches.length) fail('Release identity does not match V2 customer test', mismatches);
  return { candidate, releasePath, release };
}

function readHandoff(evidenceDir, handoffFile) {
  const handoffPath = assertExactChild(evidenceDir, handoffFile, 'backup-handoff.json', 'handoff');
  const handoff = readJson(handoffPath);
  const mismatches = [];
  if (handoff.format !== HANDOFF_FORMAT) mismatches.push('handoff.format');
  if (handoff.instance !== EXPECTED.instance) mismatches.push('handoff.instance');
  if (handoff.database !== EXPECTED.database) mismatches.push('handoff.database');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{5,95}$/.test(handoff.releaseId || '')) {
    mismatches.push('handoff.releaseId');
  }
  if (!/^backup-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(handoff.backupId || '')) {
    mismatches.push('handoff.backupId');
  }
  if (!/^[a-f0-9]{64}$/.test(handoff.manifestSha256 || '')) {
    mismatches.push('handoff.manifestSha256');
  }
  if (!/^[a-f0-9]{64}$/.test(handoff.migrationInputSha256 || '')) {
    mismatches.push('handoff.migrationInputSha256');
  }
  if (handoff.servicesHeldStopped !== true) mismatches.push('handoff.servicesHeldStopped');
  if (!Number.isFinite(Date.parse(handoff.createdAt))) mismatches.push('handoff.createdAt');
  if (mismatches.length) fail('Backup handoff is invalid', mismatches);
  return { handoffPath, handoff };
}

function reportSummaries(evidenceDir, reports) {
  const entry = (key, summary) => ({
    file: REPORT_FILES[key],
    sha256: sha256File(reportPath(evidenceDir, key)),
    ...summary
  });
  return {
    positionLevels: entry('positionLevels', {
      status: reports.position.status,
      plannedUpdateCount: reports.position.before?.plannedUpdateCount ?? null,
      blockerCount: reports.position.before.blockers.length
    }),
    transportMasterData: entry('transportMasterData', {
      status: reports.transport.status,
      mastersToCreate: reports.transport.mastersToCreate,
      recordsToUpdate: reports.transport.recordsToUpdate,
      conflictCount: reports.transport.conflicts.length
    }),
    equipmentOwnership: entry('equipmentOwnership', {
      status: reports.equipment.status,
      assetsToUpdate: reports.equipment.assetsToUpdate,
      routinePlansToUpdate: reports.equipment.routinePlansToUpdate,
      conflictCount: reports.equipment.routinePlanOrgUnitConflicts
    }),
    acceptanceJuly2026: entry('acceptanceJuly2026', {
      status: reports.acceptance.status,
      plannedWriteCount: reports.acceptance.before.plannedWriteCount,
      blockerCount: reports.acceptance.before.blockerCount
    })
  };
}

function createMigrationPreview({ candidate, evidenceDir, handoffPath, now = () => new Date() } = {}) {
  const releaseState = readRelease(candidate);
  const resolvedEvidence = assertAbsoluteDirectory(evidenceDir, 'evidenceDir');
  const { handoff } = readHandoff(resolvedEvidence, handoffPath);
  const reports = validateReportSet(resolvedEvidence);
  if (releaseState.release.releaseId !== handoff.releaseId) {
    fail('Release and backup handoff do not match', ['releaseId']);
  }
  return Object.freeze({
    format: PREVIEW_FORMAT,
    status: 'MIGRATION_PREVIEW_READY',
    previewedAt: now().toISOString(),
    instance: EXPECTED.instance,
    database: EXPECTED.database,
    mongoTarget: {
      host: EXPECTED.host,
      port: EXPECTED.port,
      replicaSet: EXPECTED.replicaSet
    },
    releaseId: handoff.releaseId,
    sourceCommit: releaseState.release.commit,
    releaseJsonSha256: sha256File(releaseState.releasePath),
    backupId: handoff.backupId,
    manifestSha256: handoff.manifestSha256,
    migrationInputSha256: handoff.migrationInputSha256,
    writePerformed: false,
    reports: reportSummaries(resolvedEvidence, reports)
  });
}

function validateMigrationPreview({ candidate, evidenceDir, handoffPath, previewPath,
  now = () => new Date() } = {}) {
  const releaseState = readRelease(candidate);
  const resolvedEvidence = assertAbsoluteDirectory(evidenceDir, 'evidenceDir');
  const { handoff } = readHandoff(resolvedEvidence, handoffPath);
  const exactPreviewPath = assertExactChild(
    resolvedEvidence,
    previewPath,
    'migration-preview.json',
    'preview'
  );
  const preview = readJson(exactPreviewPath);
  const reports = validateReportSet(resolvedEvidence);
  const expectedReports = reportSummaries(resolvedEvidence, reports);
  const mismatches = [];
  const expect = (condition, code) => { if (!condition) mismatches.push(code); };

  expect(preview.format === PREVIEW_FORMAT, 'preview.format');
  expect(preview.status === 'MIGRATION_PREVIEW_READY', 'preview.status');
  expect(preview.instance === EXPECTED.instance, 'preview.instance');
  expect(preview.database === EXPECTED.database, 'preview.database');
  expect(preview.mongoTarget?.host === EXPECTED.host, 'preview.mongoHost');
  expect(preview.mongoTarget?.port === EXPECTED.port, 'preview.mongoPort');
  expect(preview.mongoTarget?.replicaSet === EXPECTED.replicaSet, 'preview.replicaSet');
  expect(preview.releaseId === handoff.releaseId && preview.releaseId === releaseState.release.releaseId,
    'preview.releaseId');
  expect(preview.sourceCommit === releaseState.release.commit, 'preview.sourceCommit');
  expect(preview.releaseJsonSha256 === sha256File(releaseState.releasePath),
    'preview.releaseJsonSha256');
  expect(preview.backupId === handoff.backupId, 'preview.backupId');
  expect(preview.manifestSha256 === handoff.manifestSha256, 'preview.manifestSha256');
  expect(preview.migrationInputSha256 === handoff.migrationInputSha256,
    'preview.migrationInputSha256');
  expect(preview.writePerformed === false, 'preview.writePerformed');
  expect(JSON.stringify(preview.reports) === JSON.stringify(expectedReports), 'preview.reports');
  const previewedAt = Date.parse(preview.previewedAt);
  const handoffAt = Date.parse(handoff.createdAt);
  expect(Number.isFinite(previewedAt) && previewedAt >= handoffAt &&
    previewedAt <= now().getTime() + 300_000, 'preview.previewedAt');
  if (mismatches.length) fail('Migration preview does not match release evidence', mismatches);

  return Object.freeze({
    status: 'MIGRATION_PREVIEW_VERIFIED',
    releaseId: preview.releaseId,
    backupId: preview.backupId,
    manifestSha256: preview.manifestSha256,
    migrationInputSha256: preview.migrationInputSha256,
    previewSha256: sha256File(exactPreviewPath)
  });
}

function parseArgs(argv) {
  const mode = argv[0];
  if (!['create', 'verify'].includes(mode)) fail('Mode must be create or verify', ['mode']);
  const allowed = new Set(['candidate', 'evidence-dir', 'handoff', 'preview']);
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (!allowed.has(name) || !argv[index + 1]) fail(`Invalid argument: ${token}`, ['arguments']);
    if (Object.hasOwn(values, name)) fail(`Duplicate argument: ${token}`, ['arguments']);
    values[name] = argv[++index];
  }
  const missing = [...allowed].filter(name => !values[name]);
  if (missing.length) fail(`Missing arguments: ${missing.join(', ')}`, ['arguments']);
  return { mode, values };
}

function writeJsonExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o640
  });
}

function main(argv = process.argv.slice(2)) {
  const { mode, values } = parseArgs(argv);
  const input = {
    candidate: values.candidate,
    evidenceDir: values['evidence-dir'],
    handoffPath: values.handoff,
    previewPath: values.preview
  };
  if (mode === 'create') {
    const evidenceDir = assertAbsoluteDirectory(input.evidenceDir, 'evidenceDir');
    const previewPath = assertExactChild(evidenceDir, input.previewPath, 'migration-preview.json', 'preview');
    const result = createMigrationPreview(input);
    writeJsonExclusive(previewPath, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = validateMigrationPreview(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'V2_MIGRATION_PREVIEW_INVALID',
      code: error.code || 'V2_MIGRATION_PREVIEW_FAILED',
      message: error.message,
      mismatches: error.mismatches || []
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED,
  HANDOFF_FORMAT,
  MigrationPreviewInvariantError,
  PREVIEW_FORMAT,
  REPORT_FILES,
  createMigrationPreview,
  main,
  validateMigrationPreview,
  validateReportSet
};
