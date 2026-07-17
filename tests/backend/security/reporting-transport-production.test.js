'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProductionSchedule = require('../../../app/models/ProductionSchedule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const ReportChangeRecord = require('../../../app/models/ReportChangeRecord');
const TransportRecord = require('../../../app/models/TransportRecord');
const permissions = require('../../../app/config/permissions');
const {
  businessDateInShanghai,
  isNaturalDate,
  monthForDailySlot
} = require('../../../app/services/reportCalendarService');
const {
  createProductionScheduleService
} = require('../../../app/services/productionScheduleService');
const { createFileAssetService } = require('../../../app/services/fileAssetService');
const {
  createTransportRecordService
} = require('../../../app/services/transportRecordService');

const TEST_DATABASE_NAME = `reporting_${randomUUID().replaceAll('-', '')}_v2_test`;
const REPORT_PERMISSIONS = Object.freeze([
  'report.view',
  'report.submit',
  'report.export',
  'report.schedule.manage'
]);
const MODELS = [
  FileAsset,
  OrgUnit,
  ProductionSchedule,
  ProjectTeam,
  ReportChangeRecord,
  TransportRecord
];
const auditService = Object.freeze({ record: async () => null });

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({ teamId, orgUnitId, userId, scope }) {
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
      role: scope === permissions.DATA_SCOPES.TEAM
        ? permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN
        : permissions.MEMBERSHIP_ROLES.MEMBER,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: scope === permissions.DATA_SCOPES.TEAM
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

async function seedFixture() {
  const values = {
    teamA: objectId(),
    teamB: objectId(),
    orgA1: objectId(),
    orgA2: objectId(),
    orgB1: objectId(),
    adminA: objectId(),
    memberA1: objectId(),
    memberA2: objectId(),
    adminB: objectId()
  };
  await ProjectTeam.collection.insertMany([
    {
      _id: values.teamA,
      code: 'REPORT_A',
      name: 'Report Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: values.adminA
    },
    {
      _id: values.teamB,
      code: 'REPORT_B',
      name: 'Report Team B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: values.adminB
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: values.orgA1,
      teamId: values.teamA,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'A1',
      name: 'A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      level: 2,
      path: '/',
      sortOrder: 1
    },
    {
      _id: values.orgA2,
      teamId: values.teamA,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'A2',
      name: 'A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      level: 2,
      path: '/',
      sortOrder: 2
    },
    {
      _id: values.orgB1,
      teamId: values.teamB,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'B1',
      name: 'B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      level: 2,
      path: '/',
      sortOrder: 1
    }
  ]);
  values.adminAContext = teamContext({
    teamId: values.teamA,
    orgUnitId: values.orgA1,
    userId: values.adminA,
    scope: permissions.DATA_SCOPES.TEAM
  });
  values.memberA1Context = teamContext({
    teamId: values.teamA,
    orgUnitId: values.orgA1,
    userId: values.memberA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  values.memberA2Context = teamContext({
    teamId: values.teamA,
    orgUnitId: values.orgA2,
    userId: values.memberA2,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  values.adminBContext = teamContext({
    teamId: values.teamB,
    orgUnitId: values.orgB1,
    userId: values.adminB,
    scope: permissions.DATA_SCOPES.TEAM
  });
  return values;
}

async function temporaryPhoto(teamId, uploaderId, name) {
  return FileAsset.create({
    teamId,
    storageKey: `${teamId}/2026/07/${randomUUID()}.png`,
    originalName: name,
    mimeType: 'image/png',
    size: 68,
    sha256: 'a'.repeat(64),
    uploaderId
  });
}

async function photos(teamId, uploaderId, prefix) {
  return Promise.all([
    temporaryPhoto(teamId, uploaderId, `${prefix}-1.png`),
    temporaryPhoto(teamId, uploaderId, `${prefix}-2.png`)
  ]);
}

function transportInput(orgUnitId, photoFiles, overrides = {}) {
  return {
    orgUnitId: String(orgUnitId),
    reportDate: '2026-07-16',
    shift: '白班',
    tripLabel: '第1车',
    route: '仓库-总部',
    dispatchType: '配送',
    vehiclePlate: 'TEST-PLATE-03',
    vehicleType: '厢式货车',
    driverName: '=DRIVER',
    loadDetails: { standardPlasticPallet: 2 },
    photoFileIds: photoFiles.map(({ _id }) => String(_id)),
    remark: '+FORMULA',
    ...overrides
  };
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('Shanghai business dates use real natural calendar boundaries', () => {
  assert.equal(isNaturalDate('2028-02-29'), true);
  assert.equal(isNaturalDate('2027-02-29'), false);
  assert.equal(
    businessDateInShanghai(new Date('2026-01-31T15:59:59.999Z')),
    '2026-01-31'
  );
  assert.equal(
    businessDateInShanghai(new Date('2026-01-31T16:00:00.000Z')),
    '2026-02-01'
  );
  assert.equal(monthForDailySlot('previous', new Date('2026-01-01T00:00:00Z')), '2025-12');
});

test('transport records bind private photos and remain isolated by team and organization', async () => {
  const service = createTransportRecordService({
    auditService,
    connection: mongoose.connection,
    clock: () => new Date('2026-07-16T01:00:00Z')
  });
  const originalPhotos = await photos(fixture.teamA, fixture.adminA, 'original');
  const created = await service.createRecord({
    authContext: fixture.adminAContext,
    input: transportInput(fixture.orgA2, originalPhotos)
  });

  assert.equal(created.orgUnitId, String(fixture.orgA2));
  assert.equal(created.loadTotal, 2);
  for (const photo of originalPhotos) {
    const stored = await FileAsset.findById(photo._id).lean();
    assert.equal(stored.status, FileAsset.FILE_STATUSES.ACTIVE);
    assert.equal(stored.ownerType, FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT);
    assert.equal(String(stored.ownerId), created._id);
  }

  const fileService = createFileAssetService({
    auditService,
    connection: mongoose.connection
  });
  const visiblePhoto = await fileService.getMetadata({
    authContext: fixture.memberA2Context,
    fileId: originalPhotos[0]._id
  });
  assert.equal(visiblePhoto.ownerType, FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT);
  await assert.rejects(
    fileService.getMetadata({
      authContext: fixture.memberA1Context,
      fileId: originalPhotos[0]._id
    }),
    (error) => error.code === 'FILE_NOT_FOUND'
  );

  const orgA1 = await service.listRecords({ authContext: fixture.memberA1Context });
  const orgA2 = await service.listRecords({ authContext: fixture.memberA2Context });
  const teamB = await service.listRecords({ authContext: fixture.adminBContext });
  assert.equal(orgA1.total, 0);
  assert.equal(orgA2.total, 1);
  assert.equal(teamB.total, 0);

  const replacementPhotos = await photos(fixture.teamA, fixture.adminA, 'replacement');
  const updated = await service.updateRecord({
    authContext: fixture.adminAContext,
    transportRecordId: created._id,
    input: {
      orgUnitId: String(fixture.orgA2),
      photoFileIds: replacementPhotos.map(({ _id }) => String(_id)),
      remark: '+FORMULA'
    }
  });
  assert.deepEqual(
    updated.photoFileIds.sort(),
    replacementPhotos.map(({ _id }) => String(_id)).sort()
  );
  for (const photo of originalPhotos) {
    assert.equal((await FileAsset.findById(photo._id).lean()).status, 'DELETED');
  }
  assert.equal(await ReportChangeRecord.countDocuments({ resourceId: created._id }), 2);

  const exported = await service.exportMonthlySummary({
    authContext: fixture.adminAContext,
    query: { month: '2026-07' }
  });
  const workbook = XLSX.read(exported.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    raw: true
  });
  assert.equal(exported.count, 1);
  assert.match(JSON.stringify(rows), /'=DRIVER/);
  assert.match(JSON.stringify(rows), /'\+FORMULA/);
});

test('transport creation rejects missing, foreign, or forged photo references', async () => {
  const service = createTransportRecordService({ auditService, connection: mongoose.connection });
  const teamBPhotos = await photos(fixture.teamB, fixture.adminB, 'foreign');

  await assert.rejects(
    service.createRecord({
      authContext: fixture.adminAContext,
      input: transportInput(fixture.orgA1, [])
    }),
    (error) => error.code === 'REPORT_PHOTO_COUNT_INVALID'
  );
  await assert.rejects(
    service.createRecord({
      authContext: fixture.adminAContext,
      input: transportInput(fixture.orgA1, teamBPhotos)
    }),
    (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID'
  );
  await assert.rejects(
    service.createRecord({
      authContext: fixture.adminAContext,
      input: {
        ...transportInput(fixture.orgA1, teamBPhotos),
        photoFileIds: undefined,
        photoUrls: ['https://example.invalid/photo.png']
      }
    }),
    (error) => error.code === 'REPORT_LEGACY_FILE_REFERENCE_REJECTED'
  );
  assert.equal(await TransportRecord.countDocuments({}), 0);
});

test('report options and transport history preserve module data scope', async () => {
  const transportService = createTransportRecordService({
    auditService,
    connection: mongoose.connection,
    clock: () => new Date('2026-07-16T01:00:00Z')
  });
  const productionService = createProductionScheduleService({
    auditService,
    connection: mongoose.connection,
    clock: () => new Date('2026-07-16T01:00:00Z')
  });
  const stagedPhotos = await photos(fixture.teamA, fixture.adminA, 'history');
  const created = await transportService.createRecord({
    authContext: fixture.adminAContext,
    input: transportInput(fixture.orgA2, stagedPhotos)
  });
  await transportService.updateRecord({
    authContext: fixture.adminAContext,
    transportRecordId: created._id,
    input: { remark: '二次确认' }
  });

  const [teamTransportOptions, scopedTransportOptions, scopedProductionOptions] = await Promise.all([
    transportService.listOptions({ authContext: fixture.adminAContext }),
    transportService.listOptions({ authContext: fixture.memberA2Context }),
    productionService.listOptions({ authContext: fixture.memberA1Context })
  ]);
  assert.deepEqual(
    teamTransportOptions.orgUnits.map(({ _id }) => _id).sort(),
    [String(fixture.orgA1), String(fixture.orgA2)].sort()
  );
  assert.deepEqual(
    scopedTransportOptions.orgUnits.map(({ _id }) => _id),
    [String(fixture.orgA2)]
  );
  assert.deepEqual(
    scopedProductionOptions.orgUnits.map(({ _id }) => _id),
    [String(fixture.orgA1)]
  );

  const history = await transportService.getHistory({
    authContext: fixture.memberA2Context,
    transportRecordId: created._id,
    query: { page: 1, pageSize: 20 }
  });
  assert.equal(history.total, 2);
  assert.deepEqual(history.changes.map(({ changeType }) => changeType), ['UPDATE', 'CREATE']);
  assert.equal(history.transportRecord._id, created._id);
  await assert.rejects(
    transportService.getHistory({
      authContext: fixture.memberA1Context,
      transportRecordId: created._id
    }),
    (error) => error.code === 'REPORT_RECORD_NOT_FOUND'
  );
});

test('production schedules are isolated and concurrent monthly maintenance keeps one key', async () => {
  const service = createProductionScheduleService({
    auditService,
    connection: mongoose.connection,
    clock: () => new Date('2026-03-01T00:30:00Z')
  });
  const base = {
    authContext: fixture.adminAContext,
    month: '2026-03'
  };
  await Promise.all([
    service.maintainMonthlySchedule({
      ...base,
      input: { orgUnitId: String(fixture.orgA2), monthlyTotals: { aLine: 10 } }
    }),
    service.maintainMonthlySchedule({
      ...base,
      input: { orgUnitId: String(fixture.orgA2), monthlyTotals: { aLine: 20 } }
    })
  ]);

  assert.equal(await ProductionSchedule.countDocuments({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA2,
    month: '2026-03'
  }), 1);
  const stored = await ProductionSchedule.findOne({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA2,
    month: '2026-03'
  }).lean();
  assert.ok([10, 20].includes(stored.monthlyTotals.aLine));

  const orgA1 = await service.listMonthlySchedules({ authContext: fixture.memberA1Context });
  const orgA2 = await service.listMonthlySchedules({ authContext: fixture.memberA2Context });
  const teamB = await service.listMonthlySchedules({ authContext: fixture.adminBContext });
  assert.equal(orgA1.total, 0);
  assert.equal(orgA2.total, 1);
  assert.equal(teamB.total, 0);

  const maintained = await service.maintainDailySlot({
    authContext: fixture.adminAContext,
    slot: 'current',
    input: {
      orgUnitId: String(fixture.orgA2),
      dailyEntries: [{ date: '2026-03-01', aLineDay: 3 }],
      productionPlanForecast: 120
    }
  });
  assert.equal(maintained.month, undefined);
  assert.equal(maintained.slot, 'current');
  assert.equal(maintained.schedule.dailyEntries.length, 31);
  assert.equal(maintained.schedule.dailyEntries[0].total, 3);

  await assert.rejects(
    service.maintainDailySlot({
      authContext: fixture.adminAContext,
      slot: 'current',
      input: {
        orgUnitId: String(fixture.orgA2),
        dailyEntries: [{ date: '2026-02-28', aLineDay: 1 }]
      }
    }),
    (error) => error.code === 'REPORT_DATE_INVALID'
  );
  await assert.rejects(
    service.maintainMonthlySchedule({
      authContext: fixture.memberA1Context,
      month: '2026-04',
      input: { orgUnitId: String(fixture.orgA2), monthlyTotals: { aLine: 1 } }
    }),
    (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID'
  );
});

test('report change history is append-only', async () => {
  await ReportChangeRecord.create({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.PRODUCTION_SCHEDULE,
    resourceId: objectId(),
    changeType: 'CREATE',
    after: { value: 1 },
    operatorId: fixture.adminA
  });
  await assert.rejects(
    ReportChangeRecord.updateOne({}, { $set: { after: { value: 2 } } }),
    /append-only/
  );
});
