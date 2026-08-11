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
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../../../app/models/EquipmentRoutineRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const EquipmentRuntimeReading = require('../../../app/models/EquipmentRuntimeReading');
const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRegistryService
} = require('../../../app/services/equipmentRegistryService');
const {
  createEquipmentRoutineService
} = require('../../../app/services/equipmentRoutineService');
const {
  createEquipmentRoutineWorkflowService
} = require('../../../app/services/equipmentRoutineWorkflowService');
const {
  createEquipmentRoutineWorkerService
} = require('../../../app/services/equipmentRoutineWorkerService');
const { createTeamContextService } = require('../../../app/services/teamContextService');

const TEST_DATABASE_NAME = 'equipment_registry_isolation_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentChangeRecord,
  EquipmentRoutinePlan,
  EquipmentRoutineRecord,
  EquipmentRoutineRule,
  EquipmentRuntimeReading,
  FileAsset,
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
  'equipment.inspect',
  'equipment.qrcode'
]);

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, message, timeoutMs = 10000) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeout));
}

function pauseFirstEquipmentCategoryStructureLock() {
  const locked = deferred();
  const release = deferred();
  let first = true;
  return {
    locked: locked.promise,
    release: release.resolve,
    ProjectTeamModel: {
      async findOneAndUpdate(...args) {
        const team = await ProjectTeam.findOneAndUpdate(...args);
        if (first) {
          first = false;
          locked.resolve();
          await release.promise;
        }
        return team;
      }
    }
  };
}

function observeNextMongoWriteConflict(timeoutMs = 10000) {
  const client = mongoose.connection.getClient();
  let timer;
  let settled = false;
  let listener;
  const cleanup = () => {
    clearTimeout(timer);
    client.off('commandFailed', listener);
  };
  const promise = new Promise((resolve, reject) => {
    listener = (event) => {
      if (event.failure?.code !== 112 && event.failure?.codeName !== 'WriteConflict') return;
      settled = true;
      cleanup();
      resolve(event);
    };
    client.on('commandFailed', listener);
    timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error('Timed out waiting for a real MongoDB WriteConflict'));
    }, timeoutMs);
  });
  return {
    promise,
    dispose() {
      if (settled) return;
      settled = true;
      cleanup();
    }
  };
}

function teamContext({
  teamId,
  orgUnitId,
  userId,
  scope = permissions.DATA_SCOPES.TEAM,
  role = permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
  equipmentOrgUnitScopeIds = undefined
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
    ...(equipmentOrgUnitScopeIds
      ? { equipmentOrgUnitScopeIds: Object.freeze(equipmentOrgUnitScopeIds.map(String)) }
      : {}),
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
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME,
    monitorCommands: true
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

test('equipment branch scope includes the second-level division and all child groups only', async () => {
  const service = createEquipmentRegistryService();
  const subA = objectId();
  const groupA1 = objectId();
  const groupA2 = objectId();
  const disabledGroup = objectId();
  const subA2 = objectId();
  await OrgUnit.collection.insertMany([
    {
      _id: subA,
      teamId: fixture.teamA,
      parentId: fixture.orgA1,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'BRANCH_SUB_A',
      name: 'Branch Sub A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 2,
      path: `/${fixture.orgA1}/`
    },
    {
      _id: groupA1,
      teamId: fixture.teamA,
      parentId: subA,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'BRANCH_GROUP_A1',
      name: 'Branch Group A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 3,
      path: `/${fixture.orgA1}/${subA}/`
    },
    {
      _id: groupA2,
      teamId: fixture.teamA,
      parentId: subA,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'BRANCH_GROUP_A2',
      name: 'Branch Group A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 3,
      path: `/${fixture.orgA1}/${subA}/`
    },
    {
      _id: subA2,
      teamId: fixture.teamA,
      parentId: fixture.orgA1,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'BRANCH_SUB_A2',
      name: 'Branch Sub A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 2,
      path: `/${fixture.orgA1}/`
    },
    {
      _id: disabledGroup,
      teamId: fixture.teamA,
      parentId: subA,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'BRANCH_GROUP_DISABLED',
      name: 'Branch Group Disabled',
      status: permissions.ORG_UNIT_STATUSES.DISABLED,
      sortOrder: 2,
      level: 3,
      path: `/${fixture.orgA1}/${subA}/`
    }
  ]);

  const teamA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const branchUserId = objectId();
  await User.collection.insertOne({
    _id: branchUserId,
    username: 'branch-scope-user',
    usernameNormalized: 'branch-scope-user',
    password: 'unused',
    name: 'Branch Scope User',
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  });
  await TeamMembership.collection.insertOne({
    _id: objectId(),
    teamId: fixture.teamA,
    userId: branchUserId,
    orgUnitId: groupA1,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel: permissions.POSITION_LEVEL_BY_KEY[permissions.POSITION_KEYS.TEAM_LEADER],
    positionKey: permissions.POSITION_KEYS.TEAM_LEADER,
    functionalRoleKeys: [],
    permissionKeys: EQUIPMENT_PERMISSIONS,
    moduleDataScopes: permissions.deriveModuleDataScopes({
      positionLevel: permissions.POSITION_LEVEL_BY_KEY[permissions.POSITION_KEYS.TEAM_LEADER]
    }),
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date()
  });
  const branchScope = await createTeamContextService({
    User,
    ProjectTeam,
    TeamMembership,
    OrgUnit
  }).resolveContext({
    claims: {
      sub: String(branchUserId),
      mode: permissions.SESSION_MODES.TEAM,
      activeTeamId: String(fixture.teamA),
      tokenVersion: 0
    },
    session: { _id: objectId() }
  });
  assert.deepEqual(
    [...branchScope.equipmentOrgUnitScopeIds].sort(),
    [String(subA), String(groupA1), String(groupA2)].sort()
  );
  const otherBranchScope = teamContext({
    teamId: fixture.teamA,
    orgUnitId: subA2,
    userId: fixture.userA2,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    equipmentOrgUnitScopeIds: [subA2]
  });
  const assetCategory = await category(service, teamA, fixture.orgA1, 'Branch Scope Category');
  await EquipmentAsset.create({
    teamId: fixture.teamA,
    orgUnitId: disabledGroup,
    assetCode: 'DISABLED-GROUP-ASSET',
    name: 'Disabled Group Asset',
    categoryId: assetCategory._id,
    createdBy: fixture.userA1,
    updatedBy: fixture.userA1
  });
  const subAsset = await equipment(service, teamA, {
    assetCode: 'BRANCH-SUB', orgUnitId: subA, categoryId: assetCategory._id
  });
  const siblingGroupAsset = await equipment(service, teamA, {
    assetCode: 'BRANCH-GROUP-A2', orgUnitId: groupA2, categoryId: assetCategory._id
  });
  await equipment(service, teamA, {
    assetCode: 'OTHER-BRANCH', orgUnitId: subA2, categoryId: assetCategory._id
  });

  const listed = await service.listAssets({ authContext: branchScope });
  assert.deepEqual(listed.equipment.map(({ assetCode }) => assetCode), [
    'BRANCH-GROUP-A2',
    'BRANCH-SUB'
  ]);
  const options = await service.listOptions({ authContext: branchScope });
  assert.deepEqual(
    options.orgUnits.map(({ _id }) => _id).sort(),
    [String(subA), String(groupA1), String(groupA2)].sort()
  );
  assert.equal((await service.getAsset({
    authContext: branchScope,
    equipmentId: subAsset._id
  })).assetCode, 'BRANCH-SUB');

  const qr = await service.getQrPayload({
    authContext: teamA,
    equipmentId: siblingGroupAsset._id
  });
  const token = JSON.parse(qr.payload).token;
  assert.equal((await service.getAssetByQrToken({
    authContext: branchScope,
    qrToken: token
  })).assetCode, 'BRANCH-GROUP-A2');
  await assert.rejects(service.getAssetByQrToken({
    authContext: otherBranchScope,
    qrToken: token
  }), (error) => error.status === 404);

  const createdInSiblingGroup = await equipment(service, branchScope, {
    assetCode: 'BRANCH-WRITE-A2', orgUnitId: groupA2, categoryId: assetCategory._id
  });
  assert.equal(createdInSiblingGroup.orgUnitId, String(groupA2));
  const subDepartmentAssetWithGroupCustodian = await equipment(service, teamA, {
    assetCode: 'BRANCH-CUSTODIAN',
    orgUnitId: subA,
    categoryId: assetCategory._id,
    custodianUserId: branchUserId
  });
  assert.equal(subDepartmentAssetWithGroupCustodian.custodianUserId, String(branchUserId));
  await assert.rejects(equipment(service, teamA, {
    assetCode: 'FOREIGN-BRANCH-CUSTODIAN',
    orgUnitId: subA,
    categoryId: assetCategory._id,
    custodianUserId: fixture.userA2
  }), (error) => error.code === 'EQUIPMENT_RELATED_RESOURCE_INVALID');
  await assert.rejects(equipment(service, branchScope, {
    assetCode: 'OTHER-BRANCH-WRITE', orgUnitId: subA2, categoryId: assetCategory._id
  }), (error) => error.code === 'EQUIPMENT_RELATED_RESOURCE_INVALID');
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

test('interactive equipment writes persist four-level categories, template fields, and up to ten photos', async () => {
  const fileCalls = [];
  const service = createEquipmentRegistryService({
    fileAssetService: {
      async reconcileOwnerFiles(input) {
        fileCalls.push(input);
        return input.attachments.map(({ fileId }) => ({ fileId: String(fileId) }));
      }
    }
  });
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await service.createCategory({
    authContext: context,
    input: { name: '运输装备' }
  });
  const type = await service.createCategory({
    authContext: context,
    input: { name: '车辆', parentId: major._id }
  });
  const primary = await service.createCategory({
    authContext: context,
    input: { name: '厢式货车', parentId: type._id }
  });
  const secondary = await service.createCategory({
    authContext: context,
    input: { name: '4.2米轻卡', parentId: primary._id }
  });
  await assert.rejects(service.createCategory({
    authContext: context,
    input: { name: '不允许的第五级', parentId: secondary._id }
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_DEPTH_LIMIT');

  const movableRoot = await service.createCategory({
    authContext: context,
    input: { name: '待移动分类' }
  });
  await service.createCategory({
    authContext: context,
    input: { name: '待移动分类下级', parentId: movableRoot._id }
  });
  await assert.rejects(service.updateCategory({
    authContext: context,
    categoryId: movableRoot._id,
    input: { parentId: primary._id }
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_DEPTH_LIMIT');
  const firstPhotoId = objectId();
  const secondPhotoId = objectId();
  const created = await service.createAsset({
    authContext: context,
    input: {
      orgUnitId: String(fixture.orgA1),
      categoryId: secondary._id,
      sourceSequence: '1',
      assetCode: '鲁A0C01F',
      name: '4.2米轻卡',
      plateNumber: '鲁A0C01F',
      environmentalRegistrationCode: '/',
      productCode: 'LZZJBADB4KE765069',
      specification: '4.2米轻卡',
      unit: '辆',
      productionDate: '2019-10-01',
      activationDate: '2019-10-01',
      vehicleLength: '4.2米',
      ratedCapacityText: '/',
      forkliftPosition: '/',
      powerType: '柴油',
      emissionStandard: '国5',
      brand: '豪沃',
      manufacturer: '中国重汽',
      bookQuantity: 1,
      physicalQuantity: 1,
      quantity: 1,
      location: '外仓',
      photoFileIds: [String(firstPhotoId), String(secondPhotoId)]
    }
  });
  assert.deepEqual([
    created.majorCategoryName,
    created.equipmentTypeName,
    created.primaryName,
    created.secondaryName
  ], ['运输装备', '车辆', '厢式货车', '4.2米轻卡']);
  assert.equal(created.assetType, 'TRANSPORT_EQUIPMENT');
  assert.equal(created.powerType, '柴油');
  assert.equal(created.emissionStandard, '国5');
  assert.deepEqual(created.photoFileIds, [String(firstPhotoId), String(secondPhotoId)]);
  assert.equal(fileCalls[0].method, 'POST');
  assert.deepEqual(fileCalls[0].allowedMimeTypes, [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif'
  ]);

  const updated = await service.updateAsset({
    authContext: context,
    equipmentId: created._id,
    input: { photoFileIds: [String(secondPhotoId)], reason: '删除一张旧照片' }
  });
  assert.deepEqual(updated.photoFileIds, [String(secondPhotoId)]);
  assert.equal(fileCalls[1].method, 'PATCH');

  await assert.rejects(service.updateAsset({
    authContext: context,
    equipmentId: created._id,
    input: { photoFileIds: Array.from({ length: 11 }, () => String(objectId())) }
  }), (error) => error.code === 'EQUIPMENT_INPUT_INVALID');
});

test('moving equipment across primary names cancels old open plans but a secondary-only move does not', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await service.createCategory({
    authContext: context,
    input: { name: '装卸装备' }
  });
  const type = await service.createCategory({
    authContext: context,
    input: { name: '叉车', parentId: major._id }
  });
  const primaryA = await service.createCategory({
    authContext: context,
    input: { name: '铅酸叉车', parentId: type._id }
  });
  const secondaryA1 = await service.createCategory({
    authContext: context,
    input: { name: '铅酸叉车一组', parentId: primaryA._id }
  });
  const secondaryA2 = await service.createCategory({
    authContext: context,
    input: { name: '铅酸叉车二组', parentId: primaryA._id }
  });
  const primaryB = await service.createCategory({
    authContext: context,
    input: { name: '锂电叉车', parentId: type._id }
  });
  const secondaryB = await service.createCategory({
    authContext: context,
    input: { name: '锂电叉车一组', parentId: primaryB._id }
  });
  const asset = await equipment(service, context, {
    assetCode: 'MOVE-PRIMARY-001',
    orgUnitId: fixture.orgA1,
    categoryId: secondaryA1._id
  });
  const ruleId = objectId();
  const openPlan = await EquipmentRoutinePlan.create({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    equipmentId: asset._id,
    categoryId: secondaryA1._id,
    ruleId,
    ruleVersion: 1,
    ruleSnapshot: { name: '铅酸叉车点检' },
    routineType: 'INSPECTION',
    cycleKey: 'calendar:2030-01-01T00:00:00.000Z',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
    dueAt: new Date('2030-01-01T01:00:00.000Z'),
    status: 'PLANNED'
  });
  const completedPlan = await EquipmentRoutinePlan.create({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    equipmentId: asset._id,
    categoryId: secondaryA1._id,
    ruleId,
    ruleVersion: 1,
    ruleSnapshot: { name: '铅酸叉车点检' },
    routineType: 'INSPECTION',
    cycleKey: 'calendar:2029-12-31T00:00:00.000Z',
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2029-12-31T00:00:00.000Z'),
    dueAt: new Date('2029-12-31T01:00:00.000Z'),
    status: 'COMPLETED',
    completedRecordId: objectId(),
    completedAt: new Date('2029-12-31T00:30:00.000Z'),
    completedBy: fixture.userA1
  });

  await service.updateAsset({
    authContext: context,
    equipmentId: asset._id,
    input: { categoryId: secondaryA2._id, reason: '仅调整设备二级名称' }
  });
  assert.equal((await EquipmentRoutinePlan.findById(openPlan._id).lean()).status, 'PLANNED');

  const moved = await service.updateAsset({
    authContext: context,
    equipmentId: asset._id,
    input: { categoryId: secondaryB._id, reason: '调整设备一级名称' }
  });
  const cancelled = await EquipmentRoutinePlan.findById(openPlan._id).lean();
  assert.equal(moved.primaryName, '锂电叉车');
  assert.equal(moved.secondaryName, '锂电叉车一组');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancellationReason, 'EQUIPMENT_CATEGORY_CHANGED');
  assert.ok(cancelled.cancelledAt instanceof Date);
  assert.equal(String(cancelled.cancelledBy), String(fixture.userA1));
  assert.equal((await EquipmentRoutinePlan.findById(completedPlan._id).lean()).status, 'COMPLETED');
});

test('organization moves rebind only open routine plans and preserve identity and history across A-B-A', async () => {
  const now = new Date('2030-01-15T12:00:00.000Z');
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  const workflowService = createEquipmentRoutineWorkflowService({ clock: () => new Date(now) });
  const teamAdmin = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const orgB = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA2,
    userId: fixture.userA2,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const major = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Organization move major' }
  });
  const type = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Organization move type', parentId: major._id }
  });
  const primary = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Organization move primary', parentId: type._id }
  });
  const asset = await equipment(registryService, teamAdmin, {
    assetCode: 'ORG-MOVE-001',
    orgUnitId: fixture.orgA1,
    categoryId: primary._id
  });
  const rule = await routineService.createRule({
    authContext: teamAdmin,
    input: {
      routineType: 'INSPECTION',
      categoryId: primary._id,
      name: 'Organization move inspection',
      checklistItems: [{ name: 'Confirm organization ownership' }],
      schedule: { mode: 'MANUAL' }
    }
  });
  const createPlan = ({ suffix, status, scheduledFor, dueAt, ...metadata }) => (
    EquipmentRoutinePlan.create({
      teamId: fixture.teamA,
      orgUnitId: fixture.orgA1,
      equipmentId: asset._id,
      categoryId: primary._id,
      ruleId: rule._id,
      ruleVersion: rule.version,
      ruleSnapshot: { name: rule.name },
      routineType: 'INSPECTION',
      cycleKey: `organization-move:${suffix}`,
      windowKey: suffix.toUpperCase(),
      windowName: suffix,
      scheduledFor: new Date(scheduledFor),
      dueAt: new Date(dueAt),
      status,
      ...metadata
    })
  );
  const [planned, inWindow, overdue, completed, cancelled] = await Promise.all([
    createPlan({
      suffix: 'planned',
      status: 'PLANNED',
      scheduledFor: '2030-01-16T08:00:00.000Z',
      dueAt: '2030-01-16T16:00:00.000Z'
    }),
    createPlan({
      suffix: 'in-window',
      status: 'IN_WINDOW',
      scheduledFor: '2030-01-15T08:00:00.000Z',
      dueAt: '2030-01-15T16:00:00.000Z'
    }),
    createPlan({
      suffix: 'overdue',
      status: 'OVERDUE',
      scheduledFor: '2030-01-14T08:00:00.000Z',
      dueAt: '2030-01-14T16:00:00.000Z'
    }),
    createPlan({
      suffix: 'completed-history',
      status: 'COMPLETED',
      scheduledFor: '2030-01-12T08:00:00.000Z',
      dueAt: '2030-01-12T16:00:00.000Z',
      completedRecordId: objectId(),
      completedAt: new Date('2030-01-12T10:00:00.000Z'),
      completedBy: fixture.userA1
    }),
    createPlan({
      suffix: 'cancelled-history',
      status: 'CANCELLED',
      scheduledFor: '2030-01-13T08:00:00.000Z',
      dueAt: '2030-01-13T16:00:00.000Z',
      cancellationReason: 'RULE_UPDATED',
      cancelledAt: new Date('2030-01-13T09:00:00.000Z'),
      cancelledBy: fixture.userA1
    })
  ]);
  const identity = (plan) => ({
    _id: String(plan._id),
    cycleKey: plan.cycleKey,
    windowKey: plan.windowKey,
    scheduledFor: new Date(plan.scheduledFor).toISOString(),
    dueAt: new Date(plan.dueAt).toISOString()
  });
  const history = (plan) => ({
    orgUnitId: String(plan.orgUnitId),
    status: plan.status,
    completedRecordId: plan.completedRecordId ? String(plan.completedRecordId) : null,
    completedAt: plan.completedAt ? new Date(plan.completedAt).toISOString() : null,
    completedBy: plan.completedBy ? String(plan.completedBy) : null,
    cancellationReason: plan.cancellationReason || null,
    cancelledAt: plan.cancelledAt ? new Date(plan.cancelledAt).toISOString() : null,
    cancelledBy: plan.cancelledBy ? String(plan.cancelledBy) : null
  });
  const originalOpenIdentities = new Map(
    [planned, inWindow, overdue].map((plan) => [String(plan._id), identity(plan)])
  );
  const completedHistory = history(completed);
  const cancelledHistory = history(cancelled);

  await registryService.updateAsset({
    authContext: teamAdmin,
    equipmentId: asset._id,
    input: { orgUnitId: String(fixture.orgA2), reason: 'Move to organization B' }
  });

  for (const original of [planned, inWindow, overdue]) {
    const movedPlan = await EquipmentRoutinePlan.findById(original._id).lean();
    assert.equal(String(movedPlan.orgUnitId), String(fixture.orgA2));
    assert.deepEqual(identity(movedPlan), originalOpenIdentities.get(String(original._id)));
    assert.equal((await workflowService.getPlan({
      authContext: orgB,
      planId: original._id
    }))._id, String(original._id));
    await assert.rejects(workflowService.getPlan({
      authContext: orgA,
      planId: original._id
    }), (error) => error.status === 404);
  }
  assert.deepEqual(history(await EquipmentRoutinePlan.findById(completed._id).lean()), completedHistory);
  assert.deepEqual(history(await EquipmentRoutinePlan.findById(cancelled._id).lean()), cancelledHistory);

  const inWindowSubmission = {
    ruleId: rule._id,
    planId: inWindow._id,
    itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }]
  };
  await assert.rejects(routineService.createRecord({
    authContext: orgA,
    equipmentId: asset._id,
    input: inWindowSubmission
  }), (error) => error.status === 404);
  const completedInB = await routineService.createRecord({
    authContext: orgB,
    equipmentId: asset._id,
    input: inWindowSubmission
  });
  assert.equal(completedInB.orgUnitId, String(fixture.orgA2));
  const executedInBPlan = await EquipmentRoutinePlan.findById(inWindow._id).lean();
  assert.equal(executedInBPlan.status, 'COMPLETED');
  assert.equal(String(executedInBPlan.orgUnitId), String(fixture.orgA2));

  await registryService.updateAsset({
    authContext: teamAdmin,
    equipmentId: asset._id,
    input: { orgUnitId: String(fixture.orgA1), reason: 'Return to organization A' }
  });

  for (const original of [planned, overdue]) {
    const returnedPlan = await EquipmentRoutinePlan.findById(original._id).lean();
    assert.equal(String(returnedPlan.orgUnitId), String(fixture.orgA1));
    assert.deepEqual(identity(returnedPlan), originalOpenIdentities.get(String(original._id)));
    assert.equal((await workflowService.getPlan({
      authContext: orgA,
      planId: original._id
    }))._id, String(original._id));
    await assert.rejects(workflowService.getPlan({
      authContext: orgB,
      planId: original._id
    }), (error) => error.status === 404);
  }
  const retainedInB = await EquipmentRoutinePlan.findById(inWindow._id).lean();
  assert.equal(retainedInB.status, 'COMPLETED');
  assert.equal(String(retainedInB.orgUnitId), String(fixture.orgA2));
  assert.deepEqual(history(await EquipmentRoutinePlan.findById(completed._id).lean()), completedHistory);
  assert.deepEqual(history(await EquipmentRoutinePlan.findById(cancelled._id).lean()), cancelledHistory);

  const completedInA = await routineService.createRecord({
    authContext: orgA,
    equipmentId: asset._id,
    input: {
      ruleId: rule._id,
      planId: overdue._id,
      itemResults: [{ itemKey: rule.checklistItems[0].key, result: 'NORMAL' }]
    }
  });
  assert.equal(completedInA.orgUnitId, String(fixture.orgA1));
  const executedInAPlan = await EquipmentRoutinePlan.findById(overdue._id).lean();
  assert.equal(executedInAPlan.status, 'COMPLETED');
  assert.equal(String(executedInAPlan.orgUnitId), String(fixture.orgA1));
});

test('combined category and organization moves rebase recoverable plans before A-B-A worker recovery', async () => {
  const now = new Date('2030-01-15T12:00:00.000Z');
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService({ clock: () => new Date(now) });
  const workflowService = createEquipmentRoutineWorkflowService({ clock: () => new Date(now) });
  const worker = createEquipmentRoutineWorkerService({
    routineService,
    clock: () => new Date(now)
  });
  const teamAdmin = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const orgA = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const orgB = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA2,
    userId: fixture.userA2,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });
  const majorA = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move major A' }
  });
  const typeA = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move type A', parentId: majorA._id }
  });
  const primaryA = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move primary A', parentId: typeA._id }
  });
  const secondaryA = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move secondary A', parentId: primaryA._id }
  });
  const majorB = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move major B' }
  });
  const typeB = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move type B', parentId: majorB._id }
  });
  const primaryB = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move primary B', parentId: typeB._id }
  });
  const secondaryB = await registryService.createCategory({
    authContext: teamAdmin,
    input: { name: 'Combined move secondary B', parentId: primaryB._id }
  });
  const asset = await equipment(registryService, teamAdmin, {
    assetCode: 'COMBINED-MOVE-001',
    orgUnitId: fixture.orgA1,
    categoryId: secondaryA._id
  });
  const rule = await routineService.createRule({
    authContext: teamAdmin,
    input: {
      routineType: 'INSPECTION',
      categoryId: primaryA._id,
      name: 'Combined move inspection',
      checklistItems: [{ name: 'Check combined move' }],
      schedule: {
        mode: 'CALENDAR',
        calendar: {
          unit: 'DAY',
          interval: 1,
          firstDueAt: '2030-01-15T00:00:00.000Z'
        }
      },
      executionConfig: {
        timeZone: 'Asia/Shanghai',
        windows: [{
          key: 'DAY_SHIFT',
          name: 'Day shift',
          startTime: '07:00',
          endTime: '09:00',
          enabled: true
        }],
        weeklyDay: 1,
        monthlyDay: 1,
        inspectionEscalationMinutes: 60,
        locationPolicy: 'OPTIONAL',
        locationPrecisionMeters: null
      }
    }
  });

  await worker.runOnce({ now, teamId: fixture.teamA });
  const original = await EquipmentRoutinePlan.findOne({
    teamId: fixture.teamA,
    ruleId: rule._id,
    equipmentId: asset._id
  }).sort({ scheduledFor: 1, _id: 1 }).lean();
  assert.ok(original);
  assert.equal(original.status, 'OVERDUE');
  assert.equal(String(original.orgUnitId), String(fixture.orgA1));

  await registryService.updateAsset({
    authContext: teamAdmin,
    equipmentId: asset._id,
    input: {
      categoryId: secondaryB._id,
      orgUnitId: String(fixture.orgA2),
      reason: 'Move category and organization together'
    }
  });
  const cancelled = await EquipmentRoutinePlan.findById(original._id).lean();
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancellationReason, 'EQUIPMENT_CATEGORY_CHANGED');
  assert.equal(String(cancelled.orgUnitId), String(fixture.orgA2));

  await registryService.updateAsset({
    authContext: teamAdmin,
    equipmentId: asset._id,
    input: { categoryId: secondaryA._id, reason: 'Return category to the original rule' }
  });
  await worker.runOnce({ now, teamId: fixture.teamA });
  const recovered = await EquipmentRoutinePlan.findById(original._id).lean();
  assert.equal(recovered.status, 'OVERDUE');
  assert.equal(String(recovered.orgUnitId), String(fixture.orgA2));
  assert.equal((await workflowService.getPlan({
    authContext: orgB,
    planId: original._id
  })).orgUnitId, String(fixture.orgA2));
  await assert.rejects(workflowService.getPlan({
    authContext: orgA,
    planId: original._id
  }), (error) => error.status === 404);
});

test('category moves and renames refresh subtree snapshots, cancel only changed primary plans, and roll back atomically', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const [majorA, majorB] = await Promise.all([
    service.createCategory({ authContext: context, input: { name: '搬运设备大类 A' } }),
    service.createCategory({ authContext: context, input: { name: '搬运设备大类 B' } })
  ]);
  const type = await service.createCategory({
    authContext: context,
    input: { name: '叉车类型', parentId: majorA._id }
  });
  const [primaryA, primaryB] = await Promise.all([
    service.createCategory({
      authContext: context,
      input: { name: '铅酸叉车一级名称', parentId: type._id }
    }),
    service.createCategory({
      authContext: context,
      input: { name: '锂电叉车一级名称', parentId: type._id }
    })
  ]);
  const [secondary, rollbackSecondary] = await Promise.all([
    service.createCategory({
      authContext: context,
      input: { name: '待移动二级名称', parentId: primaryA._id }
    }),
    service.createCategory({
      authContext: context,
      input: { name: '回滚验证二级名称', parentId: primaryA._id }
    })
  ]);
  const [firstAsset, secondAsset, rollbackAsset] = await Promise.all([
    equipment(service, context, {
      assetCode: 'CATEGORY-MOVE-001', orgUnitId: fixture.orgA1, categoryId: secondary._id
    }),
    equipment(service, context, {
      assetCode: 'CATEGORY-MOVE-002', orgUnitId: fixture.orgA1, categoryId: secondary._id
    }),
    equipment(service, context, {
      assetCode: 'CATEGORY-MOVE-ROLLBACK', orgUnitId: fixture.orgA1, categoryId: rollbackSecondary._id
    })
  ]);

  async function createPlan(asset, categoryId, cycleKey, status = 'PLANNED') {
    return EquipmentRoutinePlan.create({
      teamId: fixture.teamA,
      orgUnitId: fixture.orgA1,
      equipmentId: asset._id,
      categoryId,
      ruleId: objectId(),
      ruleVersion: 1,
      ruleSnapshot: { name: '分类移动点检' },
      routineType: 'INSPECTION',
      cycleKey,
      windowKey: 'DAY_SHIFT',
      windowName: '白班',
      scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
      dueAt: new Date('2030-01-01T01:00:00.000Z'),
      status,
      ...(status === 'COMPLETED' ? {
        completedRecordId: objectId(),
        completedAt: new Date('2030-01-01T00:30:00.000Z'),
        completedBy: fixture.userA1
      } : {})
    });
  }

  const [firstOpen, secondOpen, completed, rollbackOpen] = await Promise.all([
    createPlan(firstAsset, secondary._id, 'category-move-first'),
    createPlan(secondAsset, secondary._id, 'category-move-second'),
    createPlan(firstAsset, secondary._id, 'category-move-completed', 'COMPLETED'),
    createPlan(rollbackAsset, rollbackSecondary._id, 'category-move-rollback')
  ]);

  await service.updateCategory({
    authContext: context,
    categoryId: type._id,
    input: { parentId: majorB._id, reason: '类型移动但一级名称节点不变' }
  });
  assert.equal((await EquipmentRoutinePlan.findById(firstOpen._id).lean()).status, 'PLANNED');
  assert.equal((await EquipmentRoutinePlan.findById(rollbackOpen._id).lean()).status, 'PLANNED');
  for (const [assetId, primaryName, secondaryName] of [
    [firstAsset._id, primaryA.name, secondary.name],
    [secondAsset._id, primaryA.name, secondary.name],
    [rollbackAsset._id, primaryA.name, rollbackSecondary.name]
  ]) {
    const refreshed = await EquipmentAsset.findById(assetId).lean();
    assert.deepEqual([
      refreshed.majorCategoryName,
      refreshed.equipmentTypeName,
      refreshed.primaryName,
      refreshed.secondaryName
    ], [majorB.name, type.name, primaryName, secondaryName]);
  }

  await service.updateCategory({
    authContext: context,
    categoryId: secondary._id,
    input: { parentId: primaryB._id, reason: '二级名称移动到另一个一级名称' }
  });
  for (const planId of [firstOpen._id, secondOpen._id]) {
    const plan = await EquipmentRoutinePlan.findById(planId).lean();
    assert.equal(plan.status, 'CANCELLED');
    assert.equal(plan.cancellationReason, 'EQUIPMENT_CATEGORY_CHANGED');
    assert.equal(String(plan.cancelledBy), String(fixture.userA1));
  }
  assert.equal((await EquipmentRoutinePlan.findById(completed._id).lean()).status, 'COMPLETED');
  for (const assetId of [firstAsset._id, secondAsset._id]) {
    const refreshed = await EquipmentAsset.findById(assetId).lean();
    assert.deepEqual([
      refreshed.majorCategoryName,
      refreshed.equipmentTypeName,
      refreshed.primaryName,
      refreshed.secondaryName
    ], [majorB.name, type.name, primaryB.name, secondary.name]);
  }

  const renamedPrimaryName = '锂电叉车一级名称（已重命名）';
  await service.updateCategory({
    authContext: context,
    categoryId: primaryB._id,
    input: { name: renamedPrimaryName, reason: '验证一级名称重命名同步设备快照' }
  });
  for (const assetId of [firstAsset._id, secondAsset._id]) {
    const refreshed = await EquipmentAsset.findById(assetId).lean();
    assert.equal(refreshed.primaryName, renamedPrimaryName);
    assert.equal(refreshed.secondaryName, secondary.name);
  }

  const rollbackAssetBefore = await EquipmentAsset.findById(rollbackAsset._id).lean();

  const failingService = createEquipmentRegistryService({
    auditService: {
      record: async () => {
        throw new Error('forced category audit failure');
      }
    }
  });
  await assert.rejects(failingService.updateCategory({
    authContext: context,
    categoryId: rollbackSecondary._id,
    input: {
      name: '不应保留的二级名称',
      parentId: primaryB._id,
      reason: '验证事务回滚'
    }
  }), /forced category audit failure/);
  const rolledBackCategory = await EquipmentCategory.findById(rollbackSecondary._id).lean();
  assert.equal(String(rolledBackCategory.parentId), primaryA._id);
  assert.equal(rolledBackCategory.name, rollbackSecondary.name);
  assert.equal((await EquipmentRoutinePlan.findById(rollbackOpen._id).lean()).status, 'PLANNED');
  const rollbackAssetAfter = await EquipmentAsset.findById(rollbackAsset._id).lean();
  assert.deepEqual({
    majorCategoryName: rollbackAssetAfter.majorCategoryName,
    equipmentTypeName: rollbackAssetAfter.equipmentTypeName,
    primaryName: rollbackAssetAfter.primaryName,
    secondaryName: rollbackAssetAfter.secondaryName
  }, {
    majorCategoryName: rollbackAssetBefore.majorCategoryName,
    equipmentTypeName: rollbackAssetBefore.equipmentTypeName,
    primaryName: rollbackAssetBefore.primaryName,
    secondaryName: rollbackAssetBefore.secondaryName
  });
});

test('a concurrent category rename and asset create share a real write lock and retry with fresh snapshots', async () => {
  const setupService = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await setupService.createCategory({
    authContext: context,
    input: { name: '并发测试大类' }
  });
  const type = await setupService.createCategory({
    authContext: context,
    input: { name: '并发测试类型', parentId: major._id }
  });
  const primary = await setupService.createCategory({
    authContext: context,
    input: { name: '改名前一级名称', parentId: type._id }
  });
  const secondary = await setupService.createCategory({
    authContext: context,
    input: { name: '并发测试二级名称', parentId: primary._id }
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const renameService = createEquipmentRegistryService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const createService = createEquipmentRegistryService();
  const conflict = observeNextMongoWriteConflict();
  const renamedPrimaryName = '重试后一级名称';
  let createPromise;
  const renamePromise = renameService.updateCategory({
    authContext: context,
    categoryId: primary._id,
    input: { name: renamedPrimaryName }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for the category rename to acquire the structure lock'
    );
    createPromise = equipment(createService, context, {
      assetCode: 'CONCURRENT-CREATE-001',
      orgUnitId: fixture.orgA1,
      categoryId: secondary._id
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    const [, created] = await Promise.all([renamePromise, createPromise]);
    assert.equal(created.primaryName, renamedPrimaryName);
  } catch (error) {
    gate.release();
    await Promise.allSettled([renamePromise, createPromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  const persisted = await EquipmentAsset.findOne({ assetCode: 'CONCURRENT-CREATE-001' }).lean();
  assert.deepEqual([
    persisted.majorCategoryName,
    persisted.equipmentTypeName,
    persisted.primaryName,
    persisted.secondaryName
  ], [major.name, type.name, renamedPrimaryName, secondary.name]);
  const finalRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  assert.equal(finalRevision, baselineRevision + 2);
});

test('a concurrent category move and asset move share a real write lock and retry with the latest path', async () => {
  const setupService = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await setupService.createCategory({
    authContext: context,
    input: { name: '并发移动大类' }
  });
  const oldType = await setupService.createCategory({
    authContext: context,
    input: { name: '移动前设备类型', parentId: major._id }
  });
  const newType = await setupService.createCategory({
    authContext: context,
    input: { name: '移动后设备类型', parentId: major._id }
  });
  const sourcePrimary = await setupService.createCategory({
    authContext: context,
    input: { name: '来源一级名称', parentId: oldType._id }
  });
  const sourceSecondary = await setupService.createCategory({
    authContext: context,
    input: { name: '来源二级名称', parentId: sourcePrimary._id }
  });
  const targetPrimary = await setupService.createCategory({
    authContext: context,
    input: { name: '目标一级名称', parentId: oldType._id }
  });
  const targetSecondary = await setupService.createCategory({
    authContext: context,
    input: { name: '目标二级名称', parentId: targetPrimary._id }
  });
  const asset = await equipment(setupService, context, {
    assetCode: 'CONCURRENT-MOVE-001',
    orgUnitId: fixture.orgA1,
    categoryId: sourceSecondary._id
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const categoryMoveService = createEquipmentRegistryService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const assetMoveService = createEquipmentRegistryService();
  const conflict = observeNextMongoWriteConflict();
  let assetMovePromise;
  const categoryMovePromise = categoryMoveService.updateCategory({
    authContext: context,
    categoryId: targetPrimary._id,
    input: { parentId: newType._id }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for the category move to acquire the structure lock'
    );
    assetMovePromise = assetMoveService.updateAsset({
      authContext: context,
      equipmentId: asset._id,
      input: { categoryId: targetSecondary._id }
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    await Promise.all([categoryMovePromise, assetMovePromise]);
  } catch (error) {
    gate.release();
    await Promise.allSettled([categoryMovePromise, assetMovePromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  const persisted = await EquipmentAsset.findById(asset._id).lean();
  assert.equal(String(persisted.categoryId), targetSecondary._id);
  assert.deepEqual([
    persisted.majorCategoryName,
    persisted.equipmentTypeName,
    persisted.primaryName,
    persisted.secondaryName
  ], [major.name, newType.name, targetPrimary.name, targetSecondary.name]);
  const finalRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  assert.equal(finalRevision, baselineRevision + 2);
});

test('category disable and rule activation require an active level-3 path without blocking disabled history edits', async () => {
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await registryService.createCategory({
    authContext: context,
    input: { name: 'Active path major' }
  });
  const type = await registryService.createCategory({
    authContext: context,
    input: { name: 'Active path type', parentId: major._id }
  });
  const primary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Active path primary', parentId: type._id }
  });
  const rule = await routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: primary._id,
      name: 'Active path rule',
      checklistItems: [{ name: 'Check active path' }],
      schedule: { mode: 'MANUAL' }
    }
  });

  await assert.rejects(registryService.disableCategory({
    authContext: context,
    categoryId: primary._id,
    input: { reason: 'Must retain an active rule binding' }
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_IN_USE');
  assert.equal((await EquipmentCategory.findById(primary._id).lean()).status, 'ACTIVE');
  assert.equal((await EquipmentRoutineRule.findById(rule._id).lean()).status, 'ACTIVE');

  await routineService.disableRule({
    authContext: context,
    ruleId: rule._id,
    input: { reason: 'Prepare category disable' }
  });
  const disabledCategory = await registryService.disableCategory({
    authContext: context,
    categoryId: primary._id,
    input: { reason: 'No active rule remains' }
  });
  assert.equal(disabledCategory.status, 'DISABLED');
  const historicalEdit = await routineService.updateRule({
    authContext: context,
    ruleId: rule._id,
    input: { name: 'Disabled historical rule' }
  });
  assert.equal(historicalEdit.name, 'Disabled historical rule');
  assert.equal(historicalEdit.status, 'DISABLED');
  await assert.rejects(routineService.updateRule({
    authContext: context,
    ruleId: rule._id,
    input: { status: 'ACTIVE' }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED');

  await registryService.updateCategory({
    authContext: context,
    categoryId: primary._id,
    input: { status: 'ACTIVE' }
  });
  await EquipmentCategory.updateOne(
    { _id: type._id },
    { $set: { status: 'DISABLED' } }
  );
  await assert.rejects(routineService.updateRule({
    authContext: context,
    ruleId: rule._id,
    input: { status: 'ACTIVE' }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED');
  await assert.rejects(routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: primary._id,
      name: 'Must reject disabled ancestor',
      checklistItems: [{ name: 'Check disabled ancestor' }],
      schedule: { mode: 'MANUAL' }
    }
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED');
});

test('a category move commits before a concurrent rule create retries and rejects the new level-4 binding', async () => {
  const registryService = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule create race major' }
  });
  const type = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule create race type', parentId: major._id }
  });
  const movingPrimary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule create race source primary', parentId: type._id }
  });
  const targetPrimary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule create race target primary', parentId: type._id }
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const moveService = createEquipmentRegistryService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const routineService = createEquipmentRoutineService();
  const conflict = observeNextMongoWriteConflict();
  let createPromise;
  const movePromise = moveService.updateCategory({
    authContext: context,
    categoryId: movingPrimary._id,
    input: { parentId: targetPrimary._id }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for the category move to acquire the shared structure lock'
    );
    createPromise = routineService.createRule({
      authContext: context,
      input: {
        routineType: 'INSPECTION',
        categoryId: movingPrimary._id,
        name: 'Must not bind after concurrent move',
        checklistItems: [{ name: 'Check shared lock' }],
        schedule: { mode: 'MANUAL' }
      }
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    await movePromise;
    await assert.rejects(
      createPromise,
      (error) => error.code === 'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED'
    );
  } catch (error) {
    gate.release();
    await Promise.allSettled([movePromise, createPromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  assert.equal(
    String((await EquipmentCategory.findById(movingPrimary._id).lean()).parentId),
    targetPrimary._id
  );
  assert.equal(await EquipmentRoutineRule.countDocuments({ categoryId: movingPrimary._id }), 0);
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    baselineRevision + 1
  );
});

test('a rule activation commits before a concurrent category move retries and preserves the level-3 binding', async () => {
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule activation race major' }
  });
  const type = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule activation race type', parentId: major._id }
  });
  const movingPrimary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule activation race source primary', parentId: type._id }
  });
  const targetPrimary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Rule activation race target primary', parentId: type._id }
  });
  const rule = await routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: movingPrimary._id,
      name: 'Concurrent activation rule',
      checklistItems: [{ name: 'Check activation lock' }],
      schedule: { mode: 'MANUAL' }
    }
  });
  await routineService.disableRule({
    authContext: context,
    ruleId: rule._id,
    input: { reason: 'Prepare concurrent activation' }
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const activationService = createEquipmentRoutineService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const conflict = observeNextMongoWriteConflict();
  let movePromise;
  const activationPromise = activationService.updateRule({
    authContext: context,
    ruleId: rule._id,
    input: { status: 'ACTIVE' }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for rule activation to acquire the shared structure lock'
    );
    movePromise = registryService.updateCategory({
      authContext: context,
      categoryId: movingPrimary._id,
      input: { parentId: targetPrimary._id }
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    await activationPromise;
    await assert.rejects(
      movePromise,
      (error) => error.code === 'EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT'
    );
  } catch (error) {
    gate.release();
    await Promise.allSettled([activationPromise, movePromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  assert.equal((await EquipmentRoutineRule.findById(rule._id).lean()).status, 'ACTIVE');
  assert.equal(
    String((await EquipmentCategory.findById(movingPrimary._id).lean()).parentId),
    type._id
  );
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    baselineRevision + 1
  );
});

test('rule activation commits before a concurrent category disable retries and rejects the disable', async () => {
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await registryService.createCategory({
    authContext: context,
    input: { name: 'Activation before disable major' }
  });
  const type = await registryService.createCategory({
    authContext: context,
    input: { name: 'Activation before disable type', parentId: major._id }
  });
  const primary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Activation before disable primary', parentId: type._id }
  });
  const rule = await routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: primary._id,
      name: 'Activation before disable rule',
      checklistItems: [{ name: 'Check serialization' }],
      schedule: { mode: 'MANUAL' }
    }
  });
  await routineService.disableRule({
    authContext: context,
    ruleId: rule._id,
    input: { reason: 'Prepare activation race' }
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const activationService = createEquipmentRoutineService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const conflict = observeNextMongoWriteConflict();
  let disablePromise;
  const activationPromise = activationService.updateRule({
    authContext: context,
    ruleId: rule._id,
    input: { status: 'ACTIVE' }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for rule activation to acquire the shared structure lock'
    );
    disablePromise = registryService.disableCategory({
      authContext: context,
      categoryId: primary._id,
      input: { reason: 'Must lose to concurrent activation' }
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    await activationPromise;
    await assert.rejects(
      disablePromise,
      (error) => error.code === 'EQUIPMENT_CATEGORY_IN_USE'
    );
  } catch (error) {
    gate.release();
    await Promise.allSettled([activationPromise, disablePromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  assert.equal((await EquipmentRoutineRule.findById(rule._id).lean()).status, 'ACTIVE');
  assert.equal((await EquipmentCategory.findById(primary._id).lean()).status, 'ACTIVE');
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    baselineRevision + 1
  );
});

test('category disable commits before a concurrent rule activation retries and rejects the activation', async () => {
  const registryService = createEquipmentRegistryService();
  const routineService = createEquipmentRoutineService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await registryService.createCategory({
    authContext: context,
    input: { name: 'Disable before activation major' }
  });
  const type = await registryService.createCategory({
    authContext: context,
    input: { name: 'Disable before activation type', parentId: major._id }
  });
  const primary = await registryService.createCategory({
    authContext: context,
    input: { name: 'Disable before activation primary', parentId: type._id }
  });
  const rule = await routineService.createRule({
    authContext: context,
    input: {
      routineType: 'INSPECTION',
      categoryId: primary._id,
      name: 'Disable before activation rule',
      checklistItems: [{ name: 'Check serialization' }],
      schedule: { mode: 'MANUAL' }
    }
  });
  await routineService.disableRule({
    authContext: context,
    ruleId: rule._id,
    input: { reason: 'Prepare disable race' }
  });
  const baselineRevision = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  const gate = pauseFirstEquipmentCategoryStructureLock();
  const disableService = createEquipmentRegistryService({
    ProjectTeamModel: gate.ProjectTeamModel
  });
  const conflict = observeNextMongoWriteConflict();
  let activationPromise;
  const disablePromise = disableService.disableCategory({
    authContext: context,
    categoryId: primary._id,
    input: { reason: 'Disable before concurrent activation' }
  });

  try {
    await withTimeout(
      gate.locked,
      'Timed out waiting for category disable to acquire the shared structure lock'
    );
    activationPromise = routineService.updateRule({
      authContext: context,
      ruleId: rule._id,
      input: { status: 'ACTIVE' }
    });
    const conflictEvent = await conflict.promise;
    assert.equal(conflictEvent.commandName, 'findAndModify');
    gate.release();
    await disablePromise;
    await assert.rejects(
      activationPromise,
      (error) => error.code === 'EQUIPMENT_ROUTINE_PRIMARY_CATEGORY_REQUIRED'
    );
  } catch (error) {
    gate.release();
    await Promise.allSettled([disablePromise, activationPromise].filter(Boolean));
    throw error;
  } finally {
    gate.release();
    conflict.dispose();
  }

  assert.equal((await EquipmentCategory.findById(primary._id).lean()).status, 'DISABLED');
  assert.equal((await EquipmentRoutineRule.findById(rule._id).lean()).status, 'DISABLED');
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    baselineRevision + 1
  );
});

test('an exhausted category structure write conflict has a stable retryable response', async () => {
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const writeConflict = Object.assign(new Error('simulated exhausted write conflict'), {
    code: 112,
    codeName: 'WriteConflict'
  });
  const service = createEquipmentRegistryService({
    ProjectTeamModel: {
      async findOneAndUpdate() {
        throw writeConflict;
      }
    }
  });

  await assert.rejects(service.createCategory({
    authContext: context,
    input: { name: '不应创建的分类' }
  }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT');
    assert.equal(
      error.message,
      'Equipment category structure changed concurrently; retry the operation'
    );
    return true;
  });
});

test('interactive equipment photos bind and remove real FileAsset records transactionally', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const rootCategory = await category(service, context, fixture.orgA1, '运输装备');
  const photo = await FileAsset.create({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.teamA}/2026/07/00000000-0000-4000-8000-000000000001.png`,
    originalName: 'equipment-photo.png',
    mimeType: 'image/png',
    size: 68,
    sha256: 'a'.repeat(64),
    uploaderId: fixture.userA1,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });

  const created = await service.createAsset({
    authContext: context,
    input: {
      assetCode: 'PHOTO-REAL-001',
      name: '设备照片绑定测试',
      orgUnitId: String(fixture.orgA1),
      categoryId: rootCategory._id,
      photoFileIds: [String(photo._id)]
    }
  });

  const bound = await FileAsset.findById(photo._id).lean();
  assert.deepEqual(created.photoFileIds, [String(photo._id)]);
  assert.equal(bound.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(bound.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT);
  assert.equal(String(bound.ownerId), created._id);

  const updated = await service.updateAsset({
    authContext: context,
    equipmentId: created._id,
    input: { photoFileIds: [] }
  });
  const removed = await FileAsset.findById(photo._id).lean();
  assert.deepEqual(updated.photoFileIds, []);
  assert.equal(removed.status, FileAsset.FILE_STATUSES.DELETED);
  assert.equal(String(removed.deletedBy), String(fixture.userA1));
  assert.ok(removed.deletedAt instanceof Date);
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

test('category names are unique only under the same parent so secondary names can repeat across primary names', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const major = await service.createCategory({
    authContext: context,
    input: { name: '装卸搬运设备' }
  });
  const type = await service.createCategory({
    authContext: context,
    input: { name: '叉车', parentId: major._id }
  });
  const leadAcid = await service.createCategory({
    authContext: context,
    input: { name: '电动叉车（分类：铅酸电池）', parentId: type._id }
  });
  const lithium = await service.createCategory({
    authContext: context,
    input: { name: '电动叉车（分类：锂离子电池）', parentId: type._id }
  });
  const first = await service.createCategory({
    authContext: context,
    input: { name: '电动叉车', parentId: leadAcid._id }
  });
  const repeatedUnderAnotherPrimary = await service.createCategory({
    authContext: context,
    input: { name: '电动叉车', parentId: lithium._id }
  });

  assert.notEqual(first._id, repeatedUnderAnotherPrimary._id);
  await assert.rejects(service.createCategory({
    authContext: context,
    input: { name: '电动叉车', parentId: leadAcid._id }
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_DUPLICATE');
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
  assert.deepEqual(workbook.SheetNames, ['设备台账']);
  assert.deepEqual(rows.map((row) => row.固定资产编号), ['TYPE-TRANSPORT']);

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

test('category deletion requires a disabled unused leaf and keeps audit evidence', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const parent = await service.createCategory({
    authContext: context,
    input: { name: 'Delete parent' }
  });
  const child = await service.createCategory({
    authContext: context,
    input: { name: 'Delete child', parentId: parent._id }
  });
  const revisionAfterCreate = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  assert.equal(revisionAfterCreate, 2);

  await assert.rejects(service.deleteCategory({
    authContext: context,
    categoryId: child._id,
    input: {}
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_CATEGORY_DELETE_REQUIRES_DISABLED'
  ));
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    revisionAfterCreate
  );

  await service.disableCategory({
    authContext: context,
    categoryId: child._id,
    input: { reason: 'Prepare leaf deletion' }
  });
  await service.disableCategory({
    authContext: context,
    categoryId: parent._id,
    input: { reason: 'Prepare parent deletion' }
  });
  const revisionAfterDisable = (await ProjectTeam.findById(fixture.teamA).lean())
    .equipmentCategoryStructureRevision;
  await assert.rejects(service.deleteCategory({
    authContext: context,
    categoryId: parent._id,
    input: {}
  }), (error) => (
    error.status === 409 && error.code === 'EQUIPMENT_CATEGORY_DELETE_HAS_CHILDREN'
  ));
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    revisionAfterDisable
  );

  const deletedChild = await service.deleteCategory({
    authContext: context,
    categoryId: child._id,
    input: { reason: 'Unused child' }
  });
  const deletedParent = await service.deleteCategory({
    authContext: context,
    categoryId: parent._id,
    input: { reason: 'Unused parent' }
  });
  assert.equal(deletedChild.name, 'Delete child');
  assert.equal(deletedParent.name, 'Delete parent');
  assert.equal(await EquipmentCategory.countDocuments({
    _id: { $in: [child._id, parent._id] }
  }), 0);
  assert.equal(await AuditLog.countDocuments({
    resourceId: { $in: [child._id, parent._id] },
    action: permissions.AUDIT_ACTIONS.DELETE
  }), 2);
  assert.equal(
    (await ProjectTeam.findById(fixture.teamA).lean()).equipmentCategoryStructureRevision,
    revisionAfterDisable + 2
  );
});

test('category deletion rejects equipment and routine-rule references', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const equipmentCategory = await category(service, context, fixture.orgA1, 'Equipment reference');
  await equipment(service, context, {
    assetCode: 'CATEGORY-REFERENCE-001',
    orgUnitId: fixture.orgA1,
    categoryId: equipmentCategory._id
  });
  await EquipmentCategory.updateOne(
    { _id: equipmentCategory._id },
    { $set: { status: 'DISABLED' } }
  );
  await assert.rejects(service.deleteCategory({
    authContext: context,
    categoryId: equipmentCategory._id,
    input: {}
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_DELETE_HAS_EQUIPMENT');

  const ruleCategory = await category(service, context, fixture.orgA1, 'Rule reference');
  await EquipmentRoutineRule.collection.insertOne({
    teamId: fixture.teamA,
    categoryId: new mongoose.Types.ObjectId(ruleCategory._id),
    routineType: 'INSPECTION',
    name: 'Referenced rule',
    description: '',
    checklistItems: [{ key: 'item-1', name: '检查项', description: '', required: true, sortOrder: 0 }],
    schedule: { mode: 'MANUAL' },
    photoPolicy: 'NONE',
    abnormalNoteRequired: true,
    executionConfig: {},
    status: 'DISABLED',
    version: 1,
    createdBy: fixture.userA1,
    updatedBy: fixture.userA1,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  await EquipmentCategory.updateOne(
    { _id: ruleCategory._id },
    { $set: { status: 'DISABLED' } }
  );
  await assert.rejects(service.deleteCategory({
    authContext: context,
    categoryId: ruleCategory._id,
    input: {}
  }), (error) => error.code === 'EQUIPMENT_CATEGORY_DELETE_HAS_RULES');
});

test('equipment deletion removes an unused asset and generated plans while retaining audit evidence', async () => {
  const service = createEquipmentRegistryService();
  const context = teamContext({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const equipmentCategory = await category(service, context, fixture.orgA1, 'Delete category');
  const asset = await equipment(service, context, {
    assetCode: 'DELETE-UNUSED-001',
    orgUnitId: fixture.orgA1,
    categoryId: equipmentCategory._id
  });
  await EquipmentRoutinePlan.create({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    equipmentId: asset._id,
    categoryId: equipmentCategory._id,
    ruleId: objectId(),
    ruleVersion: 1,
    ruleSnapshot: { name: 'Generated plan' },
    routineType: 'INSPECTION',
    cycleKey: 'calendar:2030-01-01T00:00:00.000Z',
    windowKey: 'DAY_SHIFT',
    windowName: 'Day shift',
    scheduledFor: new Date('2030-01-01T00:00:00.000Z'),
    dueAt: new Date('2030-01-01T01:00:00.000Z'),
    status: 'PLANNED'
  });

  const deleted = await service.deleteAsset({
    authContext: context,
    equipmentId: asset._id,
    input: { reason: 'Created by mistake' }
  });

  assert.equal(deleted.assetCode, 'DELETE-UNUSED-001');
  assert.equal(await EquipmentAsset.countDocuments({ _id: asset._id }), 0);
  assert.equal(await EquipmentRoutinePlan.countDocuments({ equipmentId: asset._id }), 0);
  assert.equal(await EquipmentChangeRecord.countDocuments({
    equipmentId: asset._id,
    changeType: 'DELETE'
  }), 1);
  assert.equal(await AuditLog.countDocuments({
    resourceId: asset._id,
    action: permissions.AUDIT_ACTIONS.DELETE
  }), 1);
});

test('equipment deletion rejects assets with business history and respects data scope', async () => {
  const service = createEquipmentRegistryService();
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
  const categoryA1 = await category(service, orgA1, fixture.orgA1, 'Delete protected A1');
  const categoryA2 = await category(service, orgA2, fixture.orgA2, 'Delete protected A2');
  const assetA1 = await equipment(service, orgA1, {
    assetCode: 'DELETE-HISTORY-001',
    orgUnitId: fixture.orgA1,
    categoryId: categoryA1._id
  });
  const assetA2 = await equipment(service, orgA2, {
    assetCode: 'DELETE-SCOPE-001',
    orgUnitId: fixture.orgA2,
    categoryId: categoryA2._id
  });
  await EquipmentRuntimeReading.collection.insertOne({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    equipmentId: new mongoose.Types.ObjectId(assetA1._id),
    hours: 1,
    recordedAt: new Date(),
    operatorId: fixture.userA1,
    source: 'MANUAL',
    reason: 'History guard'
  });

  await assert.rejects(service.deleteAsset({
    authContext: orgA1,
    equipmentId: assetA1._id,
    input: {}
  }), (error) => error.status === 409 && error.code === 'EQUIPMENT_DELETE_HAS_HISTORY');
  await assert.rejects(service.deleteAsset({
    authContext: orgA1,
    equipmentId: assetA2._id,
    input: {}
  }), (error) => error.status === 404);
  assert.equal(await EquipmentAsset.countDocuments({
    _id: { $in: [assetA1._id, assetA2._id] }
  }), 2);
});
