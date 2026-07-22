'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (moduleName) => require(require.resolve(moduleName, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentChangeRecord = require('../../../app/models/EquipmentChangeRecord');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRegistryService
} = require('../../../app/services/equipmentRegistryService');

const TEST_DATABASE_NAME = 'equipment_registry_isolation_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentChangeRecord,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];
const EQUIPMENT_PERMISSIONS = Object.freeze([
  'equipment.view',
  'equipment.create',
  'equipment.edit',
  'equipment.export',
  'equipment.qrcode'
]);

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
    user: Object.freeze({ _id: String(userId), username: `user-${userId}` }),
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
    permissionKeys: EQUIPMENT_PERMISSIONS,
    moduleDataScopes: Object.freeze({ equipment: scope }),
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
    user: Object.freeze({ _id: String(userId), username: 'super-admin' }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['equipment.view']),
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
    userA1: objectId(),
    userA2: objectId(),
    userB1: objectId(),
    superAdmin: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA1,
      username: 'equipment-a1',
      usernameNormalized: 'equipment-a1',
      password: 'unused',
      name: 'Equipment A1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userA2,
      username: 'equipment-a2',
      usernameNormalized: 'equipment-a2',
      password: 'unused',
      name: 'Equipment A2',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB1,
      username: 'equipment-b1',
      usernameNormalized: 'equipment-b1',
      password: 'unused',
      name: 'Equipment B1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.superAdmin,
      username: 'equipment-super',
      usernameNormalized: 'equipment-super',
      password: 'unused',
      name: 'Equipment Super',
      roles: [],
      isSuperAdmin: true,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'EQUIPMENT_A',
      name: 'Equipment Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.superAdmin
    },
    {
      _id: ids.teamB,
      code: 'EQUIPMENT_B',
      name: 'Equipment Team B',
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
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
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
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'B1',
      name: 'B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.collection.insertMany([
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userA1,
      orgUnitId: ids.orgA1,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: EQUIPMENT_PERMISSIONS,
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userA2,
      orgUnitId: ids.orgA2,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: EQUIPMENT_PERMISSIONS,
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      userId: ids.userB1,
      orgUnitId: ids.orgB1,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: EQUIPMENT_PERMISSIONS,
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    }
  ]);
  return ids;
}

async function category(service, context, orgUnitId, name) {
  return service.createCategory({
    authContext: context,
    input: { name }
  });
}

async function equipment(service, context, input) {
  return service.createAsset({
    authContext: context,
    input: {
      assetCode: input.assetCode,
      name: input.name || input.assetCode,
      orgUnitId: String(input.orgUnitId),
      categoryId: String(input.categoryId),
      custodianUserId: input.custodianUserId ? String(input.custodianUserId) : null,
      location: input.location || ''
    }
  });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
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

test('ORG_UNIT scope hides other divisions and teams with the same detail 404', async () => {
  const service = createEquipmentRegistryService();
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const ordinaryOrgA1 = teamContext({
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
  const categoryA1 = await category(service, teamA, fixture.orgA1, 'A1 Category');
  const categoryA2 = await category(service, teamA, fixture.orgA2, 'A2 Category');
  const categoryB = await category(service, teamB, fixture.orgB1, 'B Category');
  const assetA1 = await equipment(service, teamA, {
    assetCode: 'A1-001', orgUnitId: fixture.orgA1, categoryId: categoryA1._id
  });
  const assetA2 = await equipment(service, teamA, {
    assetCode: 'A2-001', orgUnitId: fixture.orgA2, categoryId: categoryA2._id
  });
  const assetB = await equipment(service, teamB, {
    assetCode: 'B-001', orgUnitId: fixture.orgB1, categoryId: categoryB._id
  });

  const listed = await service.listAssets({ authContext: orgA1 });
  assert.deepEqual(listed.equipment.map((item) => item.assetCode), ['A1-001']);
  await EquipmentAsset.updateOne(
    { _id: assetA1._id },
    { $set: { productCode: 'VIN-SEARCH-001', plateNumber: 'TEST-PLATE-06' } }
  );
  const searchedByProductCode = await service.listAssets({
    authContext: orgA1,
    query: { keyword: 'VIN-SEARCH' }
  });
  assert.deepEqual(searchedByProductCode.equipment.map((item) => item.assetCode), ['A1-001']);
  assert.equal(searchedByProductCode.equipment[0].plateNumber, 'TEST-PLATE-06');
  const missingId = objectId();
  await assert.rejects(
    service.getAsset({ authContext: orgA1, equipmentId: assetA2._id }),
    (error) => error.status === 404 && error.message === 'Equipment does not exist'
  );
  await assert.rejects(
    service.getAsset({ authContext: orgA1, equipmentId: assetB._id }),
    (error) => error.status === 404 && error.message === 'Equipment does not exist'
  );
  await assert.rejects(
    service.getAsset({ authContext: orgA1, equipmentId: missingId }),
    (error) => error.status === 404 && error.message === 'Equipment does not exist'
  );
  const sharedCategory = await service.getCategory({
    authContext: orgA1,
    categoryId: categoryA2._id
  });
  assert.equal(sharedCategory._id, categoryA2._id);
  const categories = await service.listCategories({ authContext: ordinaryOrgA1 });
  assert.deepEqual(
    categories.categories.map((item) => item.name).sort(),
    ['A1 Category', 'A2 Category']
  );
  const scopedOptions = await service.listOptions({ authContext: ordinaryOrgA1 });
  assert.deepEqual(scopedOptions.orgUnits.map((item) => item._id), [String(fixture.orgA1)]);
  assert.deepEqual(scopedOptions.custodians.map((item) => item._id), [String(fixture.userA1)]);
  const teamOptions = await service.listOptions({ authContext: teamA });
  assert.deepEqual(
    teamOptions.orgUnits.map((item) => item._id).sort(),
    [String(fixture.orgA1), String(fixture.orgA2)].sort()
  );
  assert.deepEqual(
    teamOptions.custodians.map((item) => item._id).sort(),
    [String(fixture.userA1), String(fixture.userA2)].sort()
  );
  await assert.rejects(
    service.getCategory({ authContext: ordinaryOrgA1, categoryId: categoryB._id }),
    (error) => error.status === 404
  );
  await assert.rejects(service.createCategory({
    authContext: ordinaryOrgA1,
    input: { name: 'Member cannot create shared category' }
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_TEAM_SCOPE_REQUIRED');
  assert.equal(assetA1.teamId, String(fixture.teamA));
});

test('client teamId and foreign category or custodian references are rejected', async () => {
  const service = createEquipmentRegistryService();
  const contextA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const contextB = teamContext({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB1
  });
  const categoryA = await category(service, contextA, fixture.orgA1, 'A Category');
  const categoryB = await category(service, contextB, fixture.orgB1, 'B Category');

  await assert.rejects(service.createAsset({
    authContext: contextA,
    input: {
      teamId: String(fixture.teamB),
      orgUnitId: String(fixture.orgA1),
      categoryId: categoryA._id,
      assetCode: 'SMUGGLE',
      name: 'Smuggle'
    }
  }), (error) => error.code === 'EQUIPMENT_TEAM_ID_IMMUTABLE');
  await assert.rejects(service.createAsset({
    authContext: contextA,
    input: {
      orgUnitId: String(fixture.orgA1),
      categoryId: categoryB._id,
      assetCode: 'FOREIGN-CATEGORY',
      name: 'Foreign category'
    }
  }), (error) => error.code === 'EQUIPMENT_RELATED_RESOURCE_INVALID');
  await assert.rejects(service.createAsset({
    authContext: contextA,
    input: {
      orgUnitId: String(fixture.orgA1),
      categoryId: categoryA._id,
      custodianUserId: String(fixture.userB1),
      assetCode: 'FOREIGN-USER',
      name: 'Foreign user'
    }
  }), (error) => error.code === 'EQUIPMENT_RELATED_RESOURCE_INVALID');
  assert.equal(await EquipmentAsset.countDocuments({}), 0);
});

test('asset create and edit atomically append change records and audit logs', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const categoryA = await category(service, context, fixture.orgA1, 'Audit Category');
  const created = await equipment(service, context, {
    assetCode: 'AUDIT-001',
    orgUnitId: fixture.orgA1,
    categoryId: categoryA._id,
    custodianUserId: fixture.userA1
  });
  assert.equal(created.status, EquipmentAsset.EQUIPMENT_STATUSES.IN_USE);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'qrToken'), false);

  await assert.rejects(service.updateAsset({
    authContext: context,
    equipmentId: created._id,
    input: { status: EquipmentAsset.EQUIPMENT_STATUSES.IDLE }
  }), (error) => error.code === 'EQUIPMENT_STATUS_APPROVAL_REQUIRED');
  const updated = await service.updateAsset({
    authContext: context,
    equipmentId: created._id,
    input: { name: 'Updated asset', reason: 'Correct asset name' }
  });
  assert.equal(updated.name, 'Updated asset');
  assert.equal(await EquipmentChangeRecord.countDocuments({ equipmentId: created._id }), 2);
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
    resourceId: created._id
  }), 2);

  const failingService = createEquipmentRegistryService({
    auditService: { record: async () => { throw new Error('forced audit failure'); } }
  });
  await assert.rejects(equipment(failingService, context, {
    assetCode: 'ROLLBACK-001',
    orgUnitId: fixture.orgA1,
    categoryId: categoryA._id
  }), /forced audit failure/);
  assert.equal(await EquipmentAsset.countDocuments({ assetCode: 'ROLLBACK-001' }), 0);
  assert.equal(await EquipmentChangeRecord.countDocuments({
    'after.assetCode': 'ROLLBACK-001'
  }), 0);
});

test('equipment change history rejects document saves and bulk mutations', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const assetCategory = await category(service, context, fixture.orgA1, 'Immutable History');
  const asset = await equipment(service, context, {
    assetCode: 'IMMUTABLE-001',
    orgUnitId: fixture.orgA1,
    categoryId: assetCategory._id
  });
  const change = await EquipmentChangeRecord.findOne({ equipmentId: asset._id });
  const originalAfter = change.toObject().after;

  await assert.rejects(change.save(), /append-only/);
  await assert.rejects(
    EquipmentChangeRecord.bulkWrite([{
      updateOne: {
        filter: { _id: change._id },
        update: { $set: { after: { name: 'tampered by bulk write' } } }
      }
    }]),
    /append-only/
  );

  const persisted = await EquipmentChangeRecord.findById(change._id).lean();
  assert.deepEqual(persisted.after, originalAfter);
});

test('assetCode is unique inside a team but reusable by another team', async () => {
  const service = createEquipmentRegistryService();
  const contextA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const contextB = teamContext({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB1
  });
  const categoryA1 = await category(service, contextA, fixture.orgA1, 'Unique A1');
  const categoryA2 = await category(service, contextA, fixture.orgA2, 'Unique A2');
  const categoryB = await category(service, contextB, fixture.orgB1, 'Unique B');
  await equipment(service, contextA, {
    assetCode: 'SHARED-001', orgUnitId: fixture.orgA1, categoryId: categoryA1._id
  });
  await assert.rejects(equipment(service, contextA, {
    assetCode: 'SHARED-001', orgUnitId: fixture.orgA2, categoryId: categoryA2._id
  }), (error) => error.code === 'EQUIPMENT_ASSET_CODE_DUPLICATE');
  const otherTeam = await equipment(service, contextB, {
    assetCode: 'SHARED-001', orgUnitId: fixture.orgB1, categoryId: categoryB._id
  });
  assert.equal(otherTeam.teamId, String(fixture.teamB));
});

test('Excel export is re-filtered by organization scope and neutralizes formulas', async () => {
  const service = createEquipmentRegistryService();
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const categoryA1 = await category(service, teamA, fixture.orgA1, 'Export A1');
  const categoryA2 = await category(service, teamA, fixture.orgA2, 'Export A2');
  await equipment(service, teamA, {
    assetCode: '=A1',
    name: 'A1_VISIBLE',
    orgUnitId: fixture.orgA1,
    categoryId: categoryA1._id
  });
  await equipment(service, teamA, {
    assetCode: 'A2-SECRET',
    name: 'A2_SECRET',
    orgUnitId: fixture.orgA2,
    categoryId: categoryA2._id
  });

  const exported = await service.exportAssets({ authContext: orgA1, query: {} });
  const workbook = XLSX.read(exported.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  const serialized = JSON.stringify(rows);
  assert.match(serialized, /A1_VISIBLE/);
  assert.match(serialized, /'=A1/);
  assert.doesNotMatch(serialized, /A2_SECRET/);
});

test('asset type filter is exact for both list and Excel export', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const assetCategory = await category(service, context, fixture.orgA1, 'Asset Type Filter');
  const transport = await equipment(service, context, {
    assetCode: 'TYPE-TRANSPORT',
    orgUnitId: fixture.orgA1,
    categoryId: assetCategory._id
  });
  const handling = await equipment(service, context, {
    assetCode: 'TYPE-HANDLING',
    orgUnitId: fixture.orgA1,
    categoryId: assetCategory._id
  });
  await Promise.all([
    EquipmentAsset.updateOne(
      { _id: transport._id },
      { $set: { assetType: 'TRANSPORT_EQUIPMENT' } }
    ),
    EquipmentAsset.updateOne(
      { _id: handling._id },
      { $set: { assetType: 'HANDLING_EQUIPMENT' } }
    )
  ]);

  const query = { assetType: ' TRANSPORT_EQUIPMENT ' };
  const listed = await service.listAssets({ authContext: context, query });
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.equipment.map((item) => item.assetCode), ['TYPE-TRANSPORT']);

  const exported = await service.exportAssets({ authContext: context, query });
  assert.equal(exported.count, 1);
  const workbook = XLSX.read(exported.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  assert.deepEqual(rows.map((row) => row['Asset Code']), ['TYPE-TRANSPORT']);
  assert.deepEqual(rows.map((row) => row['Asset Type']), ['TRANSPORT_EQUIPMENT']);

  const partial = await service.listAssets({
    authContext: context,
    query: { assetType: 'TRANSPORT' }
  });
  assert.equal(partial.total, 0);
  assert.deepEqual(partial.equipment, []);
});

test('QR payload is opaque, contains no public URL, and lookup retains scope checks', async () => {
  const service = createEquipmentRegistryService();
  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA1 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const orgA2 = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA2,
    userId: fixture.userA2,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const categoryA = await category(service, teamA, fixture.orgA1, 'QR Category');
  const asset = await equipment(service, teamA, {
    assetCode: 'QR-001', orgUnitId: fixture.orgA1, categoryId: categoryA._id
  });
  const qr = await service.getQrPayload({ authContext: teamA, equipmentId: asset._id });
  assert.doesNotMatch(qr.payload, /https?:\/\//i);
  const parsed = JSON.parse(qr.payload);
  assert.equal(parsed.type, 'EQUIPMENT_ASSET');
  assert.match(parsed.token, /^[A-Za-z0-9_-]{43,86}$/);
  const qrAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.GENERATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
    resourceId: asset._id
  }).lean();
  assert.ok(qrAudit);
  assert.equal(JSON.stringify(qrAudit).includes(parsed.token), false);
  const resolved = await service.getAssetByQrToken({
    authContext: orgA1,
    qrToken: parsed.token
  });
  assert.equal(resolved._id, asset._id);
  await assert.rejects(service.getAssetByQrToken({
    authContext: orgA2,
    qrToken: parsed.token
  }), (error) => error.status === 404);
});

test('global read-only mode requires an explicit active team and cannot write', async () => {
  const service = createEquipmentRegistryService();
  const contextA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const categoryA = await category(service, contextA, fixture.orgA1, 'Global Category');
  await equipment(service, contextA, {
    assetCode: 'GLOBAL-A', orgUnitId: fixture.orgA1, categoryId: categoryA._id
  });
  const global = globalContext(fixture.superAdmin);
  const listed = await service.listAssets({
    authContext: global,
    requestedTeamId: String(fixture.teamA)
  });
  assert.deepEqual(listed.equipment.map((item) => item.assetCode), ['GLOBAL-A']);
  await assert.rejects(
    service.listAssets({ authContext: global }),
    (error) => error.code === 'EQUIPMENT_TEAM_REQUIRED'
  );
  await assert.rejects(service.createCategory({
    authContext: global,
    input: { orgUnitId: String(fixture.orgA1), name: 'Forbidden' }
  }), (error) => error.status === 403);
});
