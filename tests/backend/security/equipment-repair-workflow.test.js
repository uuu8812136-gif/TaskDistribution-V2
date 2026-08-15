'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRepairOrder = require('../../../app/models/EquipmentRepairOrder');
const FileAsset = require('../../../app/models/FileAsset');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRepairService
} = require('../../../app/services/equipmentRepairService');
const { createFileAssetService } = require('../../../app/services/fileAssetService');
const {
  holdLeaderRestoration,
  promiseStateAfterDelay
} = require('../helpers/leadershipConcurrency');

const TEST_DATABASE_NAME = `equipment_repair_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRepairOrder,
  FileAsset,
  Message,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replSet;
let fixtures;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function authContext({
  teamId,
  orgUnitId,
  userId = objectId(),
  positionKey = permissions.POSITION_KEYS.EMPLOYEE,
  functionalRoleKeys = [],
  permissionKeys = ['equipment.view', 'equipment.repair', 'equipment.export'],
  scope = permissions.DATA_SCOPES.ORG_UNIT,
  equipmentOrgUnitScopeIds = null,
  isSuperAdmin = false
}) {
  const positionLevel = isSuperAdmin
    ? null
    : permissions.POSITION_LEVEL_BY_KEY[positionKey];
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `user-${userId}` }),
    isSuperAdmin,
    activeTeamId: String(teamId),
    team: Object.freeze({
      _id: String(teamId),
      name: '变速箱物流部',
      status: permissions.TEAM_STATUSES.ACTIVE
    }),
    membership: isSuperAdmin ? null : Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.MEMBER,
      positionLevel,
      positionKey,
      functionalRoleKeys: Object.freeze([...functionalRoleKeys]),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: isSuperAdmin ? null : Object.freeze({
      _id: String(orgUnitId),
      teamId: String(teamId)
    }),
    actorRole: isSuperAdmin
      ? permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([...permissionKeys]),
    moduleDataScopes: Object.freeze({ equipment: scope }),
    ...(equipmentOrgUnitScopeIds
      ? { equipmentOrgUnitScopeIds: Object.freeze([...equipmentOrgUnitScopeIds]) }
      : {}),
    readOnly: false,
    canAccessBusiness: true
  });
}

function fakeFiles() {
  return {
    async reconcileOwnerFiles({ attachments }) {
      return attachments.map((attachment, index) => ({
        fileId: attachment.fileId,
        originalName: `现场照片-${index + 1}.jpg`,
        mimeType: 'image/jpeg',
        size: 1024,
        uploadTime: new Date('2026-07-17T08:00:00.000Z')
      }));
    }
  };
}

function createService() {
  return createEquipmentRepairService({ fileAssetService: fakeFiles() });
}

async function seedFixtures() {
  const creatorId = objectId();
  const teamA = await ProjectTeam.create({
    code: 'REPAIR_A',
    name: '变速箱物流部',
    createdBy: creatorId
  });
  const teamB = await ProjectTeam.create({
    code: 'REPAIR_B',
    name: '发动机物流部',
    createdBy: creatorId
  });
  const orgA1 = await OrgUnit.create({
    teamId: teamA._id,
    code: 'A1',
    name: '仓储一分部',
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    level: 2,
    path: '/'
  });
  const orgA2 = await OrgUnit.create({
    teamId: teamA._id,
    code: 'A2',
    name: '仓储二分部',
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    level: 2,
    path: '/'
  });
  const orgA1Group = await OrgUnit.create({
    teamId: teamA._id,
    parentId: orgA1._id,
    code: 'A1_GROUP',
    name: '仓储一分部管理组',
    type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
    level: 3,
    path: `/${orgA1._id}/`
  });
  const orgB = await OrgUnit.create({
    teamId: teamB._id,
    code: 'B1',
    name: '发动机一分部',
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    level: 2,
    path: '/'
  });
  const categoryA = await EquipmentCategory.create({
    teamId: teamA._id,
    name: '叉车',
    createdBy: creatorId,
    updatedBy: creatorId
  });
  const categoryB = await EquipmentCategory.create({
    teamId: teamB._id,
    name: '叉车',
    createdBy: creatorId,
    updatedBy: creatorId
  });
  const assetA1 = await EquipmentAsset.create({
    teamId: teamA._id,
    orgUnitId: orgA1._id,
    assetCode: 'FC-A1-001',
    name: '一分部测试叉车',
    categoryId: categoryA._id,
    location: '一号库',
    plateNumber: 'TEST-PLATE-05',
    createdBy: creatorId,
    updatedBy: creatorId
  });
  const assetA2 = await EquipmentAsset.create({
    teamId: teamA._id,
    orgUnitId: orgA2._id,
    assetCode: 'FC-A2-001',
    name: '二分部测试叉车',
    categoryId: categoryA._id,
    createdBy: creatorId,
    updatedBy: creatorId
  });
  const assetB = await EquipmentAsset.create({
    teamId: teamB._id,
    orgUnitId: orgB._id,
    assetCode: 'FC-B-001',
    name: '发动机测试叉车',
    categoryId: categoryB._id,
    createdBy: creatorId,
    updatedBy: creatorId
  });
  return { teamA, teamB, orgA1, orgA1Group, orgA2, orgB, assetA1, assetA2, assetB };
}

function actors() {
  const baseA1 = { teamId: fixtures.teamA._id, orgUnitId: fixtures.orgA1._id };
  return {
    creator: authContext(baseA1),
    subManager: authContext({
      ...baseA1,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    }),
    subDeputy: authContext({
      ...baseA1,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
    }),
    supervisor: authContext({
      teamId: fixtures.teamA._id,
      orgUnitId: fixtures.orgA1Group._id,
      positionKey: permissions.POSITION_KEYS.SUPERVISOR,
      equipmentOrgUnitScopeIds: [fixtures.orgA1._id, fixtures.orgA1Group._id]
    }),
    wrongSubManager: authContext({
      teamId: fixtures.teamA._id,
      orgUnitId: fixtures.orgA2._id,
      positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
    }),
    assetAdmin: authContext({
      ...baseA1,
      functionalRoleKeys: [permissions.FUNCTIONAL_ROLE_KEYS.ASSET_ADMIN],
      scope: permissions.DATA_SCOPES.TEAM
    }),
    deputy: authContext({
      ...baseA1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_DEPUTY_MANAGER,
      scope: permissions.DATA_SCOPES.TEAM
    }),
    assistant: authContext({
      ...baseA1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
      scope: permissions.DATA_SCOPES.TEAM
    }),
    manager: authContext({
      ...baseA1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      scope: permissions.DATA_SCOPES.TEAM
    }),
    otherTeam: authContext({
      teamId: fixtures.teamB._id,
      orgUnitId: fixtures.orgB._id
    })
  };
}

async function createFault(service, creator, extra = {}) {
  return service.createRepair({
    authContext: creator,
    input: {
      type: 'FAULT_REPORT',
      equipmentId: String(fixtures.assetA1._id),
      reportTime: '2026-07-17T08:10:00.000Z',
      reportLocation: '一号库东门',
      plateNumber: 'TEST-PLATE-05',
      contactName: '张三',
      contactPhone: '13800000000',
      faultDescription: '启动后液压系统无压力',
      photoAttachments: [{ fileId: String(objectId()) }],
      ...extra
    }
  });
}

async function action(service, authContextValue, repair, actionName, extra = {}) {
  return service.transitionRepair({
    authContext: authContextValue,
    repairId: repair._id,
    input: {
      action: actionName,
      revision: repair.revision,
      ...extra
    }
  });
}

async function persistActorMembership(context, {
  orgUnitId,
  positionKey,
  permissionKeys = ['equipment.view', 'equipment.repair']
} = {}) {
  const effectivePositionKey = positionKey || context.membership.positionKey;
  const positionLevel = permissions.POSITION_LEVEL_BY_KEY[effectivePositionKey];
  const normalizedUserId = new mongoose.Types.ObjectId(context.userId);
  await User.collection.updateOne(
    { _id: normalizedUserId },
    {
      $setOnInsert: {
        username: `repair-${context.userId}`,
        usernameNormalized: `repair-${context.userId}`,
        password: 'unused',
        name: `repair-${context.userId}`,
        roles: [],
        isSuperAdmin: false,
        isSystemAccount: false,
        tokenVersion: 0
      },
      $set: { status: 'active' }
    },
    { upsert: true }
  );
  return TeamMembership.create({
    teamId: context.activeTeamId,
    userId: context.userId,
    orgUnitId: orgUnitId || context.membership.orgUnitId,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel,
    positionKey: effectivePositionKey,
    functionalRoleKeys: [],
    permissionKeys,
    moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel }),
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE
  });
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixtures = await seedFixtures();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test('fault report follows sub-department review and asset-admin receipt', async () => {
  const service = createService();
  const role = actors();
  const created = await createFault(service, role.creator);
  assert.equal(created.status, 'SUB_DEPARTMENT_REVIEW_PENDING');
  assert.equal(created.photoAttachments.length, 1);
  assert.deepEqual(created.availableActions, []);

  await assert.rejects(
    action(service, role.wrongSubManager, created, 'SUB_DEPARTMENT_APPROVE'),
    (error) => error.status === 404
  );
  const reviewed = await action(
    service,
    role.subManager,
    created,
    'SUB_DEPARTMENT_APPROVE',
    { note: '故障属实' }
  );
  assert.equal(reviewed.status, 'ASSET_ADMIN_RECEIPT_PENDING');
  const completed = await action(
    service,
    role.assetAdmin,
    reviewed,
    'ACCEPT_RECEIPT',
    { note: '已接单处理' }
  );
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.actionLogs.length, 3);
  assert.equal(await AuditLog.countDocuments({ resourceType: 'REPAIR_ORDER' }), 3);
  assert.equal(await Message.countDocuments({ 'extraData.repairId': created._id }), 1);
});

test('repair deputy is primary and supervisor fallback is scoped to the exact sub-department', async () => {
  const service = createService();
  const role = actors();
  const rootOrg = await OrgUnit.create({
    teamId: fixtures.teamA._id,
    code: 'ROOT_DEPARTMENT',
    name: '物流部根部门',
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    level: 1,
    path: '/'
  });
  const rootMisassignedManager = authContext({
    teamId: fixtures.teamA._id,
    orgUnitId: rootOrg._id,
    positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER
  });
  await persistActorMembership(role.subManager);
  await persistActorMembership(role.subDeputy);
  await persistActorMembership(role.supervisor);
  await persistActorMembership(role.wrongSubManager);
  await persistActorMembership(rootMisassignedManager);
  const noRepairPermissionManager = authContext({
    teamId: fixtures.teamA._id,
    orgUnitId: fixtures.orgA1._id,
    positionKey: permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
    permissionKeys: ['equipment.view']
  });
  await persistActorMembership(noRepairPermissionManager, {
    permissionKeys: ['equipment.view']
  });

  const created = await createFault(service, role.creator, { idempotencyKey: 'repair-supervisor-fallback' });
  assert.equal(created.availableActions.length, 0);
  const deputyView = await service.getRepair({
    authContext: role.subDeputy,
    repairId: created._id
  });
  assert.ok(deputyView.availableActions.includes('SUB_DEPARTMENT_APPROVE'));
  const supervisorView = await service.getRepair({
    authContext: role.supervisor,
    repairId: created._id
  });
  assert.deepEqual(supervisorView.availableActions, []);
  await assert.rejects(action(
    service,
    role.supervisor,
    created,
    'SUB_DEPARTMENT_APPROVE'
  ), (error) => error.status === 403);
  assert.equal((await service.listRepairs({
    authContext: role.supervisor,
    query: { todo: true }
  })).total, 0);
  assert.equal(await Message.countDocuments({ recipient: role.supervisor.userId }), 0);
  assert.equal(await Message.countDocuments({ recipient: role.wrongSubManager.userId }), 0);
  assert.equal(await Message.countDocuments({ recipient: rootMisassignedManager.userId }), 0);
  assert.equal(await Message.countDocuments({ recipient: noRepairPermissionManager.userId }), 0);

  await TeamMembership.updateMany({
    userId: {
      $in: [
        role.subManager.userId,
        role.subDeputy.userId,
        noRepairPermissionManager.userId
      ]
    }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });
  await createFault(service, role.creator, {
    idempotencyKey: 'repair-supervisor-fallback-notification'
  });
  assert.equal(await Message.countDocuments({ recipient: role.supervisor.userId }), 1);
  const supervisorFallback = await service.getRepair({
    authContext: role.supervisor,
    repairId: created._id
  });
  assert.ok(supervisorFallback.availableActions.includes('SUB_DEPARTMENT_APPROVE'));
  const supervisorTodo = await service.listRepairs({
    authContext: role.supervisor,
    query: { todo: true }
  });
  assert.equal(supervisorTodo.total, 2);
  assert.ok(supervisorTodo.repairs.some(({ _id }) => _id === created._id));
  const approved = await action(
    service,
    role.supervisor,
    supervisorFallback,
    'SUB_DEPARTMENT_APPROVE'
  );
  assert.equal(approved.status, 'ASSET_ADMIN_RECEIPT_PENDING');
});

test('concurrent leader restoration serializes before supervisor repair approval', async () => {
  const service = createService();
  const role = actors();
  const managerMembership = await persistActorMembership(role.subManager);
  await persistActorMembership(role.subDeputy);
  await persistActorMembership(role.supervisor);
  await TeamMembership.updateMany({
    userId: { $in: [role.subManager.userId, role.subDeputy.userId] }
  }, { $set: { status: permissions.MEMBERSHIP_STATUSES.DISABLED } });

  const repair = await createFault(service, role.creator, {
    idempotencyKey: 'repair-concurrent-leader-restoration'
  });
  const supervisorView = await service.getRepair({
    authContext: role.supervisor,
    repairId: repair._id
  });
  assert.ok(supervisorView.availableActions.includes('SUB_DEPARTMENT_APPROVE'));

  const held = await holdLeaderRestoration({
    authContext: role.supervisor,
    membershipId: managerMembership._id
  });
  const approval = action(
    service,
    role.supervisor,
    supervisorView,
    'SUB_DEPARTMENT_APPROVE'
  );
  assert.equal(await promiseStateAfterDelay(approval), 'pending');
  held.release();
  const [restorationResult, approvalResult] = await Promise.allSettled([
    held.restoration,
    approval
  ]);
  assert.equal(restorationResult.status, 'fulfilled');
  assert.equal(approvalResult.status, 'rejected');

  const persisted = await EquipmentRepairOrder.findById(repair._id).lean();
  assert.equal(persisted.status, 'SUB_DEPARTMENT_REVIEW_PENDING');
  assert.equal(persisted.revision, repair.revision);
  assert.equal(persisted.actionLogs.length, repair.actionLogs.length);
});

test('parts repair allows dynamic rows, server-side amount calculation, and assistant substitute', async () => {
  const service = createService();
  const role = actors();
  await persistActorMembership(role.assistant, { permissionKeys: ['equipment.repair'] });
  await persistActorMembership(role.manager, { permissionKeys: ['equipment.repair'] });
  let repair = await service.createRepair({
    authContext: role.creator,
    input: {
      type: 'PARTS_REPAIR',
      equipmentId: String(fixtures.assetA1._id),
      repairDate: '2026-07-17',
      repairerName: '李师傅',
      repairDescription: '更换液压件',
      partItems: [{ itemKey: 'pump', name: '液压泵' }]
    }
  });
  repair = await action(service, role.subDeputy, repair, 'SUB_DEPARTMENT_APPROVE', {
    note: '验收并补充配件',
    corrections: {
      repairerName: '李师傅、王师傅',
      partItems: [
        { itemKey: 'pump', name: '液压泵', specification: 'HP-01' },
        { itemKey: 'seal', name: '密封圈', specification: 'S-10' }
      ]
    }
  });
  assert.equal(repair.status, 'ASSET_ADMIN_PRICING_PENDING');
  assert.equal(repair.partItems.length, 2);
  repair = await action(service, role.assetAdmin, repair, 'CONFIRM_PRICING', {
    partItems: [
      { itemKey: 'pump', quantity: 2, unitPrice: 12.34, amount: 0 },
      { itemKey: 'seal', quantity: 1.5, unitPrice: 2, amount: 999999 }
    ]
  });
  assert.equal(repair.totalAmount, 27.68);
  assert.deepEqual(repair.partItems.map((item) => item.amount), [24.68, 3]);
  const assistantWithOrgScope = authContext({
    teamId: fixtures.teamA._id,
    orgUnitId: fixtures.orgA2._id,
    userId: role.assistant.userId,
    positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    permissionKeys: ['equipment.repair']
  });
  const assistantTodo = await service.listRepairs({
    authContext: role.assistant,
    query: { todo: true }
  });
  assert.equal(assistantTodo.total, 1);
  assert.equal(assistantTodo.total, assistantTodo.repairs.length);
  assert.equal(assistantTodo.repairs[0]._id, repair._id);
  assert.ok(assistantTodo.repairs[0].availableActions.includes('DEPUTY_APPROVE'));
  assert.ok(await Message.exists({
    recipient: role.assistant.userId,
    'extraData.repairId': repair._id,
    'extraData.status': 'DEPUTY_APPROVAL_PENDING'
  }));
  assert.equal((await service.getRepair({
    authContext: role.assistant,
    repairId: repair._id
  }))._id, repair._id);
  const assistantOrgTodo = await service.listRepairs({
    authContext: assistantWithOrgScope,
    query: { todo: true }
  });
  assert.equal(assistantOrgTodo.total, 0);
  assert.equal(assistantOrgTodo.repairs.length, 0);
  await assert.rejects(service.getRepair({
    authContext: assistantWithOrgScope,
    repairId: repair._id
  }), (error) => error.status === 404);
  await assert.rejects(action(
    service,
    assistantWithOrgScope,
    repair,
    'DEPUTY_APPROVE',
    { note: '越权审批' }
  ), (error) => error.status === 404);
  await assert.rejects(service.listRepairs({
    authContext: authContext({
      teamId: fixtures.teamA._id,
      orgUnitId: fixtures.orgA2._id,
      userId: role.assistant.userId,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER_ASSISTANT,
      permissionKeys: ['equipment.view']
    }),
    query: { todo: true }
  }), (error) => error.status === 403);
  await assert.rejects(service.listRepairs({
    authContext: assistantWithOrgScope,
    query: {}
  }), (error) => error.status === 403);
  repair = await action(service, role.assistant, repair, 'DEPUTY_APPROVE', { note: '同意价格' });
  assert.equal(repair.status, 'MANAGER_APPROVAL_PENDING');
  const managerWithOrgScope = authContext({
    teamId: fixtures.teamA._id,
    orgUnitId: fixtures.orgA2._id,
    userId: role.manager.userId,
    positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    permissionKeys: ['equipment.repair']
  });
  const managerTodo = await service.listRepairs({
    authContext: role.manager,
    query: { todo: true }
  });
  assert.equal(managerTodo.total, 1);
  assert.equal(managerTodo.total, managerTodo.repairs.length);
  assert.equal(managerTodo.repairs[0]._id, repair._id);
  assert.ok(await Message.exists({
    recipient: role.manager.userId,
    'extraData.repairId': repair._id,
    'extraData.status': 'MANAGER_APPROVAL_PENDING'
  }));
  const managerOrgTodo = await service.listRepairs({
    authContext: managerWithOrgScope,
    query: { todo: true }
  });
  assert.equal(managerOrgTodo.total, 0);
  assert.equal(managerOrgTodo.repairs.length, 0);
  repair = await action(service, role.manager, repair, 'MANAGER_APPROVE', { note: '同意结案' });
  assert.equal(repair.status, 'COMPLETED');
  assert.match(repair.summaryText, /设备编码：FC-A1-001/);
  assert.match(repair.summaryText, /维修金额：27\.68元/);
  assert.ok(repair.actionLogs.every((item) => Object.hasOwn(item, 'actorName')));
  assert.equal(
    repair.actionLogs.find(({ actorId }) => actorId === role.assistant.userId)?.actorName,
    `repair-${role.assistant.userId}`
  );
  assert.equal(
    repair.actionLogs.find(({ actorId }) => actorId === role.manager.userId)?.actorName,
    `repair-${role.manager.userId}`
  );
});

test('repair locations are team scoped, validated, and writable only with equipment edit permission', async () => {
  const service = createService();
  const role = actors();
  const editor = authContext({
    teamId: fixtures.teamA._id,
    orgUnitId: fixtures.orgA1._id,
    permissionKeys: ['equipment.view', 'equipment.edit']
  });

  await assert.rejects(service.updateRepairLocations({
    authContext: role.creator,
    input: { locations: ['一号库东门'] }
  }), (error) => error.status === 403);
  await assert.rejects(service.updateRepairLocations({
    authContext: editor,
    input: { locations: ['一号库东门', '一号库东门'] }
  }), (error) => error.status === 400);

  const locations = await service.updateRepairLocations({
    authContext: editor,
    input: { locations: ['一号库东门', '重汽4号门/幸福仓库'], reason: '维护常用地点' }
  });
  assert.deepEqual(locations, ['一号库东门', '重汽4号门/幸福仓库']);
  assert.deepEqual(
    (await service.listRepairLocations({ authContext: role.creator })).locations,
    locations
  );
  assert.deepEqual(
    (await service.listRepairLocations({ authContext: role.otherTeam })).locations,
    []
  );
  const audit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.UPDATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.PROJECT_TEAM,
    resourceId: String(fixtures.teamA._id)
  }).lean();
  assert.ok(audit);
  assert.deepEqual(audit.after.repairLocations, locations);
});

test('no-parts repair supports reject previous, reject creator, resubmit, and void', async () => {
  const service = createService();
  const role = actors();
  let repair = await service.createRepair({
    authContext: role.creator,
    input: {
      type: 'NO_PARTS_REPAIR',
      equipmentId: String(fixtures.assetA1._id),
      repairDate: '2026-07-17',
      repairerName: '赵师傅'
    }
  });
  repair = await action(service, role.subManager, repair, 'SUB_DEPARTMENT_APPROVE');
  assert.equal(repair.status, 'DEPUTY_APPROVAL_PENDING');
  repair = await action(service, role.deputy, repair, 'REJECT_TO_PREVIOUS', { note: '补充维修说明' });
  assert.equal(repair.status, 'SUB_DEPARTMENT_ACCEPTANCE_PENDING');
  repair = await action(service, role.subManager, repair, 'REJECT_TO_CREATOR', { note: '请创建人补充' });
  assert.equal(repair.status, 'RETURNED_TO_CREATOR');
  repair = await action(service, role.creator, repair, 'RESUBMIT', {
    corrections: { repairDescription: '紧固接线端子并复测' }
  });
  assert.equal(repair.status, 'SUB_DEPARTMENT_ACCEPTANCE_PENDING');
  assert.equal(repair.repairDescription, '紧固接线端子并复测');
  repair = await action(service, role.subManager, repair, 'VOID', { note: '设备已由厂家召回' });
  assert.equal(repair.status, 'VOIDED');
});

test('tenant, org-unit, duplicate, and revision checks prevent unauthorized or repeated mutation', async () => {
  const service = createService();
  const role = actors();
  const idempotencyKey = randomUUID();
  const first = await createFault(service, role.creator, { idempotencyKey });
  const duplicate = await createFault(service, role.creator, { idempotencyKey });
  assert.equal(duplicate._id, first._id);
  assert.equal(await EquipmentRepairOrder.countDocuments({}), 1);

  await assert.rejects(
    service.getRepair({ authContext: role.otherTeam, repairId: first._id }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service.createRepair({
      authContext: role.creator,
      input: {
        type: 'NO_PARTS_REPAIR',
        equipmentId: String(fixtures.assetA2._id),
        repairDate: '2026-07-17',
        repairerName: '越权用户'
      }
    }),
    (error) => error.status === 404
  );

  const reviewed = await action(service, role.subManager, first, 'SUB_DEPARTMENT_APPROVE');
  await assert.rejects(
    action(service, role.subManager, first, 'SUB_DEPARTMENT_APPROVE'),
    (error) => error.status === 409
  );
  await assert.rejects(
    service.transitionRepair({
      authContext: role.assetAdmin,
      repairId: reviewed._id,
      input: { action: 'ACCEPT_RECEIPT', revision: first.revision }
    }),
    (error) => error.status === 409
  );
});

test('repair photo metadata is hidden from another org unit and another team', async () => {
  const service = createService();
  const role = actors();
  const repair = await createFault(service, role.creator);
  const file = await FileAsset.create({
    teamId: fixtures.teamA._id,
    ownerType: FileAsset.FILE_OWNER_TYPES.REPAIR,
    ownerId: repair._id,
    storageKey: `${fixtures.teamA._id}/2026/07/${randomUUID()}.jpg`,
    originalName: '故障现场.jpg',
    mimeType: 'image/jpeg',
    size: 1024,
    sha256: 'a'.repeat(64),
    uploaderId: role.creator.userId,
    status: FileAsset.FILE_STATUSES.ACTIVE
  });
  const fileService = createFileAssetService({ storageRoot: process.cwd() });
  const metadata = await fileService.getMetadata({
    authContext: role.creator,
    fileId: String(file._id)
  });
  assert.equal(metadata.ownerType, 'REPAIR');

  await assert.rejects(
    fileService.getMetadata({ authContext: role.wrongSubManager, fileId: String(file._id) }),
    (error) => error.status === 404
  );
  await assert.rejects(
    fileService.getMetadata({ authContext: role.otherTeam, fileId: String(file._id) }),
    (error) => error.status === 404
  );
});

test('concurrent duplicate approval commits exactly one transition', async () => {
  const service = createService();
  const role = actors();
  const created = await createFault(service, role.creator);
  const reviewed = await action(service, role.subManager, created, 'SUB_DEPARTMENT_APPROVE');
  const results = await Promise.allSettled([
    action(service, role.assetAdmin, reviewed, 'ACCEPT_RECEIPT', { note: '并发请求A' }),
    action(service, role.assetAdmin, reviewed, 'ACCEPT_RECEIPT', { note: '并发请求B' })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(rejected.reason.code, 'EQUIPMENT_REPAIR_CONFLICT');
  const persisted = await EquipmentRepairOrder.findById(reviewed._id).lean();
  assert.equal(persisted.status, 'COMPLETED');
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.actionLogs.length, 3);
});

test('repair export stays scoped and neutralizes spreadsheet formulas', async () => {
  const service = createService();
  const role = actors();
  const repair = await service.createRepair({
    authContext: role.creator,
    input: {
      type: 'NO_PARTS_REPAIR',
      equipmentId: String(fixtures.assetA1._id),
      repairDate: '2026-07-17',
      repairerName: '=HYPERLINK("https://invalid.test")',
      repairDescription: '+formula'
    }
  });
  const exportQuery = {
    type: 'NO_PARTS_REPAIR',
    status: repair.status,
    equipmentId: String(fixtures.assetA1._id),
    orgUnitId: String(fixtures.orgA1._id),
    createdBy: role.creator.userId,
    keyword: 'HYPERLINK'
  };
  const workbookBuffer = await service.exportRepairs({
    authContext: role.creator,
    req: {
      method: 'GET',
      originalUrl: '/api/equipment/repairs/export?type=NO_PARTS_REPAIR'
    },
    query: exportQuery
  });
  const workbook = XLSX.read(workbookBuffer, { type: 'buffer', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['维修记录'], { defval: '' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['维修人'], "'=HYPERLINK(\"https://invalid.test\")");
  assert.equal(rows[0]['维修说明'], "'+formula");
  assert.equal(rows[0]['设备编码'], 'FC-A1-001');
  const exportAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.REPAIR_ORDER
  }).lean();
  assert.ok(exportAudit);
  assert.equal(String(exportAudit.actorUserId), role.creator.userId);
  assert.equal(String(exportAudit.activeTeamId), String(fixtures.teamA._id));
  assert.equal(String(exportAudit.targetTeamId), String(fixtures.teamA._id));
  assert.equal(exportAudit.requestMethod, 'GET');
  assert.equal(exportAudit.requestPath, '/api/equipment/repairs/export');
  assert.equal(exportAudit.after.count, 1);
  assert.deepEqual(exportAudit.after.filters, {
    type: 'NO_PARTS_REPAIR',
    statuses: [repair.status],
    equipmentId: String(fixtures.assetA1._id),
    orgUnitId: String(fixtures.orgA1._id),
    createdBy: role.creator.userId,
    keyword: 'HYPERLINK',
    startDate: null,
    endDate: null
  });
});
