'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const ReportChangeRecord = require('../../../app/models/ReportChangeRecord');
const TransportMasterData = require('../../../app/models/TransportMasterData');
const TransportRecord = require('../../../app/models/TransportRecord');
const permissions = require('../../../app/config/permissions');
const { createAuditService } = require('../../../app/services/auditService');
const {
  createTransportMasterDataService
} = require('../../../app/services/transportMasterDataService');
const {
  createTransportRecordService
} = require('../../../app/services/transportRecordService');
const {
  MASTER_REFERENCE_FIELDS,
  createTransportMasterDataBackfillService
} = require('../../../app/services/transportMasterDataBackfillService');

const DATABASE_NAME = `transport_master_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AuditLog,
  FileAsset,
  OrgUnit,
  ProjectTeam,
  ReportChangeRecord,
  TransportMasterData,
  TransportRecord
];

let replicaSet;
let fixture;
let service;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({
  teamId,
  userId,
  orgUnitId = objectId(),
  transportReporter = false,
  manageMasterData = false,
  isSuperAdmin = false
}) {
  const membership = isSuperAdmin
    ? null
    : Object.freeze({
        _id: String(objectId()),
        teamId: String(teamId),
        userId: String(userId),
        orgUnitId: String(orgUnitId),
        role: permissions.MEMBERSHIP_ROLES.MEMBER,
        functionalRoleKeys: Object.freeze(transportReporter
          ? [permissions.FUNCTIONAL_ROLE_KEYS.TRANSPORT_REPORTER]
          : []),
        status: permissions.MEMBERSHIP_STATUSES.ACTIVE
      });
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `transport-${userId}` }),
    isSuperAdmin,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership,
    orgUnit: membership
      ? Object.freeze({ _id: membership.orgUnitId, teamId: String(teamId) })
      : null,
    actorRole: isSuperAdmin
      ? permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([
      'report.view',
      'report.submit',
      ...(manageMasterData ? ['report.transport.master.manage'] : [])
    ]),
    moduleDataScopes: Object.freeze({
      [permissions.DATA_SCOPE_MODULES.REPORT_TRANSPORT]: permissions.DATA_SCOPES.TEAM
    }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function globalReadOnlyContext(userId) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `transport-global-${userId}` }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['report.view', 'report.submit', 'report.transport.master.manage']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

async function seedFixture() {
  const values = {
    teamA: objectId(),
    teamB: objectId(),
    orgA: objectId(),
    reporterA: objectId(),
    ordinaryA: objectId(),
    reporterB: objectId(),
    superAdmin: objectId()
  };
  await ProjectTeam.collection.insertMany([
    {
      _id: values.teamA,
      code: 'TRANSPORT_MASTER_A',
      name: '运输基础资料团队 A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: values.superAdmin
    },
    {
      _id: values.teamB,
      code: 'TRANSPORT_MASTER_B',
      name: '运输基础资料团队 B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: values.superAdmin
    }
  ]);
  await OrgUnit.collection.insertOne({
    _id: values.orgA,
    teamId: values.teamA,
    parentId: null,
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'TRANSPORT_A',
    name: '运输分部 A',
    status: permissions.ORG_UNIT_STATUSES.ACTIVE,
    sortOrder: 1,
    level: 2,
    path: '/'
  });
  values.reporterAContext = teamContext({
    teamId: values.teamA,
    userId: values.reporterA,
    orgUnitId: values.orgA,
    transportReporter: true
  });
  values.ordinaryAContext = teamContext({
    teamId: values.teamA,
    userId: values.ordinaryA,
    orgUnitId: values.orgA
  });
  values.masterManagerAContext = teamContext({
    teamId: values.teamA,
    userId: values.ordinaryA,
    orgUnitId: values.orgA,
    manageMasterData: true
  });
  values.reporterBContext = teamContext({
    teamId: values.teamB,
    userId: values.reporterB,
    transportReporter: true
  });
  values.masterManagerBContext = teamContext({
    teamId: values.teamB,
    userId: values.reporterB,
    transportReporter: true,
    manageMasterData: true
  });
  values.superAdminAContext = teamContext({
    teamId: values.teamA,
    userId: values.superAdmin,
    orgUnitId: values.orgA,
    manageMasterData: true,
    isSuperAdmin: true
  });
  values.globalContext = globalReadOnlyContext(values.superAdmin);
  return values;
}

async function createMaster(authContext, input) {
  return service.createMasterData({ authContext, input });
}

async function temporaryPhotos(teamId, uploaderId) {
  return Promise.all([1, 2].map((index) => FileAsset.create({
    teamId,
    storageKey: `${teamId}/2026/07/${randomUUID()}.png`,
    originalName: `transport-master-${index}.png`,
    mimeType: 'image/png',
    size: 68,
    sha256: String(index).repeat(64),
    uploaderId
  })));
}

function fakeManagedFileService() {
  return Object.freeze({
    async reconcileOwnerFiles({ attachments }) {
      return attachments.map(({ fileId }) => ({ fileId: String(fileId) }));
    }
  });
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), { dbName: DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  for (const model of [...MODELS].reverse()) await model.collection.deleteMany({});
  fixture = await seedFixture();
  service = createTransportMasterDataService({
    auditService: createAuditService({ AuditLog }),
    connection: mongoose.connection
  });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('five master-data kinds normalize business keys and reject scoped duplicates', async () => {
  const trip = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: '  第   十  车  '
  });
  const storedTrip = await TransportMasterData.findById(trip._id).lean();
  assert.equal(storedTrip.name, '第   十  车');
  assert.equal(storedTrip.normalizedKey, '第 十 车');

  await assert.rejects(createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: '第 十 车'
  }), (error) => (
    error.status === 409 &&
    error.code === 'TRANSPORT_MASTER_DUPLICATE' &&
    error.message === '同一团队内已存在相同的趟次'
  ));

  const plate = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE,
    name: ' 鲁 a a 2991 '
  });
  const vehicleType = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
    name: ' 厢式货车 '
  });
  const driver = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER,
    name: ' 张师傅 '
  });
  const storedPlate = await TransportMasterData.findById(plate._id).lean();
  assert.equal(storedPlate.name, '鲁 a a 2991');
  assert.equal(storedPlate.normalizedKey, '鲁AA2991');
  assert.equal(vehicleType.name, '厢式货车');
  assert.equal(driver.name, '张师傅');
  assert.deepEqual(
    new Set((await service.listMasterData({
      authContext: fixture.reporterAContext,
      query: { includeDisabled: true }
    })).masterData.map(({ kind }) => kind)),
    new Set(['TRIP', 'VEHICLE_PLATE', 'VEHICLE_TYPE', 'DRIVER'])
  );

  const sameKeyOtherTeam = await createMaster(fixture.masterManagerBContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: '第 十 车'
  });
  assert.equal(sameKeyOtherTeam.teamId, String(fixture.teamB));
});

test('five master-data name limits match immutable transport snapshot fields', async () => {
  const snapshotLimits = {
    [TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP]: TransportRecord.schema.path('tripLabel').options.maxlength,
    [TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE]: TransportRecord.schema.path('route').options.maxlength,
    [TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE]: TransportRecord.schema.path('vehiclePlate').options.maxlength,
    [TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE]: TransportRecord.schema.path('vehicleType').options.maxlength,
    [TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER]: TransportRecord.schema.path('driverName').options.maxlength
  };
  assert.deepEqual(snapshotLimits, {
    TRIP: 50,
    ROUTE: 200,
    VEHICLE_PLATE: 50,
    VEHICLE_TYPE: 100,
    DRIVER: 100
  });
  assert.deepEqual(TransportMasterData.TRANSPORT_MASTER_NAME_MAX_LENGTHS, snapshotLimits);

  for (const [kind, maxLength] of Object.entries(snapshotLimits)) {
    const accepted = await createMaster(fixture.masterManagerAContext, {
      kind,
      name: kind[0] + 'x'.repeat(maxLength - 1)
    });
    assert.equal(accepted.name.length, maxLength);

    await assert.rejects(createMaster(fixture.masterManagerAContext, {
      kind,
      name: kind[0] + 'y'.repeat(maxLength)
    }), (error) => (
      error.status === 400 &&
      error.code === 'REPORT_INPUT_INVALID' &&
      error.message === 'name is too long'
    ));
  }

  await assert.rejects(new TransportMasterData({
    teamId: fixture.teamA,
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: 'z'.repeat(51),
    createdBy: fixture.ordinaryA
  }).validate(), /name cannot exceed 50 characters for kind TRIP/);
});

test('team isolation and the independent master-data permission include the super-admin exception', async () => {
  await assert.rejects(createMaster(fixture.ordinaryAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '普通成员不可维护'
  }), (error) => error.status === 403 && error.code === 'PERMISSION_DENIED');
  await assert.rejects(createMaster(fixture.reporterAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '运输提报员也不能自动维护'
  }), (error) => error.status === 403 && error.code === 'PERMISSION_DENIED');

  const teamARecord = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: 'A 团队路线'
  });
  const superAdminRecord = await createMaster(fixture.superAdminAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '超级管理员路线'
  });
  const teamBRecord = await createMaster(fixture.masterManagerBContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: 'B 团队路线'
  });

  assert.equal(superAdminRecord.teamId, String(fixture.teamA));
  assert.equal(fixture.superAdminAContext.membership, null);

  const teamAList = await service.listMasterData({
    authContext: fixture.reporterAContext,
    query: { includeDisabled: true }
  });
  assert.deepEqual(
    new Set(teamAList.masterData.map(({ _id }) => _id)),
    new Set([teamARecord._id, superAdminRecord._id])
  );
  assert.equal(teamAList.masterData.some(({ _id }) => _id === teamBRecord._id), false);

  const globalTeamBList = await service.listMasterData({
    authContext: fixture.globalContext,
    requestedTeamId: String(fixture.teamB),
    query: { includeDisabled: true }
  });
  assert.deepEqual(globalTeamBList.masterData.map(({ _id }) => _id), [teamBRecord._id]);

  await assert.rejects(service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: teamBRecord._id,
    input: { sortOrder: 99 }
  }), (error) => error.status === 404 && error.code === 'TRANSPORT_MASTER_NOT_FOUND');
  await assert.rejects(createMaster(fixture.globalContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '全局只读不可写'
  }), (error) => error.code === 'TEAM_CONTEXT_REQUIRED');
});

test('active lists follow stable sort order and status changes retain before/after audits', async () => {
  const routeB = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '路线 B',
    sortOrder: 20
  });
  const routeC = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '路线 C',
    sortOrder: 10
  });
  const routeA = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '路线 A',
    sortOrder: 10
  });

  let listed = await service.listMasterData({
    authContext: fixture.reporterAContext,
    query: { kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE }
  });
  assert.deepEqual(listed.masterData.map(({ _id }) => _id), [routeA._id, routeC._id, routeB._id]);

  await AuditLog.collection.deleteMany({});
  const reordered = await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: routeB._id,
    input: { sortOrder: 0 }
  });
  assert.equal(reordered.sortOrder, 0);
  const disabled = await service.setMasterDataStatus({
    authContext: fixture.masterManagerAContext,
    masterDataId: routeA._id,
    input: { status: TransportMasterData.TRANSPORT_MASTER_STATUSES.DISABLED }
  });
  assert.equal(disabled.status, TransportMasterData.TRANSPORT_MASTER_STATUSES.DISABLED);

  listed = await service.listMasterData({
    authContext: fixture.reporterAContext,
    query: { kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE }
  });
  assert.deepEqual(listed.masterData.map(({ _id }) => _id), [routeB._id, routeC._id]);

  const withDisabled = await service.listMasterData({
    authContext: fixture.reporterAContext,
    query: {
      kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
      includeDisabled: true
    }
  });
  assert.deepEqual(withDisabled.masterData.map(({ _id }) => _id), [
    routeB._id,
    routeC._id,
    routeA._id
  ]);

  await service.setMasterDataStatus({
    authContext: fixture.masterManagerAContext,
    masterDataId: routeA._id,
    input: { status: TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE }
  });
  const audits = await AuditLog.find({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA
  }).sort({ createdAt: 1, _id: 1 }).lean();
  assert.deepEqual(audits.map(({ action }) => action), [
    permissions.AUDIT_ACTIONS.UPDATE,
    permissions.AUDIT_ACTIONS.DISABLE,
    permissions.AUDIT_ACTIONS.ENABLE
  ]);
  assert.equal(audits[0].before.sortOrder, 20);
  assert.equal(audits[0].after.sortOrder, 0);
  assert.equal(audits[1].before.status, TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE);
  assert.equal(audits[1].after.status, TransportMasterData.TRANSPORT_MASTER_STATUSES.DISABLED);
  assert.equal(audits[2].before.status, TransportMasterData.TRANSPORT_MASTER_STATUSES.DISABLED);
  assert.equal(audits[2].after.status, TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE);
  assert.ok(audits.every(({ targetTeamId }) => String(targetTeamId) === String(fixture.teamA)));
});

test('transport records use server-side master fields and preserve historical snapshots', async () => {
  const trip = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: '第十车'
  });
  const route = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE,
    name: '仓库至客户工厂'
  });
  const vehiclePlate = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE,
    name: '鲁AA2991'
  });
  const vehicleType = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
    name: '厢式货车'
  });
  const driver = await createMaster(fixture.masterManagerAContext, {
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER,
    name: '张师傅'
  });
  const photos = await temporaryPhotos(fixture.teamA, fixture.reporterA);
  const recordService = createTransportRecordService({
    auditService: createAuditService({ AuditLog }),
    fileAssetService: fakeManagedFileService(),
    connection: mongoose.connection,
    clock: () => new Date('2026-07-16T01:00:00.000Z')
  });

  await assert.rejects(recordService.createRecord({
    authContext: fixture.ordinaryAContext,
    input: {}
  }), (error) => (
    error.status === 403 && error.code === 'TRANSPORT_REPORTER_REQUIRED'
  ));
  const reporterWithoutSubmit = Object.freeze({
    ...fixture.reporterAContext,
    permissionKeys: Object.freeze(['report.view'])
  });
  await assert.rejects(recordService.createRecord({
    authContext: reporterWithoutSubmit,
    input: {}
  }), (error) => error.status === 403 && error.code === 'PERMISSION_DENIED');

  const record = await recordService.createRecord({
    authContext: fixture.reporterAContext,
    input: {
      orgUnitId: String(fixture.orgA),
      reportDate: '2026-07-16',
      shift: '白班',
      tripMasterId: trip._id,
      tripLabel: '客户端伪造趟次',
      routeMasterId: route._id,
      route: '客户端伪造路线',
      dispatchType: '配送',
      vehiclePlateMasterId: vehiclePlate._id,
      vehiclePlate: 'CLIENT-PLATE',
      vehicleTypeMasterId: vehicleType._id,
      vehicleType: '客户端车型',
      driverMasterId: driver._id,
      driverName: '客户端司机',
      loadDetails: { standardPlasticPallet: 2 },
      photoFileIds: photos.map(({ _id }) => String(_id)),
      remark: '主数据快照测试'
    }
  });

  assert.equal(record.tripMasterId, trip._id);
  assert.equal(record.tripLabel, '第十车');
  assert.equal(record.routeMasterId, route._id);
  assert.equal(record.route, '仓库至客户工厂');
  assert.equal(record.vehiclePlateMasterId, vehiclePlate._id);
  assert.equal(record.vehiclePlate, '鲁AA2991');
  assert.equal(record.vehicleTypeMasterId, vehicleType._id);
  assert.equal(record.vehicleType, '厢式货车');
  assert.equal(record.driverMasterId, driver._id);
  assert.equal(record.driverName, '张师傅');

  await assert.rejects(recordService.createRecord({
    authContext: fixture.reporterAContext,
    input: {
      orgUnitId: String(fixture.orgA),
      reportDate: '2026-07-16',
      shift: '白班',
      tripMasterId: trip._id,
      routeMasterId: route._id,
      dispatchType: '配送',
      vehiclePlateMasterId: vehiclePlate._id,
      vehicleTypeMasterId: vehicleType._id,
      driverName: '不能用原始文本代替司机主数据',
      photoFileIds: photos.map(({ _id }) => String(_id))
    }
  }), (error) => error.code === 'TRANSPORT_MASTER_SELECTION_REQUIRED');

  await assert.rejects(recordService.createRecord({
    authContext: fixture.reporterAContext,
    input: {
      orgUnitId: String(fixture.orgA),
      reportDate: '2026-07-16',
      shift: '白班',
      tripMasterId: trip._id,
      routeMasterId: route._id,
      dispatchType: '配送',
      vehiclePlateMasterId: vehiclePlate._id,
      driverMasterId: driver._id,
      photoFileIds: photos.map(({ _id }) => String(_id))
    }
  }), (error) => error.code === 'TRANSPORT_MASTER_SELECTION_REQUIRED');

  await assert.rejects(recordService.updateRecord({
    authContext: fixture.ordinaryAContext,
    transportRecordId: record._id,
    input: { remark: 'ordinary users cannot update transport records' }
  }), (error) => (
    error.status === 403 && error.code === 'TRANSPORT_REPORTER_REQUIRED'
  ));

  const superPhotos = await temporaryPhotos(fixture.teamA, fixture.superAdmin);
  const superRecord = await recordService.createRecord({
    authContext: fixture.superAdminAContext,
    input: {
      orgUnitId: String(fixture.orgA),
      reportDate: '2026-07-17',
      shift: record.shift,
      tripMasterId: trip._id,
      routeMasterId: route._id,
      dispatchType: record.dispatchType,
      vehiclePlateMasterId: vehiclePlate._id,
      vehicleTypeMasterId: vehicleType._id,
      driverMasterId: driver._id,
      loadDetails: { standardPlasticPallet: 1 },
      photoFileIds: superPhotos.map(({ _id }) => String(_id))
    }
  });
  assert.equal(superRecord.createdBy, String(fixture.superAdmin));

  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: trip._id,
    input: { name: '第十车（新）' }
  });
  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: route._id,
    input: { name: '仓库至新工厂' }
  });
  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: vehiclePlate._id,
    input: { name: '鲁AA2991（新）' }
  });
  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: vehicleType._id,
    input: { name: '新能源货车' }
  });
  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: driver._id,
    input: { name: '李师傅' }
  });

  const historical = await recordService.getRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id
  });
  assert.equal(historical.tripLabel, '第十车');
  assert.equal(historical.route, '仓库至客户工厂');
  assert.equal(historical.vehiclePlate, '鲁AA2991');
  assert.equal(historical.vehicleType, '厢式货车');
  assert.equal(historical.driverName, '张师傅');

  const unchanged = await recordService.updateRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id,
    input: {
      tripMasterId: trip._id,
      tripLabel: 'forged trip snapshot',
      routeMasterId: route._id,
      route: 'forged route snapshot',
      vehiclePlateMasterId: vehiclePlate._id,
      vehiclePlate: 'FORGED-PLATE',
      vehicleTypeMasterId: vehicleType._id,
      vehicleType: 'forged vehicle type',
      driverMasterId: driver._id,
      driverName: 'forged driver'
    }
  });
  assert.equal(unchanged.tripLabel, '第十车');
  assert.equal(unchanged.route, '仓库至客户工厂');
  assert.equal(unchanged.vehiclePlate, '鲁AA2991');
  assert.equal(unchanged.vehicleType, '厢式货车');
  assert.equal(unchanged.driverName, '张师傅');

  const replacements = {};
  for (const [field, kind, name] of [
    ['tripMasterId', TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP, '第十一车'],
    ['routeMasterId', TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE, '仓库至新工厂二线'],
    ['vehiclePlateMasterId', TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE, '鲁AV1515'],
    ['vehicleTypeMasterId', TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE, '新能源厢式二型'],
    ['driverMasterId', TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER, '王师傅']
  ]) {
    replacements[field] = await createMaster(fixture.masterManagerAContext, { kind, name });
  }
  const changedSelection = await recordService.updateRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id,
    input: Object.fromEntries(Object.entries(replacements).map(([field, master]) => [field, master._id]))
  });
  assert.equal(changedSelection.tripLabel, '第十一车');
  assert.equal(changedSelection.route, '仓库至新工厂二线');
  assert.equal(changedSelection.vehiclePlate, '鲁AV1515');
  assert.equal(changedSelection.vehicleType, '新能源厢式二型');
  assert.equal(changedSelection.driverName, '王师傅');

  for (const masterDataId of Object.values(replacements).map(({ _id }) => _id)) {
    await service.setMasterDataStatus({
      authContext: fixture.masterManagerAContext,
      masterDataId,
      input: { status: TransportMasterData.TRANSPORT_MASTER_STATUSES.DISABLED }
    });
  }

  const unrelatedEdit = await recordService.updateRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id,
    input: { remark: 'unrelated edit after master data was disabled' }
  });
  assert.equal(unrelatedEdit.tripLabel, changedSelection.tripLabel);
  assert.equal(unrelatedEdit.route, changedSelection.route);
  assert.equal(unrelatedEdit.vehiclePlate, changedSelection.vehiclePlate);
  assert.equal(unrelatedEdit.vehicleType, changedSelection.vehicleType);
  assert.equal(unrelatedEdit.driverName, changedSelection.driverName);

  await assert.rejects(recordService.updateRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id,
    input: { tripMasterId: null, tripLabel: 'forged snapshot after disable' }
  }), (error) => error.code === 'REPORT_RELATED_RESOURCE_INVALID');
  await assert.rejects(recordService.updateRecord({
    authContext: fixture.reporterAContext,
    transportRecordId: record._id,
    input: { tripMasterId: route._id }
  }), (error) => error.code === 'TRANSPORT_MASTER_SELECTION_INVALID');
});

test('transport master-data backfill is dry-run by default and idempotently preserves snapshots', async () => {
  const base = {
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA,
    shift: '白班',
    tripLabel: '第十二车',
    route: '仓库至装配厂',
    dispatchType: '配送',
    vehiclePlate: '鲁AV1528',
    vehicleType: '厢式货车',
    driverName: '王师傅',
    loadDetails: { standardPlasticPallet: 8 },
    photoFileIds: [],
    remark: '',
    submittedAt: new Date('2026-07-17T01:00:00.000Z'),
    createdBy: fixture.reporterA,
    updatedBy: fixture.reporterA
  };
  await TransportRecord.create([
    { ...base, reportDate: '2026-07-16' },
    { ...base, reportDate: '2026-07-17' }
  ]);
  const backfill = createTransportMasterDataBackfillService({
    auditService: createAuditService({ AuditLog }),
    backupVerifier: async (backupDirectory, options) => {
      assert.equal(backupDirectory, 'E:\\verified-transport-backup');
      assert.deepEqual(options, { verifyFiles: true });
      return {
        backupDirectory,
        manifestSha256: 'a'.repeat(64),
        manifest: {
          backupId: 'backup-20260723T010000Z-12345678',
          completedAt: '2026-07-23T01:00:00.000Z',
          database: {
            name: DATABASE_NAME,
            collections: [{ name: 'transportrecords' }]
          },
          files: [{ file: `database/${DATABASE_NAME}/transportrecords.bson` }]
        }
      };
    },
    connection: mongoose.connection
  });
  const executeOptions = {
    execute: true,
    confirmDatabase: DATABASE_NAME,
    backupDirectory: 'E:\\verified-transport-backup'
  };
  await assert.rejects(
    backfill.run({ ...executeOptions, confirmDatabase: 'wrong_database' }),
    (error) => error.code === 'DATABASE_CONFIRMATION_MISMATCH'
  );
  await assert.rejects(
    backfill.run({ ...executeOptions, backupDirectory: undefined }),
    (error) => error.code === 'BACKUP_DIRECTORY_REQUIRED'
  );
  const incompleteBackup = createTransportMasterDataBackfillService({
    backupVerifier: async () => ({
      manifest: {
        database: {
          name: DATABASE_NAME,
          collections: [{ name: 'transportrecords' }]
        },
        files: []
      }
    }),
    connection: mongoose.connection
  });
  await assert.rejects(
    incompleteBackup.run(executeOptions),
    (error) => error.code === 'BACKUP_TRANSPORT_RECORDS_MISSING'
  );

  const preview = await backfill.run();
  assert.equal(preview.mode, 'dry-run');
  assert.equal(preview.mastersToCreate, 5);
  assert.equal(preview.recordsToUpdate, 2);
  assert.equal(preview.writePerformed, false);
  assert.equal(await TransportMasterData.countDocuments({}), 0);

  const first = await backfill.run(executeOptions);
  assert.equal(first.mastersCreated, 5);
  assert.equal(first.recordsUpdated, 2);
  assert.equal(first.writePerformed, true);
  const recordsAfter = await TransportRecord.find({}).sort({ reportDate: 1 }).lean();
  assert.ok(recordsAfter.every((record) => (
    record.tripMasterId &&
    record.routeMasterId &&
    record.vehiclePlateMasterId &&
    record.vehicleTypeMasterId &&
    record.driverMasterId
  )));
  assert.ok(recordsAfter.every((record) => (
    record.tripLabel === '第十二车' &&
    record.route === '仓库至装配厂' &&
    record.vehiclePlate === '鲁AV1528' &&
    record.vehicleType === '厢式货车' &&
    record.driverName === '王师傅'
  )));

  const preservedReferences = recordsAfter.map((record) => (
    MASTER_REFERENCE_FIELDS.map(({ field }) => String(record[field]))
  ));
  await service.updateMasterData({
    authContext: fixture.masterManagerAContext,
    masterDataId: recordsAfter[0].tripMasterId,
    input: { name: 'renamed trip master' }
  });

  const second = await backfill.run(executeOptions);
  assert.equal(second.mastersCreated, 0);
  assert.equal(second.recordsUpdated, 0);
  assert.equal(second.writePerformed, false);
  assert.equal(await TransportMasterData.countDocuments({}), 5);
  const recordsAfterRenameRerun = await TransportRecord.find({}).sort({ reportDate: 1 }).lean();
  assert.deepEqual(recordsAfterRenameRerun.map((record) => (
    MASTER_REFERENCE_FIELDS.map(({ field }) => String(record[field]))
  )), preservedReferences);
  assert.equal(await TransportMasterData.countDocuments({
    kind: TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    name: recordsAfter[0].tripLabel
  }), 0);
  assert.equal(await AuditLog.countDocuments({
    action: permissions.AUDIT_ACTIONS.IMPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA
  }), 1);
});
