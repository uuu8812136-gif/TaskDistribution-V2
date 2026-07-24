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
const OrgUnit = require('../../../app/models/OrgUnit');
const ProductionSchedule = require('../../../app/models/ProductionSchedule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  TARGETS,
  createAcceptanceJuly2026DataRepairService
} = require('../../../app/services/acceptanceJuly2026DataRepairService');

const DATABASE_NAME = 'acceptance_july_2026_repair_v2_test';
const MODELS = [
  AttendanceDailyReview,
  AttendanceSubmission,
  AuditLog,
  GeneratedDailyReport,
  OrgUnit,
  ProductionSchedule,
  ProjectTeam,
  User
];
let replicaSet;
let fixture;

function oid(value) {
  return value ? new mongoose.Types.ObjectId(value) : new mongoose.Types.ObjectId();
}

function named(count = 0, names = []) {
  return { count, names };
}

function shift(actualAttendanceCount) {
  return {
    actualAttendanceCount,
    leave: named(),
    rest: named(),
    sickLeave: named(),
    absenteeism: named(),
    notYetEmployed: named(),
    pendingDeparture: named()
  };
}

function dailyEntry(date, value) {
  return {
    date,
    aLineDay: value,
    aLineNight: null,
    northLine: null,
    transferCaseLine: null,
    bLineDay: null,
    bLineNight: null
  };
}

async function createEmptyCollections() {
  for (const Model of MODELS) await Model.createCollection();
  await mongoose.connection.db.createCollection('authsessions');
}

async function seed() {
  const createdAt = new Date('2026-07-24T01:00:00.000Z');
  const reviewerId = oid();
  const teamId = oid();
  const rootOrgUnitId = oid();
  const secondOrgUnitId = oid();
  const thirdOrgUnitId = oid();
  const secondSubmissionId = oid();

  await User.collection.insertOne({
    _id: reviewerId,
    username: 'acceptance-reviewer',
    usernameNormalized: 'acceptance-reviewer',
    password: 'unused-hash',
    name: '验收审核员',
    roles: [],
    isSuperAdmin: false,
    isSystemAccount: false,
    tokenVersion: 0,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    __v: 0
  });
  await ProjectTeam.collection.insertOne({
    _id: teamId,
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    status: permissions.TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: reviewerId,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  });
  await OrgUnit.collection.insertMany([
    {
      _id: rootOrgUnitId,
      teamId,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'DEPARTMENT',
      name: '变速箱物流部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      referenceRevision: 0,
      leadershipRevision: 0,
      level: 1,
      path: '/',
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: secondOrgUnitId,
      teamId,
      parentId: rootOrgUnitId,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'WAREHOUSE_TWO',
      name: '仓配二分部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      referenceRevision: 0,
      leadershipRevision: 0,
      level: 2,
      path: `/${rootOrgUnitId}/`,
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: thirdOrgUnitId,
      teamId,
      parentId: rootOrgUnitId,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'WAREHOUSE_THREE',
      name: '仓配三分部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 2,
      referenceRevision: 0,
      leadershipRevision: 0,
      level: 2,
      path: `/${rootOrgUnitId}/`,
      deletedAt: null,
      deletedBy: null,
      deletionReason: null,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    }
  ]);

  const entries = [
    dailyEntry('2026-07-23', 20),
    dailyEntry('2026-07-24', 30)
  ];
  const juneCanonicalEntries = [
    dailyEntry('2026-06-23', 240),
    dailyEntry('2026-06-24', 239)
  ];
  const juneDuplicateEntries = juneCanonicalEntries.map((entry) => ({
    ...entry,
    aLineNight: 0,
    northLine: 0,
    transferCaseLine: 0,
    bLineDay: 0,
    bLineNight: 0
  }));
  await ProductionSchedule.collection.insertMany([
    {
      _id: oid(TARGETS.juneCanonicalScheduleId),
      teamId,
      orgUnitId: rootOrgUnitId,
      month: TARGETS.juneMonth,
      dailyEntries: juneCanonicalEntries,
      productionPlanForecast: TARGETS.juneCanonicalProductionPlanForecast,
      monthlyTotals: TARGETS.juneCanonicalMonthlyTotals,
      createdBy: reviewerId,
      updatedBy: reviewerId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: oid(TARGETS.juneDuplicateScheduleId),
      teamId,
      orgUnitId: secondOrgUnitId,
      month: TARGETS.juneMonth,
      dailyEntries: juneDuplicateEntries,
      productionPlanForecast: null,
      monthlyTotals: {
        aLine: null,
        northLine: null,
        transferCaseLine: null,
        bLineDay: null,
        bLineNight: null
      },
      createdBy: reviewerId,
      updatedBy: reviewerId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: oid(TARGETS.canonicalScheduleId),
      teamId,
      orgUnitId: rootOrgUnitId,
      month: TARGETS.month,
      dailyEntries: entries,
      productionPlanForecast: 1000,
      monthlyTotals: {
        aLine: 1000,
        northLine: null,
        transferCaseLine: null,
        bLineDay: null,
        bLineNight: null
      },
      createdBy: reviewerId,
      updatedBy: reviewerId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: oid(TARGETS.duplicateScheduleId),
      teamId,
      orgUnitId: secondOrgUnitId,
      month: TARGETS.month,
      dailyEntries: entries,
      productionPlanForecast: null,
      monthlyTotals: {
        aLine: null,
        northLine: null,
        transferCaseLine: null,
        bLineDay: null,
        bLineNight: null
      },
      createdBy: reviewerId,
      updatedBy: reviewerId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    }
  ]);

  const attendanceBase = {
    teamId,
    reportDate: TARGETS.reportDate,
    authorizedHeadcount: 20,
    registeredHeadcount: 20,
    nightShift: shift(0),
    support: { destination: '', count: 0, names: [] },
    reviewStatus: AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.REVIEWED,
    reviewedAt: createdAt,
    reviewedBy: reviewerId,
    dataQualityStatus: AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.CONFIRMED,
    dataQualityIssues: [],
    source: { type: AttendanceSubmission.ATTENDANCE_SOURCE_TYPES.MANUAL },
    submittedAt: createdAt,
    createdBy: reviewerId,
    updatedBy: reviewerId,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  };
  await AttendanceSubmission.collection.insertMany([
    {
      ...attendanceBase,
      _id: oid(TARGETS.attendanceSubmissionId),
      orgUnitId: secondOrgUnitId,
      dayShift: shift(10),
      otherRemark: TARGETS.sourceRemark
    },
    {
      ...attendanceBase,
      _id: secondSubmissionId,
      orgUnitId: thirdOrgUnitId,
      dayShift: shift(8),
      otherRemark: ''
    }
  ]);
  await AttendanceDailyReview.collection.insertOne({
    _id: oid(TARGETS.attendanceDailyReviewId),
    teamId,
    reportDate: TARGETS.reportDate,
    expectedOrgUnitIds: [secondOrgUnitId, thirdOrgUnitId],
    submissionIds: [oid(TARGETS.attendanceSubmissionId), secondSubmissionId],
    summarySnapshot: { legacy: true, doubledSchedule: true },
    finalText: 'legacy doubled schedule text',
    reviewedBy: reviewerId,
    reviewedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  });
  return {
    reviewerId,
    teamId,
    rootOrgUnitId,
    secondOrgUnitId,
    thirdOrgUnitId,
    secondSubmissionId
  };
}

async function completeBackupVerifier() {
  const names = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
  const collections = [];
  for (const name of names) {
    collections.push({
      name,
      documentCount: await mongoose.connection.db.collection(name).countDocuments({})
    });
  }
  return {
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-july-repair-backup'),
    manifestSha256: 'b'.repeat(64),
    manifest: {
      backupId: 'backup-20990101T000000Z-12345678',
      completedAt: '2099-01-01T00:00:00.000Z',
      database: {
        name: DATABASE_NAME,
        collectionCount: collections.length,
        collections
      },
      uploads: { fileCount: 0, bytes: 0 },
      consistency: {
        restoreSet: 'database-and-uploads',
        databaseFileAssetsVerifiedAgainstUploadBytes: true
      },
      files: collections.map(({ name }) => ({
        file: `database/${DATABASE_NAME}/${name}.bson`
      }))
    }
  };
}

function service(options = {}) {
  return createAcceptanceJuly2026DataRepairService({
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
  await createEmptyCollections();
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('dry-run identifies exactly four writes and does not mutate acceptance data', async () => {
  const beforeHashes = {
    schedules: JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean()),
    submissions: JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()),
    reviews: JSON.stringify(await AttendanceDailyReview.find({}).sort({ _id: 1 }).lean())
  };
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_READY');
  assert.equal(report.writePerformed, false);
  assert.equal(report.before.plannedWriteCount, 4);
  assert.equal(report.before.plannedAuditCount, 4);
  assert.equal(report.before.blockerCount, 0);
  assert.deepEqual(report.before.operations.map(({ type }) => type), [
    'DELETE_DUPLICATE_JUNE_PRODUCTION_SCHEDULE',
    'DELETE_DUPLICATE_PRODUCTION_SCHEDULE',
    'MIGRATE_TEMPORARY_WORKER_ATTENDANCE',
    'RECOMPUTE_ATTENDANCE_DAILY_REVIEW'
  ]);
  assert.deepEqual({
    schedules: JSON.stringify(await ProductionSchedule.find({}).sort({ _id: 1 }).lean()),
    submissions: JSON.stringify(await AttendanceSubmission.find({}).sort({ _id: 1 }).lean()),
    reviews: JSON.stringify(await AttendanceDailyReview.find({}).sort({ _id: 1 }).lean())
  }, beforeHashes);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('execute repairs all fixed records transactionally and the second dry-run is a zero-write no-op', async () => {
  const report = await service().run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-july-repair-backup')
  });
  assert.equal(report.status, 'EXECUTED');
  assert.equal(report.writePerformed, true);
  assert.equal(report.dataWrites, 4);
  assert.equal(report.auditLogsCreated, 4);
  assert.equal(report.after.state, 'ALREADY_APPLIED');
  assert.equal(report.after.plannedWriteCount, 0);

  assert.equal(await ProductionSchedule.countDocuments({}), 2);
  assert.equal(await ProductionSchedule.countDocuments({
    _id: oid(TARGETS.duplicateScheduleId)
  }), 0);
  assert.equal(await ProductionSchedule.countDocuments({
    _id: oid(TARGETS.juneDuplicateScheduleId)
  }), 0);
  const canonical = await ProductionSchedule.findById(TARGETS.canonicalScheduleId).lean();
  assert.equal(String(canonical.orgUnitId), String(fixture.rootOrgUnitId));

  const submission = await AttendanceSubmission.findById(TARGETS.attendanceSubmissionId).lean();
  assert.equal(submission.otherRemark, '');
  assert.deepEqual(submission.dayShift.temporaryWorker, { count: 2, names: [] });
  assert.deepEqual(submission.nightShift.temporaryWorker, { count: 0, names: [] });

  const review = await AttendanceDailyReview.findById(TARGETS.attendanceDailyReviewId).lean();
  assert.equal(review.summarySnapshot.dayShift.temporaryWorker.count, 2);
  assert.equal(review.summarySnapshot.nightShift.temporaryWorker.count, 0);
  assert.equal(review.summarySnapshot.dayShift.actualAttendanceCount, 20);
  assert.deepEqual(review.summarySnapshot.otherRemarks, []);
  assert.match(review.finalText, /临时工2人/);
  assert.match(review.finalText, /今日白班安排出勤\d+人，夜班安排出勤0人/);
  assert.equal(review.finalText.includes('legacy doubled schedule text'), false);

  const audits = await AuditLog.find({}).sort({ createdAt: 1 }).lean();
  assert.equal(audits.length, 4);
  assert.deepEqual(new Set(audits.map(({ resourceType }) => resourceType)), new Set([
    permissions.AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
    permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION,
    permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW
  ]));
  for (const audit of audits) {
    assert.match(audit.before.sha256, /^[a-f0-9]{64}$/);
    assert.match(audit.after.sha256, /^[a-f0-9]{64}$/);
  }

  const repeated = await service().run();
  assert.equal(repeated.status, 'DRY_RUN_NO_CHANGES');
  assert.equal(repeated.before.state, 'ALREADY_APPLIED');
  assert.equal(repeated.before.plannedWriteCount, 0);
  assert.equal(repeated.writePerformed, false);
  assert.equal(await AuditLog.countDocuments({}), 4);
});

test('any unrelated teamId + month conflict blocks the fixed migration', async () => {
  const otherTeamId = oid();
  const otherOrgOne = oid();
  const otherOrgTwo = oid();
  await ProductionSchedule.collection.insertMany([
    {
      _id: oid(),
      teamId: otherTeamId,
      orgUnitId: otherOrgOne,
      month: '2026-08',
      dailyEntries: [],
      productionPlanForecast: null,
      monthlyTotals: {},
      createdBy: fixture.reviewerId,
      updatedBy: fixture.reviewerId,
      __v: 0
    },
    {
      _id: oid(),
      teamId: otherTeamId,
      orgUnitId: otherOrgTwo,
      month: '2026-08',
      dailyEntries: [],
      productionPlanForecast: null,
      monthlyTotals: {},
      createdBy: fixture.reviewerId,
      updatedBy: fixture.reviewerId,
      __v: 0
    }
  ]);
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.plannedWriteCount, 0);
  assert.ok(report.before.blockers.some(({ code }) => code === 'UNEXPECTED_TEAM_MONTH_SCHEDULE_CONFLICT'));
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('an existing generated daily report blocks migration instead of being overwritten', async () => {
  await GeneratedDailyReport.collection.insertOne({
    _id: oid(),
    teamId: fixture.teamId,
    reportDate: TARGETS.reportDate,
    version: 1,
    finalText: 'existing',
    sourceFingerprint: 'a'.repeat(64),
    sourceSnapshot: {},
    ruleVersion: 'existing',
    generatedBy: fixture.reviewerId,
    generatedByName: '验收审核员',
    generatedAt: new Date(),
    versions: [],
    __v: 0
  });
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.generatedDailyReportCount, 1);
  assert.ok(report.before.blockers.some(({ code }) => code === 'GENERATED_DAILY_REPORT_EXISTS'));
  assert.equal(await GeneratedDailyReport.countDocuments({}), 1);
});

test('a changed fixed duplicate is a blocker and is never guessed or merged', async () => {
  await ProductionSchedule.collection.updateOne({
    _id: oid(TARGETS.duplicateScheduleId)
  }, {
    $set: { productionPlanForecast: 1 }
  });
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.plannedWriteCount, 0);
  assert.ok(report.before.blockers.some(({ code }) => code === 'DUPLICATE_SCHEDULE_FORECAST_NOT_EMPTY'));
  assert.equal(await ProductionSchedule.countDocuments({}), 4);
  assert.equal((await AttendanceSubmission.findById(TARGETS.attendanceSubmissionId).lean()).otherRemark, TARGETS.sourceRemark);
});

test('a changed fixed June duplicate blocks migration instead of being deleted', async () => {
  await ProductionSchedule.collection.updateOne({
    _id: oid(TARGETS.juneDuplicateScheduleId)
  }, {
    $set: { 'dailyEntries.0.aLineDay': 241 }
  });
  const report = await service().run();
  assert.equal(report.status, 'DRY_RUN_BLOCKED');
  assert.equal(report.before.plannedWriteCount, 0);
  assert.ok(report.before.blockers.some(({ code }) => code === 'JUNE_DUPLICATE_SCHEDULE_DAILY_VALUES_DIFFER'));
  assert.equal(await ProductionSchedule.countDocuments({}), 4);
  assert.equal(await ProductionSchedule.countDocuments({
    _id: oid(TARGETS.juneDuplicateScheduleId)
  }), 1);
  assert.equal((await AttendanceSubmission.findById(TARGETS.attendanceSubmissionId).lean()).otherRemark, TARGETS.sourceRemark);
});

test('an audit failure rolls back all four business mutations', async () => {
  let auditCalls = 0;
  const failingAuditService = {
    async recordSystem() {
      auditCalls += 1;
      if (auditCalls === 2) throw new Error('simulated audit persistence failure');
    }
  };
  await assert.rejects(service({ auditService: failingAuditService }).run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-july-repair-backup')
  }), /simulated audit persistence failure/);
  assert.equal(await ProductionSchedule.countDocuments({}), 4);
  const submission = await AttendanceSubmission.findById(TARGETS.attendanceSubmissionId).lean();
  assert.equal(submission.otherRemark, TARGETS.sourceRemark);
  assert.equal(submission.dayShift.temporaryWorker?.count || 0, 0);
  const review = await AttendanceDailyReview.findById(TARGETS.attendanceDailyReviewId).lean();
  assert.deepEqual(review.summarySnapshot, { legacy: true, doubledSchedule: true });
  assert.equal(review.finalText, 'legacy doubled schedule text');
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('execute is denied outside the exact acceptance database allowlist', async () => {
  const denied = createAcceptanceJuly2026DataRepairService({
    connection: mongoose.connection,
    backupVerifier: completeBackupVerifier
  });
  await assert.rejects(denied.run({
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-july-repair-backup')
  }), (error) => error.code === 'EXECUTION_DATABASE_FORBIDDEN');
});
