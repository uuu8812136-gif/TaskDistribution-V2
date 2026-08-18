'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRepairService,
  normalizeRepairQueryKeyword
} = require('../../../app/services/equipmentRepairService');

function objectId() {
  return new mongoose.Types.ObjectId().toString();
}

function context() {
  const teamId = objectId();
  const orgUnitId = objectId();
  const userId = objectId();
  return Object.freeze({
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId,
    user: Object.freeze({ _id: userId }),
    isSuperAdmin: false,
    activeTeamId: teamId,
    team: Object.freeze({ _id: teamId, name: '测试团队' }),
    membership: Object.freeze({
      orgUnitId,
      positionKey: permissions.POSITION_KEYS.EMPLOYEE,
      functionalRoleKeys: Object.freeze([])
    }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze(['equipment.view', 'equipment.repair']),
    moduleDataScopes: Object.freeze({ equipment: permissions.DATA_SCOPES.ORG_UNIT }),
    readOnly: false,
    canAccessBusiness: true
  });
}

test('repair creation fails before any business or attachment write on standalone MongoDB', async () => {
  let attachmentWrites = 0;
  const service = createEquipmentRepairService({
    connection: { client: { topology: { description: { type: 'Single' } } } },
    fileAssetService: {
      async reconcileOwnerFiles() {
        attachmentWrites += 1;
        return [];
      }
    }
  });

  await assert.rejects(service.createRepair({
    authContext: context(),
    input: {
      type: 'FAULT_REPORT',
      equipmentId: objectId(),
      reportTime: '2026-07-17T08:00:00+08:00',
      reportLocation: '测试地点',
      contactName: '测试联系人',
      contactPhone: '13800000000',
      faultDescription: '测试故障',
      photoAttachments: [{ fileId: objectId() }]
    }
  }), (error) => (
    error.status === 503 && error.code === 'EQUIPMENT_REPAIR_TRANSACTIONS_REQUIRED'
  ));
  assert.equal(attachmentWrites, 0);
});

test('repair query treats legacy serialized undefined keyword as empty', () => {
  assert.equal(normalizeRepairQueryKeyword(undefined), null);
  assert.equal(normalizeRepairQueryKeyword(''), null);
  assert.equal(normalizeRepairQueryKeyword('  undefined  '), null);
  assert.equal(normalizeRepairQueryKeyword('鲁AA5528'), '鲁AA5528');
  assert.throws(() => normalizeRepairQueryKeyword('x'.repeat(101)), /keyword is too long/);
});
