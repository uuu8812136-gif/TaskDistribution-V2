'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const permissions = require('../../../app/config/permissions');
const {
  createContractManagementService,
  derivedContractState,
  normalizeAttachmentInput,
  normalizeRecordInput,
  todayShanghai
} = require('../../../app/services/contractManagementService');

function id() {
  return new mongoose.Types.ObjectId().toString();
}

function context() {
  const teamId = id();
  const userId = id();
  return Object.freeze({
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId,
    activeTeamId: teamId,
    permissionKeys: Object.freeze(['contract.supplier.manage']),
    moduleDataScopes: Object.freeze({}),
    membership: Object.freeze({ role: permissions.MEMBERSHIP_ROLES.MEMBER }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
    readOnly: false,
    canAccessBusiness: true
  });
}

test('Shanghai date-only contract validity uses only expiry day and auto-renew', () => {
  const today = todayShanghai(new Date('2026-08-11T02:00:00.000Z'));
  assert.equal(today.toISOString(), '2026-08-11T00:00:00.000Z');
  const base = {
    signingStatus: 'SIGNED',
    effectiveDate: new Date('2026-08-01T00:00:00.000Z'),
    expiryDate: new Date('2026-08-11T00:00:00.000Z'),
    autoRenew: false
  };
  assert.deepEqual(derivedContractState(base, today), {
    hasSignedContract: true,
    contractValid: true
  });
  assert.equal(derivedContractState({ ...base, expiryDate: new Date('2026-08-10'), autoRenew: false }, today).contractValid, false);
  assert.equal(derivedContractState({ ...base, expiryDate: new Date('2026-08-10'), autoRenew: true }, today).contractValid, true);
  assert.equal(derivedContractState({ ...base, effectiveDate: new Date('2026-08-12') }, today).contractValid, true);
  assert.equal(derivedContractState({ ...base, signingStatus: 'UNSIGNED' }, today).contractValid, true);
  assert.deepEqual(derivedContractState({ ...base, signingStatus: 'UNSIGNED' }, today), {
    hasSignedContract: false,
    contractValid: true
  });
  assert.equal(derivedContractState({ ...base, expiryDate: null, autoRenew: true }, today).contractValid, false);
  assert.deepEqual(derivedContractState(null, today), {
    hasSignedContract: false,
    contractValid: false
  });
});

test('record input accepts nullable contract dates and nullable detail dates', () => {
  const normalized = normalizeRecordInput({
    category: 'MAIN_SERVICE_AGREEMENT',
    signingStatus: 'UNSIGNED',
    contractNumber: '',
    effectiveDate: '',
    expiryDate: null,
    autoRenew: false,
    details: {
      supplierSignedDate: '',
      companySignedDate: null,
      returnDate: '',
      deliveredBusinessDate: '',
      deliveredFactoryDate: ''
    }
  });
  assert.equal(normalized.effectiveDate, null);
  assert.equal(normalized.expiryDate, null);
  assert.equal(normalized.details.supplierSignedDate, null);
  assert.equal(normalized.details.companySignedDate, null);
});

test('manual contract renewal input accepts boolean values and legacy labels', () => {
  for (const category of [
    'MAIN_SERVICE_AGREEMENT',
    'LOGISTICS_FEE_AGREEMENT',
    'TURNOVER_EQUIPMENT_SERVICE',
    'EQUIPMENT_RENTAL'
  ]) {
    const base = {
      category,
      signingStatus: 'SIGNED',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      details: {}
    };
    assert.equal(normalizeRecordInput({ ...base, autoRenew: true }).autoRenew, true);
    assert.equal(normalizeRecordInput({ ...base, autoRenew: false }).autoRenew, false);
    assert.equal(normalizeRecordInput({ ...base, autoRenew: '是' }).autoRenew, true);
    assert.equal(normalizeRecordInput({ ...base, autoRenew: '否' }).autoRenew, false);
    assert.equal(normalizeRecordInput({ ...base, autoRenew: '未设置' }).autoRenew, null);
  }
});

test('record PATCH deep-merges only the current category details', () => {
  const current = {
    category: 'LOGISTICS_FEE_AGREEMENT',
    signingStatus: 'SIGNED',
    contractNumber: '',
    effectiveDate: new Date('2026-01-01'),
    expiryDate: new Date('2026-12-31'),
    autoRenew: false,
    details: {
      warehouseServiceRate: '7‰',
      overstorageServiceRate: '8‰',
      overstorageDays: '30+15',
      settlementCycle: '月结',
      remarks: 'before',
      equipmentType: 'must not leak from the shared schema'
    },
    attachments: []
  };
  const normalized = normalizeRecordInput({ details: { remarks: 'after' } }, {
    current,
    partial: true
  });
  assert.equal(normalized.details.warehouseServiceRate, '7‰');
  assert.equal(normalized.details.overstorageDays, '30+15');
  assert.equal(normalized.details.remarks, 'after');
  assert.equal(Object.hasOwn(normalized.details, 'equipmentType'), false);

  const freeText = normalizeRecordInput({
    category: 'LOGISTICS_FEE_AGREEMENT',
    signingStatus: 'SIGNED',
    details: { overstorageDays: '  免超储费  ' }
  });
  assert.equal(freeText.details.overstorageDays, '免超储费');
});

test('attachment purpose is category-scoped and duplicate file IDs are rejected', () => {
  const fileId = id();
  assert.deepEqual(normalizeAttachmentInput('EQUIPMENT_RENTAL', [
    { fileId, purpose: 'PAYMENT_RECEIPT' }
  ]), [{ fileId, purpose: 'PAYMENT_RECEIPT' }]);
  assert.throws(() => normalizeAttachmentInput('LOGISTICS_FEE_AGREEMENT', [
    { fileId, purpose: 'PAYMENT_RECEIPT' }
  ]), { code: 'CONTRACT_ATTACHMENT_PURPOSE_INVALID' });
  assert.throws(() => normalizeAttachmentInput('EQUIPMENT_RENTAL', [
    { fileId, purpose: 'CONTRACT_PDF' },
    { fileId, purpose: 'PAYMENT_RECEIPT' }
  ]), { code: 'CONTRACT_ATTACHMENT_DUPLICATE' });
});

test('standalone MongoDB rejects contract writes before any model mutation', async () => {
  let createCalled = false;
  const service = createContractManagementService({
    SupplierModel: {
      create() { createCalled = true; }
    },
    auditService: { record() { throw new Error('must not audit'); } },
    fileAssetService: { reconcileOwnerFiles() { throw new Error('must not bind'); } },
    connection: { client: { topology: { description: { type: 'Single' } } } }
  });
  await assert.rejects(service.createFirstRecord({
    authContext: context(),
    input: {
      supplierIdentity: { name: 'Supplier', code: '0001' },
      trusteeAttribute: 'HOSTED',
      category: 'SUPPLIER_INFO',
      details: {},
      attachments: []
    }
  }), {
    status: 503,
    code: 'CONTRACT_TRANSACTIONS_REQUIRED'
  });
  assert.equal(createCalled, false);
});
