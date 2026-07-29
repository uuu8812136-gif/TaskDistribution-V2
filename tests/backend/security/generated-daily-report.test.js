'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const AttendanceDailyReview = require('../../../app/models/AttendanceDailyReview');
const AttendanceSubmission = require('../../../app/models/AttendanceSubmission');
const GeneratedDailyReport = require('../../../app/models/GeneratedDailyReport');
const ProductionSchedule = require('../../../app/models/ProductionSchedule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  REPORT_RULE_VERSION,
  createGeneratedDailyReportService,
  plannedAttendanceCount,
  shiftNaturalDate
} = require('../../../app/services/generatedDailyReportService');
const {
  naturalDatesForMonth,
  naturalMonthFromDate,
  parseNaturalDate,
  shiftNaturalMonth
} = require('../../../app/services/reportCalendarService');

const TEST_DATABASE_NAME = `generated_daily_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AttendanceDailyReview,
  AttendanceSubmission,
  GeneratedDailyReport,
  ProductionSchedule,
  ProjectTeam,
  User
];

let mongoServer;
let sequence = 0;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({ teamId, orgUnitId, userId, permissionKeys = undefined }) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `generator-${userId}` }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze(permissionKeys || [
      'report.view',
      'report.daily.generate'
    ]),
    moduleDataScopes: Object.freeze({}),
    readOnly: false,
    canAccessBusiness: true
  });
}

function globalReadContext(userId) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'global-reader' }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['report.view']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

function named(count = 0, names = []) {
  return { count, names };
}

function summary(reportDate, overrides = {}) {
  return {
    reportDate,
    submissionCount: 7,
    orgUnitIds: [],
    authorizedHeadcount: 70,
    registeredHeadcount: overrides.registeredHeadcount ?? 70,
    dayShift: {
      actualAttendanceCount: overrides.dayActual ?? 60,
      leave: named(overrides.dayLeave ?? 1),
      rest: named(overrides.dayRest ?? 5),
      sickLeave: named(overrides.daySick ?? 0),
      absenteeism: named(),
      notYetEmployed: named(overrides.dayNotYetEmployed ?? 0),
      pendingDeparture: named(overrides.dayPending ?? 2),
      temporaryWorker: named(
        overrides.dayTemporary ?? 2,
        overrides.dayTemporaryNames || ['临时甲', '临时乙']
      ),
      leaveWithSickCount: (overrides.dayLeave ?? 1) + (overrides.daySick ?? 0)
    },
    nightShift: {
      actualAttendanceCount: overrides.nightActual ?? 2,
      leave: named(overrides.nightLeave ?? 0),
      rest: named(overrides.nightRest ?? 68),
      sickLeave: named(overrides.nightSick ?? 0),
      absenteeism: named(),
      notYetEmployed: named(overrides.nightNotYetEmployed ?? 0),
      pendingDeparture: named(overrides.nightPending ?? 0),
      temporaryWorker: named(overrides.nightTemporary ?? 0),
      leaveWithSickCount: (overrides.nightLeave ?? 0) + (overrides.nightSick ?? 0)
    },
    pendingDepartureCount: (overrides.dayPending ?? 2) + (overrides.nightPending ?? 0),
    support: overrides.support || [
      { destination: '物流技术部', count: 1, names: ['张三'] }
    ],
    otherRemarks: overrides.otherRemarks || [
      { orgUnitId: 'division-1', orgUnitName: '仓配一分部', remark: '客户备注' }
    ],
    dataQuality: { status: 'CONFIRMED', issues: [] }
  };
}

function shiftDocument(reportDate, index, values = {}) {
  const registered = values.registeredHeadcount ?? 10;
  return {
    authorizedHeadcount: registered,
    registeredHeadcount: registered,
    dayShift: {
      actualAttendanceCount: values.dayActual ?? 9,
      leave: named(),
      rest: named(1),
      sickLeave: named(),
      absenteeism: named(),
      notYetEmployed: named(),
      pendingDeparture: named(index === 0 ? 1 : 0)
    },
    nightShift: {
      actualAttendanceCount: 0,
      leave: named(),
      rest: named(registered),
      sickLeave: named(),
      absenteeism: named(),
      notYetEmployed: named(),
      pendingDeparture: named()
    },
    support: { destination: '', count: 0, names: [] },
    reportDate
  };
}

function dailyEntry(date, overrides = {}) {
  return {
    date,
    aLineDay: 1,
    aLineNight: 0,
    northLine: 0,
    transferCaseLine: 0,
    bLineDay: 0,
    bLineNight: 0,
    ...overrides
  };
}

function requiredMonths(reportDate) {
  const parsed = parseNaturalDate(reportDate);
  const currentMonth = naturalMonthFromDate(reportDate);
  const values = [currentMonth, shiftNaturalMonth(currentMonth, -1)];
  for (const year of [parsed.year - 1, parsed.year]) {
    for (let month = 1; month <= 6; month += 1) {
      values.push(`${year}-${String(month).padStart(2, '0')}`);
    }
  }
  return [...new Set(values)].sort();
}

async function seedScenario({ reportDate = '2026-07-15', teamName = '变速箱物流部' } = {}) {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 8)}`;
  const fixture = {
    teamId: objectId(),
    orgUnitId: objectId(),
    generatorId: objectId(),
    reviewerId: objectId(),
    orgUnitIds: Array.from({ length: 7 }, objectId)
  };
  await ProjectTeam.collection.insertOne({
    _id: fixture.teamId,
    code: `DAILY-${suffix}`,
    name: teamName,
    status: permissions.TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: fixture.generatorId
  });
  await User.collection.insertMany([
    {
      _id: fixture.generatorId,
      username: `generator-${suffix}`,
      usernameNormalized: `generator-${suffix}`,
      name: '日报生成员',
      status: 'active'
    },
    {
      _id: fixture.reviewerId,
      username: `reviewer-${suffix}`,
      usernameNormalized: `reviewer-${suffix}`,
      name: '审核员A',
      status: 'active'
    }
  ]);

  const yesterday = shiftNaturalDate(reportDate, -1);
  for (const [date, sourceSummary] of [
    [reportDate, summary(reportDate)],
    [yesterday, summary(yesterday, {
      registeredHeadcount: 69,
      dayActual: 59,
      dayRest: 4,
      dayPending: 1,
      nightActual: 1,
      nightRest: 68,
      support: []
    })]
  ]) {
    const submissionIds = fixture.orgUnitIds.map(() => objectId());
    const reviewedAt = new Date(`${date}T01:00:00.000Z`);
    await AttendanceSubmission.collection.insertMany(submissionIds.map((id, index) => ({
      _id: id,
      teamId: fixture.teamId,
      orgUnitId: fixture.orgUnitIds[index],
      ...shiftDocument(date, index),
      reviewStatus: AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.REVIEWED,
      reviewedAt,
      reviewedBy: fixture.reviewerId,
      dataQualityStatus: 'CONFIRMED',
      dataQualityIssues: [],
      source: { type: 'MANUAL' },
      submittedAt: reviewedAt,
      createdBy: fixture.reviewerId,
      updatedBy: fixture.reviewerId,
      createdAt: reviewedAt,
      updatedAt: reviewedAt
    })));
    sourceSummary.orgUnitIds = fixture.orgUnitIds.map(String);
    await AttendanceDailyReview.collection.insertOne({
      _id: objectId(),
      teamId: fixture.teamId,
      reportDate: date,
      expectedOrgUnitIds: fixture.orgUnitIds,
      submissionIds,
      summarySnapshot: sourceSummary,
      finalText: 'legacy attendance review text is not used as production report source',
      reviewedBy: fixture.reviewerId,
      reviewedAt,
      createdAt: reviewedAt,
      updatedAt: reviewedAt
    });
  }

  const currentMonth = naturalMonthFromDate(reportDate);
  const yesterdayMonth = naturalMonthFromDate(yesterday);
  for (const month of requiredMonths(reportDate)) {
    const dailyEntries = naturalDatesForMonth(month).map((date) => dailyEntry(date));
    if (month === currentMonth) {
      const todayEntry = dailyEntries.find(({ date }) => date === reportDate);
      Object.assign(todayEntry, dailyEntry(reportDate, {
        aLineDay: 10,
        transferCaseLine: 2,
        bLineDay: 20
      }));
    }
    if (month === yesterdayMonth) {
      const yesterdayEntry = dailyEntries.find(({ date }) => date === yesterday);
      Object.assign(yesterdayEntry, dailyEntry(yesterday, {
        aLineDay: 8,
        transferCaseLine: 1,
        bLineDay: 12
      }));
    }
    const updatedAt = new Date(`${month}-01T00:00:00.000Z`);
    await ProductionSchedule.collection.insertOne({
      _id: objectId(),
      teamId: fixture.teamId,
      orgUnitId: fixture.orgUnitId,
      month,
      dailyEntries,
      productionPlanForecast: month === currentMonth ? 12000 : 10000,
      monthlyTotals: {
        aLine: 100,
        northLine: 0,
        transferCaseLine: 0,
        bLineDay: 0,
        bLineNight: 0
      },
      createdBy: fixture.generatorId,
      updatedBy: fixture.generatorId,
      createdAt: updatedAt,
      updatedAt
    });
  }
  fixture.context = teamContext({
    teamId: fixture.teamId,
    orgUnitId: fixture.orgUnitId,
    userId: fixture.generatorId
  });
  fixture.reportDate = reportDate;
  fixture.yesterday = yesterday;
  return fixture;
}

function service(auditEvents = []) {
  let tick = 0;
  return createGeneratedDailyReportService({
    auditService: {
      async record(event) {
        auditEvents.push(event);
        return null;
      }
    },
    clock: () => new Date(Date.UTC(2026, 6, 17, 2, 0, tick++))
  });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryServer.create({ instance: { dbName: TEST_DATABASE_NAME } });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('fixed customer template generates traceable text and copy-safe lines', async () => {
  const fixture = await seedScenario({ teamName: '变速箱物流部\n=HYPERLINK("x")' });
  const events = [];
  const result = await service(events).generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  assert.equal(result.versionCreated, true);
  assert.equal(result.dailyReport.version, 1);
  assert.equal(result.dailyReport.sourceSnapshot.rule.sourceRange, 'D4:D13');
  assert.equal(result.dailyReport.ruleVersion, REPORT_RULE_VERSION);
  assert.equal(REPORT_RULE_VERSION, 'production-daily-text-v4-2026-07-29');
  assert.equal(result.dailyReport.sourceSnapshot.attendance.currentDate.submissions.length, 7);
  assert.ok(result.dailyReport.sourceSnapshot.production.schedules.length >= 12);
  assert.match(result.dailyReport.finalText, /^7月15日变速箱物流部 =HYPERLINK\("x"\)生产日报/m);
  assert.match(result.dailyReport.finalText, /1\.本月生产计划12000台。/);
  assert.match(
    result.dailyReport.finalText,
    /2\.昨日排产计划21台，实际完成21台，本月累计完成34台，上月同期累计完成14台。/
  );
  assert.match(
    result.dailyReport.finalText,
    /3\.今日排产计划32台（A线10台、B线20台、分动器线2台）。/
  );
  assert.match(
    result.dailyReport.finalText,
    /4\.2025年1-6月实际生产600台，2026年1-6月实际生产600台。/
  );
  assert.match(
    result.dailyReport.finalText,
    /5\.人员情况:在册人数70人，待离职2人。昨日白班安排出勤60人，实际出勤59人，昨日夜班安排出勤1人，实际出勤1人；今日白班安排出勤61人，夜班安排出勤2人。/
  );
  assert.match(result.dailyReport.finalText, /①、到物流技术部帮产1人（张三）；/);
  assert.match(result.dailyReport.finalText, /②、临时工2人（临时甲、临时乙）；/);
  assert.match(result.dailyReport.finalText, /③、仓配一分部：客户备注；/);
  assert.match(result.dailyReport.finalText, /④、今日实际出勤62人，请假1人。/);
  assert.match(result.dailyReport.finalText, /提报人:审核员A$/);
  assert.ok(result.dailyReport.finalText.split('\n').every((line) => !/^[=+@-]/.test(line)));
  assert.equal(events.length, 1);
  assert.equal(events[0].resourceType, permissions.AUDIT_RESOURCE_TYPES.GENERATED_DAILY_REPORT);
});

test('planned attendance follows each shift actual plus non-sick leave and absenteeism', () => {
  const source = summary('2026-07-15', {
    registeredHeadcount: 123,
    dayActual: 120,
    dayLeave: 0,
    daySick: 3,
    dayRest: 1,
    dayNotYetEmployed: 2,
    dayTemporary: 2,
    nightActual: 7,
    nightLeave: 0,
    nightSick: 0,
    nightRest: 0,
    nightNotYetEmployed: 1,
    nightTemporary: 0
  });
  assert.equal(plannedAttendanceCount(source, 'dayShift'), 120);
  assert.equal(plannedAttendanceCount(source, 'nightShift'), 7);
});

test('same sources are idempotent under concurrent generation', async () => {
  const fixture = await seedScenario();
  const reportService = service();
  const results = await Promise.all(Array.from({ length: 6 }, () => (
    reportService.generateDailyReport({
      authContext: fixture.context,
      reportDate: fixture.reportDate,
      input: {}
    })
  )));
  assert.equal(await GeneratedDailyReport.countDocuments({ teamId: fixture.teamId }), 1);
  const stored = await GeneratedDailyReport.findOne({ teamId: fixture.teamId }).lean();
  assert.equal(stored.version, 1);
  assert.equal(stored.versions.length, 0);
  assert.equal(results.filter(({ versionCreated }) => versionCreated).length, 1);
  assert.ok(results.every(({ dailyReport }) => dailyReport.version === 1));
});

test('source changes create versions and A to B to A preserves all three versions', async () => {
  const fixture = await seedScenario();
  const reportService = service();
  const first = await reportService.generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  const schedule = await ProductionSchedule.findOne({
    teamId: fixture.teamId,
    month: naturalMonthFromDate(fixture.reportDate)
  }).lean();
  const originalEntries = structuredClone(schedule.dailyEntries);
  const originalUpdatedAt = schedule.updatedAt;
  const changedEntries = structuredClone(schedule.dailyEntries);
  changedEntries.find(({ date }) => date === fixture.reportDate).aLineDay = 11;
  await ProductionSchedule.collection.updateOne(
    { _id: schedule._id },
    { $set: { dailyEntries: changedEntries, updatedAt: new Date('2026-07-17T03:00:00.000Z') } }
  );
  const second = await reportService.generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  await ProductionSchedule.collection.updateOne(
    { _id: schedule._id },
    { $set: { dailyEntries: originalEntries, updatedAt: originalUpdatedAt } }
  );
  const third = await reportService.generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  assert.deepEqual([first.dailyReport.version, second.dailyReport.version, third.dailyReport.version], [1, 2, 3]);
  assert.equal(first.dailyReport.sourceFingerprint, third.dailyReport.sourceFingerprint);
  assert.notEqual(first.dailyReport.sourceFingerprint, second.dailyReport.sourceFingerprint);
  const stored = await GeneratedDailyReport.findOne({ teamId: fixture.teamId }).lean();
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.versions.map(({ version }) => version), [1, 2]);
  assert.equal(stored.versions[0].sourceSnapshot.production.derived.today.total, 32);
  assert.equal(stored.versions[1].sourceSnapshot.production.derived.today.total, 33);
  assert.equal(stored.sourceSnapshot.production.derived.today.total, 32);
  const firstVersion = await reportService.getDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    query: { version: 1 }
  });
  assert.equal(firstVersion.dailyReport.version, 1);
  assert.match(firstVersion.dailyReport.finalText, /今日排产计划32台/);
});

test('missing, unreviewed attendance and missing production sources block generation explicitly', async () => {
  const fixture = await seedScenario();
  const reportService = service();
  await AttendanceDailyReview.collection.deleteOne({
    teamId: fixture.teamId,
    reportDate: fixture.reportDate
  });
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: fixture.context,
      reportDate: fixture.reportDate,
      input: {}
    }),
    (error) => error.code === 'DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED'
  );

  await AttendanceDailyReview.collection.deleteMany({});
  await AttendanceSubmission.collection.deleteMany({});
  const secondFixture = await seedScenario();
  await AttendanceSubmission.collection.updateOne(
    { teamId: secondFixture.teamId, reportDate: secondFixture.reportDate },
    { $set: { reviewStatus: AttendanceSubmission.ATTENDANCE_REVIEW_STATUSES.PENDING_REVIEW } }
  );
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: secondFixture.context,
      reportDate: secondFixture.reportDate,
      input: {}
    }),
    (error) => error.code === 'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING'
  );

  const thirdFixture = await seedScenario();
  await ProductionSchedule.deleteOne({
    teamId: thirdFixture.teamId,
    month: naturalMonthFromDate(thirdFixture.reportDate)
  });
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: thirdFixture.context,
      reportDate: thirdFixture.reportDate,
      input: {}
    }),
    (error) => error.code === 'DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED'
  );
});

test('calendar logic covers month, year and leap-day boundaries', async () => {
  assert.equal(shiftNaturalDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftNaturalDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftNaturalDate('2024-03-01', -1), '2024-02-29');
  for (const reportDate of ['2026-03-01', '2026-01-01', '2024-03-01']) {
    const fixture = await seedScenario({ reportDate });
    const result = await service().generateDailyReport({
      authContext: fixture.context,
      reportDate,
      input: {}
    });
    assert.equal(
      result.dailyReport.sourceSnapshot.production.previousNaturalDate,
      shiftNaturalDate(reportDate, -1)
    );
    assert.equal(
      result.dailyReport.sourceSnapshot.production.derived.actualCompletionSource.sourceDate,
      shiftNaturalDate(reportDate, -1)
    );
    assert.equal(result.dailyReport.version, 1);
  }
});

test('team isolation, global read-only access, fixed permission and custom input rules are enforced', async () => {
  const fixture = await seedScenario();
  const reportService = service();
  await reportService.generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  const otherTeamContext = teamContext({
    teamId: objectId(),
    orgUnitId: objectId(),
    userId: fixture.generatorId
  });
  await assert.rejects(
    reportService.getDailyReport({
      authContext: otherTeamContext,
      reportDate: fixture.reportDate,
      query: {}
    }),
    (error) => error.code === 'DAILY_REPORT_NOT_FOUND'
  );
  const globalResult = await reportService.getDailyReport({
    authContext: globalReadContext(fixture.generatorId),
    requestedTeamId: String(fixture.teamId),
    reportDate: fixture.reportDate,
    query: {}
  });
  assert.equal(globalResult.dailyReport.teamId, String(fixture.teamId));
  const managerResult = await reportService.getDailyReport({
    authContext: teamContext({
      teamId: fixture.teamId,
      orgUnitId: fixture.orgUnitId,
      userId: fixture.generatorId,
      permissionKeys: ['report.view']
    }),
    reportDate: fixture.reportDate,
    query: {}
  });
  assert.equal(managerResult.dailyReport.version, 1);
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: teamContext({
        teamId: fixture.teamId,
        orgUnitId: fixture.orgUnitId,
        userId: fixture.generatorId,
        permissionKeys: ['report.view']
      }),
      reportDate: fixture.reportDate,
      input: {}
    }),
    (error) => error.code === 'PERMISSION_DENIED'
  );
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: fixture.context,
      reportDate: fixture.reportDate,
      input: { finalText: '=client controlled' }
    }),
    (error) => error.code === 'DAILY_REPORT_INPUT_FIXED'
  );
});

test('the bounded root document rejects a changed source after version 50', async () => {
  const fixture = await seedScenario();
  const reportService = service();
  const first = await reportService.generateDailyReport({
    authContext: fixture.context,
    reportDate: fixture.reportDate,
    input: {}
  });
  const prior = Array.from({ length: 49 }, (_, index) => ({
    version: index + 1,
    finalText: first.dailyReport.finalText,
    sourceFingerprint: first.dailyReport.sourceFingerprint,
    sourceSnapshot: first.dailyReport.sourceSnapshot,
    ruleVersion: first.dailyReport.ruleVersion,
    generatedBy: fixture.generatorId,
    generatedByName: '日报生成员',
    generatedAt: new Date('2026-07-17T02:00:00.000Z')
  }));
  await GeneratedDailyReport.collection.updateOne(
    { teamId: fixture.teamId, reportDate: fixture.reportDate },
    {
      $set: {
        version: 50,
        versions: prior,
        sourceFingerprint: 'b'.repeat(64)
      }
    }
  );
  await assert.rejects(
    reportService.generateDailyReport({
      authContext: fixture.context,
      reportDate: fixture.reportDate,
      input: {}
    }),
    (error) => error.code === 'DAILY_REPORT_VERSION_LIMIT_REACHED'
  );
});
