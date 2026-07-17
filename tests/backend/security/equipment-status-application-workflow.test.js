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

const DB_NAME = `equipment_status_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
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
    ['idle', orgA1._id, 'IDLE']
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

test('final approval atomically updates asset and audit failure rolls back application, history, and status', async () => {
  let current = await createApplication(fixture.assets.a1, 'SCRAPPED');
  current = await action(current, 'deputy', 'DEPUTY_APPROVE');
  const baselineApprovals = await EquipmentStatusApproval.countDocuments({ applicationId: current._id });
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
