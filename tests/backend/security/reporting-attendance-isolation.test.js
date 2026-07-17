'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const AuditLog = require('../../../app/models/AuditLog');
const AttendanceSubmission = require('../../../app/models/AttendanceSubmission');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const ReportChangeRecord = require('../../../app/models/ReportChangeRecord');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createAttendanceSubmissionService
} = require('../../../app/services/attendanceSubmissionService');

const TEST_DATABASE_NAME = `attendance_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AttendanceSubmission,
  AuditLog,
  OrgUnit,
  ProjectTeam,
  ReportChangeRecord,
  User
];
const REPORT_PERMISSIONS = Object.freeze(['report.view', 'report.submit', 'report.review']);
const FIXED_NOW = new Date('2026-07-14T00:30:00.000Z');

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({
  teamId,
  orgUnitId,
  userId,
  scope = permissions.DATA_SCOPES.TEAM,
  role = permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
}) {
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
      role,
      functionalRoleKeys: Object.freeze([
        scope === permissions.DATA_SCOPES.TEAM
          ? permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_OFFICER
          : permissions.FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER
      ]),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: role === permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
      ? permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN
      : permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: REPORT_PERMISSIONS,
    moduleDataScopes: Object.freeze({
      [permissions.DATA_SCOPE_MODULES.REPORT_ATTENDANCE]: scope
    }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function globalContext(userId) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'attendance-super' }),
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

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA1: objectId(),
    orgA2: objectId(),
    orgB1: objectId(),
    userA: objectId(),
    userB: objectId(),
    superAdmin: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA,
      username: 'attendance-a',
      usernameNormalized: 'attendance-a',
      password: 'unused',
      name: 'Attendance A',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB,
      username: 'attendance-b',
      usernameNormalized: 'attendance-b',
      password: 'unused',
      name: 'Attendance B',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.superAdmin,
      username: 'attendance-super',
      usernameNormalized: 'attendance-super',
      password: 'unused',
      name: 'Attendance Super',
      roles: [],
      isSuperAdmin: true,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'ATTENDANCE_A',
      name: 'Attendance A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    },
    {
      _id: ids.teamB,
      code: 'ATTENDANCE_B',
      name: 'Attendance B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: ids.orgA1,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'A1',
      name: 'A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgA2,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'A2',
      name: 'A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgB1,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'B1',
      name: 'B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  return ids;
}

function attendanceInput(orgUnitId, registeredHeadcount, actualAttendanceCount) {
  return {
    orgUnitId: String(orgUnitId),
    reportDate: '2026-07-14',
    authorizedHeadcount: registeredHeadcount,
    registeredHeadcount,
    dayShift: {
      actualAttendanceCount,
      leave: { count: registeredHeadcount - actualAttendanceCount, names: [] },
      rest: { count: 0, names: [] },
      sickLeave: { count: 0, names: [] },
      absenteeism: { count: 0, names: [] },
      notYetEmployed: { count: 0, names: [] },
      pendingDeparture: { count: 0, names: [] }
    },
    nightShift: { actualAttendanceCount: 0 },
    support: { destination: '', count: 0, names: [] },
    otherRemark: ''
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
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
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('attendance records and summaries enforce team and organization isolation', async () => {
  const service = createAttendanceSubmissionService({ clock: () => FIXED_NOW });
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    role: permissions.MEMBERSHIP_ROLES.MEMBER
  });
  const teamB = teamContext({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB
  });

  const a1 = await service.createSubmission({
    authContext: teamA,
    input: attendanceInput(fixture.orgA1, 12, 11)
  });
  const a2 = await service.createSubmission({
    authContext: teamA,
    input: attendanceInput(fixture.orgA2, 15, 15)
  });
  await service.createSubmission({
    authContext: teamB,
    input: attendanceInput(fixture.orgB1, 99, 99)
  });

  const orgList = await service.listSubmissions({ authContext: orgA1 });
  assert.deepEqual(orgList.attendanceSubmissions.map(({ _id }) => _id), [a1._id]);
  await assert.rejects(
    service.getSubmission({ authContext: orgA1, attendanceSubmissionId: a2._id }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service.updateSubmission({
      authContext: orgA1,
      attendanceSubmissionId: a2._id,
      input: { registeredHeadcount: 999 }
    }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service.createSubmission({
      authContext: teamA,
      input: { ...attendanceInput(fixture.orgA1, 1, 1), teamId: String(fixture.teamB) }
    }),
    (error) => error.code === 'REPORT_TEAM_ID_IMMUTABLE'
  );

  const daily = await service.getDailySummary({
    authContext: teamA,
    query: { date: '2026-07-14' }
  });
  assert.equal(daily.attendanceSummary.submissionCount, 2);
  assert.equal(daily.attendanceSummary.registeredHeadcount, 27);
  assert.equal(daily.attendanceSummary.dayShift.actualAttendanceCount, 26);
  assert.equal(daily.attendanceSummary.dayShift.leaveWithSickCount, 1);

  const monthly = await service.getMonthlySummary({
    authContext: orgA1,
    query: { month: '2026-07' }
  });
  assert.equal(monthly.submissionCount, 0);
  assert.deepEqual(monthly.attendanceSummaries, []);

  const global = globalContext(fixture.superAdmin);
  await assert.rejects(
    service.listSubmissions({ authContext: global }),
    (error) => error.code === 'REPORT_TEAM_REQUIRED'
  );
  const globalTeamB = await service.listSubmissions({
    authContext: global,
    requestedTeamId: String(fixture.teamB)
  });
  assert.equal(globalTeamB.total, 1);
  assert.equal(globalTeamB.attendanceSubmissions[0].registeredHeadcount, 99);
  await assert.rejects(
    service.createSubmission({
      authContext: global,
      input: attendanceInput(fixture.orgA1, 1, 1)
    }),
    (error) => error.status === 403
  );

  assert.equal(await ReportChangeRecord.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION
  }), 3);
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.ATTENDANCE_SUBMISSION
  }), 3);
});

test('daily summaries surface source contradictions as pending confirmation', async () => {
  const service = createAttendanceSubmissionService({ clock: () => FIXED_NOW });
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA
  });
  const created = await service.createSubmission({
    authContext: context,
    input: attendanceInput(fixture.orgA1, 125, 125)
  });
  await AttendanceSubmission.updateOne({ _id: created._id }, {
    $set: {
      dataQualityStatus: AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION,
      dataQualityIssues: [{
        code: 'SOURCE_REGISTERED_TOTAL_MISMATCH',
        message: 'source mismatch',
        sourceValue: 126,
        calculatedValue: 125,
        sourceReference: 'source!D9'
      }]
    }
  });
  const result = await service.getDailySummary({
    authContext: context,
    query: { date: '2026-07-14' }
  });
  assert.equal(
    result.attendanceSummary.dataQuality.status,
    AttendanceSubmission.ATTENDANCE_QUALITY_STATUSES.PENDING_CONFIRMATION
  );
  assert.deepEqual(result.attendanceSummary.dataQuality.issues[0], {
    code: 'SOURCE_REGISTERED_TOTAL_MISMATCH',
    message: 'source mismatch',
    sourceValue: 126,
    calculatedValue: 125,
    sourceReference: 'source!D9'
  });
});
