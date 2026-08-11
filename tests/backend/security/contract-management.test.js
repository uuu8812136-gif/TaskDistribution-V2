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
  return service.createSupplier({
    authContext,
    input: { name, code, trusteeAttribute: 'HOSTED' }
  });
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
    code: 'CONTRACT_SUPPLIER_CODE_DUPLICATE'
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

test('latest main contract derives supplier state and PATCH preserves omitted details', async () => {
  const created = await supplier(fixture.contextA, 'STATE-1');
  await record(fixture.contextA, created._id, {
    contractNumber: 'OLD', effectiveDate: '2025-01-01', expiryDate: '2025-12-31', autoRenew: false
  });
  await record(fixture.contextA, created._id, {
    contractNumber: 'LATEST', effectiveDate: '2026-01-01', expiryDate: '2026-08-11', autoRenew: false,
    details: { supplierSignedDate: '2026-01-02', courierNumber: 'SF-1', remarks: 'before' }
  });
  const listed = await service.listSuppliers({ authContext: fixture.contextA });
  assert.equal(listed.suppliers[0].hasSignedContract, true);
  assert.equal(listed.suppliers[0].contractValid, true);
  assert.equal(listed.suppliers[0].latestContractNumber, 'LATEST');
  const records = await service.listRecords({ authContext: fixture.contextA,
    supplierId: created._id, query: { category: 'MAIN_SERVICE_AGREEMENT' } });
  const latest = records.records.find((item) => item.contractNumber === 'LATEST');
  const updated = await service.updateRecord({ authContext: fixture.contextA,
    recordId: latest._id, input: { details: { remarks: 'after' } } });
  assert.equal(updated.details.courierNumber, 'SF-1');
  assert.equal(updated.details.remarks, 'after');
  assert.equal(new Date(updated.details.supplierSignedDate).toISOString().slice(0, 10), '2026-01-02');
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

test('supplier deletion is blocked by either contract or settlement dependencies', async () => {
  const withContract = await supplier(fixture.contextA, 'DEP-1');
  await record(fixture.contextA, withContract._id, {});
  await assert.rejects(service.deleteSupplier({ authContext: fixture.contextA,
    supplierId: withContract._id }), { status: 409, code: 'CONTRACT_SUPPLIER_HAS_DEPENDENCIES' });
  const empty = await supplier(fixture.contextA, 'EMPTY-1');
  await service.deleteSupplier({ authContext: fixture.contextA, supplierId: empty._id });
  assert.equal(await Supplier.exists({ _id: empty._id }), null);
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
  await assert.rejects(failing.createSupplier({ authContext: fixture.contextA,
    input: { name: 'Rollback', code: 'ROLLBACK-1', trusteeAttribute: 'HOSTED' } }), /audit failed/);
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

async function supplierWorkbook({ code, name, contractNumber = 'MAIN-1' }) {
  const workbook = new ExcelJS.Workbook();
  const main = workbook.addWorksheet('主表（供应商合同管理）');
  main.addRow(['一级主表']);
  main.addRow(['序号', '供应商名称', '供应商编码', '托管属性', '是否签订合同', '合同是否有效']);
  main.addRow([1, name, code, '托管', '', '']);
  const detail = workbook.addWorksheet('三级细表（供应商合同管理）');
  detail.addRow([]);
  detail.addRow(DETAIL_HEADERS);
  const row = Array(56).fill('');
  row[0] = 1;
  row[1] = code;
  row[2] = name;
  row[11] = '已签订';
  row[12] = contractNumber;
  row[13] = '2026-01-01';
  row[14] = '2026-12-31';
  row[22] = '否';
  detail.addRow(row);
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
