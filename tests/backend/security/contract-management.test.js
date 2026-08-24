'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const ExcelJS = appRequire('exceljs');
const XLSX = appRequire('xlsx');
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
const { resolveStoragePath } = require('../../../app/services/fileStorageService');
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

function pdfZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const crc32 = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.from(entry.content);
    const compressed = entry.deflate ? zlib.deflateRawSync(content) : content;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central); offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function storageFiles(directory = storageRoot) {
  const result = [];
  async function visit(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  await visit(directory);
  return result.sort();
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
  await fs.promises.rm(storageRoot, { recursive: true, force: true });
  await fs.promises.mkdir(storageRoot, { recursive: true });
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

test('supplier, expiry, and settlement reads stay isolated across every team selection path', async () => {
  const supplierA = await supplier(fixture.contextA, 'ISO-A', 'Isolated Supplier A');
  const supplierB = await supplier(fixture.contextB, 'ISO-B', 'Isolated Supplier B');
  await record(fixture.contextA, supplierA._id, {
    contractNumber: 'ISO-CONTRACT-A',
    expiryDate: '2026-08-20'
  });
  await record(fixture.contextB, supplierB._id, {
    contractNumber: 'ISO-CONTRACT-B',
    expiryDate: '2026-08-21'
  });
  await service.createSettlement({
    authContext: fixture.contextA,
    input: { supplierId: supplierA._id, month: '2026-08', productLaunchAmount: 10 }
  });
  await service.createSettlement({
    authContext: fixture.contextB,
    input: { supplierId: supplierB._id, month: '2026-08', productLaunchAmount: 20 }
  });

  async function readCodes(authContext, requestedTeamId) {
    const input = { authContext, ...(requestedTeamId ? { requestedTeamId } : {}) };
    const [suppliers, expiry, settlements] = await Promise.all([
      service.listSuppliers(input),
      service.listExpiryAlerts(input),
      service.listSettlements(input)
    ]);
    return {
      suppliers: suppliers.suppliers.map((item) => item.code),
      expiry: expiry.alerts.map((item) => item.supplierCode),
      settlements: settlements.settlements.map((item) => item.supplierCode)
    };
  }

  const expectedA = { suppliers: ['ISO-A'], expiry: ['ISO-A'], settlements: ['ISO-A'] };
  const expectedB = { suppliers: ['ISO-B'], expiry: ['ISO-B'], settlements: ['ISO-B'] };
  assert.deepEqual(await readCodes(fixture.contextA), expectedA);
  assert.deepEqual(await readCodes(fixture.contextB), expectedB);

  // TEAM mode is authoritative: a client cannot override its active team with a query parameter.
  assert.deepEqual(await readCodes(fixture.contextA, String(fixture.teamB)), expectedA);

  assert.deepEqual(await readCodes(fixture.global, String(fixture.teamA)), expectedA);
  assert.deepEqual(await readCodes(fixture.global, String(fixture.teamB)), expectedB);
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
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: first._id, month: '2026-07', productLaunchAmount: 100,
    warehousingLogisticsFee: 200, overstorageProductAmount: 300, overstorageLogisticsFee: 400
  } });
  await service.createSettlement({ authContext: fixture.contextA, input: {
    supplierId: first._id, month: '2026-09', productLaunchAmount: 1000,
    warehousingLogisticsFee: 2000, overstorageProductAmount: 3000, overstorageLogisticsFee: 4000
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
  assert.deepEqual(signed.settlements.map((item) => item.supplierCode), ['SET-1', 'SET-1', 'SET-1']);

  const ranged = await service.listSettlements({ authContext: fixture.contextA,
    query: { startMonth: '2026-07', endMonth: '2026-08', pageSize: 1 } });
  assert.equal(ranged.settlements.length, 1);
  assert.equal(ranged.total, 3);
  assert.deepEqual(ranged.totals, {
    productLaunchAmount: 111,
    warehousingLogisticsFee: 222,
    overstorageProductAmount: 333,
    overstorageLogisticsFee: 444
  });

  const exported = await service.settlementExport({ authContext: fixture.contextA,
    query: { startMonth: '2026-07', endMonth: '2026-08' } });
  const exportBook = XLSX.read(exported.buffer, { type: 'buffer' });
  const exportRows = XLSX.utils.sheet_to_json(exportBook.Sheets[exportBook.SheetNames[0]], {
    header: 1,
    defval: ''
  });
  assert.equal(exported.count, 3);
  assert.deepEqual(exportRows.slice(1).map((row) => row[1]).sort(), ['2026-07', '2026-08', '2026-08']);

  await assert.rejects(service.listSettlements({ authContext: fixture.contextA,
    query: { startMonth: '2026-09', endMonth: '2026-08' } }), {
    status: 400,
    code: 'CONTRACT_SETTLEMENT_MONTH_RANGE_INVALID'
  });
  await assert.rejects(service.listSettlements({ authContext: fixture.contextA,
    query: { month: '2026-08', startMonth: '2026-07', endMonth: '2026-08' } }), {
    status: 400,
    code: 'CONTRACT_SETTLEMENT_MONTH_FILTER_CONFLICT'
  });
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
    query: { scope: 'detail', supplierId: orphan._id, category: 'SUPPLIER_INFO' }
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

test('supplier export scopes honor filters and isolate overview, secondary, and detail sheets', async () => {
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

  const overviewResult = await service.supplierExport({
    authContext: fixture.contextA,
    query: {
      scope: 'overview',
      trusteeAttribute: 'HOSTED',
      hasSignedContract: false,
      contractValid: true
    }
  });
  assert.equal(overviewResult.supplierCount, 1);
  assert.equal(overviewResult.recordCount, 0);
  assert.equal(overviewResult.exportedCount, 1);
  const overviewWorkbook = new ExcelJS.Workbook();
  await overviewWorkbook.xlsx.load(overviewResult.buffer);
  assert.deepEqual(overviewWorkbook.worksheets.map(({ name }) => name), ['主表（供应商合同管理）']);
  const overview = overviewWorkbook.getWorksheet('主表（供应商合同管理）');
  assert.equal(overview.rowCount, 3);
  assert.equal(overview.getRow(3).getCell(3).value, 'EXPORT-IN');

  const secondaryResult = await service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'secondary', supplierId: included._id }
  });
  const secondaryWorkbook = new ExcelJS.Workbook();
  assert.equal(secondaryResult.exportedCount, 1);
  await secondaryWorkbook.xlsx.load(secondaryResult.buffer);
  assert.deepEqual(secondaryWorkbook.worksheets.map(({ name }) => name), ['二级细表（供应商合同管理）']);
  const secondary = secondaryWorkbook.getWorksheet('二级细表（供应商合同管理）');
  assert.equal(secondary.getRow(3).getCell(5).value, 1);
  assert.equal(secondary.getRow(3).getCell(6).value, 1);

  const detailResult = await service.supplierExport({
    authContext: fixture.contextA,
    query: {
      scope: 'detail', supplierId: included._id, category: 'MAIN_SERVICE_AGREEMENT'
    }
  });
  assert.equal(detailResult.supplierCount, 1);
  assert.equal(detailResult.recordCount, 1);
  assert.equal(detailResult.exportedCount, 1);
  const detailWorkbook = new ExcelJS.Workbook();
  await detailWorkbook.xlsx.load(detailResult.buffer);
  assert.deepEqual(detailWorkbook.worksheets.map(({ name }) => name), ['三级细表（供应商合同管理）']);
  const details = detailWorkbook.getWorksheet('三级细表（供应商合同管理）');
  assert.equal(details.rowCount, 3);
  assert.equal(details.getRow(3).getCell(14).value, 'EXPORT-MAIN');

  const allDetailsResult = await service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'detail' }
  });
  assert.equal(allDetailsResult.supplierCount >= 2, true);
  assert.equal(allDetailsResult.recordCount >= 5, true);
  const allDetailsWorkbook = new ExcelJS.Workbook();
  await allDetailsWorkbook.xlsx.load(allDetailsResult.buffer);
  assert.equal(allDetailsWorkbook.worksheets[0].name, '三级细表（供应商合同管理）');
  assert.equal(allDetailsWorkbook.worksheets[0].columnCount, 60);
  const exportAudit = await AuditLog.findOne({
    action: permissions.AUDIT_ACTIONS.EXPORT,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.SUPPLIER_CONTRACT_RECORD,
    targetTeamId: fixture.teamA,
    'after.scope': 'detail'
  }).sort({ createdAt: -1 }).lean();
  assert.deepEqual(exportAudit.after, {
    supplierCount: allDetailsResult.supplierCount,
    recordCount: allDetailsResult.recordCount,
    scope: 'detail',
    supplierId: null,
    category: null
  });
});

test('supplier export rejects unknown or contradictory scopes', async () => {
  const created = await supplier(fixture.contextA, 'EXPORT-VALIDATION');
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'unknown' }
  }), { status: 400, code: 'CONTRACT_EXPORT_SCOPE_INVALID' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'secondary' }
  }), { status: 400, code: 'CONTRACT_EXPORT_SUPPLIER_REQUIRED' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'secondary', supplierId: created._id, category: 'SUPPLIER_INFO' }
  }), { status: 400, code: 'CONTRACT_EXPORT_CATEGORY_NOT_ALLOWED' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'overview', category: 'SUPPLIER_INFO' }
  }), { status: 400, code: 'CONTRACT_EXPORT_CATEGORY_NOT_ALLOWED' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'secondary', supplierId: created._id, name: 'ignored filter' }
  }), { status: 400, code: 'CONTRACT_EXPORT_PARAMETER_INVALID' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'detail', contractValid: true }
  }), { status: 400, code: 'CONTRACT_EXPORT_PARAMETER_INVALID' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'detail', supplierId: created._id }
  }), { status: 400, code: 'CONTRACT_EXPORT_DETAIL_CONTEXT_INVALID' });
  await assert.rejects(service.supplierExport({
    authContext: fixture.contextA,
    query: { scope: 'detail', category: 'SUPPLIER_INFO' }
  }), { status: 400, code: 'CONTRACT_EXPORT_DETAIL_CONTEXT_INVALID' });
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
  effectiveDate = '2026-01-01',
  expiryDate = '2026-12-31',
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
    const row = Array(60).fill('');
    row[0] = index;
    row[1] = input.code;
    row[2] = input.name;
    row[3] = input.trustee;
    row[12] = '已签订';
    row[13] = input.contractNumber;
    row[14] = input.effectiveDate || effectiveDate;
    row[15] = input.expiryDate || expiryDate;
    row[23] = '否';
    detail.addRow(row);
  };
  addRow({ code, name, contractNumber, trustee, effectiveDate, expiryDate }, 1);
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

test('supplier import stores customer-provided reversed dates and returns a non-blocking warning', async () => {
  const buffer = await supplierWorkbook({
    code: 'DATE-WARNING-IMPORT',
    name: 'Date Warning Supplier',
    contractNumber: 'DATE-WARNING-1',
    effectiveDate: '2028-08-01',
    expiryDate: '2027-07-31'
  });
  const result = await service.importSuppliers({
    authContext: fixture.contextA,
    file: { buffer }
  });

  assert.equal(result.createdRecords, 1);
  assert.equal(result.warningCount, 1);
  assert.equal(result.warnings[0].code, 'CONTRACT_IMPORT_DATE_RANGE_INVALID');
  assert.match(result.warnings[0].message, /已按原数据导入/);
  const persisted = await SupplierContractRecord.findOne({
    teamId: fixture.teamA,
    contractNumber: 'DATE-WARNING-1'
  }).lean();
  assert.equal(persisted.effectiveDate.toISOString().slice(0, 10), '2028-08-01');
  assert.equal(persisted.expiryDate.toISOString().slice(0, 10), '2027-07-31');

  const updated = await service.updateRecord({
    authContext: fixture.contextA,
    recordId: persisted._id,
    input: { autoRenew: true }
  });
  assert.equal(updated.autoRenew, true);
  assert.equal(new Date(updated.effectiveDate).toISOString().slice(0, 10), '2028-08-01');
  assert.equal(new Date(updated.expiryDate).toISOString().slice(0, 10), '2027-07-31');

  await assert.rejects(service.updateRecord({
    authContext: fixture.contextA,
    recordId: persisted._id,
    input: { expiryDate: '2027-06-30' }
  }), { status: 400, code: 'CONTRACT_DATE_RANGE_INVALID' });

  const pdf = Buffer.from('%PDF-1.7\nreversed-date\n%%EOF');
  const zip = pdfZip([{ name: 'DATE-WARNING-IMPORT__DATE-WARNING-1.pdf', content: pdf }]);
  const attachmentResult = await service.importContractPdfs({
    authContext: fixture.contextA,
    file: { buffer: zip },
    req: { method: 'POST', originalUrl: '/api/contracts/suppliers/contract-pdfs/import' }
  });
  assert.equal(attachmentResult.importedCount, 1);
  assert.equal((await SupplierContractRecord.findById(persisted._id).lean()).attachments.length, 1);
});

test('supplier and settlement imports use the authenticated team when codes overlap', async () => {
  const teamBSupplier = await supplier(
    fixture.contextB,
    'IMPORT-SHARED',
    'Team B Supplier'
  );
  const supplierBuffer = await supplierWorkbook({
    code: 'IMPORT-SHARED',
    name: 'Team A Supplier',
    contractNumber: 'TEAM-A-IMPORT'
  });

  await service.importSuppliers({
    authContext: fixture.contextA,
    file: { buffer: supplierBuffer }
  });
  const [teamASupplier, persistedTeamBSupplier] = await Promise.all([
    Supplier.findOne({ teamId: fixture.teamA, code: 'IMPORT-SHARED' }).lean(),
    Supplier.findById(teamBSupplier._id).lean()
  ]);
  assert.equal(teamASupplier.name, 'Team A Supplier');
  assert.equal(persistedTeamBSupplier.name, 'Team B Supplier');
  assert.notEqual(String(teamASupplier._id), String(persistedTeamBSupplier._id));
  assert.equal(await SupplierContractRecord.countDocuments({
    teamId: fixture.teamA,
    supplierId: teamASupplier._id,
    contractNumber: 'TEAM-A-IMPORT'
  }), 1);
  assert.equal(await SupplierContractRecord.countDocuments({
    teamId: fixture.teamB,
    supplierId: persistedTeamBSupplier._id,
    contractNumber: 'TEAM-A-IMPORT'
  }), 0);

  const settlementBuffer = await settlementWorkbook([{
    month: '2026-08',
    name: 'Team A Supplier',
    code: 'IMPORT-SHARED',
    amount: 12
  }]);
  await service.importSettlements({
    authContext: fixture.contextA,
    file: { buffer: settlementBuffer }
  });
  assert.equal(await SupplierSettlementFee.countDocuments({
    teamId: fixture.teamA,
    supplierId: teamASupplier._id,
    month: '2026-08'
  }), 1);
  assert.equal(await SupplierSettlementFee.countDocuments({
    teamId: fixture.teamB,
    supplierId: persistedTeamBSupplier._id,
    month: '2026-08'
  }), 0);
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

test('bulk contract PDF import matches by supplier and contract number, is idempotent, and stays team-scoped', async () => {
  await supplier(fixture.contextA, 'PDF', 'Similar Prefix Supplier');
  const target = await supplier(fixture.contextA, 'PDF-BATCH', 'PDF Batch Supplier');
  const first = await record(fixture.contextA, target._id, { contractNumber: 'MAIN.2026.01' });
  const second = await record(fixture.contextA, target._id, { contractNumber: 'MAIN.2026.02' });
  const firstPdf = Buffer.from('%PDF-1.7\nA\n%%EOF');
  const secondPdf = Buffer.from('%PDF-1.7\nB\n%%EOF');
  const zip = pdfZip([
    { name: 'PDF-BATCH__MAIN.2026.01.pdf', content: firstPdf, deflate: true },
    { name: 'PDF-BATCH__MAIN.2026.02.pdf', content: secondPdf }
  ]);
  const request = { method: 'POST', originalUrl: '/api/contracts/suppliers/contract-pdfs/import' };
  const result = await service.importContractPdfs({ authContext: fixture.contextA, file: { buffer: zip }, req: request });
  assert.deepEqual({ matchedCount: result.matchedCount, importedCount: result.importedCount }, {
    matchedCount: 2, importedCount: 2
  });
  const persisted = await SupplierContractRecord.find({ _id: { $in: [first._id, second._id] } }).lean();
  assert.deepEqual(persisted.map((item) => item.attachments.length).sort(), [1, 1]);
  const persistedFiles = await FileAsset.find({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }).sort({ originalName: 1 }).lean();
  assert.equal(persistedFiles.length, 2);
  const expectedBytes = new Map([
    ['PDF-BATCH__MAIN.2026.01.pdf', firstPdf],
    ['PDF-BATCH__MAIN.2026.02.pdf', secondPdf]
  ]);
  for (const persistedFile of persistedFiles) {
    const diskBytes = await fs.promises.readFile(resolveStoragePath(storageRoot, persistedFile.storageKey));
    assert.deepEqual(diskBytes, expectedBytes.get(persistedFile.originalName));
  }
  assert.equal((await storageFiles()).length, 2);
  const repeated = await service.importContractPdfs({ authContext: fixture.contextA, file: { buffer: zip }, req: request });
  assert.equal(repeated.importedCount, 0);
  assert.equal(repeated.skippedExisting, 2);
  assert.equal((await storageFiles()).length, 2);
  await assert.rejects(service.importContractPdfs({ authContext: fixture.contextB, file: { buffer: zip }, req: request }), {
    status: 409,
    code: 'CONTRACT_PDF_MATCH_FAILED'
  });
  assert.equal(await FileAsset.countDocuments({
    teamId: fixture.teamB,
    ownerType: FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT
  }), 0);
});

test('bulk payment receipt import matches only equipment rentals, is idempotent, and stays team-scoped', async () => {
  const target = await supplier(fixture.contextA, 'PAY-BATCH', 'Payment Batch Supplier');
  const rental = await record(fixture.contextA, target._id, {
    category: 'EQUIPMENT_RENTAL',
    contractNumber: 'RENT-2026-01'
  });
  const nonRental = await record(fixture.contextA, target._id, {
    category: 'MAIN_SERVICE_AGREEMENT',
    contractNumber: 'MAIN-2026-01'
  });
  const pdf = Buffer.from('%PDF-1.7\\npayment\\n%%EOF');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]);
  const zip = pdfZip([
    { name: 'PAY-BATCH__RENT-2026-01.pdf', content: pdf, deflate: true },
    { name: 'PAY-BATCH__RENT-2026-01.jpg', content: jpeg }
  ]);
  const request = { method: 'POST', originalUrl: '/api/contracts/suppliers/payment-receipts/import' };
  const result = await service.importPaymentReceipts({
    authContext: fixture.contextA,
    file: { buffer: zip },
    req: request
  });
  assert.deepEqual({ matchedCount: result.matchedCount, importedCount: result.importedCount }, {
    matchedCount: 2, importedCount: 2
  });
  const persisted = await SupplierContractRecord.findById(rental._id).lean();
  assert.equal(persisted.attachments.length, 2);
  assert.deepEqual(persisted.attachments.map((item) => item.purpose).sort(), ['PAYMENT_RECEIPT', 'PAYMENT_RECEIPT']);
  assert.equal((await SupplierContractRecord.findById(nonRental._id).lean()).attachments.length, 0);
  assert.equal(await FileAsset.countDocuments({
    teamId: fixture.teamA,
    ownerId: rental._id,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }), 2);

  const repeated = await service.importPaymentReceipts({
    authContext: fixture.contextA,
    file: { buffer: zip },
    req: request
  });
  assert.equal(repeated.importedCount, 0);
  assert.equal(repeated.skippedExisting, 2);
  await assert.rejects(service.importPaymentReceipts({
    authContext: fixture.contextB,
    file: { buffer: zip },
    req: request
  }), { status: 409, code: 'CONTRACT_PAYMENT_MATCH_FAILED' });
  assert.equal(await FileAsset.countDocuments({
    teamId: fixture.teamB,
    ownerType: FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT
  }), 0);
});

test('payment receipt import rejects an unresolved file before staging or writing', async () => {
  const zip = pdfZip([{
    name: 'UNKNOWN__RENT-404.pdf',
    content: '%PDF-1.7\\nunknown\\n%%EOF'
  }]);
  await assert.rejects(service.importPaymentReceipts({
    authContext: fixture.contextA,
    file: { buffer: zip },
    req: { method: 'POST', originalUrl: '/api/contracts/suppliers/payment-receipts/import' }
  }), { status: 409, code: 'CONTRACT_PAYMENT_MATCH_FAILED' });
  assert.equal(await FileAsset.countDocuments({ teamId: fixture.teamA }), 0);
  assert.deepEqual(await storageFiles(), []);
});

test('concurrent duplicate contract PDF imports bind once and remove the unbound staged file', async () => {
  const target = await supplier(fixture.contextA, 'PDF-RACE', 'PDF Race Supplier');
  const targetRecord = await record(fixture.contextA, target._id, { contractNumber: 'RACE-1' });
  const pdf = Buffer.from('%PDF-1.7\nconcurrent\n%%EOF');
  const zip = pdfZip([{ name: 'PDF-RACE__RACE-1.pdf', content: pdf, deflate: true }]);
  const request = { method: 'POST', originalUrl: '/api/contracts/suppliers/contract-pdfs/import' };
  const realAudit = createAuditService({ AuditLog });
  let arrivals = 0;
  let release;
  const bothTransactionsStaged = new Promise((resolve) => { release = resolve; });
  const auditService = {
    async record(options) {
      if (
        options.resourceType === permissions.AUDIT_RESOURCE_TYPES.FILE_ASSET &&
        arrivals < 2
      ) {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothTransactionsStaged;
      }
      return realAudit.record(options);
    }
  };
  service = createService({ auditService });

  const results = await Promise.all([
    service.importContractPdfs({ authContext: fixture.contextA, file: { buffer: zip }, req: request }),
    service.importContractPdfs({ authContext: fixture.contextA, file: { buffer: zip }, req: request })
  ]);
  assert.equal(results.reduce((sum, item) => sum + item.importedCount, 0), 1);
  assert.equal(results.reduce((sum, item) => sum + item.skippedExisting, 0), 1);
  assert.equal(await FileAsset.countDocuments({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT,
    ownerId: targetRecord._id,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }), 1);
  const persisted = await SupplierContractRecord.findById(targetRecord._id).lean();
  assert.equal(persisted.attachments.length, 1);
  const files = await storageFiles();
  assert.equal(files.length, 1);
  assert.deepEqual(await fs.promises.readFile(files[0]), pdf);
});

test('failed contract PDF import rolls back metadata and removes staged disk bytes', async () => {
  const target = await supplier(fixture.contextA, 'PDF-ROLLBACK', 'PDF Rollback Supplier');
  const targetRecord = await record(fixture.contextA, target._id, { contractNumber: 'ROLLBACK-1' });
  const zip = pdfZip([{
    name: 'PDF-ROLLBACK__ROLLBACK-1.pdf',
    content: '%PDF-1.7\nrollback\n%%EOF'
  }]);
  const realAudit = createAuditService({ AuditLog });
  service = createService({
    auditService: {
      async record(options) {
        if (options.resourceType === permissions.AUDIT_RESOURCE_TYPES.FILE_ASSET) {
          throw new Error('contract PDF audit unavailable');
        }
        return realAudit.record(options);
      }
    }
  });

  await assert.rejects(service.importContractPdfs({
    authContext: fixture.contextA,
    file: { buffer: zip },
    req: { method: 'POST', originalUrl: '/api/contracts/suppliers/contract-pdfs/import' }
  }), /contract PDF audit unavailable/);
  assert.equal(await FileAsset.countDocuments({
    teamId: fixture.teamA,
    ownerType: FileAsset.FILE_OWNER_TYPES.SUPPLIER_CONTRACT
  }), 0);
  const persisted = await SupplierContractRecord.findById(targetRecord._id).lean();
  assert.equal(persisted.attachments.length, 0);
  assert.deepEqual(await storageFiles(), []);
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
