'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const EquipmentStatusApplication = require('../../../app/models/EquipmentStatusApplication');
const EquipmentStatusApproval = require('../../../app/models/EquipmentStatusApproval');
const FileAsset = require('../../../app/models/FileAsset');
const Message = require('../../../app/models/Message');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const { createAuditService } = require('../../../app/services/auditService');
const { createEquipmentRegistryService } = require('../../../app/services/equipmentRegistryService');
const { createFileAssetService } = require('../../../app/services/fileAssetService');
const {
  createEquipmentStatusApplicationService
} = require('../../../app/services/equipmentStatusApplicationService');
const {
  createEquipmentRoutineWorkerService
} = require('../../../app/services/equipmentRoutineWorkerService');

const DB_NAME = `equipment_status_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutinePlan,
  EquipmentRoutineRule,
  EquipmentStatusApplication,
  EquipmentStatusApproval,
  FileAsset,
  Message,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function fakeFiles() {
  return {
    async reconcileOwnerFiles({ attachments }) {
      return attachments.map((attachment, index) => ({
        fileId: attachment.fileId,
        originalName: `status-${index + 1}.jpg`,
        mimeType: 'image/jpeg',
        size: 1024,
        uploadTime: new Date('2026-07-17T08:00:00.000Z')
      }));
    }
  };
}

function scopeMap(membership) {
  return Object.freeze(Object.fromEntries(
    membership.moduleDataScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
  ));
}

function context(key) {
  const membership = fixture.memberships[key];
  const user = fixture.users[key];
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(user._id),
    user: Object.freeze({ _id: String(user._id), username: user.username, name: user.name }),
    isSuperAdmin: false,
    activeTeamId: String(membership.teamId),
    team: Object.freeze({ _id: String(membership.teamId), name: '测试物流部', status: 'ACTIVE' }),
    membership: Object.freeze({
      _id: String(membership._id),
      teamId: String(membership.teamId),
      userId: String(membership.userId),
      orgUnitId: String(membership.orgUnitId),
      role: membership.role,
      positionLevel: membership.positionLevel,
      positionKey: membership.positionKey,
      functionalRoleKeys: Object.freeze([...membership.functionalRoleKeys]),
      status: membership.status
    }),
    orgUnit: Object.freeze({ _id: String(membership.orgUnitId), teamId: String(membership.teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([...membership.permissionKeys]),
    moduleDataScopes: scopeMap(membership),
    readOnly: false,
    canAccessBusiness: true
  });
}

async function createActor({
  key,
  teamId,
  orgUnitId,
  positionKey = permissions.POSITION_KEYS.EMPLOYEE,
  functionalRoleKeys = [],
  permissionKeys = ['equipment.view']
}) {
  const user = await User.create({
    username: `status_${key}`,
    name: key,
    password: 'test-only-status-password',
    roles: ['executor']
  });
  const membership = await TeamMembership.create({
    teamId,
    userId: user._id,
    orgUnitId,
    positionKey,
    positionLevel: permissions.POSITION_LEVEL_BY_KEY[positionKey],
    functionalRoleKeys,
    permissionKeys
  });
  fixture.users[key] = user;
  fixture.memberships[key] = membership;
}

async function seed() {
  const seedUser = objectId();
  const teamA = await ProjectTeam.create({ code: 'STATUS_A', name: '变速箱物流部', createdBy: seedUser });
  const teamB = await ProjectTeam.create({ code: 'STATUS_B', name: '发动机物流部', createdBy: seedUser });
  const orgA1 = await OrgUnit.create({ teamId: teamA._id, code: 'A1', name: '一分部', type: 'SUB_DEPARTMENT', level: 2, path: '/' });
  const orgA2 = await OrgUnit.create({ teamId: teamA._id, code: 'A2', name: '二分部', type: 'SUB_DEPARTMENT', level: 2, path: '/' });
  const orgB = await OrgUnit.create({ teamId: teamB._id, code: 'B1', name: '发动机分部', type: 'SUB_DEPARTMENT', level: 2, path: '/' });
  const categoryA = await EquipmentCategory.create({ teamId: teamA._id, name: '叉车', createdBy: seedUser, updatedBy: seedUser });
  const categoryB = await EquipmentCategory.create({ teamId: teamB._id, name: '叉车', createdBy: seedUser, updatedBy: seedUser });
  const assets = {};
  for (const [key, orgUnitId, status = 'IN_USE'] of [
    ['a1', orgA1._id],
    ['a2', orgA2._id],
    ['a3', orgA1._id],
    ['idle', orgA1._id, 'IDLE'],
    ['stopped', orgA1._id, 'STOPPED'],
    ['scrapped', orgA1._id, 'SCRAPPED']
  ]) {
    assets[key] = await EquipmentAsset.create({
      teamId: teamA._id,
      orgUnitId,
      assetCode: `STATUS-${key.toUpperCase()}`,
      name: `状态测试设备${key}`,
      categoryId: categoryA._id,
      status,
      createdBy: seedUser,
      updatedBy: seedUser
    });
  }
  assets.b1 = await EquipmentAsset.create({
    teamId: teamB._id,
    orgUnitId: orgB._id,
    assetCode: 'STATUS-B1',
    name: '另一团队设备',
    categoryId: categoryB._id,
    createdBy: seedUser,
    updatedBy: seedUser
  });
  fixture = { teamA, teamB, orgA1, orgA2, orgB, assets, users: {}, memberships: {} };
  await createActor({ key: 'assetAdmin', teamId: teamA._id, orgUnitId: orgA1._id, functionalRoleKeys: ['ASSET_ADMIN'], permissionKeys: ['equipment.view', 'equipment.status.apply'] });
  await createActor({ key: 'regular', teamId: teamA._id, orgUnitId: orgA1._id, permissionKeys: ['equipment.view', 'equipment.status.apply'] });
  await createActor({ key: 'otherDivision', teamId: teamA._id, orgUnitId: orgA2._id, permissionKeys: ['equipment.view'] });
  await createActor({ key: 'deputy', teamId: teamA._id, orgUnitId: orgA1._id, positionKey: 'DEPARTMENT_DEPUTY_MANAGER', permissionKeys: ['equipment.view', 'equipment.status.approve'] });
  await createActor({ key: 'assistant', teamId: teamA._id, orgUnitId: orgA2._id, positionKey: 'DEPARTMENT_MANAGER_ASSISTANT', permissionKeys: ['equipment.view', 'equipment.status.approve'] });
  await createActor({ key: 'manager', teamId: teamA._id, orgUnitId: orgA1._id, positionKey: 'DEPARTMENT_MANAGER', permissionKeys: ['equipment.view', 'equipment.status.approve'] });
  await createActor({ key: 'otherTeamAdmin', teamId: teamB._id, orgUnitId: orgB._id, functionalRoleKeys: ['ASSET_ADMIN'], permissionKeys: ['equipment.view', 'equipment.status.apply'] });
}

function service(options = {}) {
  return createEquipmentStatusApplicationService({
    fileAssetService: fakeFiles(),
    ...options
  });
}

async function createApplication(asset, applicationType = 'IDLE', extra = {}) {
  return service().createApplication({
    authContext: context('assetAdmin'),
    input: {
      equipmentId: String(asset._id),
      applicationType,
      reason: `${applicationType}测试原因`,
      attachments: [{ fileId: String(objectId()) }],
      ...extra
    }
  });
}

async function action(application, actor, actionName, extra = {}, customService = service()) {
  return customService.transitionApplication({
    authContext: context(actor),
    applicationId: application._id,
    input: {
      action: actionName,
      revision: application.revision,
      opinion: `${actionName}意见`,
      ...extra
    }
  });
}

async function createOpenRoutinePlans(asset) {
  const prefix = randomUUID();
  const planBase = {
    teamId: asset.teamId,
    orgUnitId: asset.orgUnitId,
    equipmentId: asset._id,
    categoryId: asset.categoryId,
    ruleVersion: 1,
    scheduledFor: new Date('2026-07-17T00:00:00.000Z'),
    dueAt: new Date('2026-07-17T02:00:00.000Z')
  };
  return EquipmentRoutinePlan.create([
    {
      ...planBase,
      ruleId: objectId(),
      ruleSnapshot: { name: '状态变更前点检规则' },
      routineType: 'INSPECTION',
      cycleKey: `${prefix}:inspection`,
      windowKey: 'DAY_SHIFT',
      windowName: '白班',
      status: 'IN_WINDOW'
    },
    {
      ...planBase,
      ruleId: objectId(),
      ruleSnapshot: { name: '状态变更前保养规则' },
      routineType: 'MAINTENANCE',
      cycleKey: `${prefix}:maintenance`,
      windowKey: 'MAINTENANCE',
      windowName: '保养窗口',
      status: 'OVERDUE'
    }
  ]);
}

before(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: DB_NAME }]
  });
  await mongoose.connect(replSet.getUri(DB_NAME), { dbName: DB_NAME });
  for (const model of MODELS) await model.syncIndexes();
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test('all three application types share the fixed chain and assistant substitutes for deputy', async () => {
  const idle = await createApplication(fixture.assets.a1, 'IDLE');
  const stopped = await createApplication(fixture.assets.a2, 'STOPPED');
  const scrapped = await createApplication(fixture.assets.a3, 'SCRAPPED');
  assert.deepEqual([idle, stopped, scrapped].map((item) => item.workflowStatus), [
    'DEPUTY_REVIEW_PENDING',
    'DEPUTY_REVIEW_PENDING',
    'DEPUTY_REVIEW_PENDING'
  ]);
  const approved = [];
  for (const [application, reviewer] of [
    [idle, 'assistant'],
    [stopped, 'deputy'],
    [scrapped, 'assistant']
  ]) {
    let current = await action(application, reviewer, 'DEPUTY_APPROVE');
    assert.equal(current.workflowStatus, 'MANAGER_REVIEW_PENDING');
    current = await action(current, 'manager', 'MANAGER_APPROVE');
    assert.equal(current.workflowStatus, 'APPROVED');
    approved.push(current);
    assert.equal(await EquipmentStatusApproval.countDocuments({ applicationId: application._id }), 3);
  }
  const persisted = await EquipmentAsset.find({
    _id: { $in: [fixture.assets.a1._id, fixture.assets.a2._id, fixture.assets.a3._id] }
  }).sort({ assetCode: 1 }).lean();
  assert.deepEqual(persisted.map((asset) => asset.status), ['IDLE', 'STOPPED', 'SCRAPPED']);
  assert.ok(approved.every((application) => application.open === false));
});

test('idle and stopped equipment can return to in-use through the fixed approval chain', async () => {
  for (const [asset, reviewer] of [
    [fixture.assets.idle, 'deputy'],
    [fixture.assets.stopped, 'assistant']
  ]) {
    const openPlans = await createOpenRoutinePlans(asset);
    let current = await createApplication(asset, 'IN_USE');
    assert.equal(current.sourceStatus, asset.status);
    assert.equal(current.targetStatus, 'IN_USE');
    current = await action(current, reviewer, 'DEPUTY_APPROVE');
    current = await action(current, 'manager', 'MANAGER_APPROVE');
    assert.equal(current.workflowStatus, 'APPROVED');
    assert.equal((await EquipmentAsset.findById(asset._id).lean()).status, 'IN_USE');
    assert.equal(await EquipmentStatusApproval.countDocuments({ applicationId: current._id }), 3);
    const notifications = await Message.find({ type: 'equipment_status' }).lean();
    const notification = notifications.find((item) => (
      String(item.extraData?.statusApplicationId) === String(current._id) &&
      item.extraData?.applicationType === 'IN_USE'
    ));
    assert.ok(notification);
    assert.match(notification.title, /恢复在用/);
    const persistedPlans = await EquipmentRoutinePlan.find({
      _id: { $in: openPlans.map(({ _id }) => _id) }
    }).lean();
    assert.ok(persistedPlans.every(({ status, cancellationReason, cancelledAt, cancelledBy }) => (
      ['IN_WINDOW', 'OVERDUE'].includes(status) &&
      cancellationReason === null &&
      cancelledAt === null &&
      cancelledBy === null
    )));
  }
});

test('worker restores the same current-cycle plans after final reactivation without reviving history', async () => {
  const runAt = new Date('2030-01-15T02:30:00.000Z');
  const categoryType = await EquipmentCategory.create({
    teamId: fixture.teamA._id,
    parentId: fixture.assets.idle.categoryId,
    name: 'Reactivation type',
    createdBy: fixture.users.manager._id,
    updatedBy: fixture.users.manager._id
  });
  const primaryCategory = await EquipmentCategory.create({
    teamId: fixture.teamA._id,
    parentId: categoryType._id,
    name: 'Reactivation primary',
    createdBy: fixture.users.manager._id,
    updatedBy: fixture.users.manager._id
  });
  const secondaryCategory = await EquipmentCategory.create({
    teamId: fixture.teamA._id,
    parentId: primaryCategory._id,
    name: 'Reactivation secondary',
    createdBy: fixture.users.manager._id,
    updatedBy: fixture.users.manager._id
  });
  const rules = await EquipmentRoutineRule.create([
    {
      teamId: fixture.teamA._id,
      categoryId: primaryCategory._id,
      routineType: 'INSPECTION',
      name: 'Reactivation daily inspection',
      checklistItems: [{ key: 'reactivation-check', name: 'Check after reactivation' }],
      schedule: {
        mode: 'CALENDAR',
        calendar: {
          unit: 'DAY',
          interval: 1,
          firstDueAt: new Date('2030-01-15T00:00:00.000Z')
        }
      },
      executionConfig: {
        timeZone: 'Asia/Shanghai',
        windows: [
          { key: 'DAY_SHIFT', name: 'Day shift', startTime: '07:00', endTime: '09:00', enabled: true },
          { key: 'NIGHT_SHIFT', name: 'Night shift', startTime: '19:00', endTime: '21:00', enabled: true }
        ],
        weeklyDay: 1,
        monthlyDay: 1,
        inspectionEscalationMinutes: 60,
        locationPolicy: 'PENDING_CONFIRMATION',
        locationPrecisionMeters: null
      },
      createdBy: fixture.users.manager._id,
      updatedBy: fixture.users.manager._id
    },
    {
      teamId: fixture.teamA._id,
      categoryId: primaryCategory._id,
      routineType: 'MAINTENANCE',
      name: 'Reactivation daily maintenance',
      checklistItems: [{ key: 'reactivation-maintenance', name: 'Maintain after reactivation' }],
      schedule: {
        mode: 'CALENDAR',
        calendar: {
          unit: 'DAY',
          interval: 1,
          firstDueAt: new Date('2030-01-15T00:00:00.000Z')
        }
      },
      executionConfig: {
        timeZone: 'Asia/Shanghai',
        windows: [
          { key: 'MAINTENANCE', name: 'Maintenance window', startTime: '07:00', endTime: '09:00', enabled: true },
          { key: 'UNUSED_WINDOW', name: 'Unused window', startTime: '19:00', endTime: '21:00', enabled: true }
        ],
        weeklyDay: 1,
        monthlyDay: 1,
        inspectionEscalationMinutes: 60,
        locationPolicy: 'PENDING_CONFIRMATION',
        locationPrecisionMeters: null
      },
      createdBy: fixture.users.manager._id,
      updatedBy: fixture.users.manager._id
    }
  ]);
  const assets = await EquipmentAsset.create([
    {
      teamId: fixture.teamA._id,
      orgUnitId: fixture.orgA1._id,
      categoryId: secondaryCategory._id,
      assetCode: 'STATUS-REACTIVATE-IDLE',
      name: 'Idle equipment awaiting reactivation',
      status: 'IN_USE',
      createdBy: fixture.users.manager._id,
      updatedBy: fixture.users.manager._id
    },
    {
      teamId: fixture.teamA._id,
      orgUnitId: fixture.orgA1._id,
      categoryId: secondaryCategory._id,
      assetCode: 'STATUS-REACTIVATE-STOPPED',
      name: 'Stopped equipment awaiting reactivation',
      status: 'IN_USE',
      createdBy: fixture.users.manager._id,
      updatedBy: fixture.users.manager._id
    }
  ]);
  const worker = createEquipmentRoutineWorkerService({ clock: () => runAt });
  await worker.runOnce({ now: runAt, teamId: fixture.teamA._id });
  const currentCycleKey = 'calendar:2030-01-15T00:00:00.000Z';
  const currentPlans = await EquipmentRoutinePlan.find({
    ruleId: { $in: rules.map(({ _id }) => _id) },
    equipmentId: { $in: assets.map(({ _id }) => _id) },
    cycleKey: currentCycleKey
  }).sort({ equipmentId: 1, ruleId: 1, windowKey: 1 }).lean();
  assert.equal(currentPlans.length, 6);
  for (const asset of assets) {
    assert.deepEqual(
      currentPlans
        .filter(({ equipmentId, routineType }) => (
          String(equipmentId) === String(asset._id) && routineType === 'INSPECTION'
        ))
        .map(({ windowKey }) => windowKey)
        .sort(),
      ['DAY_SHIFT', 'NIGHT_SHIFT']
    );
    assert.deepEqual(
      currentPlans
        .filter(({ equipmentId, routineType }) => (
          String(equipmentId) === String(asset._id) && routineType === 'MAINTENANCE'
        ))
        .map(({ windowKey }) => windowKey),
      ['MAINTENANCE']
    );
  }
  const currentPlanIds = currentPlans.map(({ _id }) => String(_id)).sort();
  const historicalPlans = await EquipmentRoutinePlan.create(assets.map((asset) => ({
    teamId: fixture.teamA._id,
    orgUnitId: fixture.orgA1._id,
    equipmentId: asset._id,
    categoryId: secondaryCategory._id,
    ruleId: rules[0]._id,
    ruleVersion: rules[0].version,
    ruleSnapshot: { name: rules[0].name },
    routineType: 'INSPECTION',
    cycleKey: 'calendar:2030-01-14T00:00:00.000Z',
    windowKey: 'DAY_SHIFT',
    windowName: 'Day shift',
    scheduledFor: new Date('2030-01-13T23:00:00.000Z'),
    dueAt: new Date('2030-01-14T01:00:00.000Z'),
    status: 'CANCELLED',
    cancellationReason: 'EQUIPMENT_STATUS_CHANGED',
    cancelledAt: new Date('2030-01-14T00:30:00.000Z'),
    cancelledBy: fixture.users.manager._id
  })));

  for (const [asset, targetStatus] of [
    [assets[0], 'IDLE'],
    [assets[1], 'STOPPED']
  ]) {
    let application = await createApplication(asset, targetStatus);
    application = await action(application, 'deputy', 'DEPUTY_APPROVE');
    application = await action(application, 'manager', 'MANAGER_APPROVE');
    assert.equal(application.workflowStatus, 'APPROVED');
  }
  const cancelledCurrentPlans = await EquipmentRoutinePlan.find({
    _id: { $in: currentPlans.map(({ _id }) => _id) }
  }).lean();
  assert.ok(cancelledCurrentPlans.every(({ status, cancellationReason }) => (
    status === 'CANCELLED' && cancellationReason === 'EQUIPMENT_STATUS_CHANGED'
  )));

  for (const asset of assets) {
    let application = await createApplication(asset, 'IN_USE');
    application = await action(application, 'deputy', 'DEPUTY_APPROVE');
    application = await action(application, 'manager', 'MANAGER_APPROVE');
    assert.equal(application.workflowStatus, 'APPROVED');
  }
  await worker.runOnce({ now: runAt, teamId: fixture.teamA._id });
  const restoredPlans = await EquipmentRoutinePlan.find({
    _id: { $in: currentPlans.map(({ _id }) => _id) }
  }).sort({ equipmentId: 1, ruleId: 1, windowKey: 1 }).lean();
  assert.deepEqual(restoredPlans.map(({ _id }) => String(_id)).sort(), currentPlanIds);
  for (const plan of restoredPlans) {
    assert.ok(['PLANNED', 'IN_WINDOW', 'OVERDUE'].includes(plan.status));
    assert.equal(plan.cancellationReason, null);
    assert.equal(plan.cancelledAt, null);
    assert.equal(plan.cancelledBy, null);
    assert.equal(plan.rematerializationCount, 1);
    assert.equal(plan.rematerializationHistory.length, 1);
    assert.equal(plan.rematerializationHistory[0].cancellationReason, 'EQUIPMENT_STATUS_CHANGED');
    assert.equal(plan.rematerializationHistory[0].source, 'WORKER');
  }

  const persistedHistory = await EquipmentRoutinePlan.find({
    _id: { $in: historicalPlans.map(({ _id }) => _id) }
  }).sort({ equipmentId: 1, windowKey: 1 }).lean();
  assert.ok(persistedHistory.every(({
    status,
    cancellationReason,
    rematerializationCount,
    rematerializationHistory
  }) => (
    status === 'CANCELLED' &&
    cancellationReason === 'EQUIPMENT_STATUS_CHANGED' &&
    rematerializationCount === 0 &&
    rematerializationHistory.length === 0
  )));

  const planCountAfterFirstRun = await EquipmentRoutinePlan.countDocuments({
    ruleId: { $in: rules.map(({ _id }) => _id) }
  });
  await worker.runOnce({ now: runAt, teamId: fixture.teamA._id });
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    ruleId: { $in: rules.map(({ _id }) => _id) }
  }), planCountAfterFirstRun);
  assert.deepEqual(
    (await EquipmentRoutinePlan.find({
      ruleId: { $in: rules.map(({ _id }) => _id) },
      equipmentId: { $in: assets.map(({ _id }) => _id) },
      cycleKey: currentCycleKey
    }).lean()).map(({ _id }) => String(_id)).sort(),
    currentPlanIds
  );
  assert.ok((await EquipmentRoutinePlan.find({
    _id: { $in: currentPlanIds }
  }).lean()).every(({ rematerializationCount, rematerializationHistory }) => (
    rematerializationCount === 1 && rematerializationHistory.length === 1
  )));
});

test('in-use is rejected as a same-state target and scrapped equipment remains terminal', async () => {
  await assert.rejects(
    createApplication(fixture.assets.a1, 'IN_USE'),
    (error) => error.status === 409 && error.code === 'EQUIPMENT_STATUS_APPLICATION_CONFLICT'
  );
  await assert.rejects(
    createApplication(fixture.assets.scrapped, 'IN_USE'),
    (error) => error.status === 409 && error.code === 'EQUIPMENT_STATUS_APPLICATION_CONFLICT'
  );
});

test('only ASSET_ADMIN can initiate and team/org scope blocks unrelated readers', async () => {
  await assert.rejects(
    service().createApplication({
      authContext: context('regular'),
      input: { equipmentId: String(fixture.assets.a1._id), applicationType: 'IDLE', reason: '绕过岗位' }
    }),
    (error) => error.status === 403 && error.code === 'EQUIPMENT_STATUS_APPLICANT_FORBIDDEN'
  );
  const created = await createApplication(fixture.assets.a1, 'IDLE');
  await assert.rejects(
    service().getApplication({ authContext: context('otherTeamAdmin'), applicationId: created._id }),
    (error) => error.status === 404
  );
  await assert.rejects(
    service().getApplication({ authContext: context('otherDivision'), applicationId: created._id }),
    (error) => error.status === 404
  );
});

test('todo filtering happens before pagination and reports only actionable rows', async () => {
  const actionable = await createApplication(fixture.assets.a1, 'IDLE');
  const now = new Date();
  await EquipmentStatusApplication.insertMany(Array.from({ length: 20 }, (_, index) => ({
    teamId: fixture.teamA._id,
    orgUnitId: fixture.orgA1._id,
    equipmentId: fixture.assets.a1._id,
    applicationType: 'IDLE',
    sourceStatus: 'IN_USE',
    targetStatus: 'IDLE',
    workflowStatus: 'VOIDED',
    reason: `已结束申请 ${index + 1}`,
    equipmentSnapshot: {
      assetCode: fixture.assets.a1.assetCode,
      name: fixture.assets.a1.name,
      sourceStatus: 'IN_USE',
      targetStatus: 'IDLE'
    },
    createdBy: fixture.users.assetAdmin._id,
    lastActionBy: fixture.users.assetAdmin._id,
    lastActionAt: now,
    submittedAt: now,
    finalizedAt: now,
    revision: 1,
    open: false
  })));

  const result = await service().listApplications({
    authContext: context('deputy'),
    query: { todo: true, page: 1, pageSize: 20 }
  });
  assert.equal(result.total, 1);
  assert.equal(result.applications.length, 1);
  assert.equal(result.applications[0]._id, actionable._id);
  assert.ok(result.applications[0].availableActions.includes('DEPUTY_APPROVE'));
});

test('return to creator supports reason/attachment revision and resubmission, reject and void are terminal', async () => {
  let current = await createApplication(fixture.assets.a1, 'STOPPED');
  current = await action(current, 'deputy', 'RETURN_TO_CREATOR', { opinion: '补充停用依据' });
  assert.equal(current.workflowStatus, 'RETURNED_TO_CREATOR');
  current = await action(current, 'assetAdmin', 'RESUBMIT', {
    opinion: '',
    corrections: {
      reason: '已补充完整停用依据',
      attachments: [{ fileId: String(objectId()) }]
    }
  });
  assert.equal(current.workflowStatus, 'DEPUTY_REVIEW_PENDING');
  assert.equal(current.reason, '已补充完整停用依据');
  assert.equal(current.attachments.length, 1);
  current = await action(current, 'deputy', 'REJECT', { opinion: '依据仍不充分' });
  assert.equal(current.workflowStatus, 'REJECTED');
  assert.equal(current.open, false);
  assert.equal((await EquipmentAsset.findById(fixture.assets.a1._id).lean()).status, 'IN_USE');

  let voided = await createApplication(fixture.assets.a2, 'IDLE');
  voided = await action(voided, 'assetAdmin', 'VOID', { opinion: '申请信息有误' });
  assert.equal(voided.workflowStatus, 'VOIDED');
});

test('ordinary equipment PATCH cannot bypass approval and duplicate/concurrent transitions are rejected', async () => {
  const registry = createEquipmentRegistryService();
  await assert.rejects(
    registry.updateAsset({
      authContext: Object.freeze({
        ...context('assetAdmin'),
        permissionKeys: Object.freeze([...context('assetAdmin').permissionKeys, 'equipment.edit'])
      }),
      equipmentId: String(fixture.assets.a1._id),
      input: { status: 'IDLE' }
    }),
    (error) => error.status === 409 && error.code === 'EQUIPMENT_STATUS_APPROVAL_REQUIRED'
  );
  const created = await createApplication(fixture.assets.a1, 'IDLE', { idempotencyKey: 'same-request' });
  const duplicate = await createApplication(fixture.assets.a1, 'IDLE', { idempotencyKey: 'same-request' });
  assert.equal(duplicate._id, created._id);
  await assert.rejects(
    createApplication(fixture.assets.a1, 'STOPPED'),
    (error) => error.status === 409
  );
  const results = await Promise.allSettled([
    action(created, 'deputy', 'DEPUTY_APPROVE'),
    action(created, 'assistant', 'DEPUTY_APPROVE')
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'EQUIPMENT_STATUS_APPLICATION_CONFLICT');
});

test('status application attachments are isolated by team and organization', async () => {
  const created = await createApplication(fixture.assets.a1, 'IDLE');
  const file = await FileAsset.create({
    teamId: fixture.teamA._id,
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION,
    ownerId: created._id,
    storageKey: `${fixture.teamA._id}/2026/07/${randomUUID()}.jpg`,
    originalName: '闲置依据.jpg',
    mimeType: 'image/jpeg',
    size: 1024,
    sha256: 'b'.repeat(64),
    uploaderId: context('assetAdmin').userId,
    status: FileAsset.FILE_STATUSES.ACTIVE
  });
  const files = createFileAssetService({ storageRoot: process.cwd() });
  const metadata = await files.getMetadata({ authContext: context('assetAdmin'), fileId: String(file._id) });
  assert.equal(metadata.ownerType, 'EQUIPMENT_STATUS_APPLICATION');
  await assert.rejects(
    files.getMetadata({ authContext: context('otherDivision'), fileId: String(file._id) }),
    (error) => error.status === 404
  );
  await assert.rejects(
    files.getMetadata({ authContext: context('otherTeamAdmin'), fileId: String(file._id) }),
    (error) => error.status === 404
  );
});

test('final approval cancels every open inspection and maintenance plan with the status-change reason', async () => {
  let current = await createApplication(fixture.assets.a1, 'STOPPED');
  current = await action(current, 'deputy', 'DEPUTY_APPROVE');
  const openPlans = await createOpenRoutinePlans(fixture.assets.a1);
  const completedPlan = await EquipmentRoutinePlan.create({
    teamId: fixture.teamA._id,
    orgUnitId: fixture.orgA1._id,
    equipmentId: fixture.assets.a1._id,
    categoryId: fixture.assets.a1.categoryId,
    ruleId: objectId(),
    ruleVersion: 1,
    ruleSnapshot: { name: '已完成历史规则' },
    routineType: 'INSPECTION',
    cycleKey: `${randomUUID()}:completed`,
    windowKey: 'DAY_SHIFT',
    windowName: '白班',
    scheduledFor: new Date('2026-07-16T00:00:00.000Z'),
    dueAt: new Date('2026-07-16T02:00:00.000Z'),
    status: 'COMPLETED',
    completedRecordId: objectId(),
    completedAt: new Date('2026-07-16T01:00:00.000Z'),
    completedBy: fixture.users.assetAdmin._id
  });

  const approved = await action(current, 'manager', 'MANAGER_APPROVE');
  assert.equal(approved.workflowStatus, 'APPROVED');
  assert.equal((await EquipmentAsset.findById(fixture.assets.a1._id).lean()).status, 'STOPPED');

  const cancelledPlans = await EquipmentRoutinePlan.find({
    _id: { $in: openPlans.map(({ _id }) => _id) }
  }).lean();
  assert.equal(cancelledPlans.length, 2);
  assert.ok(cancelledPlans.every(({ status, cancellationReason, cancelledAt, cancelledBy }) => (
    status === 'CANCELLED' &&
    cancellationReason === 'EQUIPMENT_STATUS_CHANGED' &&
    cancelledAt instanceof Date &&
    String(cancelledBy) === String(fixture.users.manager._id)
  )));
  assert.equal((await EquipmentRoutinePlan.findById(completedPlan._id).lean()).status, 'COMPLETED');
});

test('final approval atomically updates asset and audit failure rolls back application, history, and status', async () => {
  let current = await createApplication(fixture.assets.a1, 'SCRAPPED');
  current = await action(current, 'deputy', 'DEPUTY_APPROVE');
  const openPlans = await createOpenRoutinePlans(fixture.assets.a1);
  const baselineApprovals = await EquipmentStatusApproval.countDocuments({ applicationId: current._id });
  const baselineAudits = await AuditLog.countDocuments({});
  const realAudit = createAuditService();
  const failingAudit = {
    async record(input) {
      if (input.resourceType === permissions.AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET) {
        throw new Error('forced equipment audit failure');
      }
      return realAudit.record(input);
    }
  };
  await assert.rejects(
    action(current, 'manager', 'MANAGER_APPROVE', {}, service({ auditService: failingAudit })),
    /forced equipment audit failure/
  );
  const persistedApplication = await EquipmentStatusApplication.findById(current._id).lean();
  const persistedAsset = await EquipmentAsset.findById(fixture.assets.a1._id).lean();
  assert.equal(persistedApplication.workflowStatus, 'MANAGER_REVIEW_PENDING');
  assert.equal(persistedApplication.revision, current.revision);
  assert.equal(persistedAsset.status, 'IN_USE');
  assert.equal(await EquipmentStatusApproval.countDocuments({ applicationId: current._id }), baselineApprovals);
  assert.equal(await AuditLog.countDocuments({}), baselineAudits);
  const persistedPlans = await EquipmentRoutinePlan.find({
    _id: { $in: openPlans.map(({ _id }) => _id) }
  }).lean();
  assert.ok(persistedPlans.every(({ status, cancellationReason, cancelledAt, cancelledBy }) => (
    ['IN_WINDOW', 'OVERDUE'].includes(status) &&
    cancellationReason === null &&
    cancelledAt === null &&
    cancelledBy === null
  )));
  assert.equal(await AuditLog.countDocuments({ resourceType: 'EQUIPMENT_ASSET', resourceId: String(persistedAsset._id) }), 0);
});

test('approval history rejects in-place mutation', async () => {
  const created = await createApplication(fixture.assets.a1, 'IDLE');
  const approval = await EquipmentStatusApproval.findOne({ applicationId: created._id });
  await assert.rejects(
    EquipmentStatusApproval.updateOne({ _id: approval._id }, { $set: { opinion: '篡改' } }),
    (error) => error.code === 'EQUIPMENT_STATUS_APPROVAL_APPEND_ONLY'
  );
});
