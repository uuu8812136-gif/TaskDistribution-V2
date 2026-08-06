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
const ProductionSchedule = require('../../../app/models/ProductionSchedule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const permissions = require('../../../app/config/permissions');
const {
  TARGET,
  createAttendanceProductionCumulativeCorrectionService,
  expectedMonths
} = require('../../../app/services/attendanceProductionCumulativeCorrectionService');

const DATABASE_NAME = 'attendance_production_cumulative_correction_v2_test';
const MODELS = [
  AttendanceDailyReview,
  AttendanceSubmission,
  AuditLog,
  GeneratedDailyReport,
  ProductionSchedule,
  ProjectTeam
];
let replicaSet;
let fixture;

function oid(value) {
  return value ? new mongoose.Types.ObjectId(value) : new mongoose.Types.ObjectId();
}

function monthlyTotals(total) {
  return {
    aLine: total,
    northLine: 0,
    transferCaseLine: 0,
    bLineDay: 0,
    bLineNight: 0
  };
}

async function createCollections() {
  for (const Model of MODELS) await Model.createCollection();
  await mongoose.connection.db.createCollection('authsessions');
}

function scheduleTotals(year) {
  const firstHalf = year === TARGET.previousYear
    ? TARGET.previousYearFirstHalfTotal
    : TARGET.currentYearFirstHalfTotal;
  const july = year === TARGET.previousYear
    ? TARGET.previousYearJulyTotal
    : TARGET.currentYearJulyTotal;
  return [firstHalf, 0, 0, 0, 0, 0, july];
}

async function seed() {
  const now = new Date('2026-08-06T00:55:00.000Z');
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
    registeredHeadcount: index === 0 ? 124 : 0,
    dayShift: {},
    nightShift: {},
    status: 'REVIEWED',
    createdAt: now,
    updatedAt: now,
    __v: 0
  })));
  const productionSchedules = [];
  for (const year of [TARGET.previousYear, TARGET.currentYear]) {
    expectedMonths(year).forEach((month, index) => {
      productionSchedules.push({
        _id: oid(),
        teamId,
        month,
        productionPlanForecast: 0,
        dailyEntries: [],
        monthlyTotals: monthlyTotals(scheduleTotals(year)[index]),
        createdAt: now,
        updatedAt: now,
        __v: 0
      });
    });
  }
  await ProductionSchedule.collection.insertMany(productionSchedules);

  const finalText = [
    '8月6日变速箱物流部生产日报',
    '1.本月生产计划10000台。',
    TARGET.oldLine,
    '5.人员情况:在册人数124人，待离职3人。',
    '提报人:李静'
  ].join('\n');
  await AttendanceDailyReview.collection.insertOne({
    _id: oid(TARGET.reviewId),
    teamId,
    reportDate: TARGET.reportDate,
    expectedOrgUnitIds: Array.from({ length: TARGET.submissionCount }, () => oid()),
    submissionIds,
    summarySnapshot: { registeredHeadcount: 124, marker: 'preserve-this-snapshot' },
    finalText,
    reviewedBy: reviewerId,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    __v: 3
  });
  return { teamId, submissionIds, productionSchedules, finalText };
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
      backupId: 'backup-20260806T010000Z-12345678',
      completedAt: '2026-08-06T01:00:00.000Z',
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
  return createAttendanceProductionCumulativeCorrectionService({
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

test('dry-run verifies the exact January-July sources without changing customer data', async () => {
  const reviewBefore = JSON.stringify(await AttendanceDailyReview.findById(TARGET.reviewId).lean());
  const submissionsBefore = JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean());
  const schedulesBefore = JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean());
  const report = await service().run();

  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.state, 'READY');
  assert.equal(report.before.plannedWriteCount, 1);
  assert.equal(report.before.plannedAuditCount, 1);
  assert.equal(report.before.blockerCount, 0);
  assert.equal(report.before.target.previousProduction.cumulativeTotal, 64110);
  assert.equal(report.before.target.currentProduction.cumulativeTotal, 96137);
  assert.equal(JSON.stringify(await AttendanceDailyReview.findById(TARGET.reviewId).lean()), reviewBefore);
  assert.equal(JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()), submissionsBefore);
  assert.equal(JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean()), schedulesBefore);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('execute changes only finalText metadata, writes one system audit, and is idempotent', async () => {
  const original = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  const submissionsBefore = JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean());
  const schedulesBefore = JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean());
  const report = await service().run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: path.resolve(os.tmpdir(), 'attendance-production-cumulative-correction-backup')
  });

  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.dataWrites, 1);
  assert.equal(report.auditLogsCreated, 1);
  assert.equal(report.after.state, 'ALREADY_APPLIED');
  const corrected = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  assert.equal(corrected.finalText.includes(TARGET.oldLine), false);
  assert.equal(corrected.finalText.includes(TARGET.correctedLine), true);
  assert.deepEqual(corrected.summarySnapshot, original.summarySnapshot);
  assert.deepEqual(corrected.submissionIds, original.submissionIds);
  assert.equal(corrected.reviewedAt.toISOString(), original.reviewedAt.toISOString());
  assert.equal(corrected.__v, original.__v + 1);
  assert.equal(JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()), submissionsBefore);
  assert.equal(JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean()), schedulesBefore);

  const audit = await AuditLog.findOne({}).lean();
  assert.equal(audit.actorRole, permissions.AUDIT_ACTOR_ROLES.SYSTEM);
  assert.equal(audit.action, permissions.AUDIT_ACTIONS.CORRECT);
  assert.equal(audit.resourceType, permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW);
  assert.equal(audit.resourceId, TARGET.reviewId);
  assert.equal(String(audit.targetTeamId), String(fixture.teamId));
  assert.equal(audit.before.value.finalText, fixture.finalText);
  assert.equal(audit.after.value.finalText.includes(TARGET.correctedLine), true);

  const repeated = await service().run({
    execute: true,
    confirmDatabase: DATABASE_NAME
  });
  assert.equal(repeated.status, 'NO_CHANGES');
  assert.equal(repeated.writePerformed, false);
  assert.equal(repeated.dataWrites, 0);
  assert.equal(await AuditLog.countDocuments({}), 1);
});

test('a changed July production source blocks correction before any write', async () => {
  await ProductionSchedule.collection.updateOne({
    teamId: fixture.teamId,
    month: '2026-07'
  }, {
    $inc: { 'monthlyTotals.aLine': 1, __v: 1 }
  });
  const before = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.blockers.some(({ code }) => code === 'PRODUCTION_TOTALS_MISMATCH'), true);
  assert.deepEqual(await AttendanceDailyReview.findById(TARGET.reviewId).lean(), before);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('a complete finalText change between backup and transaction fails before correction', async () => {
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
      backupDirectory: path.resolve(os.tmpdir(), 'attendance-production-cumulative-stale-backup')
    }),
    (error) => error.code === 'TARGET_STATE_CHANGED_BEFORE_EXECUTION'
  );
  const review = await AttendanceDailyReview.findById(TARGET.reviewId).lean();
  assert.equal(review.finalText, 'concurrent replacement');
  assert.equal(await AuditLog.countDocuments({}), 0);
});
