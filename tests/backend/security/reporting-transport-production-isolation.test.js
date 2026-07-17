'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const request = appRequire('supertest');
const XLSX = appRequire('xlsx');

const { createApp } = require('../../../app/app');
const AuditLog = require('../../../app/models/AuditLog');
const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProductionSchedule = require('../../../app/models/ProductionSchedule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const ReportChangeRecord = require('../../../app/models/ReportChangeRecord');
const TransportRecord = require('../../../app/models/TransportRecord');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  businessDateInShanghai,
  businessMonthInShanghai,
  isNaturalDate,
  isNaturalMonth,
  monthForDailySlot
} = require('../../../app/services/reportCalendarService');
const {
  createProductionScheduleService,
  normalizeDailyEntries
} = require('../../../app/services/productionScheduleService');
const {
  createTransportRecordService
} = require('../../../app/services/transportRecordService');

const TEST_DATABASE_NAME = `reporting_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AuditLog,
  FileAsset,
  OrgUnit,
  ProductionSchedule,
  ProjectTeam,
  ReportChangeRecord,
  TransportRecord,
  User
];
const REPORT_PERMISSIONS = Object.freeze([
  'report.view',
  'report.submit',
  'report.export',
  'report.schedule.manage'
]);
const FIXED_NOW = new Date(Date.UTC(2026, 6, 31, 16, 30, 0));

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
    user: Object.freeze({ _id: String(userId), username: `report-${userId}` }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: role === permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
      ? permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN
      : permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: REPORT_PERMISSIONS,
    moduleDataScopes: Object.freeze({
      [permissions.DATA_SCOPE_MODULES.REPORT_TRANSPORT]: scope,
      [permissions.DATA_SCOPE_MODULES.REPORT_PRODUCTION]: scope
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
    user: Object.freeze({ _id: String(userId), username: 'report-super' }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['report.view', 'report.export']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

function fileDocument({ id, teamId, uploaderId, suffix }) {
  return {
    _id: id,
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${teamId}/2026/08/${randomUUID()}.png`,
    originalName: `${suffix}.png`,
    mimeType: 'image/png',
    size: 128,
    sha256: suffix.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    uploaderId,
    status: FileAsset.FILE_STATUSES.TEMPORARY,
    deletedAt: null,
    deletedBy: null
  };
}

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA1: objectId(),
    orgA2: objectId(),
    orgB1: objectId(),
    userA1: objectId(),
    userA2: objectId(),
    userB1: objectId(),
    superAdmin: objectId(),
    fileA1: objectId(),
    fileA2: objectId(),
    fileA3: objectId(),
    fileA4: objectId(),
    fileB1: objectId(),
    fileB2: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA1,
      username: 'report-a1',
      usernameNormalized: 'report-a1',
      password: 'unused',
      name: 'Report A1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userA2,
      username: 'report-a2',
      usernameNormalized: 'report-a2',
      password: 'unused',
      name: 'Report A2',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB1,
      username: 'report-b1',
      usernameNormalized: 'report-b1',
      password: 'unused',
      name: 'Report B1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.superAdmin,
      username: 'report-super',
      usernameNormalized: 'report-super',
      password: 'unused',
      name: 'Report Super',
      roles: [],
      isSuperAdmin: true,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'REPORT_A',
      name: '=Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    },
    {
      _id: ids.teamB,
      code: 'REPORT_B',
      name: 'Team B',
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
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A1',
      name: '=Org A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgA2,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A2',
      name: 'Org A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgB1,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'B1',
      name: 'Org B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  await FileAsset.collection.insertMany([
    fileDocument({ id: ids.fileA1, teamId: ids.teamA, uploaderId: ids.userA1, suffix: 'a' }),
    fileDocument({ id: ids.fileA2, teamId: ids.teamA, uploaderId: ids.userA1, suffix: 'b' }),
    fileDocument({ id: ids.fileA3, teamId: ids.teamA, uploaderId: ids.userA1, suffix: 'e' }),
    fileDocument({ id: ids.fileA4, teamId: ids.teamA, uploaderId: ids.userA1, suffix: 'f' }),
    fileDocument({ id: ids.fileB1, teamId: ids.teamB, uploaderId: ids.userB1, suffix: 'c' }),
    fileDocument({ id: ids.fileB2, teamId: ids.teamB, uploaderId: ids.userB1, suffix: 'd' })
  ]);
  return ids;
}

function transportInput({ orgUnitId, route, photoFileIds = [] }) {
  return {
    orgUnitId: String(orgUnitId),
    reportDate: '2026-08-01',
    shift: '白班',
    tripLabel: '第1车',
    route,
    dispatchType: '配送',
    vehiclePlate: 'TEST-PLATE-04',
    vehicleType: '大厢式翼开车（9.6米）',
    driverName: '司机A',
    loadDetails: { standardPlasticPallet: 2, other: 1 },
    photoFileIds
  };
}

function monthlyInput(orgUnitId, aLine) {
  return {
    orgUnitId: String(orgUnitId),
    monthlyTotals: {
      aLine,
      northLine: 1,
      transferCaseLine: 2,
      bLineDay: 3,
      bLineNight: 4
    }
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  for (const model of [...MODELS].reverse()) await model.collection.deleteMany({});
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (replicaSet) await replicaSet.stop();
});

test('calendar values use strict natural dates and the Asia/Shanghai business boundary', () => {
  const justBeforeMidnight = new Date(Date.UTC(2026, 6, 31, 15, 59, 59, 999));
  const justAfterMidnight = new Date(Date.UTC(2026, 6, 31, 16, 0, 0));
  assert.equal(businessDateInShanghai(justBeforeMidnight), '2026-07-31');
  assert.equal(businessDateInShanghai(justAfterMidnight), '2026-08-01');
  assert.equal(businessMonthInShanghai(justAfterMidnight), '2026-08');
  assert.equal(monthForDailySlot('current', justAfterMidnight), '2026-08');
  assert.equal(monthForDailySlot('previous', justAfterMidnight), '2026-07');
  assert.equal(isNaturalDate('2024-02-29'), true);
  assert.equal(isNaturalDate('2026-02-29'), false);
  assert.equal(isNaturalDate('2026-7-1'), false);
  assert.equal(isNaturalDate('2026-07-01T00:00:00Z'), false);
  assert.equal(isNaturalMonth('2026-13'), false);
  assert.throws(
    () => normalizeDailyEntries([{ date: '2026-02-29' }], '2026-02'),
    (error) => error.code === 'REPORT_DATE_INVALID'
  );
});

test('transport records enforce team, organization, related-file, read-only, and export scope', async () => {
  const service = createTransportRecordService({ clock: () => FIXED_NOW });
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    role: permissions.MEMBERSHIP_ROLES.MEMBER
  });
  const teamB = teamContext({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB1
  });
  const recordA1 = await service.createRecord({
    authContext: teamA,
    input: transportInput({
      orgUnitId: fixture.orgA1,
      route: '=CMD()',
      photoFileIds: [String(fixture.fileA1), String(fixture.fileA2)]
    })
  });
  const recordA2 = await service.createRecord({
    authContext: teamA,
    input: transportInput({
      orgUnitId: fixture.orgA2,
      route: 'A2_SECRET',
      photoFileIds: [String(fixture.fileA3), String(fixture.fileA4)]
    })
  });
  const recordB = await service.createRecord({
    authContext: teamB,
    input: transportInput({
      orgUnitId: fixture.orgB1,
      route: 'B_SECRET',
      photoFileIds: [String(fixture.fileB1), String(fixture.fileB2)]
    })
  });

  await assert.rejects(service.createRecord({
    authContext: teamA,
    input: transportInput({ orgUnitId: fixture.orgB1, route: 'FOREIGN_ORG' })
  }), (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID');
  await assert.rejects(service.createRecord({
    authContext: teamA,
    input: transportInput({
      orgUnitId: fixture.orgA1,
      route: 'FOREIGN_FILES',
      photoFileIds: [String(fixture.fileB1), String(fixture.fileB2)]
    })
  }), (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID');
  await assert.rejects(service.createRecord({
    authContext: teamA,
    input: { ...transportInput({ orgUnitId: fixture.orgA1, route: 'TEAM_SMUGGLE' }), teamId: String(fixture.teamB) }
  }), (error) => error.code === 'REPORT_TEAM_ID_IMMUTABLE');
  await assert.rejects(service.createRecord({
    authContext: teamA,
    input: { ...transportInput({ orgUnitId: fixture.orgA1, route: 'OLD_PATH' }), photoPaths: ['/uploads/a.jpg'] }
  }), (error) => error.code === 'REPORT_LEGACY_FILE_REFERENCE_REJECTED');

  const orgList = await service.listRecords({ authContext: orgA1 });
  assert.deepEqual(orgList.transportRecords.map(({ _id }) => _id), [recordA1._id]);
  await assert.rejects(
    service.getRecord({ authContext: orgA1, transportRecordId: recordA2._id }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service.getRecord({ authContext: orgA1, transportRecordId: recordB._id }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service.updateRecord({
      authContext: orgA1,
      transportRecordId: recordA2._id,
      input: { remark: 'must not update' }
    }),
    (error) => error.status === 404
  );

  const global = globalContext(fixture.superAdmin);
  await assert.rejects(
    service.listRecords({ authContext: global }),
    (error) => error.code === 'REPORT_TEAM_REQUIRED'
  );
  const globalTeamA = await service.listRecords({
    authContext: global,
    requestedTeamId: String(fixture.teamA)
  });
  assert.equal(globalTeamA.total, 2);
  await assert.rejects(
    service.createRecord({
      authContext: global,
      input: transportInput({ orgUnitId: fixture.orgA1, route: 'GLOBAL_WRITE' })
    }),
    (error) => error.status === 403
  );

  const exported = await service.exportMonthlySummary({
    authContext: orgA1,
    query: { month: '2026-08' }
  });
  const workbook = XLSX.read(exported.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: null
  });
  const serialized = JSON.stringify(rows);
  assert.match(serialized, /'=CMD\(\)/);
  assert.doesNotMatch(serialized, /A2_SECRET/);
  assert.doesNotMatch(serialized, /B_SECRET/);
  assert.equal(exported.count, 1);
});

test('transport create rolls back its record and immutable change when audit append fails', async () => {
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const service = createTransportRecordService({
    auditService: { record: async () => { throw new Error('forced audit failure'); } },
    clock: () => FIXED_NOW
  });
  await assert.rejects(service.createRecord({
    authContext: context,
    input: transportInput({
      orgUnitId: fixture.orgA1,
      route: 'ROLLBACK',
      photoFileIds: [String(fixture.fileA1), String(fixture.fileA2)]
    })
  }), /forced audit failure/);
  assert.equal(await TransportRecord.countDocuments({}), 0);
  assert.equal(await ReportChangeRecord.countDocuments({}), 0);
  assert.equal((await FileAsset.findById(fixture.fileA1).lean()).status, 'TEMPORARY');
});

test('production maintenance and exports isolate two teams and two divisions', async () => {
  const service = createProductionScheduleService({ clock: () => FIXED_NOW });
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    role: permissions.MEMBERSHIP_ROLES.MEMBER
  });
  const teamB = teamContext({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB1
  });
  await service.maintainMonthlySchedule({
    authContext: teamA,
    month: '2026-08',
    input: monthlyInput(fixture.orgA1, 111)
  });
  await service.maintainMonthlySchedule({
    authContext: teamA,
    month: '2026-08',
    input: monthlyInput(fixture.orgA2, 222)
  });
  await service.maintainMonthlySchedule({
    authContext: teamB,
    month: '2026-08',
    input: monthlyInput(fixture.orgB1, 333)
  });
  await service.maintainDailySlot({
    authContext: teamA,
    slot: 'current',
    input: {
      orgUnitId: String(fixture.orgA1),
      month: '2026-08',
      dailyEntries: [{ date: '2026-08-01', aLineDay: 11 }],
      productionPlanForecast: 1000
    }
  });
  await service.maintainDailySlot({
    authContext: teamA,
    slot: 'current',
    input: {
      orgUnitId: String(fixture.orgA2),
      dailyEntries: [{ date: '2026-08-01', aLineDay: 22 }]
    }
  });

  await assert.rejects(service.maintainMonthlySchedule({
    authContext: orgA1,
    month: '2026-09',
    input: monthlyInput(fixture.orgA2, 999)
  }), (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID');
  await assert.rejects(service.maintainMonthlySchedule({
    authContext: teamA,
    month: '2026-09',
    input: monthlyInput(fixture.orgB1, 999)
  }), (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID');
  await assert.rejects(service.maintainDailySlot({
    authContext: teamA,
    slot: 'current',
    input: {
      orgUnitId: String(fixture.orgA1),
      month: '2026-07',
      dailyEntries: []
    }
  }), (error) => error.code === 'PRODUCTION_DAILY_MONTH_MISMATCH');

  const orgDaily = await service.getDailySlot({ authContext: orgA1, slot: 'current' });
  assert.equal(orgDaily.month, '2026-08');
  assert.equal(orgDaily.schedules.length, 1);
  assert.equal(orgDaily.schedules[0].dailyEntries.length, 31);
  assert.equal(orgDaily.schedules[0].dailyEntries[0].aLineDay, 11);
  const orgMonthly = await service.listMonthlySchedules({ authContext: orgA1 });
  assert.deepEqual(
    orgMonthly.productionSchedules.map((item) => item.monthlyTotals.aLine),
    [111]
  );
  const teamMonthly = await service.listMonthlySchedules({ authContext: teamA });
  assert.deepEqual(
    teamMonthly.productionSchedules.map((item) => item.monthlyTotals.aLine).sort(),
    [111, 222]
  );

  const global = globalContext(fixture.superAdmin);
  await assert.rejects(
    service.listMonthlySchedules({ authContext: global }),
    (error) => error.code === 'REPORT_TEAM_REQUIRED'
  );
  const globalTeamB = await service.listMonthlySchedules({
    authContext: global,
    requestedTeamId: String(fixture.teamB)
  });
  assert.deepEqual(
    globalTeamB.productionSchedules.map((item) => item.monthlyTotals.aLine),
    [333]
  );
  await assert.rejects(service.maintainMonthlySchedule({
    authContext: global,
    month: '2026-08',
    input: monthlyInput(fixture.orgA1, 444)
  }), (error) => error.status === 403);

  const monthlyExport = await service.exportMonthlySchedules({
    authContext: orgA1,
    query: { fromMonth: '2026-08', toMonth: '2026-08' }
  });
  const monthlyBook = XLSX.read(monthlyExport.buffer, { type: 'buffer' });
  const monthlyText = JSON.stringify(
    XLSX.utils.sheet_to_json(monthlyBook.Sheets[monthlyBook.SheetNames[0]], {
      header: 1,
      defval: null
    })
  );
  assert.match(monthlyText, /111/);
  assert.match(monthlyText, /'=Team A/);
  assert.doesNotMatch(monthlyText, /222/);
  assert.doesNotMatch(monthlyText, /333/);

  const dailyExport = await service.exportDailySlot({
    authContext: orgA1,
    slot: 'current',
    query: {}
  });
  const dailyBook = XLSX.read(dailyExport.buffer, { type: 'buffer' });
  const dailyText = JSON.stringify(
    XLSX.utils.sheet_to_json(dailyBook.Sheets[dailyBook.SheetNames[0]], {
      header: 1,
      defval: null
    })
  );
  assert.match(dailyText, /11/);
  const augustFirst = XLSX.utils.sheet_to_json(
    dailyBook.Sheets[dailyBook.SheetNames[0]],
    { header: 1, defval: null }
  ).find((row) => row[0] === '2026-08-01');
  assert.equal(augustFirst[1], 11);
  assert.notEqual(augustFirst[1], 22);
});

test('concurrent idempotent monthly maintenance retains one scoped month key and audits every write', async () => {
  const service = createProductionScheduleService({ clock: () => FIXED_NOW });
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const attempts = 6;
  const results = await Promise.all(Array.from({ length: attempts }, () => (
    service.maintainMonthlySchedule({
      authContext: context,
      month: '2027-01',
      input: monthlyInput(fixture.orgA1, 700)
    })
  )));
  assert.equal(new Set(results.map(({ _id }) => _id)).size, 1);
  const filter = {
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    month: '2027-01'
  };
  const schedule = await ProductionSchedule.findOne(filter).lean();
  assert.ok(schedule);
  assert.equal(await ProductionSchedule.countDocuments(filter), 1);
  assert.equal(await ReportChangeRecord.countDocuments({ resourceId: schedule._id }), attempts);
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
    resourceId: String(schedule._id)
  }), attempts);
});

test('report change records are append-only', async () => {
  const service = createProductionScheduleService({ clock: () => FIXED_NOW });
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const schedule = await service.maintainMonthlySchedule({
    authContext: context,
    month: '2026-10',
    input: monthlyInput(fixture.orgA1, 100)
  });
  const change = await ReportChangeRecord.findOne({ resourceId: schedule._id });
  change.reason = 'tamper';
  await assert.rejects(change.save(), /immutable|append-only/);
  await assert.rejects(
    ReportChangeRecord.updateOne({ _id: change._id }, { $set: { reason: 'tamper' } }),
    /append-only/
  );
  const persisted = await ReportChangeRecord.findById(change._id).lean();
  assert.equal(persisted.reason, null);
});

test('the isolated app mounts both reporting route groups behind authentication', async () => {
  const config = {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'reporting-v2-test',
    port: 18099,
    mongodbUri: `mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    jwtSecret: 'reporting-test-secret-0123456789abcdef',
    jwtExpire: '1h',
    uploadPath: path.resolve(__dirname, '../../.test-data/reporting-uploads'),
    maxFileSize: 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
  const app = createApp(config);
  await request(app).get('/api/transport-records').expect(401);
  await request(app).get('/api/production-schedules/monthly').expect(401);
});
