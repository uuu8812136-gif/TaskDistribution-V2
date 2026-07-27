'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const AttendanceDailyReview = require('../../../app/models/AttendanceDailyReview');
const AttendanceSubmission = require('../../../app/models/AttendanceSubmission');
const AuditLog = require('../../../app/models/AuditLog');
const GeneratedDailyReport = require('../../../app/models/GeneratedDailyReport');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const permissions = require('../../../app/config/permissions');
const {
  TARGET,
  createAttendancePlannedCorrectionService
} = require('../../../app/services/attendancePlannedCorrectionService');

const DATABASE_NAME = 'attendance_planned_correction_v2_test';
const MODELS = [
  AttendanceDailyReview,
  AttendanceSubmission,
  AuditLog,
  GeneratedDailyReport,
  ProjectTeam
];
let replicaSet;
let fixture;

function oid(value) {
  return value ? new mongoose.Types.ObjectId(value) : new mongoose.Types.ObjectId();
}

function named(count = 0, names = []) {
  return { count, names };
}

function summarySnapshot() {
  return {
    registeredHeadcount: 123,
    dayShift: {
      actualAttendanceCount: 124,
      leave: named(3, ['leave-a', 'leave-b', 'leave-c']),
      rest: named(1, ['rest-a']),
      sickLeave: named(),
      absenteeism: named(),
      notYetEmployed: named(2, ['new-a', 'new-b']),
      pendingDeparture: named(4, ['pending-a', 'pending-b', 'pending-c', 'pending-d']),
      temporaryWorker: named(2, ['temp-a', 'temp-b'])
    },
    nightShift: {
      actualAttendanceCount: 0,
      leave: named(),
      rest: named(),
      sickLeave: named(),
      absenteeism: named(),
      notYetEmployed: named(),
      pendingDeparture: named(),
      temporaryWorker: named()
    },
    otherRemarks: []
  };
}

async function createCollections() {
  for (const Model of MODELS) await Model.createCollection();
  for (const name of ['authsessions', 'productionschedules']) {
    await mongoose.connection.db.createCollection(name);
  }
}

async function seed() {
  const now = new Date('2026-07-27T01:33:00.000Z');
  const teamId = oid();
  const reviewerId = oid();
  const submissionIds = Array.from({ length: TARGET.submissionCount }, () => oid());
  await ProjectTeam.collection.insertOne({
    _id: teamId,
    code: TARGET.teamCode,
    name: '变速箱物流部',
    status: permissions.TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: reviewerId,
    createdAt: now,
    updatedAt: now,
    __v: 0
  });
  await AttendanceSubmission.collection.insertMany(submissionIds.map((_id, index) => ({
    _id,
    teamId,
    orgUnitId: oid(),
    reportDate: TARGET.reportDate,
    reporterId: reviewerId,
    reporterName: `reporter-${index}`,
    registeredHeadcount: index === 0 ? 123 : 0,
    dayShift: {},
    nightShift: {},
    status: 'REVIEWED',
    createdAt: now,
    updatedAt: now,
    __v: 0
  })));
  const finalText = [
    '7月27日变速箱物流部生产日报',
    '5.人员情况:在册人数123人，待离职4人。昨日白班安排出勤45人，实际出勤45人，昨日夜班安排出勤0人，实际出勤0人；' +
      TARGET.oldSentence,
    '提报人:李静'
  ].join('\n');
  await AttendanceDailyReview.collection.insertOne({
    _id: oid(TARGET.reviewId),
    teamId,
    reportDate: TARGET.reportDate,
    expectedOrgUnitIds: Array.from({ length: TARGET.submissionCount }, () => oid()),
    submissionIds,
    summarySnapshot: summarySnapshot(),
    finalText,
    reviewedBy: reviewerId,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    __v: 4
  });
  return { teamId, submissionIds, finalText };
}

async function completeBackupVerifier(directory) {
  const entries = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  const collections = [];
  for (const { name } of entries.filter(({ name }) => !name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name))) {
    collections.push({ name, documentCount: await mongoose.connection.db.collection(name).countDocuments({}) });
  }
  return {
    backupDirectory: directory,
    manifestSha256: 'a'.repeat(64),
    manifest: {
      backupId: 'backup-20260727T020000Z-12345678',
      completedAt: '2026-07-27T02:00:00.000Z',
      database: {
        name: DATABASE_NAME,
        collectionCount: collections.length,
        collections
      },
      consistency: {
        restoreSet: 'database-and-uploads',
        databaseFileAssetsVerifiedAgainstUploadBytes: true
      },
      files: collections.map(({ name }) => ({
        file: `database/${DATABASE_NAME}/${name}.bson`,
        sha256: 'b'.repeat(64)
      }))
    }
  };
}

function service(options = {}) {
  return createAttendancePlannedCorrectionService({
    connection: mongoose.connection,
    backupVerifier: completeBackupVerifier,
    allowedExecutionDatabaseNames: [DATABASE_NAME],
    ...options
  });
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000
  });
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await createCollections();
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('dry-run plans one locked-text correction without changing reviews or submissions', async () => {
  const reviewBefore = JSON.stringify(await AttendanceDailyReview.findById(TARGET.reviewId).lean());
  const submissionsBefore = JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean());
  const report = await service().run();

  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.state, 'READY');
  assert.equal(report.before.plannedWriteCount, 1);
  assert.equal(report.before.plannedAuditCount, 1);
  assert.equal(report.before.blockerCount, 0);
  assert.equal(report.before.target.snapshotValues.correctedDayPlanned, 126);
  assert.equal(JSON.stringify(await AttendanceDailyReview.findById(TARGET.reviewId).lean()), reviewBefore);
  assert.equal(JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()), submissionsBefore);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('execute changes only finalText metadata, writes one system audit, and is idempotent', async () => {
  const original = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  const submissionsBefore = JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean());
  const report = await service().run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: path.resolve(os.tmpdir(), 'attendance-planned-correction-backup')
  });

  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.dataWrites, 1);
  assert.equal(report.auditLogsCreated, 1);
  assert.equal(report.after.state, 'ALREADY_APPLIED');
  const corrected = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  assert.equal(corrected.finalText.includes(TARGET.oldSentence), false);
  assert.equal(corrected.finalText.includes(TARGET.correctedSentence), true);
  assert.deepEqual(corrected.summarySnapshot, original.summarySnapshot);
  assert.deepEqual(corrected.submissionIds, original.submissionIds);
  assert.equal(corrected.__v, original.__v + 1);
  assert.equal(JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()), submissionsBefore);

  const audit = await AuditLog.findOne({}).lean();
  assert.equal(audit.actorRole, permissions.AUDIT_ACTOR_ROLES.SYSTEM);
  assert.equal(audit.action, permissions.AUDIT_ACTIONS.CORRECT);
  assert.equal(audit.resourceType, permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW);
  assert.equal(audit.resourceId, TARGET.reviewId);
  assert.equal(String(audit.targetTeamId), String(fixture.teamId));
  assert.equal(audit.before.value.finalText, fixture.finalText);
  assert.equal(audit.after.value.finalText.includes(TARGET.correctedSentence), true);

  const repeated = await service().run({
    execute: true,
    confirmDatabase: DATABASE_NAME
  });
  assert.equal(repeated.status, 'NO_CHANGES');
  assert.equal(repeated.writePerformed, false);
  assert.equal(repeated.dataWrites, 0);
  assert.equal(await AuditLog.countDocuments({}), 1);
});

test('existing generated report blocks correction and leaves the locked review unchanged', async () => {
  await GeneratedDailyReport.collection.insertOne({
    _id: oid(),
    teamId: fixture.teamId,
    reportDate: TARGET.reportDate,
    version: 1,
    finalText: 'already generated',
    createdAt: new Date(),
    updatedAt: new Date()
  });
  const before = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.blockers.some(({ code }) => code === 'GENERATED_DAILY_REPORT_EXISTS'), true);
  assert.deepEqual(await AttendanceDailyReview.findById(TARGET.reviewId).lean(), before);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('a complete finalText change between backup and transaction fails before any correction', async () => {
  const transactionRunner = async (work) => {
    await AttendanceDailyReview.collection.updateOne({ _id: oid(TARGET.reviewId) }, {
      $set: { finalText: 'concurrent replacement' },
      $inc: { __v: 1 }
    });
    return work(null);
  };
  await assert.rejects(
    service({ transactionRunner }).run({
      execute: true,
      confirmDatabase: DATABASE_NAME,
      backupDirectory: path.resolve(os.tmpdir(), 'attendance-planned-correction-stale-backup')
    }),
    (error) => error.code === 'TARGET_STATE_CHANGED_BEFORE_EXECUTION'
  );
  const review = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  assert.equal(review.finalText, 'concurrent replacement');
  assert.equal(await AuditLog.countDocuments({}), 0);
});
