'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const AttendanceDailyReview = require('../../../app/models/AttendanceDailyReview');
const AttendanceSubmission = require('../../../app/models/AttendanceSubmission');
const AuditLog = require('../../../app/models/AuditLog');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const ReportChangeRecord = require('../../../app/models/ReportChangeRecord');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  ACCEPTANCE_TIME_BYPASS_AUDIT_REASON,
  createAttendanceSubmissionService,
  attendanceMonthlyExportRows,
  isAttendanceDeadlineReached,
  plannedAttendanceCount,
  serializeAttendanceSubmission
} = require('../../../app/services/attendanceSubmissionService');

const TEST_DATABASE_NAME = `attendance_workflow_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AttendanceDailyReview,
  AttendanceSubmission,
  AuditLog,
  Message,
  OrgUnit,
  ProjectTeam,
  ReportChangeRecord,
  TeamMembership,
  User
];
const DIVISION_NAMES = Object.freeze([
  '仓配一分部',
  '仓配二分部',
  '仓配三分部',
  '综合管理室-综合组',
  '综合管理室-技术组',
  '现场配送分部',
  '立体库仓配分部'
]);

let replicaSet;
let fixture;
let now;

test('unused all-zero shift has zero planned attendance and serialized records expose effective actuals', () => {
  const emptyNightSummary = {
    registeredHeadcount: 123,
    nightShift: {
      actualAttendanceCount: 0,
      rest: { count: 0 },
      leave: { count: 0 },
      sickLeave: { count: 0 },
      absenteeism: { count: 0 },
      notYetEmployed: { count: 0 },
      pendingDeparture: { count: 0 },
      temporaryWorker: { count: 0 }
    }
  };
  assert.equal(plannedAttendanceCount(emptyNightSummary, 'nightShift'), 0);
  assert.equal(plannedAttendanceCount({
    registeredHeadcount: 123,
    dayShift: {
      actualAttendanceCount: 124,
      rest: { count: 1 },
      notYetEmployed: { count: 2 },
      temporaryWorker: { count: 2 }
    }
  }, 'dayShift'), 126);

  const serialized = serializeAttendanceSubmission({
    _id: objectId(),
    teamId: objectId(),
    orgUnitId: objectId(),
    reportDate: '2026-07-24',
    dayShift: {
      actualAttendanceCount: 122,
      notYetEmployed: { count: 1, names: [] },
      temporaryWorker: { count: 2, names: [] }
    },
    nightShift: {}
  });
  assert.equal(serialized.dayShift.actualAttendanceCount, 122);
  assert.equal(serialized.dayShift.effectiveActualAttendanceCount, 125);
});

function objectId() {
  return new mongoose.Types.ObjectId();
}

function context({ teamId, orgUnitId, userId, functionalRoleKeys, scope, permissions: keys }) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `attendance-${userId}` }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.MEMBER,
      functionalRoleKeys: Object.freeze([...functionalRoleKeys]),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([...keys]),
    moduleDataScopes: Object.freeze({
      [permissions.DATA_SCOPE_MODULES.REPORT_ATTENDANCE]: scope
    }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function reporterContext(index = 0) {
  return context({
    teamId: fixture.team,
    orgUnitId: fixture.divisions[index],
    userId: fixture.reporters[index],
    functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER],
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    permissions: ['report.view', 'report.submit', 'report.review']
  });
}

function officerContext() {
  return context({
    teamId: fixture.team,
    orgUnitId: fixture.root,
    userId: fixture.officer,
    functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER],
    scope: permissions.DATA_SCOPES.TEAM,
    permissions: ['report.view', 'report.submit', 'report.review', 'report.export']
  });
}

function ordinaryContext() {
  return context({
    teamId: fixture.team,
    orgUnitId: fixture.divisions[0],
    userId: fixture.ordinary,
    functionalRoleKeys: [],
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    permissions: ['report.view', 'report.submit', 'report.review']
  });
}

function submissionInput(orgUnitId, registered = 10, overrides = {}) {
  return {
    orgUnitId: String(orgUnitId),
    reportDate: '2026-07-14',
    authorizedHeadcount: registered,
    registeredHeadcount: registered,
    dayShift: {
      actualAttendanceCount: registered - 1,
      leave: { count: 0, names: [] },
      rest: { count: 1, names: [] },
      sickLeave: { count: 0, names: [] },
      absenteeism: { count: 0, names: [] },
      notYetEmployed: { count: 0, names: [] },
      pendingDeparture: { count: 0, names: [] },
      ...(overrides.dayShift || {})
    },
    nightShift: {
      actualAttendanceCount: 0,
      leave: { count: 0, names: [] },
      rest: { count: registered, names: [] },
      sickLeave: { count: 0, names: [] },
      absenteeism: { count: 0, names: [] },
      notYetEmployed: { count: 0, names: [] },
      pendingDeparture: { count: 0, names: [] },
      ...(overrides.nightShift || {})
    },
    support: { destination: '', count: 0, names: [] },
    otherRemark: '',
    ...overrides,
    dayShift: {
      actualAttendanceCount: registered - 1,
      leave: { count: 0, names: [] },
      rest: { count: 1, names: [] },
      sickLeave: { count: 0, names: [] },
      absenteeism: { count: 0, names: [] },
      notYetEmployed: { count: 0, names: [] },
      pendingDeparture: { count: 0, names: [] },
      ...(overrides.dayShift || {})
    },
    nightShift: {
      actualAttendanceCount: 0,
      leave: { count: 0, names: [] },
      rest: { count: registered, names: [] },
      sickLeave: { count: 0, names: [] },
      absenteeism: { count: 0, names: [] },
      notYetEmployed: { count: 0, names: [] },
      pendingDeparture: { count: 0, names: [] },
      ...(overrides.nightShift || {})
    }
  };
}

async function seedFixture() {
  const ids = {
    team: objectId(),
    root: objectId(),
    divisions: DIVISION_NAMES.map(() => objectId()),
    invalidOrgUnits: {
      wrongType: objectId(),
      wrongLevel: objectId(),
      disabled: objectId()
    },
    reporters: DIVISION_NAMES.map(() => objectId()),
    officer: objectId(),
    manager: objectId(),
    ordinary: objectId()
  };
  const users = [
    ...ids.reporters.map((id, index) => ({ id, username: `reporter-${index + 1}`, name: `提报人${index + 1}` })),
    { id: ids.officer, username: 'attendance-officer', name: '部门考勤员' },
    { id: ids.manager, username: 'department-manager', name: '部门经理' },
    { id: ids.ordinary, username: 'ordinary-user', name: '普通员工' }
  ];
  await User.collection.insertMany(users.map((user) => ({
    _id: user.id,
    username: user.username,
    usernameNormalized: user.username,
    password: 'unused',
    name: user.name,
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  })));
  await ProjectTeam.collection.insertOne({
    _id: ids.team,
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    status: permissions.TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: ids.manager
  });
  await OrgUnit.collection.insertOne({
    _id: ids.root,
    teamId: ids.team,
    parentId: null,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: 'DEPARTMENT',
    name: '变速箱物流部',
    status: permissions.ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 0,
    level: 1,
    path: '/'
  });
  await OrgUnit.collection.insertMany(ids.divisions.map((id, index) => ({
    _id: id,
    teamId: ids.team,
    parentId: ids.root,
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: `DIVISION_${index + 1}`,
    name: DIVISION_NAMES[index],
    status: permissions.ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: index + 1,
    level: 2,
    path: `/${ids.root}/`
  })));
  await OrgUnit.collection.insertMany([
    {
      _id: ids.invalidOrgUnits.wrongType,
      teamId: ids.team,
      parentId: ids.root,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'WRONG_TYPE',
      name: '二级班组',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 20,
      level: 2,
      path: `/${ids.root}/`
    },
    {
      _id: ids.invalidOrgUnits.wrongLevel,
      teamId: ids.team,
      parentId: ids.divisions[0],
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'WRONG_LEVEL',
      name: '三级分部',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 21,
      level: 3,
      path: `/${ids.root}/${ids.divisions[0]}/`
    },
    {
      _id: ids.invalidOrgUnits.disabled,
      teamId: ids.team,
      parentId: ids.root,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'DISABLED_DIVISION',
      name: '停用分部',
      status: permissions.ORG_UNIT_STATUSES.DISABLED,
      sortOrder: 22,
      level: 2,
      path: `/${ids.root}/`
    }
  ]);
  const membershipBase = {
    teamId: ids.team,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date('2026-01-01T00:00:00.000Z')
  };
  await TeamMembership.collection.insertMany([
    ...ids.reporters.map((userId, index) => ({
      ...membershipBase,
      userId,
      orgUnitId: ids.divisions[index],
      positionLevel: permissions.POSITION_LEVELS.EMPLOYEE,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER],
      permissionKeys: ['report.view', 'report.submit'],
      moduleDataScopes: []
    })),
    {
      ...membershipBase,
      userId: ids.officer,
      orgUnitId: ids.root,
      positionLevel: permissions.POSITION_LEVELS.EMPLOYEE,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER],
      permissionKeys: ['report.view', 'report.submit', 'report.review'],
      moduleDataScopes: []
    },
    {
      ...membershipBase,
      userId: ids.manager,
      orgUnitId: ids.root,
      positionLevel: permissions.POSITION_LEVELS.DEPARTMENT_MANAGER,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['report.view'],
      moduleDataScopes: []
    },
    {
      ...membershipBase,
      userId: ids.ordinary,
      orgUnitId: ids.divisions[0],
      positionLevel: permissions.POSITION_LEVELS.EMPLOYEE,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: [],
      permissionKeys: ['report.view', 'report.submit'],
      moduleDataScopes: []
    }
  ]);
  return ids;
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  for (const model of [...MODELS].reverse()) await model.collection.deleteMany({});
  fixture = await seedFixture();
  now = new Date('2026-07-14T00:59:59.999Z');
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('reporters overwrite only their division before 09:00 and officers need a late reason', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  assert.equal(isAttendanceDeadlineReached('2026-07-14', now), false);
  const reporter = reporterContext(0);
  const created = await service.createSubmission({
    authContext: reporter,
    input: submissionInput(fixture.divisions[0], 10)
  });
  const overwritten = await service.createSubmission({
    authContext: reporter,
    input: submissionInput(fixture.divisions[0], 12)
  });
  assert.equal(overwritten._id, created._id);
  assert.equal(overwritten.overwritten, true);
  assert.equal(await AttendanceSubmission.countDocuments({}), 1);
  assert.equal((await AttendanceSubmission.findById(created._id).lean()).registeredHeadcount, 12);
  assert.equal(await ReportChangeRecord.countDocuments({ resourceId: created._id }), 2);

  await assert.rejects(service.createSubmission({
    authContext: reporter,
    input: submissionInput(fixture.divisions[1], 10)
  }), (error) => (
    error.code === 'ATTENDANCE_ORG_UNIT_INVALID' &&
    error.message === '所属分部只能选择当前团队已启用的二级分部'
  ));

  now = new Date('2026-07-14T01:00:00.000Z');
  assert.equal(isAttendanceDeadlineReached('2026-07-14', now), true);
  await assert.rejects(service.createSubmission({
    authContext: reporter,
    input: submissionInput(fixture.divisions[0], 13)
  }), (error) => error.code === 'ATTENDANCE_REPORTER_DEADLINE_LOCKED');

  const officer = officerContext();
  await assert.rejects(service.updateSubmission({
    authContext: officer,
    attendanceSubmissionId: created._id,
    input: { registeredHeadcount: 13 }
  }), (error) => error.code === 'ATTENDANCE_LATE_REASON_REQUIRED');
  const corrected = await service.updateSubmission({
    authContext: officer,
    attendanceSubmissionId: created._id,
    input: { registeredHeadcount: 13, reason: '核对考勤表后补正' }
  });
  assert.equal(corrected.registeredHeadcount, 13);
  const change = await ReportChangeRecord.findOne({ resourceId: created._id })
    .sort({ occurredAt: -1 }).lean();
  assert.equal(change.reason, '核对考勤表后补正');
  assert.equal(change.before.registeredHeadcount, 12);
  assert.equal(change.after.registeredHeadcount, 13);

  await assert.rejects(service.createSubmission({
    authContext: ordinaryContext(),
    input: submissionInput(fixture.divisions[0], 10)
  }), (error) => error.code === 'ATTENDANCE_SUBMITTER_ROLE_REQUIRED');
});

test('attendance options and writes accept only active level-2 sub-departments', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  const officer = officerContext();
  const options = await service.listOptions({ authContext: officer });

  assert.deepEqual(options.orgUnits.map(({ _id }) => _id), fixture.divisions.map(String));
  assert.ok(options.orgUnits.every((orgUnit) => (
    orgUnit.status === permissions.ORG_UNIT_STATUSES.ACTIVE &&
    orgUnit.type === permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT &&
    orgUnit.level === 2
  )));

  const invalidOrgUnitIds = [
    fixture.root,
    fixture.invalidOrgUnits.wrongType,
    fixture.invalidOrgUnits.wrongLevel,
    fixture.invalidOrgUnits.disabled
  ];
  const assertInvalidAttendanceOrgUnit = (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'ATTENDANCE_ORG_UNIT_INVALID');
    assert.equal(error.message, '所属分部只能选择当前团队已启用的二级分部');
    return true;
  };

  for (const orgUnitId of invalidOrgUnitIds) {
    await assert.rejects(service.createSubmission({
      authContext: officer,
      input: submissionInput(orgUnitId)
    }), assertInvalidAttendanceOrgUnit);
  }
  assert.equal(await AttendanceSubmission.countDocuments({}), 0);

  const created = await service.createSubmission({
    authContext: officer,
    input: submissionInput(fixture.divisions[0])
  });
  for (const orgUnitId of invalidOrgUnitIds) {
    await assert.rejects(service.updateSubmission({
      authContext: officer,
      attendanceSubmissionId: created._id,
      input: { orgUnitId: String(orgUnitId) }
    }), assertInvalidAttendanceOrgUnit);
  }
  const unchanged = await AttendanceSubmission.findById(created._id).lean();
  assert.equal(String(unchanged.orgUnitId), String(fixture.divisions[0]));
  assert.equal(await ReportChangeRecord.countDocuments({ resourceId: created._id }), 1);
});

test('acceptance test account bypasses date and 09:00 restrictions but keeps permanent locks', async () => {
  now = new Date('2026-07-14T06:00:00.000Z');
  const bypassedUserIds = new Set([
    String(fixture.officer),
    String(fixture.reporters[0])
  ]);
  const service = createAttendanceSubmissionService({
    clock: () => now,
    timeRestrictionBypass: (authContext) => bypassedUserIds.has(String(authContext.userId))
  });

  const options = await service.listOptions({ authContext: officerContext() });
  assert.equal(options.attendancePolicy.deadlineReached, true);
  assert.equal(options.attendancePolicy.timeRestrictionsBypassed, true);
  assert.equal(options.attendancePolicy.lateReasonRequired, false);
  assert.equal(options.attendancePolicy.canCreate, true);

  const officerCreated = await service.createSubmission({
    authContext: officerContext(),
    input: submissionInput(fixture.divisions[0], 13)
  });
  assert.equal(officerCreated.accessPolicy.timeRestrictionsBypassed, true);
  assert.equal(officerCreated.accessPolicy.lateReasonRequired, false);
  const officerChange = await ReportChangeRecord.findOne({ resourceId: officerCreated._id }).lean();
  assert.equal(officerChange.reason, ACCEPTANCE_TIME_BYPASS_AUDIT_REASON);

  const reporterCreated = await service.createSubmission({
    authContext: reporterContext(0),
    input: submissionInput(fixture.divisions[0], 11, { reportDate: '2026-07-13' })
  });
  assert.equal(reporterCreated.reportDate, '2026-07-13');
  assert.equal(reporterCreated.accessPolicy.editable, true);

  await AttendanceDailyReview.collection.insertOne({
    teamId: fixture.team,
    reportDate: '2026-07-12',
    expectedOrgUnitIds: fixture.divisions,
    submissionIds: [],
    summarySnapshot: {},
    finalText: 'locked',
    reviewedBy: fixture.officer,
    reviewedAt: now
  });
  await assert.rejects(service.createSubmission({
    authContext: officerContext(),
    input: submissionInput(fixture.divisions[1], 10, { reportDate: '2026-07-12' })
  }), (error) => error.code === 'ATTENDANCE_SUBMISSION_REVIEWED');
});

test('fixed A:R attendance export preserves 28, 29, 30, and 31-day natural months', () => {
  for (const [month, dayCount] of [
    ['2026-02', 28],
    ['2024-02', 29],
    ['2026-04', 30],
    ['2026-07', 31]
  ]) {
    const rows = attendanceMonthlyExportRows({
      teamName: '变速箱物流部',
      month,
      summaries: []
    });
    assert.equal(rows.length, dayCount + 3);
    assert.equal(rows[2].length, 18);
    assert.ok(rows.slice(3).every((row) => row.length === 18));
  }
});

test('division-scoped reporters cannot export the department A:R attendance workbook', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  const reporter = context({
    teamId: fixture.team,
    orgUnitId: fixture.divisions[0],
    userId: fixture.reporters[0],
    functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER],
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    permissions: ['report.view', 'report.export']
  });
  await assert.rejects(service.exportMonthlySummary({
    authContext: reporter,
    query: { month: '2026-07' }
  }), (error) => error.code === 'ATTENDANCE_TEAM_SCOPE_REQUIRED');
});

test('incomplete review is blocked and sends deduplicated reminders to missing reporters and officer', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  await service.createSubmission({
    authContext: reporterContext(0),
    input: submissionInput(fixture.divisions[0], 10)
  });
  const officer = officerContext();
  await assert.rejects(service.reviewDailySummary({
    authContext: officer,
    reportDate: '2026-07-14'
  }), (error) => error.code === 'ATTENDANCE_DAILY_INCOMPLETE');
  assert.equal(await AttendanceDailyReview.countDocuments({}), 0);
  assert.equal(await Message.countDocuments({ type: 'attendance_missing' }), 7);
  assert.equal(await Message.countDocuments({ recipient: fixture.reporters[0] }), 0);
  assert.equal(await Message.countDocuments({ recipient: fixture.officer }), 1);

  await assert.rejects(service.reviewDailySummary({
    authContext: officer,
    reportDate: '2026-07-14'
  }), (error) => error.code === 'ATTENDANCE_DAILY_INCOMPLETE');
  assert.equal(await Message.countDocuments({ type: 'attendance_missing' }), 7);
  assert.equal(await AttendanceSubmission.countDocuments({ reviewStatus: 'REVIEWED' }), 0);
});

test('concurrent complete review locks all seven rows once, notifies manager, and feeds reviewed-only month summary', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  for (let index = 0; index < fixture.divisions.length; index += 1) {
    await service.createSubmission({
      authContext: reporterContext(index),
      input: submissionInput(fixture.divisions[index], 10, index === 0 ? {
        dayShift: {
          actualAttendanceCount: 122,
          sickLeave: { count: 1, names: ['张三'] },
          leave: { count: 1, names: ['李四'] },
          notYetEmployed: { count: 1, names: ['未入职甲'] },
          temporaryWorker: { count: 2, names: ['临时甲', '临时乙'] }
        },
        support: { destination: '物流技术部', count: 1, names: ['王五'] },
        otherRemark: '客户月报验证'
      } : {
        dayShift: { actualAttendanceCount: 0 }
      })
    });
  }
  const officer = officerContext();
  const legacySubmission = await AttendanceSubmission.findOne({
    orgUnitId: fixture.divisions[1]
  }).lean();
  await AttendanceSubmission.collection.updateOne(
    { _id: legacySubmission._id },
    {
      $unset: {
        'dayShift.temporaryWorker': '',
        'nightShift.temporaryWorker': ''
      }
    }
  );
  const serializedLegacy = await service.getSubmission({
    authContext: officer,
    attendanceSubmissionId: legacySubmission._id
  });
  assert.deepEqual(serializedLegacy.dayShift.temporaryWorker, { count: 0, names: [] });
  assert.deepEqual(serializedLegacy.nightShift.temporaryWorker, { count: 0, names: [] });

  const attempts = await Promise.all(Array.from({ length: 5 }, () => (
    service.reviewDailySummary({
      authContext: officer,
      reportDate: '2026-07-14',
      input: { reason: '七个分部已核对完整' }
    })
  )));
  assert.equal(attempts.filter(({ idempotent }) => idempotent === false).length, 1);
  assert.equal(attempts.filter(({ idempotent }) => idempotent === true).length, 4);
  assert.equal(await AttendanceDailyReview.countDocuments({}), 1);
  assert.equal(await AttendanceSubmission.countDocuments({ reviewStatus: 'REVIEWED' }), 7);
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_REVIEW,
    action: permissions.AUDIT_ACTIONS.APPROVE
  }), 1);
  assert.equal(await Message.countDocuments({
    type: 'attendance_reviewed',
    recipient: fixture.manager
  }), 1);

  const review = await AttendanceDailyReview.findOne({}).lean();
  assert.match(review.finalText, /7月14日变速箱物流部生产日报/);
  assert.match(review.finalText, /在册人数70人/);
  assert.equal(review.summarySnapshot.dayShift.reportedActualAttendanceCount, 122);
  assert.equal(review.summarySnapshot.dayShift.notYetEmployed.count, 1);
  assert.deepEqual(review.summarySnapshot.dayShift.temporaryWorker, {
    count: 2,
    names: ['临时甲', '临时乙']
  });
  assert.equal(review.summarySnapshot.dayShift.actualAttendanceCount, 125);
  assert.deepEqual(review.summarySnapshot.otherRemarks, [{
    orgUnitId: String(fixture.divisions[0]),
    orgUnitName: DIVISION_NAMES[0],
    remark: '客户月报验证'
  }]);
  assert.match(review.finalText, /到物流技术部帮产1人（王五）/);
  assert.match(review.finalText, /临时工2人（临时甲、临时乙）/);
  assert.match(review.finalText, /仓配一分部：客户月报验证/);
  assert.match(review.finalText, /今日白班安排出勤66人，夜班安排出勤0人/);
  assert.match(review.finalText, /今日实际出勤125人，请假2人/);
  assert.match(review.finalText, /提报人:部门考勤员/);
  const daily = await service.getDailySummary({
    authContext: officer,
    query: { date: '2026-07-14' }
  });
  assert.equal(daily.attendanceSummary.review._id, String(review._id));
  assert.equal(daily.attendanceSummary.canReview, false);
  assert.deepEqual(daily.attendanceSummary.otherRemarks, [{
    orgUnitId: String(fixture.divisions[0]),
    orgUnitName: DIVISION_NAMES[0],
    remark: '客户月报验证'
  }]);

  now = new Date('2026-07-14T01:30:00.000Z');
  const first = await AttendanceSubmission.findOne({ orgUnitId: fixture.divisions[0] }).lean();
  await assert.rejects(service.updateSubmission({
    authContext: officer,
    attendanceSubmissionId: first._id,
    input: { registeredHeadcount: 999, reason: '不得修改' }
  }), (error) => error.code === 'ATTENDANCE_SUBMISSION_REVIEWED');
  await assert.rejects(service.createSubmission({
    authContext: officer,
    input: { ...submissionInput(fixture.divisions[0], 999), reason: '不得覆盖' }
  }), (error) => error.code === 'ATTENDANCE_SUBMISSION_REVIEWED');

  const monthly = await service.getMonthlySummary({
    authContext: officer,
    query: { month: '2026-07' }
  });
  assert.equal(monthly.submissionCount, 7);
  assert.equal(monthly.attendanceSummaries.length, 1);
  assert.equal(monthly.attendanceSummaries[0].dayShift.leave.count, 1);
  assert.equal(monthly.attendanceSummaries[0].dayShift.sickLeave.count, 1);
  assert.equal(monthly.attendanceSummaries[0].dayShift.leaveWithSickCount, 2);
  assert.equal(monthly.attendanceSummaries[0].dayShift.reportedActualAttendanceCount, 122);
  assert.equal(monthly.attendanceSummaries[0].dayShift.actualAttendanceCount, 125);
  assert.deepEqual(monthly.attendanceSummaries[0].dayShift.temporaryWorker, {
    count: 2,
    names: ['临时甲', '临时乙']
  });
  assert.deepEqual(monthly.attendanceSummaries[0].otherRemarks, [{
    orgUnitId: String(fixture.divisions[0]),
    orgUnitName: DIVISION_NAMES[0],
    remark: '客户月报验证'
  }]);

  const exported = await service.exportMonthlySummary({
    authContext: officer,
    query: { month: '2026-07' }
  });
  assert.equal(exported.dayCount, 31);
  assert.equal(exported.reviewedDateCount, 1);
  assert.equal(exported.submissionCount, 7);
  const workbook = XLSX.read(exported.buffer, { type: 'buffer', cellDates: true });
  const worksheet = workbook.Sheets['出勤月报-部门汇总'];
  assert.equal(worksheet['!ref'], 'A1:R34');
  assert.deepEqual(
    XLSX.utils.sheet_to_json(worksheet, { header: 1, range: 'A3:R3' })[0],
    [
      '日期', '部门', '编制人数', '在册人数',
      '实际出勤', '休班', '请假', '未入职', '待离职', '旷工',
      '实际出勤', '休班', '请假', '未入职', '待离职', '旷工',
      '帮产人员', '其他情况备注'
    ]
  );
  assert.equal(worksheet.E17.v, 125);
  assert.equal(worksheet.G17.v, 2);
  assert.match(worksheet.Q17.v, /物流技术部帮产1人（王五）/);
  assert.equal(worksheet.R17.v, `${DIVISION_NAMES[0]}：客户月报验证`);
  assert.equal(worksheet.C16.v, '');
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_MONTHLY_SUMMARY,
    action: permissions.AUDIT_ACTIONS.EXPORT
  }), 1);

  const repeated = await service.reviewDailySummary({
    authContext: officer,
    reportDate: '2026-07-14'
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(await Message.countDocuments({ type: 'attendance_reviewed' }), 1);
});

test('a division reporter cannot approve a complete department summary', async () => {
  const service = createAttendanceSubmissionService({ clock: () => now });
  await assert.rejects(service.reviewDailySummary({
    authContext: reporterContext(0),
    reportDate: '2026-07-14'
  }), (error) => error.code === 'ATTENDANCE_OFFICER_REQUIRED');
});
