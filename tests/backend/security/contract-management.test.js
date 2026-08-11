'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const ExcelJS = appRequire('exceljs');
const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const FileAsset = require('../../../app/models/FileAsset');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const Supplier = require('../../../app/models/Supplier');
const SupplierContractRecord = require('../../../app/models/SupplierContractRecord');
const SupplierSettlementFee = require('../../../app/models/SupplierSettlementFee');
const permissions = require('../../../app/config/permissions');
const { createAuditService } = require('../../../app/services/auditService');
const { createFileAssetService } = require('../../../app/services/fileAssetService');
const {
  createContractManagementService
} = require('../../../app/services/contractManagementService');
const {
  DETAIL_HEADERS,
  SETTLEMENT_HEADERS
} = require('../../../app/services/contractWorkbookService');

const DATABASE_NAME = `contract_${randomUUID().replaceAll('-', '')}_v2_test`;
const MODELS = [AuditLog, FileAsset, SupplierSettlementFee, SupplierContractRecord, Supplier, ProjectTeam];
const ALL_PERMISSIONS = permissions.PERMISSIONS_BY_MODULE.contract;

let replicaSet;
let fixture;
let service;
let storageRoot;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext(teamId, userId, permissionKeys = ALL_PERMISSIONS) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'contract-admin' }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()), teamId: String(teamId), userId: String(userId),
      orgUnitId: String(objectId()), role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze([...permissionKeys]),
    moduleDataScopes: Object.freeze({}),
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
    user: Object.freeze({ _id: String(userId), username: 'contract-super' }),
    isSuperAdmin: true,
    activeTeamId: null,
    team: null,
    membership: null,
    orgUnit: null,
    actorRole: permissions.AUDIT_ACTOR_ROLES.SUPER_ADMIN,
    permissionKeys: Object.freeze([
      'contract.supplier.view', 'contract.expiry.view', 'contract.settlement.view'
    ]),
    moduleDataScopes: Object.freeze({}),
    readOnly: true,
    canAccessBusiness: true
  });
}

function createService(overrides = {}) {
  const auditService = overrides.auditService || createAuditService({ AuditLog });
  const fileAssetService = createFileAssetService({
    storageRoot,
    FileAssetModel: FileAsset,
    SupplierContractRecordModel: SupplierContractRecord,
    auditService,
    connection: mongoose.connection
  });
  return createContractManagementService({
    auditService,
    fileAssetService,
    connection: mongoose.connection,
    storageRoot,
    now: () => new Date('2026-08-11T03:00:00.000Z'),
    ...overrides
  });
}

async function seedFixture() {
  const values = {
    teamA: objectId(),
    teamB: objectId(),
    userA: objectId(),
    userB: objectId(),
    superUser: objectId()
  };
  await ProjectTeam.collection.insertMany([
    { _id: values.teamA, code: 'CONTRACT_A', name: 'Contract A',
      status: permissions.TEAM_STATUSES.ACTIVE, settings: { timeZone: 'Asia/Shanghai' }, createdBy: values.userA },
    { _id: values.teamB, code: 'CONTRACT_B', name: 'Contract B',
      status: permissions.TEAM_STATUSES.ACTIVE, settings: { timeZone: 'Asia/Shanghai' }, createdBy: values.userB }
  ]);
  values.contextA = teamContext(values.teamA, values.userA);
  values.contextB = teamContext(values.teamB, values.userB);
  values.global = globalContext(values.superUser);
  return values;
}

async function supplier(authContext, code, name = `Supplier ${code}`) {
  const created = await service.createFirstRecord({
    authContext,
    input: {
      supplierIdentity: { name, code },
      trusteeAttribute: 'HOSTED',
      category: 'SUPPLIER_INFO',
      details: {},
      attachments: []
    }
  });
  return created.supplier;
}

async function record(authContext, supplierId, input) {
  return service.createRecord({ authContext, supplierId, input: {
    category: 'MAIN_SERVICE_AGREEMENT', signingStatus: 'SIGNED',
    contractNumber: '', effectiveDate: '2026-01-01', expiryDate: '2026-12-31',
    autoRenew: false, details: {}, ...input
  } });
}

before(async () => {
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'contract-v2-'));
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
  service = createService();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
  if (storageRoot) await fs.promises.rm(storageRoot, { recursive: true, force: true });
});

test('supplier codes are unique per team and reads cannot cross teams', async () => {
  const a = await supplier(fixture.contextA, '0001', 'Supplier A');
  const b = await supplier(fixture.contextB, '0001', 'Supplier B');
  assert.notEqual(String(a._id), String(b._id));
  await assert.rejects(supplier(fixture.contextA, '0001', 'Duplicate'), {
    status: 409,
    code: 'CONTRACT_SUPPLIER_ALREADY_EXISTS'
  });
  await assert.rejects(service.getSupplier({
    authContext: fixture.contextB,
    supplierId: a._id
  }), { status: 404, code: 'CONTRACT_SUPPLIER_NOT_FOUND' });
  const listA = await service.listSuppliers({ authContext: fixture.contextA });
  assert.deepEqual(listA.suppliers.map((item) => item.name), ['Supplier A']);
});

test('global read-only requires explicit active team and can read either team only', async () => {
  await supplier(fixture.contextA, 'A-1', 'Supplier A');
  await supplier(fixture.contextB, 'B-1', 'Supplier B');
  await assert.rejects(service.listSuppliers({ authContext: fixture.global }), {
    status: 400,
    code: 'REPORT_TEAM_REQUIRED'
  });
  const result = await service.listSuppliers({
    authContext: fixture.global,
    requestedTeamId: String(fixture.teamB)
  });
  assert.deepEqual(result.suppliers.map((item) => item.code), ['B-1']);
});

test('first tertiary record atomically creates its supplier and rejects an existing code', async () => {
  const created = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { code: 'FIRST-001', name: 'First Supplier' },
      trusteeAttribute: 'NON_HOSTED',
      category: 'SUPPLIER_INFO',
      details: { supplyStatus: 'NORMAL', remarks: 'created from tertiary entry' },
      attachments: []
    }
  });
  assert.equal(created.supplier.code, 'FIRST-001');
  assert.equal(created.supplier.trusteeAttribute, 'NON_HOSTED');
  assert.equal(String(created.record.supplierId), String(created.supplier._id));
  assert.equal(await Supplier.countDocuments({ teamId: fixture.teamA, code: 'FIRST-001' }), 1);
  assert.equal(await SupplierContractRecord.countDocuments({
    teamId: fixture.teamA,
    supplierId: created.supplier._id
  }), 1);

  await assert.rejects(service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { code: 'FIRST-001', name: 'Conflicting Name' },
      trusteeAttribute: 'HOSTED',
      category: 'SUPPLIER_INFO',
      details: {},
      attachments: []
    }
  }), { status: 409, code: 'CONTRACT_SUPPLIER_ALREADY_EXISTS' });
  assert.equal(await SupplierContractRecord.countDocuments({
    teamId: fixture.teamA,
    supplierId: created.supplier._id
  }), 1);
});

test('supplier identity PATCH is allowed only after a tertiary record exists', async () => {
  const empty = await Supplier.create({
    teamId: fixture.teamA,
    name: 'Unlinked Supplier',
    code: 'PATCH-GUARD',
    trusteeAttribute: 'HOSTED',
    createdBy: fixture.userA,
    updatedBy: fixture.userA
  });
  await assert.rejects(service.updateSupplier({
    authContext: fixture.contextA,
    supplierId: empty._id,
    input: { name: 'Must Not Change' }
  }), {
    status: 409,
    code: 'CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED'
  });
  assert.equal((await Supplier.findById(empty._id).lean()).name, 'Unlinked Supplier');

  await record(fixture.contextA, empty._id, { contractNumber: 'PATCH-GUARD-1' });
  const updated = await service.updateSupplier({
    authContext: fixture.contextA,
    supplierId: empty._id,
    input: {
      name: '三级维护供应商',
      code: 'PATCH-GUARD-UPDATED',
      trusteeAttribute: 'NON_HOSTED'
    }
  });
  assert.equal(updated.name, '三级维护供应商');
  assert.equal(updated.code, 'PATCH-GUARD-UPDATED');
  assert.equal(updated.trusteeAttribute, 'NON_HOSTED');
});

test('latest main contract uses the greatest expiry and PATCH preserves omitted details', async () => {
  const created = await supplier(fixture.contextA, 'STATE-1');
  await record(fixture.contextA, created._id, {
    contractNumber: 'OLD-LONG', signingStatus: 'UNSIGNED',
    effectiveDate: '2025-01-01', expiryDate: '2027-12-31', autoRenew: false
  });
  await record(fixture.contextA, created._id, {
    contractNumber: 'NEW-SHORT', effectiveDate: '2026-01-01', expiryDate: '2026-08-11', autoRenew: false,
    details: { supplierSignedDate: '2026-01-02', courierNumber: 'SF-1', remarks: 'before' }
  });
  const listed = await service.listSuppliers({ authContext: fixture.contextA });
  assert.equal(listed.suppliers[0].hasSignedContract, false);
  assert.equal(listed.suppliers[0].contractValid, true);
  assert.equal(listed.suppliers[0].latestContractNumber, 'OLD-LONG');
  const records = await service.listRecords({ authContext: fixture.contextA,
    supplierId: created._id, query: { category: 'MAIN_SERVICE_AGREEMENT' } });
  assert.equal(records.records[0].contractNumber, 'OLD-LONG');
  const latest = records.records.find((item) => item.contractNumber === 'NEW-SHORT');
  const updated = await service.updateRecord({ authContext: fixture.contextA,
    recordId: latest._id, input: {
      trusteeAttribute: 'NON_HOSTED',
      details: { remarks: 'after' }
    } });
  assert.equal(updated.details.courierNumber, 'SF-1');
  assert.equal(updated.details.remarks, 'after');
  assert.equal(new Date(updated.details.supplierSignedDate).toISOString().slice(0, 10), '2026-01-02');
  assert.equal((await Supplier.findById(created._id).lean()).trusteeAttribute, 'NON_HOSTED');
});

test('latest main contract breaks equal expiry by createdAt then _id and keeps null expiry last', async () => {
  const created = await supplier(fixture.contextA, 'LATEST-TIE');
  const first = await record(fixture.contextA, created._id, {
    contractNumber: 'FIRST', signingStatus: 'UNSIGNED', expiryDate: '2027-12-31'
  });
  const second = await record(fixture.contextA, created._id, {
    contractNumber: 'SECOND', signingStatus: 'SIGNED', expiryDate: '2027-12-31'
  });
  await record(fixture.contextA, created._id, {
    contractNumber: 'NO-EXPIRY', signingStatus: 'SIGNED', expiryDate: null
  });

  await SupplierContractRecord.collection.updateOne(
    { _id: first._id },
    { $set: { createdAt: new Date('2026-02-01T00:00:00.000Z') } }
  );
  await SupplierContractRecord.collection.updateOne(
    { _id: second._id },
    { $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') } }
  );
  let listed = await service.listSuppliers({ authContext: fixture.contextA });
  assert.equal(listed.suppliers[0].latestContractNumber, 'FIRST');
  assert.equal(listed.suppliers[0].hasSignedContract, false);

  const tiedCreatedAt = new Date('2026-03-01T00:00:00.000Z');
  await SupplierContractRecord.collection.updateMany(
    { _id: { $in: [first._id, second._id] } },
    { $set: { createdAt: tiedCreatedAt } }
  );
  listed = await service.listSuppliers({ authContext: fixture.contextA });
  assert.equal(listed.suppliers[0].latestContractNumber, 'SECOND');
  assert.equal(listed.suppliers[0].hasSignedContract, true);
  assert.equal(listed.suppliers[0].contractValid, true);
});

test('expiry alerts include only signed calculable contracts and honor colors and filters', async () => {
  const created = await supplier(fixture.contextA, 'ALERT-1');
  await record(fixture.contextA, created._id, {
    category: 'LOGISTICS_FEE_AGREEMENT', contractNumber: '',
    effectiveDate: '2026-01-01', expiryDate: '2026-08-20', autoRenew: false,
    details: { warehouseServiceRate: '7‰' }
  });
  await record(fixture.contextA, created._id, {
    category: 'TURNOVER_EQUIPMENT_SERVICE', effectiveDate: '2026-01-01',
    expiryDate: '2026-08-10', autoRenew: false
  });
  await record(fixture.contextA, created._id, {
    category: 'EQUIPMENT_RENTAL', effectiveDate: '2026-01-01',
    expiryDate: '2026-08-01', autoRenew: true
  });
  await record(fixture.contextA, created._id, {
    category: 'MAIN_SERVICE_AGREEMENT', signingStatus: 'UNSIGNED',
    effectiveDate: '2026-01-01', expiryDate: '2026-08-12'
  });
  const result = await service.listExpiryAlerts({ authContext: fixture.contextA,
    query: { supplierCode: 'ALERT-1' } });
  assert.deepEqual(result.alerts.map((item) => [item.category, item.remainingDays, item.alertLevel]), [
    ['EQUIPMENT_RENTAL', -10, 'NORMAL'],
    ['TURNOVER_EQUIPMENT_SERVICE', -1, 'EXPIRED'],
    ['LOGISTICS_FEE_AGREEMENT', 9, 'WARNING']
  ]);
  const filtered = await service.listExpiryAlerts({ authContext: fixture.contextA,
    query: { remainingDaysGt: 0, remainingDaysLt: 30 } });
  assert.equal(filtered.total, 1);
});

test('settlement totals cover the full filtered result and status is dynamically linked', async () => {
  const first = await supplier(fixture.contextA, 'SET-1');
  const second = await supplier(fixture.contextA, 'SET-2');
  await record(fixture.contextA, first._id, { contractNumber: 'ACTIVE' });
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: first._id, month: '2026-08', productLaunchAmount: 10,
    warehousingLogisticsFee: 20, overstorageProductAmount: 30, overstorageLogisticsFee: 40
  } });
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: second._id, month: '2026-08', productLaunchAmount: 1,
    warehousingLogisticsFee: 2, overstorageProductAmount: 3, overstorageLogisticsFee: 4
  } });
  const result = await service.listSettlements({ authContext: fixture.contextA,
    query: { month: '2026-08', pageSize: 1 } });
  assert.equal(result.settlements.length, 1);
  assert.equal(result.total, 2);
  assert.deepEqual(result.totals, {
    productLaunchAmount: 11,
    warehousingLogisticsFee: 22,
    overstorageProductAmount: 33,
    overstorageLogisticsFee: 44
  });
  const signed = await service.listSettlements({ authContext: fixture.contextA,
    query: { hasSignedContract: true } });
  assert.deepEqual(signed.settlements.map((item) => item.supplierCode), ['SET-1']);
});

test('standalone supplier writes are absent and orphan projections stay out of all three views', async () => {
  assert.equal(service.createSupplier, undefined);
  assert.equal(service.deleteSupplier, undefined);
  const orphan = await Supplier.create({
    teamId: fixture.teamA,
    name: 'Orphan Supplier',
    code: 'ORPHAN-1',
    trusteeAttribute: 'HOSTED',
    createdBy: fixture.userA,
    updatedBy: fixture.userA
  });
  const listed = await service.listSuppliers({ authContext: fixture.contextA });
  assert.equal(listed.suppliers.some((item) => item.code === 'ORPHAN-1'), false);
  await assert.rejects(service.getSupplier({
    authContext: fixture.contextA,
    supplierId: orphan._id
  }), { status: 404, code: 'CONTRACT_SUPPLIER_NOT_FOUND' });
  await assert.rejects(service.listRecords({
    authContext: fixture.contextA,
    supplierId: orphan._id
  }), { status: 404, code: 'CONTRACT_SUPPLIER_NOT_FOUND' });
  await assert.rejects(service.createSettlement({
    authContext: fixture.contextA,
    input: { supplierId: orphan._id, month: '2026-08' }
  }), { status: 409, code: 'CONTRACT_SUPPLIER_TERTIARY_RECORD_REQUIRED' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { supplierId: orphan._id }
  }), { status: 404, code: 'CONTRACT_SUPPLIER_NOT_FOUND' });
});

test('deleting the last tertiary record removes its derived supplier but refuses to orphan settlements', async () => {
  const removableCreated = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier LAST-1', code: 'LAST-1' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'LAST-ONLY',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });
  const removable = removableCreated.supplier;
  const removableRecord = removableCreated.record;
  const deleted = await service.deleteRecord({ authContext: fixture.contextA, recordId: removableRecord._id });
  assert.equal(deleted.supplierDeleted, true);
  assert.equal(await Supplier.exists({ _id: removable._id }), null);
  assert.equal(await SupplierContractRecord.exists({ _id: removableRecord._id }), null);

  const retainedCreated = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier LAST-SETTLEMENT', code: 'LAST-SETTLEMENT' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'HAS-SETTLEMENT',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });
  const retained = retainedCreated.supplier;
  const retainedRecord = retainedCreated.record;
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: retained._id,
    month: '2026-08',
    productLaunchAmount: 1
  } });
  await assert.rejects(service.deleteRecord({
    authContext: fixture.contextA,
    recordId: retainedRecord._id
  }), {
    status: 409,
    code: 'CONTRACT_SUPPLIER_LAST_RECORD_HAS_SETTLEMENTS'
  });
  assert.notEqual(await Supplier.exists({ _id: retained._id }), null);
  assert.notEqual(await SupplierContractRecord.exists({ _id: retainedRecord._id }), null);
});

test('concurrent tertiary deletes serialize on the supplier and cannot leave an orphan projection', async () => {
  const firstCreated = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier DELETE-RACE', code: 'DELETE-RACE' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'DELETE-RACE-1',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });
  const created = firstCreated.supplier;
  const first = firstCreated.record;
  const second = await record(fixture.contextA, created._id, { contractNumber: 'DELETE-RACE-2' });

  const results = await Promise.all([
    service.deleteRecord({ authContext: fixture.contextA, recordId: first._id }),
    service.deleteRecord({ authContext: fixture.contextA, recordId: second._id })
  ]);

  assert.equal(results.filter((item) => item.supplierDeleted).length, 1);
  assert.equal(await SupplierContractRecord.countDocuments({ supplierId: created._id }), 0);
  assert.equal(await Supplier.exists({ _id: created._id }), null);
});

test('concurrent final-record deletion and tertiary creation cannot leave an orphan record', async () => {
  const initial = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier CREATE-RACE', code: 'CREATE-RACE' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'CREATE-RACE-INITIAL',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });

  const outcomes = await Promise.allSettled([
    service.deleteRecord({ authContext: fixture.contextA, recordId: initial.record._id }),
    record(fixture.contextA, initial.supplier._id, { contractNumber: 'CREATE-RACE-NEW' })
  ]);
  const supplierExists = Boolean(await Supplier.exists({ _id: initial.supplier._id }));
  const recordCount = await SupplierContractRecord.countDocuments({ supplierId: initial.supplier._id });
  assert.equal(recordCount > 0, supplierExists);
  for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
    assert.equal(outcome.reason.code, 'CONTRACT_SUPPLIER_NOT_FOUND');
  }
});

test('concurrent final-record deletion and settlement creation cannot leave an orphan settlement', async () => {
  const initial = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier SETTLEMENT-RACE', code: 'SETTLEMENT-RACE' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'SETTLEMENT-RACE-INITIAL',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });

  const outcomes = await Promise.allSettled([
    service.deleteRecord({ authContext: fixture.contextA, recordId: initial.record._id }),
    service.createSettlement({
      authContext: fixture.contextA,
      input: { supplierId: initial.supplier._id, month: '2026-08', productLaunchAmount: 1 }
    })
  ]);
  const supplierExists = Boolean(await Supplier.exists({ _id: initial.supplier._id }));
  const recordCount = await SupplierContractRecord.countDocuments({ supplierId: initial.supplier._id });
  const settlementCount = await SupplierSettlementFee.countDocuments({ supplierId: initial.supplier._id });
  assert.equal(settlementCount > 0, supplierExists);
  assert.equal(settlementCount > 0 ? recordCount > 0 : true, true);
  if (!supplierExists) assert.equal(recordCount + settlementCount, 0);
  const allowedCodes = new Set([
    'CONTRACT_SUPPLIER_NOT_FOUND',
    'CONTRACT_SUPPLIER_LAST_RECORD_HAS_SETTLEMENTS'
  ]);
  for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
    assert.equal(allowedCodes.has(outcome.reason.code), true);
  }
});

test('concurrent final-record deletion and settlement import cannot leave orphan imported rows', async () => {
  const initial = await service.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Supplier IMPORT-RACE', code: 'IMPORT-RACE' },
      trusteeAttribute: 'HOSTED',
      category: 'MAIN_SERVICE_AGREEMENT',
      signingStatus: 'SIGNED',
      contractNumber: 'IMPORT-RACE-INITIAL',
      effectiveDate: '2026-01-01',
      expiryDate: '2026-12-31',
      autoRenew: false,
      details: {},
      attachments: []
    }
  });
  const buffer = await settlementWorkbook([
    { month: '2026-08', name: initial.supplier.name, code: initial.supplier.code, amount: 1 }
  ]);

  const outcomes = await Promise.allSettled([
    service.deleteRecord({ authContext: fixture.contextA, recordId: initial.record._id }),
    service.importSettlements({ authContext: fixture.contextA, file: { buffer } })
  ]);
  const supplierExists = Boolean(await Supplier.exists({ _id: initial.supplier._id }));
  const recordCount = await SupplierContractRecord.countDocuments({ supplierId: initial.supplier._id });
  const settlementCount = await SupplierSettlementFee.countDocuments({ supplierId: initial.supplier._id });
  assert.equal(settlementCount > 0, supplierExists);
  assert.equal(settlementCount > 0 ? recordCount > 0 : true, true);
  if (!supplierExists) assert.equal(recordCount + settlementCount, 0);
  const allowedCodes = new Set([
    'CONTRACT_SETTLEMENT_SUPPLIER_NOT_FOUND',
    'CONTRACT_SUPPLIER_LAST_RECORD_HAS_SETTLEMENTS'
  ]);
  for (const outcome of outcomes.filter((item) => item.status === 'rejected')) {
    assert.equal(allowedCodes.has(outcome.reason.code), true);
  }
});

test('supplier export honors derived filters and keeps full secondary counts for category exports', async () => {
  const included = await supplier(fixture.contextA, 'EXPORT-IN', 'Export Included');
  await record(fixture.contextA, included._id, {
    contractNumber: 'EXPORT-MAIN',
    signingStatus: 'UNSIGNED',
    expiryDate: '2027-12-31'
  });
  await record(fixture.contextA, included._id, {
    category: 'LOGISTICS_FEE_AGREEMENT',
    contractNumber: '',
    expiryDate: '2027-11-30',
    details: { warehouseServiceRate: '7‰' }
  });
  const excluded = await supplier(fixture.contextA, 'EXPORT-OUT', 'Export Excluded');
  await record(fixture.contextA, excluded._id, { contractNumber: 'EXCLUDED' });
  await service.updateSupplier({
    authContext: fixture.contextA,
    supplierId: excluded._id,
    input: { trusteeAttribute: 'NON_HOSTED' }
  });

  const result = await service.supplierExport({
    authContext: fixture.contextA,
    query: {
      trusteeAttribute: 'HOSTED',
      hasSignedContract: false,
      contractValid: true,
      category: 'MAIN_SERVICE_AGREEMENT'
    }
  });
  assert.equal(result.supplierCount, 1);
  assert.equal(result.recordCount, 1);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.buffer);
  const overview = workbook.getWorksheet('主表（供应商合同管理）');
  assert.equal(overview.rowCount, 3);
  assert.equal(overview.getRow(3).getCell(3).value, 'EXPORT-IN');
  const secondary = workbook.getWorksheet('二级细表（供应商合同管理）');
  assert.equal(secondary.getRow(3).getCell(5).value, 1);
  assert.equal(secondary.getRow(3).getCell(6).value, 1);
  const details = workbook.getWorksheet('三级细表（供应商合同管理）');
  assert.equal(details.rowCount, 3);
  assert.equal(details.getRow(3).getCell(14).value, 'EXPORT-MAIN');
});

test('contract attachment purpose binds atomically and record delete marks the file deleted', async () => {
  const created = await supplier(fixture.contextA, 'FILE-1');
  const temporary = await FileAsset.create({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    storageKey: `${fixture.teamA}/2026/08/${randomUUID()}.pdf`,
    originalName: 'contract.pdf',
    mimeType: 'application/pdf',
    size: 100,
    sha256: 'a'.repeat(64),
    uploaderId: fixture.userA,
    status: FileAsset.FILE_STATUSES.TEMPORARY
  });
  const createdRecord = await record(fixture.contextA, created._id, {
    attachments: [{ fileId: temporary._id, purpose: 'CONTRACT_PDF' }]
  });
  assert.equal(createdRecord.attachments[0].purpose, 'CONTRACT_PDF');
  let file = await FileAsset.findById(temporary._id).lean();
  assert.equal(file.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(file.ownerType, FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT);
  await service.deleteRecord({ authContext: fixture.contextA, recordId: createdRecord._id });
  file = await FileAsset.findById(temporary._id).lean();
  assert.equal(file.status, FileAsset.FILE_STATUSES.DELETED);
  assert.equal(await SupplierContractRecord.exists({ _id: createdRecord._id }), null);
});

test('supplier profile and contract files enforce view permission, team isolation, and global team selection', async () => {
  const created = await supplier(fixture.contextA, 'FILE-ACCESS');
  const temporaryFiles = await FileAsset.create([
    {
      teamId: fixture.teamA, ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
      ownerId: null, storageKey: `${fixture.teamA}/2026/08/${randomUUID()}.png`,
      originalName: 'invoice.png', mimeType: 'image/png', size: 100,
      sha256: 'b'.repeat(64), uploaderId: fixture.userA, status: FileAsset.FILE_STATUSES.TEMPORARY
    },
    {
      teamId: fixture.teamA, ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
      ownerId: null, storageKey: `${fixture.teamA}/2026/08/${randomUUID()}.pdf`,
      originalName: 'contract.pdf', mimeType: 'application/pdf', size: 100,
      sha256: 'c'.repeat(64), uploaderId: fixture.userA, status: FileAsset.FILE_STATUSES.TEMPORARY
    }
  ]);
  await service.createRecord({ authContext: fixture.contextA, supplierId: created._id, input: {
    category: 'SUPPLIER_INFO', details: { invoiceInfoText: 'invoice' },
    attachments: [{ fileId: temporaryFiles[0]._id, purpose: 'INVOICE_INFO' }]
  } });
  await record(fixture.contextA, created._id, {
    attachments: [{ fileId: temporaryFiles[1]._id, purpose: 'CONTRACT_PDF' }]
  });

  const fileService = createFileAssetService({
    storageRoot, FileAssetModel: FileAsset,
    SupplierContractRecordModel: SupplierContractRecord,
    auditService: createAuditService({ AuditLog }), connection: mongoose.connection
  });
  const viewOnly = teamContext(fixture.teamA, objectId(), ['contract.supplier.view']);
  const noView = teamContext(fixture.teamA, objectId(), []);
  for (const file of temporaryFiles) {
    const sameTeam = await fileService.getMetadata({
      authContext: viewOnly,
      fileId: file._id
    });
    assert.equal(String(sameTeam._id), String(file._id));
    await assert.rejects(fileService.getMetadata({
      authContext: fixture.contextB,
      fileId: file._id
    }), { status: 404, code: 'FILE_NOT_FOUND' });
    const global = await fileService.getMetadata({
      authContext: fixture.global,
      requestedTeamId: String(fixture.teamA),
      fileId: file._id
    });
    assert.equal(String(global._id), String(file._id));
    await assert.rejects(fileService.getMetadata({
      authContext: noView,
      fileId: file._id
    }), { status: 403, code: 'PERMISSION_DENIED' });
  }
});

test('audit failure rolls back the business write', async () => {
  const failing = createService({
    auditService: { async record() { throw new Error('audit failed'); } }
  });
  await assert.rejects(failing.createFirstRecord({
    authContext: fixture.contextA,
    input: {
      supplierIdentity: { name: 'Rollback', code: 'ROLLBACK-1' },
      trusteeAttribute: 'HOSTED',
      category: 'SUPPLIER_INFO',
      details: {},
      attachments: []
    }
  }), /audit failed/);
  assert.equal(await Supplier.exists({ teamId: fixture.teamA, code: 'ROLLBACK-1' }), null);
});

async function settlementWorkbook(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('供应商结算费用表');
  sheet.addRow(SETTLEMENT_HEADERS);
  rows.forEach((row, index) => sheet.addRow([
    index + 1, row.month, row.name, row.code,
    row.amount || 0, 0, 0, 0, '', '', ''
  ]));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function supplierWorkbook({
  code,
  name,
  contractNumber = 'MAIN-1',
  trustee = '托管',
  additionalRows = []
}) {
  const workbook = new ExcelJS.Workbook();
  const main = workbook.addWorksheet('主表（供应商合同管理）');
  main.addRow(['一级主表']);
  main.addRow(['序号', '供应商名称', '供应商编码', '托管属性', '是否签订合同', '合同是否有效']);
  main.addRow([1, name, code, '托管', '', '']);
  const detail = workbook.addWorksheet('三级细表（供应商合同管理）');
  detail.addRow([]);
  detail.addRow(DETAIL_HEADERS);
  const addRow = (input, index) => {
    const row = Array(57).fill('');
    row[0] = index;
    row[1] = input.code;
    row[2] = input.name;
    row[3] = input.trustee;
    row[12] = '已签订';
    row[13] = input.contractNumber;
    row[14] = '2026-01-01';
    row[15] = '2026-12-31';
    row[23] = '否';
    detail.addRow(row);
  };
  addRow({ code, name, contractNumber, trustee }, 1);
  additionalRows.forEach((row, index) => addRow(row, index + 2));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('supplier import writes one atomic supplier and history batch and constrains detail imports', async () => {
  const buffer = await supplierWorkbook({ code: 'SUP-IMP-01', name: 'Imported Supplier' });
  const result = await service.importSuppliers({
    authContext: fixture.contextA,
    file: { buffer }
  });
  assert.deepEqual({
    createdSuppliers: result.createdSuppliers,
    updatedSuppliers: result.updatedSuppliers,
    createdRecords: result.createdRecords
  }, { createdSuppliers: 1, updatedSuppliers: 0, createdRecords: 1 });
  const imported = await Supplier.findOne({ teamId: fixture.teamA, code: 'SUP-IMP-01' }).lean();
  assert.equal(imported.name, 'Imported Supplier');
  assert.equal(await SupplierContractRecord.countDocuments({
    teamId: fixture.teamA,
    supplierId: imported._id
  }), 1);

  const mismatch = await supplierWorkbook({ code: 'OTHER-CODE', name: 'Other Supplier' });
  await assert.rejects(service.importSuppliers({
    authContext: fixture.contextA,
    supplierId: imported._id,
    file: { buffer: mismatch }
  }), { status: 409, code: 'CONTRACT_IMPORT_SUPPLIER_MISMATCH' });
  assert.equal(await Supplier.exists({ teamId: fixture.teamA, code: 'OTHER-CODE' }), null);

  const failing = createService({
    auditService: { async record() { throw new Error('import audit failed'); } }
  });
  const rollback = await supplierWorkbook({ code: 'ROLLBACK-IMPORT', name: 'Rollback Import' });
  await assert.rejects(failing.importSuppliers({
    authContext: fixture.contextA,
    file: { buffer: rollback }
  }), /import audit failed/);
  assert.equal(await Supplier.exists({ teamId: fixture.teamA, code: 'ROLLBACK-IMPORT' }), null);
  assert.equal(await SupplierContractRecord.exists({ teamId: fixture.teamA,
    contractNumber: 'MAIN-1', supplierId: { $ne: imported._id } }), null);
});

test('conflicting trustee attributes for one code reject the whole supplier import without writes', async () => {
  const buffer = await supplierWorkbook({
    code: 'BATCH-FIRST',
    name: 'Batch First',
    additionalRows: [
      { code: 'TRUSTEE-CONFLICT', name: 'Trustee Conflict', trustee: '托管', contractNumber: 'CONFLICT-1' },
      { code: 'TRUSTEE-CONFLICT', name: 'Trustee Conflict', trustee: '非托', contractNumber: 'CONFLICT-2' }
    ]
  });

  await assert.rejects(service.importSuppliers({
    authContext: fixture.contextA,
    file: { buffer }
  }), {
    status: 400,
    code: 'CONTRACT_IMPORT_SUPPLIER_CONFLICT'
  });
  assert.equal(await Supplier.exists({ teamId: fixture.teamA, code: 'BATCH-FIRST' }), null);
  assert.equal(await Supplier.exists({ teamId: fixture.teamA, code: 'TRUSTEE-CONFLICT' }), null);
  assert.equal(await SupplierContractRecord.exists({
    teamId: fixture.teamA,
    contractNumber: { $in: ['MAIN-1', 'CONFLICT-1', 'CONFLICT-2'] }
  }), null);
});

test('settlement import duplicate aborts the whole batch without a partial first row', async () => {
  const first = await supplier(fixture.contextA, 'IMP-1', 'Import One');
  const second = await supplier(fixture.contextA, 'IMP-2', 'Import Two');
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: second._id, month: '2026-08', productLaunchAmount: 99
  } });
  const buffer = await settlementWorkbook([
    { month: '2026-08', name: 'Import One', code: 'IMP-1', amount: 1 },
    { month: '2026-08', name: 'Import Two', code: 'IMP-2', amount: 2 }
  ]);
  await assert.rejects(service.importSettlements({ authContext: fixture.contextA,
    file: { buffer } }), { status: 409, code: 'CONTRACT_SETTLEMENT_DUPLICATE' });
  assert.equal(await SupplierSettlementFee.exists({ teamId: fixture.teamA,
    supplierId: first._id, month: '2026-08' }), null);
  assert.equal(await SupplierSettlementFee.countDocuments({ teamId: fixture.teamA }), 1);
});
