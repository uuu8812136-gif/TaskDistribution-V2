'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const {
  BACKUP_MANIFEST_FORMAT,
  REQUIRED_BACKUP_COLLECTIONS
} = require('../../../app/services/migrationBackupManifestService');
const {
  COLLECTIONS,
  ROLE_PERMISSION_MAP,
  TARGET_ROOT_ORG,
  TARGET_TEAM,
  createLegacyTenantMigrationService
} = require('../../../app/services/legacyTenantMigrationService');
const {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  TEAM_STATUSES,
  deriveModuleDataScopes
} = require('../../../app/config/permissions');

const TEST_DATABASE_NAME = `legacy_migration_${randomUUID().replaceAll('-', '')}_v2_test`;
const TEST_DATA_ROOT = path.resolve(
  __dirname,
  '../../../.test-data',
  `legacy-migration-${randomUUID()}`
);
const COLLECTION_NAMES = Object.values(COLLECTIONS);

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function seedLegacyData(options = {}) {
  const plannedTeamId = options.plannedTeamId || objectId();
  const plannedRootOrgId = options.plannedRootOrgId || objectId();
  const adminId = objectId();
  const workerId = objectId();
  const taskId = objectId();
  const reviewId = objectId();
  const extensionId = objectId();
  const now = new Date('2026-07-16T04:00:00.000Z');

  await mongoose.connection.db.collection(COLLECTIONS.users).insertMany([
    {
      _id: adminId,
      username: 'AdminOne',
      password: 'legacy-hash',
      name: 'Admin One',
      roles: ['admin'],
      status: 'active',
      createdAt: now,
      updatedAt: now
    },
    {
      _id: workerId,
      username: 'WorkerOne',
      password: 'legacy-hash',
      name: 'Worker One',
      roles: ['executor', 'cc'],
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  ]);
  await mongoose.connection.db.collection(COLLECTIONS.tasks).insertOne({
    _id: taskId,
    taskName: 'Legacy task',
    creator: adminId,
    executor: [workerId],
    ccUsers: [workerId],
    plannedCompletionTime: new Date('2026-08-01T00:00:00.000Z'),
    status: 'in_progress',
    attachments: [{ filename: 'legacy.txt', size: 12, path: 'uploads/legacy.txt' }],
    completionAttachments: [],
    executorCompletions: [{
      executor: workerId,
      status: 'pending',
      attachments: [{ filename: 'proof.jpg', size: 34, path: 'uploads/proof.jpg' }]
    }],
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.taskreviews).insertOne({
    _id: reviewId,
    task: taskId,
    reviewer: workerId,
    content: 'Legacy review',
    attachments: [{ filename: 'review.txt', size: 5, path: 'uploads/review.txt' }],
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.extensionrequests).insertOne({
    _id: extensionId,
    task: taskId,
    applicant: workerId,
    requestType: 'main_task',
    reason: 'Legacy request',
    originalCompletionTime: new Date('2026-08-01T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.messages).insertOne({
    _id: objectId(),
    type: 'task_assigned',
    title: 'Legacy message',
    content: 'Legacy message content',
    recipient: workerId,
    sender: adminId,
    relatedTask: taskId,
    relatedExtension: extensionId,
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.fileassets).insertOne({
    _id: objectId(),
    ownerType: 'TASK',
    ownerId: taskId,
    storageKey: `${plannedTeamId}/2026/07/00000000-0000-4000-8000-000000000001.txt`,
    originalName: 'asset.txt',
    mimeType: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
    uploaderId: adminId,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now
  });

  return {
    plannedTeamId,
    plannedRootOrgId,
    adminId,
    workerId,
    taskId,
    reviewId,
    extensionId
  };
}

async function createBackupManifest(label, countOverrides = {}) {
  const directory = path.join(TEST_DATA_ROOT, label);
  await fs.promises.mkdir(directory, { recursive: true });
  const collections = [];
  for (const name of REQUIRED_BACKUP_COLLECTIONS) {
    const content = Buffer.from(`verified test BSON for ${name}\n`, 'utf8');
    const file = `${name}.bson`;
    await fs.promises.writeFile(path.join(directory, file), content);
    collections.push({
      name,
      documentCount: Object.prototype.hasOwnProperty.call(countOverrides, name)
        ? countOverrides[name]
        : await mongoose.connection.db.collection(name).countDocuments(),
      file,
      bytes: content.length,
      sha256: sha256(content)
    });
  }
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.promises.writeFile(manifestPath, JSON.stringify({
    format: BACKUP_MANIFEST_FORMAT,
    databaseName: TEST_DATABASE_NAME,
    completedAt: '2026-07-16T03:59:00.000Z',
    collections
  }, null, 2));
  return manifestPath;
}

function migrationService() {
  return createLegacyTenantMigrationService({
    connection: mongoose.connection,
    clock: () => new Date('2026-07-16T05:00:00.000Z')
  });
}

function runOptions(overrides = {}) {
  return {
    superAdminUsername: 'AdminOne',
    plannedTeamId: fixture.plannedTeamId,
    plannedRootOrgId: fixture.plannedRootOrgId,
    ...overrides
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  assert.ok(TEST_DATA_ROOT.includes(`${path.sep}.test-data${path.sep}`));
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME,
    autoIndex: false
  });
});

beforeEach(async () => {
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await mongoose.connection.db.dropDatabase();
  fixture = await seedLegacyData();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
  if (TEST_DATA_ROOT.includes(`${path.sep}.test-data${path.sep}`)) {
    await fs.promises.rm(TEST_DATA_ROOT, { recursive: true, force: true });
  }
});

test('default mode performs a complete dry-run without database writes', async () => {
  const beforeTask = await mongoose.connection.db.collection(COLLECTIONS.tasks)
    .findOne({ _id: fixture.taskId });
  const report = await migrationService().run(runOptions());

  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.after, null);
  assert.equal(report.plan.changes.projectTeamsCreated, 1);
  assert.equal(report.plan.changes.membershipsCreated, 2);
  assert.equal(report.before.legacyEmbeddedAttachments.files, 3);
  assert.equal(report.before.legacyEmbeddedAttachments.diskFilesTouched, false);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.teammemberships).countDocuments(), 0);
  const afterTask = await mongoose.connection.db.collection(COLLECTIONS.tasks)
    .findOne({ _id: fixture.taskId });
  assert.deepEqual(afterTask, beforeTask);
});

test('system super administrator is preserved while its existing membership is disabled', async () => {
  const systemUserId = objectId();
  const systemMembershipId = objectId();
  const now = new Date('2026-07-16T04:30:00.000Z');
  await mongoose.connection.db.collection(COLLECTIONS.users).insertOne({
    _id: systemUserId,
    username: 'InternalMigrationControl',
    usernameNormalized: 'internalmigrationcontrol',
    password: 'legacy-hash',
    name: 'Internal Migration Control',
    roles: ['admin'],
    isSuperAdmin: true,
    isSystemAccount: true,
    tokenVersion: 7,
    status: 'active',
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.projectteams).insertOne({
    _id: fixture.plannedTeamId,
    code: TARGET_TEAM.code,
    name: TARGET_TEAM.name,
    status: TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: fixture.adminId,
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.orgunits).insertOne({
    _id: fixture.plannedRootOrgId,
    teamId: fixture.plannedTeamId,
    parentId: null,
    type: TARGET_ROOT_ORG.type,
    code: TARGET_ROOT_ORG.code,
    name: TARGET_ROOT_ORG.name,
    status: ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 0,
    level: TARGET_ROOT_ORG.level,
    path: TARGET_ROOT_ORG.path,
    createdAt: now,
    updatedAt: now
  });
  await mongoose.connection.db.collection(COLLECTIONS.teammemberships).insertOne({
    _id: systemMembershipId,
    teamId: fixture.plannedTeamId,
    userId: systemUserId,
    orgUnitId: fixture.plannedRootOrgId,
    role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
    positionKey: POSITION_KEYS.EMPLOYEE,
    positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.EMPLOYEE],
    functionalRoleKeys: [],
    permissionKeys: ['member.view'],
    moduleDataScopes: deriveModuleDataScopes({
      positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.EMPLOYEE],
      functionalRoleKeys: []
    }),
    status: MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: now,
    createdAt: now,
    updatedAt: now
  });

  const dryRun = await migrationService().run(runOptions());
  assert.equal(dryRun.status, 'DRY_RUN_READY');
  assert.equal(dryRun.before.anomalies.counts.UNEXPECTED_EXISTING_SUPER_ADMIN, undefined);
  assert.equal(dryRun.plan.changes.membershipsCreated, 2);
  assert.equal(dryRun.plan.changes.membershipsUpdated, 1);

  const manifestPath = await createBackupManifest('system-account-preservation');
  const report = await migrationService().run(runOptions({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupManifestPath: manifestPath
  }));
  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.actualModifications.membershipsCreated, 2);
  assert.equal(report.actualModifications.membershipsUpdated, 1);

  const storedSystemUser = await mongoose.connection.db.collection(COLLECTIONS.users)
    .findOne({ _id: systemUserId });
  assert.equal(storedSystemUser.isSuperAdmin, true);
  assert.equal(storedSystemUser.isSystemAccount, true);
  assert.equal(storedSystemUser.tokenVersion, 7);
  const storedSystemMembership = await mongoose.connection.db.collection(COLLECTIONS.teammemberships)
    .findOne({ _id: systemMembershipId, userId: systemUserId });
  assert.ok(storedSystemMembership);
  assert.equal(storedSystemMembership.status, MEMBERSHIP_STATUSES.DISABLED);
  assert.equal(storedSystemMembership.role, MEMBERSHIP_ROLES.PROJECT_ADMIN);
  assert.deepEqual(storedSystemMembership.permissionKeys, ['member.view']);
});

test('execute mode rejects every missing or mismatched safety parameter before writes', async () => {
  const manifestPath = await createBackupManifest('guard-test');
  const service = migrationService();

  await assert.rejects(
    service.run(runOptions({ execute: true, backupManifestPath: manifestPath })),
    (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH'
  );
  await assert.rejects(
    service.run(runOptions({
      execute: true,
      confirmDatabase: `${TEST_DATABASE_NAME}_wrong`,
      backupManifestPath: manifestPath
    })),
    (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH'
  );
  await assert.rejects(
    service.run(runOptions({
      execute: true,
      confirmDatabase: TEST_DATABASE_NAME,
      superAdminUsername: null,
      backupManifestPath: manifestPath
    })),
    (error) => error.code === 'SUPER_ADMIN_USERNAME_REQUIRED'
  );
  await assert.rejects(
    service.run(runOptions({
      execute: true,
      confirmDatabase: TEST_DATABASE_NAME,
      backupManifestPath: null
    })),
    (error) => error.code === 'BACKUP_MANIFEST_REQUIRED'
  );

  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.auditlogs).countDocuments(), 0);
});

test('username normalization conflicts block dry-run and execute without partial writes', async () => {
  await mongoose.connection.db.collection(COLLECTIONS.users).insertOne({
    _id: objectId(),
    username: 'ＡｄｍｉｎＯｎｅ',
    password: 'legacy-hash',
    name: 'Collision',
    roles: ['executor'],
    status: 'active'
  });
  const dryRun = await migrationService().run(runOptions());
  assert.equal(dryRun.status, 'DRY_RUN_BLOCKED');
  assert.equal(dryRun.before.anomalies.counts.USERNAME_NORMALIZED_COLLISION, 2);

  const manifestPath = await createBackupManifest('collision-test');
  const execute = await migrationService().run(runOptions({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupManifestPath: manifestPath
  }));
  assert.equal(execute.status, 'BLOCKED');
  assert.equal(execute.writePerformed, false);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.auditlogs).countDocuments(), 0);
});

test('execute maps role unions and backfills every legacy collection in one transaction', async () => {
  await mongoose.connection.db.collection(COLLECTIONS.users).bulkWrite([
    {
      updateOne: {
        filter: { _id: fixture.adminId },
        update: { $set: { usernameNormalized: 'workerone' } }
      }
    },
    {
      updateOne: {
        filter: { _id: fixture.workerId },
        update: { $set: { usernameNormalized: 'adminone' } }
      }
    }
  ]);
  const manifestPath = await createBackupManifest('execute-test');
  const report = await migrationService().run(runOptions({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupManifestPath: manifestPath
  }));

  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.writePerformed, true);
  assert.equal(report.before.collections.tasks.missingTeamId, 1);
  assert.equal(report.after.collections.tasks.missingTeamId, 0);
  assert.equal(report.after.collections.tasks.missingOrgUnitId, 0);
  assert.equal(report.after.anomalies.blockerCount, 0);
  assert.equal(report.actualModifications.projectTeamsCreated, 1);
  assert.equal(report.actualModifications.rootOrgUnitsCreated, 1);
  assert.equal(report.actualModifications.membershipsCreated, 2);
  assert.equal(report.actualModifications.embeddedAttachmentFilesMoved, 0);

  const admin = await mongoose.connection.db.collection(COLLECTIONS.users)
    .findOne({ _id: fixture.adminId });
  const worker = await mongoose.connection.db.collection(COLLECTIONS.users)
    .findOne({ _id: fixture.workerId });
  assert.equal(admin.usernameNormalized, 'adminone');
  assert.equal(admin.isSuperAdmin, true);
  assert.equal(admin.tokenVersion, 0);
  assert.equal(worker.usernameNormalized, 'workerone');
  assert.equal(worker.isSuperAdmin, false);
  assert.equal(worker.tokenVersion, 0);

  const adminMembership = await mongoose.connection.db.collection(COLLECTIONS.teammemberships)
    .findOne({ userId: fixture.adminId });
  const workerMembership = await mongoose.connection.db.collection(COLLECTIONS.teammemberships)
    .findOne({ userId: fixture.workerId });
  assert.equal(adminMembership.role, 'PROJECT_ADMIN');
  assert.deepEqual(adminMembership.permissionKeys, [...ROLE_PERMISSION_MAP.admin].sort());
  assert.equal(workerMembership.role, 'MEMBER');
  assert.deepEqual(
    workerMembership.permissionKeys,
    [...new Set([...ROLE_PERMISSION_MAP.executor, ...ROLE_PERMISSION_MAP.cc])].sort()
  );

  for (const collection of [
    COLLECTIONS.tasks,
    COLLECTIONS.taskreviews,
    COLLECTIONS.extensionrequests,
    COLLECTIONS.messages,
    COLLECTIONS.fileassets
  ]) {
    const documents = await mongoose.connection.db.collection(collection).find({}).toArray();
    assert.ok(documents.length > 0);
    assert.ok(documents.every((document) => document.teamId.equals(fixture.plannedTeamId)));
  }
  const task = await mongoose.connection.db.collection(COLLECTIONS.tasks)
    .findOne({ _id: fixture.taskId });
  assert.ok(task.orgUnitId.equals(fixture.plannedRootOrgId));

  const audit = await mongoose.connection.db.collection(COLLECTIONS.auditlogs).findOne({});
  assert.equal(audit.actorRole, 'SYSTEM');
  assert.equal(audit.actorMode, 'SYSTEM');
  assert.equal(audit.action, 'IMPORT');
  assert.equal(audit.resourceType, 'SYSTEM');
  assert.ok(audit.targetTeamId.equals(fixture.plannedTeamId));
});

test('rerunning execute is idempotent for tenant state and records a separate import audit', async () => {
  const manifestPath = await createBackupManifest('idempotency-test');
  const options = runOptions({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupManifestPath: manifestPath
  });
  const first = await migrationService().run(options);
  const second = await migrationService().run(options);

  assert.equal(first.status, 'EXECUTED');
  assert.equal(second.status, 'EXECUTED');
  assert.equal(second.plan.changes.projectTeamsCreated, 0);
  assert.equal(second.plan.changes.rootOrgUnitsCreated, 0);
  assert.equal(second.plan.changes.usersUpdated, 0);
  assert.equal(second.plan.changes.membershipsCreated, 0);
  assert.equal(second.plan.changes.membershipsUpdated, 0);
  assert.equal(second.plan.changes.tasksTeamIdBackfilled, 0);
  assert.equal(second.actualModifications.usersUpdated, 0);
  assert.equal(second.actualModifications.membershipsCreated, 0);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 1);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.orgunits).countDocuments(), 1);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.teammemberships).countDocuments(), 2);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.auditlogs).countDocuments(), 2);
});

test('other-team data and orphan references are blocking anomalies', async () => {
  const otherTeamId = objectId();
  await mongoose.connection.db.collection(COLLECTIONS.tasks).updateOne(
    { _id: fixture.taskId },
    { $set: { teamId: otherTeamId } }
  );
  await mongoose.connection.db.collection(COLLECTIONS.taskreviews).updateOne(
    { _id: fixture.reviewId },
    { $set: { reviewer: objectId() } }
  );

  const report = await migrationService().run(runOptions());
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.collections.tasks.otherTeamId, 1);
  assert.ok(report.before.anomalies.counts.OTHER_TEAM_ID_PRESENT >= 1);
  assert.ok(report.before.anomalies.counts.ORPHAN_USER_REFERENCE >= 1);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 0);
});

test('verified backup count mismatch blocks execute and is reconciled in the report', async () => {
  const manifestPath = await createBackupManifest('backup-count-test', { tasks: 999 });
  const report = await migrationService().run(runOptions({
    execute: true,
    confirmDatabase: TEST_DATABASE_NAME,
    backupManifestPath: manifestPath
  }));

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.writePerformed, false);
  assert.deepEqual(report.before.backupComparison.tasks, {
    backupCount: 999,
    currentCount: 1,
    matches: false
  });
  assert.equal(report.before.anomalies.counts.BACKUP_DOCUMENT_COUNT_MISMATCH, 1);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.auditlogs).countDocuments(), 0);
});

test('execute rejects a backup file changed after the manifest was created', async () => {
  const manifestPath = await createBackupManifest('backup-hash-test');
  await fs.promises.appendFile(path.join(path.dirname(manifestPath), 'tasks.bson'), 'tampered');

  await assert.rejects(
    migrationService().run(runOptions({
      execute: true,
      confirmDatabase: TEST_DATABASE_NAME,
      backupManifestPath: manifestPath
    })),
    (error) => ['BACKUP_FILE_SIZE_MISMATCH', 'BACKUP_FILE_HASH_MISMATCH'].includes(error.code)
  );
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.projectteams).countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection(COLLECTIONS.auditlogs).countDocuments(), 0);
});
