'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const mongoose = require('../../../app/node_modules/mongoose');
const { MongoMemoryReplSet } = require('../../../app/node_modules/mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const FileAsset = require('../../../app/models/FileAsset');
const InventoryApproval = require('../../../app/models/InventoryApproval');
const InventoryItem = require('../../../app/models/InventoryItem');
const InventorySession = require('../../../app/models/InventorySession');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const { createEquipmentInventoryService } = require('../../../app/services/equipmentInventoryService');
const { createFileAssetService } = require('../../../app/services/fileAssetService');
const {
  createStorageKey,
  resolveStoragePath
} = require('../../../app/services/fileStorageService');
const {
  holdLeaderRestoration,
  promiseStateAfterDelay
} = require('../helpers/leadershipConcurrency');

const TEST_DATABASE_NAME = 'equipment_inventory_workflow_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  FileAsset,
  InventoryApproval,
  InventoryItem,
  InventorySession,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];
const PNG_CONTENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(8, 0x01)
]);

let replicaSet;
let storageRoot;
let fixture;
let service;
let fileService;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function scopeMap(membership) {
  return Object.freeze(Object.fromEntries(
    membership.moduleDataScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
  ));
}

function authContext(key) {
  const membership = fixture.memberships[key];
  const user = fixture.users[key];
  const orgUnit = fixture.orgUnitsById.get(String(membership.orgUnitId));
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(user._id),
    user: Object.freeze({ _id: String(user._id), username: user.username, name: user.name }),
    isSuperAdmin: false,
    activeTeamId: String(membership.teamId),
    team: Object.freeze({ _id: String(membership.teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(membership._id),
      teamId: String(membership.teamId),
      userId: String(membership.userId),
      orgUnitId: String(membership.orgUnitId),
      role: membership.role,
      positionLevel: membership.positionLevel,
      positionKey: membership.positionKey,
      functionalRoleKeys: membership.functionalRoleKeys,
      status: membership.status
    }),
    orgUnit: Object.freeze({
      _id: String(orgUnit._id),
      teamId: String(orgUnit.teamId),
      level: orgUnit.level,
      status: orgUnit.status
    }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([...membership.permissionKeys]),
    moduleDataScopes: scopeMap(membership),
    readOnly: false,
    canAccessBusiness: true
  });
}

function globalReadOnlyContext() {
  const user = fixture.users.manager;
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.GLOBAL_READ_ONLY,
    tokenVersion: 0,
    userId: String(user._id),
    user: Object.freeze({ _id: String(user._id), username: user.username, name: user.name }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze(['equipment.view', 'equipment.inventory']),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

async function membership({ teamId, userId, orgUnitId, positionKey }) {
  const positionLevel = permissions.POSITION_LEVEL_BY_KEY[positionKey];
  return TeamMembership.create({
    teamId,
    userId,
    orgUnitId,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel,
    positionKey,
    functionalRoleKeys: [],
    permissionKeys: ['equipment.view', 'equipment.inventory'],
    moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel }),
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE
  });
}

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    departmentA: objectId(),
    subA: objectId(),
    groupA: objectId(),
    groupA2: objectId(),
    subA2: objectId(),
    departmentB: objectId(),
    subB: objectId(),
    categoryA: objectId(),
    categoryB: objectId()
  };
  const userKeys = [
    'inventory', 'subManager', 'subDeputy', 'supervisor', 'otherSubManager', 'deputy', 'assistant', 'manager',
    'teamBInventory'
  ];
  const users = Object.fromEntries(userKeys.map((key) => [key, {
    _id: objectId(),
    username: key.toLowerCase(),
    usernameNormalized: key.toLowerCase(),
    password: 'unused',
    name: key,
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  }]));
  await User.collection.insertMany(Object.values(users));
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'INVENTORY_A',
      name: 'Inventory A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: users.manager._id
    },
    {
      _id: ids.teamB,
      code: 'INVENTORY_B',
      name: 'Inventory B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: users.teamBInventory._id
    }
  ]);
  const orgUnits = [
    {
      _id: ids.departmentA,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'DEPARTMENT_A',
      name: 'Department A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.subA,
      teamId: ids.teamA,
      parentId: ids.departmentA,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'SUB_A',
      name: 'Sub A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 2,
      path: `/${ids.departmentA}/`
    },
    {
      _id: ids.subA2,
      teamId: ids.teamA,
      parentId: ids.departmentA,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'SUB_A2',
      name: 'Sub A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 2,
      path: `/${ids.departmentA}/`
    },
    {
      _id: ids.groupA,
      teamId: ids.teamA,
      parentId: ids.subA,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'GROUP_A',
      name: 'Group A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 3,
      path: `/${ids.departmentA}/${ids.subA}/`
    },
    {
      _id: ids.groupA2,
      teamId: ids.teamA,
      parentId: ids.subA,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'GROUP_A2',
      name: 'Group A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 3,
      path: `/${ids.departmentA}/${ids.subA}/`
    },
    {
      _id: ids.departmentB,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'DEPARTMENT_B',
      name: 'Department B',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.subB,
      teamId: ids.teamB,
      parentId: ids.departmentB,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'SUB_B',
      name: 'Sub B',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 2,
      path: `/${ids.departmentB}/`
    }
  ];
  await OrgUnit.collection.insertMany(orgUnits);
  const memberships = {
    inventory: await membership({
      teamId: ids.teamA,
      userId: users.inventory._id,
      orgUnitId: ids.subA,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE
    }),
    subManager: await membership({
      teamId: ids.teamA,
      userId: users.subManager._id,
      orgUnitId: ids.subA,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    }),
    subDeputy: await membership({
      teamId: ids.teamA,
      userId: users.subDeputy._id,
      orgUnitId: ids.subA,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
    }),
    supervisor: await membership({
      teamId: ids.teamA,
      userId: users.supervisor._id,
      orgUnitId: ids.groupA,
      positionKey: permissions.POSITION_KEYS.SUPERVISOR
    }),
    otherSubManager: await membership({
      teamId: ids.teamA,
      userId: users.otherSubManager._id,
      orgUnitId: ids.subA2,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    }),
    deputy: await membership({
      teamId: ids.teamA,
      userId: users.deputy._id,
      orgUnitId: ids.departmentA,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER
    }),
    assistant: await membership({
      teamId: ids.teamA,
      userId: users.assistant._id,
      orgUnitId: ids.departmentA,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT
    }),
    manager: await membership({
      teamId: ids.teamA,
      userId: users.manager._id,
      orgUnitId: ids.departmentA,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER
    }),
    teamBInventory: await membership({
      teamId: ids.teamB,
      userId: users.teamBInventory._id,
      orgUnitId: ids.subB,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE
    })
  };
  await EquipmentCategory.collection.insertMany([
    {
      _id: ids.categoryA,
      teamId: ids.teamA,
      name: 'Category A',
      parentId: null,
      sortOrder: 0,
      status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
      createdBy: users.manager._id,
      updatedBy: users.manager._id
    },
    {
      _id: ids.categoryB,
      teamId: ids.teamB,
      name: 'Category B',
      parentId: null,
      sortOrder: 0,
      status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
      createdBy: users.teamBInventory._id,
      updatedBy: users.teamBInventory._id
    }
  ]);
  const qrTokens = {
    assetA1: 'A'.repeat(43),
    assetA2: 'B'.repeat(43),
    assetOtherOrg: 'C'.repeat(43),
    assetB: 'D'.repeat(43)
  };
  const assets = {
    assetA1: await EquipmentAsset.create({
      teamId: ids.teamA,
      orgUnitId: ids.subA,
      assetCode: 'INV-A-001',
      name: 'Asset A1',
      categoryId: ids.categoryA,
      specification: 'MODEL-A1',
      quantity: 1,
      location: 'Area A',
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      qrToken: qrTokens.assetA1,
      createdBy: users.manager._id,
      updatedBy: users.manager._id
    }),
    assetA2: await EquipmentAsset.create({
      teamId: ids.teamA,
      orgUnitId: ids.subA,
      assetCode: 'INV-A-002',
      name: 'Asset A2',
      categoryId: ids.categoryA,
      specification: 'MODEL-A2',
      quantity: 2,
      location: 'Area A',
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      qrToken: qrTokens.assetA2,
      createdBy: users.manager._id,
      updatedBy: users.manager._id
    }),
    assetOtherOrg: await EquipmentAsset.create({
      teamId: ids.teamA,
      orgUnitId: ids.subA2,
      assetCode: 'INV-A2-001',
      name: 'Asset Other Org',
      categoryId: ids.categoryA,
      quantity: 1,
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      qrToken: qrTokens.assetOtherOrg,
      createdBy: users.manager._id,
      updatedBy: users.manager._id
    }),
    assetB: await EquipmentAsset.create({
      teamId: ids.teamB,
      orgUnitId: ids.subB,
      assetCode: 'INV-B-001',
      name: 'Asset B',
      categoryId: ids.categoryB,
      quantity: 1,
      status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
      qrToken: qrTokens.assetB,
      createdBy: users.teamBInventory._id,
      updatedBy: users.teamBInventory._id
    })
  };
  return {
    ids,
    users,
    memberships,
    assets,
    qrTokens,
    orgUnitsById: new Map(orgUnits.map((orgUnit) => [String(orgUnit._id), orgUnit]))
  };
}

async function temporaryPhoto({ teamId, uploaderId, suffix = crypto.randomUUID() }) {
  const originalName = `${suffix}.png`;
  const storageKey = createStorageKey({ teamId, originalName, mimeType: 'image/png' });
  const target = resolveStoragePath(storageRoot, storageKey);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, PNG_CONTENT);
  return FileAsset.create({
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey,
    originalName,
    mimeType: 'image/png',
    size: PNG_CONTENT.length,
    sha256: crypto.createHash('sha256').update(PNG_CONTENT).digest('hex'),
    uploaderId,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
}

async function createDraft(assetIds = [fixture.assets.assetA1._id]) {
  const inventorySession = await service.createSession({
    authContext: authContext('inventory'),
    input: {
      name: 'Inventory batch',
      orgUnitId: fixture.ids.subA.toString(),
      equipmentIds: assetIds.map(String)
    }
  });
  return service.getSession({
    authContext: authContext('inventory'),
    inventorySessionId: inventorySession._id,
    query: { pageSize: 20 }
  });
}

async function recordMatchingItem(detail, itemIndex = 0) {
  const item = detail.items[itemIndex];
  return service.updateItem({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    inventoryItemId: item._id,
    input: {
      actualPresent: true,
      actualStatus: item.bookStatus,
      actualQuantity: item.bookQuantity,
      actualLocation: item.bookLocation,
      differenceNote: '',
      photoFileIds: [],
      expectedVersion: item.version
    }
  });
}

async function submitDraft(detail) {
  return service.submitSession({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    input: {
      expectedVersion: detail.inventorySession.version,
      comment: 'Inventory person submitted'
    }
  });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inventory-files-'));
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  await fs.promises.rm(storageRoot, { recursive: true, force: true });
  await fs.promises.mkdir(storageRoot, { recursive: true });
  fixture = await seedFixture();
  fileService = createFileAssetService({
    storageRoot,
    InventoryItemModel: InventoryItem,
    connection: mongoose.connection
  });
  service = createEquipmentInventoryService({
    fileAssetService: fileService,
    connection: mongoose.connection
  });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
  await fs.promises.rm(storageRoot, { recursive: true, force: true });
});

test('inventory person, manager chain, differences, photos, and audit remain atomic', async () => {
  const detail = await createDraft([
    fixture.assets.assetA1._id,
    fixture.assets.assetA2._id
  ]);
  assert.equal(detail.inventorySession.itemCount, 2);
  await recordMatchingItem(detail, 0);

  const differenceItem = detail.items[1];
  const photo = await temporaryPhoto({
    teamId: fixture.ids.teamA,
    uploaderId: fixture.users.inventory._id
  });
  await service.updateItem({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    inventoryItemId: differenceItem._id,
    input: {
      actualPresent: false,
      differenceNote: 'Asset was not found on site',
      photoFileIds: [photo._id.toString()],
      expectedVersion: differenceItem.version
    }
  });
  const updatedDetail = await service.getSession({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    query: { pageSize: 20 }
  });
  assert.equal(updatedDetail.inventorySession.checkedCount, 2);
  assert.equal(updatedDetail.inventorySession.differenceCount, 1);
  const submitted = await submitDraft(updatedDetail);
  assert.equal(submitted.status, InventorySession.INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER);

  await assert.rejects(service.reviewSession({
    authContext: authContext('deputy'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', expectedVersion: submitted.version }
  }), (error) => error.status === 403 && error.code === 'EQUIPMENT_INVENTORY_APPROVAL_FORBIDDEN');

  const subApproved = await service.reviewSession({
    authContext: authContext('subManager'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', comment: 'Sub manager approved', expectedVersion: submitted.version }
  });
  const deputyApproved = await service.reviewSession({
    authContext: authContext('deputy'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', comment: 'Deputy approved', expectedVersion: subApproved.version }
  });
  const completed = await service.reviewSession({
    authContext: authContext('manager'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', comment: 'Manager final approval', expectedVersion: deputyApproved.version }
  });
  assert.equal(completed.status, InventorySession.INVENTORY_SESSION_STATUSES.COMPLETED);
  assert.equal(completed.approvalStep, 4);

  const approvals = await InventoryApproval.find({ inventorySessionId: completed._id })
    .sort({ sequence: 1 })
    .lean();
  assert.deepEqual(
    approvals.map(({ stage }) => stage),
    ['INVENTORY_PERSON', 'SUB_DEPARTMENT_MANAGER', 'DEPARTMENT_DEPUTY_OR_ASSISTANT', 'DEPARTMENT_MANAGER']
  );
  const persistedDifference = await InventoryItem.findById(differenceItem._id).lean();
  assert.equal(persistedDifference.differenceStatus, InventoryItem.INVENTORY_DIFFERENCE_STATUSES.CONFIRMED);
  assert.deepEqual(persistedDifference.differenceTypes, [InventoryItem.INVENTORY_DIFFERENCE_TYPES.MISSING]);
  const boundPhoto = await FileAsset.findById(photo._id).lean();
  assert.equal(boundPhoto.ownerType, FileAsset.FILE_OWNER_TYPES.INVENTORY);
  assert.equal(String(boundPhoto.ownerId), String(differenceItem._id));
  assert.equal(await AuditLog.countDocuments({
    targetTeamId: fixture.ids.teamA,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.INVENTORY_APPROVAL
  }), 4);

  await assert.rejects(service.reviewSession({
    authContext: authContext('manager'),
    inventorySessionId: completed._id,
    input: { decision: 'APPROVE', expectedVersion: completed.version }
  }), (error) => error.status === 409);
});

test('department manager assistant can replace the deputy at the same fixed stage', async () => {
  const detail = await createDraft();
  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  const subApproved = await service.reviewSession({
    authContext: authContext('subManager'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', expectedVersion: submitted.version }
  });
  const assistantApproved = await service.reviewSession({
    authContext: authContext('assistant'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', expectedVersion: subApproved.version }
  });
  assert.equal(
    assistantApproved.status,
    InventorySession.INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_MANAGER
  );
  const approval = await InventoryApproval.findOne({
    inventorySessionId: submitted._id,
    stage: InventoryApproval.INVENTORY_APPROVAL_STAGES.DEPARTMENT_DEPUTY_OR_ASSISTANT
  }).lean();
  assert.equal(approval.actorPositionKey, permissions.POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT);
});

test('sub-department deputy approves and supervisor fallback ignores other branches and root misassignments', async () => {
  const rootMisassignedUser = await User.create({
    username: 'root-misassigned-sub-manager',
    usernameNormalized: 'root-misassigned-sub-manager',
    password: 'unused',
    name: 'root misassigned sub manager',
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  });
  await membership({
    teamId: fixture.ids.teamA,
    userId: rootMisassignedUser._id,
    orgUnitId: fixture.ids.departmentA,
    positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
  });

  const detail = await createDraft();
  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  await InventorySession.updateOne(
    { _id: submitted._id },
    { $set: { orgUnitId: fixture.ids.groupA2 } }
  );
  const deputyView = await service.getSession({
    authContext: authContext('subDeputy'),
    inventorySessionId: submitted._id,
    query: {}
  });
  assert.equal(deputyView.inventorySession.canApprove, true);
  await assert.rejects(service.getSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id,
    query: {}
  }), (error) => error.status === 404);
  await assert.rejects(service.exportSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id
  }), (error) => error.status === 404);
  assert.equal((await service.listSessions({
    authContext: authContext('supervisor'),
    query: { pendingOnly: true }
  })).total, 0);

  await TeamMembership.updateMany({
    _id: { $in: [fixture.memberships.subManager._id, fixture.memberships.subDeputy._id] }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });
  const supervisorFallback = await service.getSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id,
    query: {}
  });
  assert.equal(supervisorFallback.inventorySession.canApprove, true);
  const pending = await service.listSessions({
    authContext: authContext('supervisor'),
    query: { pendingOnly: true }
  });
  assert.equal(pending.total, 1);
  assert.equal(pending.inventorySessions[0].canApprove, true);
  const exported = await service.exportSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id
  });
  assert.equal(exported.count, 1);

  const reviewed = await service.reviewSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id,
    input: {
      decision: 'APPROVE',
      comment: '主管兜底审批',
      expectedVersion: supervisorFallback.inventorySession.version
    }
  });
  assert.equal(reviewed.status, 'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT');
});

test('concurrent leader restoration serializes before supervisor inventory approval', async () => {
  await TeamMembership.updateMany({
    _id: { $in: [fixture.memberships.subManager._id, fixture.memberships.subDeputy._id] }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });
  const detail = await createDraft();
  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  const supervisorView = await service.getSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id,
    query: {}
  });
  assert.equal(supervisorView.inventorySession.canApprove, true);

  const held = await holdLeaderRestoration({
    authContext: authContext('supervisor'),
    membershipId: fixture.memberships.subManager._id
  });
  const approval = service.reviewSession({
    authContext: authContext('supervisor'),
    inventorySessionId: submitted._id,
    input: {
      decision: 'APPROVE',
      expectedVersion: supervisorView.inventorySession.version
    }
  });
  assert.equal(await promiseStateAfterDelay(approval), 'pending');
  held.release();
  const [restorationResult, approvalResult] = await Promise.allSettled([
    held.restoration,
    approval
  ]);
  assert.equal(restorationResult.status, 'fulfilled');
  assert.equal(approvalResult.status, 'rejected');

  const persisted = await InventorySession.findById(submitted._id).lean();
  assert.equal(persisted.status, InventorySession.INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER);
  assert.equal(persisted.__v, submitted.version);
  assert.equal(await InventoryApproval.countDocuments({
    inventorySessionId: submitted._id,
    stage: InventoryApproval.INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER
  }), 0);
});

test('team, organization, and attachment boundaries hide foreign resources', async () => {
  await assert.rejects(service.createSession({
    authContext: authContext('inventory'),
    input: {
      name: 'Foreign asset batch',
      orgUnitId: fixture.ids.subA.toString(),
      equipmentIds: [fixture.assets.assetOtherOrg._id.toString()]
    }
  }), (error) => error.status === 404);

  const detail = await createDraft();
  const item = detail.items[0];
  const foreignPhoto = await temporaryPhoto({
    teamId: fixture.ids.teamB,
    uploaderId: fixture.users.teamBInventory._id
  });
  await assert.rejects(service.updateItem({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    inventoryItemId: item._id,
    input: {
      actualPresent: false,
      differenceNote: 'Foreign photo must not bind',
      photoFileIds: [foreignPhoto._id.toString()],
      expectedVersion: item.version
    }
  }), (error) => error.status === 404 && error.code === 'FILE_NOT_FOUND');
  assert.equal((await InventoryItem.findById(item._id).lean()).actualPresent, null);

  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  await assert.rejects(service.reviewSession({
    authContext: authContext('otherSubManager'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', expectedVersion: submitted.version }
  }), (error) => error.status === 404);
  await assert.rejects(service.getSession({
    authContext: authContext('teamBInventory'),
    inventorySessionId: submitted._id,
    query: { pageSize: 20 }
  }), (error) => error.status === 404);
});

test('global read-only can list, read, export, and download a named team inventory but cannot write', async () => {
  const detail = await createDraft();
  const item = detail.items[0];
  const photo = await temporaryPhoto({
    teamId: fixture.ids.teamA,
    uploaderId: fixture.users.inventory._id
  });
  await service.updateItem({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    inventoryItemId: item._id,
    input: {
      actualPresent: false,
      differenceNote: 'Global read-only evidence check',
      photoFileIds: [photo._id.toString()],
      expectedVersion: item.version
    }
  });

  const context = globalReadOnlyContext();
  const requestedTeamId = fixture.ids.teamA.toString();
  const listed = await service.listSessions({
    authContext: context,
    requestedTeamId,
    query: { teamId: requestedTeamId }
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.inventorySessions[0]._id, detail.inventorySession._id);

  const loaded = await service.getSession({
    authContext: context,
    requestedTeamId,
    inventorySessionId: detail.inventorySession._id,
    query: { teamId: requestedTeamId, pageSize: 20 }
  });
  assert.equal(loaded.items[0].photoFileIds[0], photo._id.toString());

  const exported = await service.exportSession({
    authContext: context,
    requestedTeamId,
    inventorySessionId: detail.inventorySession._id
  });
  assert.equal(exported.count, 1);
  assert.ok(Buffer.isBuffer(exported.buffer));

  const metadata = await fileService.getMetadata({
    authContext: context,
    fileId: photo._id.toString(),
    requestedTeamId,
    method: 'GET'
  });
  assert.equal(metadata.ownerType, FileAsset.FILE_OWNER_TYPES.INVENTORY);

  await assert.rejects(service.createSession({
    authContext: context,
    input: {
      name: 'Forbidden global write',
      orgUnitId: fixture.ids.subA.toString()
    }
  }), (error) => error.status === 403 && error.code === 'TEAM_CONTEXT_REQUIRED');
});

test('duplicate concurrent approval commits exactly once', async () => {
  const detail = await createDraft();
  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  const attempts = await Promise.allSettled([1, 2].map(() => service.reviewSession({
    authContext: authContext('subManager'),
    inventorySessionId: submitted._id,
    input: { decision: 'APPROVE', expectedVersion: submitted.version }
  })));
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(await InventoryApproval.countDocuments({
    inventorySessionId: submitted._id,
    stage: InventoryApproval.INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER
  }), 1);
  const persisted = await InventorySession.findById(submitted._id).lean();
  assert.equal(
    persisted.status,
    InventorySession.INVENTORY_SESSION_STATUSES.PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT
  );
});

test('returned batch requires correction and restarts a new immutable approval round once', async () => {
  const detail = await createDraft();
  await recordMatchingItem(detail);
  const submitted = await submitDraft(detail);
  const returned = await service.reviewSession({
    authContext: authContext('subManager'),
    inventorySessionId: submitted._id,
    input: {
      decision: 'RETURN',
      comment: 'Recheck the on-site location',
      expectedVersion: submitted.version
    }
  });
  assert.equal(returned.status, InventorySession.INVENTORY_SESSION_STATUSES.RETURNED);
  assert.equal(returned.reviewRound, 1);

  await assert.rejects(service.submitSession({
    authContext: authContext('inventory'),
    inventorySessionId: returned._id,
    input: { expectedVersion: returned.version, comment: 'No correction yet' }
  }), (error) => error.status === 400);

  const returnedDetail = await service.getSession({
    authContext: authContext('inventory'),
    inventorySessionId: returned._id,
    query: { pageSize: 20 }
  });
  await recordMatchingItem(returnedDetail);
  const correctedDetail = await service.getSession({
    authContext: authContext('inventory'),
    inventorySessionId: returned._id,
    query: { pageSize: 20 }
  });
  assert.equal(correctedDetail.inventorySession.correctionRevision, 1);

  const attempts = await Promise.allSettled([1, 2].map(() => service.submitSession({
    authContext: authContext('inventory'),
    inventorySessionId: returned._id,
    input: {
      expectedVersion: correctedDetail.inventorySession.version,
      comment: 'Corrected and resubmitted'
    }
  })));
  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
  const resubmitted = attempts.find(({ status }) => status === 'fulfilled').value;
  assert.equal(resubmitted.reviewRound, 2);
  assert.equal(
    resubmitted.status,
    InventorySession.INVENTORY_SESSION_STATUSES.PENDING_SUB_DEPARTMENT_MANAGER
  );
  assert.equal(await InventoryApproval.countDocuments({
    inventorySessionId: returned._id,
    reviewRound: 2,
    stage: InventoryApproval.INVENTORY_APPROVAL_STAGES.SUB_DEPARTMENT_MANAGER
  }), 0);

  const subApproved = await service.reviewSession({
    authContext: authContext('subManager'),
    inventorySessionId: returned._id,
    input: { decision: 'APPROVE', expectedVersion: resubmitted.version }
  });
  const deputyApproved = await service.reviewSession({
    authContext: authContext('deputy'),
    inventorySessionId: returned._id,
    input: { decision: 'APPROVE', expectedVersion: subApproved.version }
  });
  const completed = await service.reviewSession({
    authContext: authContext('manager'),
    inventorySessionId: returned._id,
    input: { decision: 'APPROVE', expectedVersion: deputyApproved.version }
  });
  assert.equal(completed.status, InventorySession.INVENTORY_SESSION_STATUSES.COMPLETED);
  const approvals = await InventoryApproval.find({ inventorySessionId: returned._id })
    .sort({ reviewRound: 1, sequence: 1 })
    .lean();
  assert.deepEqual(
    approvals.map(({ reviewRound, stage, decision }) => `${reviewRound}:${stage}:${decision}`),
    [
      '1:INVENTORY_PERSON:SUBMIT',
      '1:SUB_DEPARTMENT_MANAGER:RETURN',
      '2:INVENTORY_PERSON:SUBMIT',
      '2:SUB_DEPARTMENT_MANAGER:APPROVE',
      '2:DEPARTMENT_DEPUTY_OR_ASSISTANT:APPROVE',
      '2:DEPARTMENT_MANAGER:APPROVE'
    ]
  );
});

test('inventory scan resolves only a valid QR token inside the selected batch', async () => {
  const detail = await createDraft();
  const found = await service.scanItem({
    authContext: authContext('inventory'),
    inventorySessionId: detail.inventorySession._id,
    input: { qrToken: fixture.qrTokens.assetA1 }
  });
  assert.equal(found.item.equipmentId, fixture.assets.assetA1._id.toString());

  for (const qrToken of ['short', 'Z'.repeat(43), fixture.qrTokens.assetB]) {
    await assert.rejects(service.scanItem({
      authContext: authContext('inventory'),
      inventorySessionId: detail.inventorySession._id,
      input: { qrToken }
    }), (error) => error.status === 404 && error.code === 'EQUIPMENT_INVENTORY_NOT_FOUND');
  }
});
