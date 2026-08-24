'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const Supplier = require('../../../app/models/Supplier');
const SupplierContractRecord = require('../../../app/models/SupplierContractRecord');
const SupplierSettlementFee = require('../../../app/models/SupplierSettlementFee');

const objectId = () => new mongoose.Types.ObjectId();

function auditFields() {
  const actorId = objectId();
  return { createdBy: actorId, updatedBy: actorId };
}

test('supplier keeps codes as trimmed text and declares team-scoped uniqueness', async () => {
  const supplier = new Supplier({
    teamId: objectId(),
    name: '  测试供应商  ',
    code: '  001078  ',
    trusteeAttribute: Supplier.SUPPLIER_TRUSTEE_ATTRIBUTES.HOSTED,
    ...auditFields()
  });

  await supplier.validate();
  assert.equal(supplier.name, '测试供应商');
  assert.equal(supplier.code, '001078');
  assert.equal(supplier.schema.path('code').instance, 'String');
  assert.equal(supplier.schema.path('teamId').options.immutable, true);
  assert.equal(supplier.schema.path('hasSignedContract'), undefined);
  assert.equal(supplier.schema.path('contractValidity'), undefined);

  const uniqueIndex = Supplier.schema.indexes().find(([, options]) => (
    options.name === 'uq_supplier_team_code'
  ));
  assert.deepEqual(uniqueIndex?.[0], { teamId: 1, code: 1 });
  assert.equal(uniqueIndex?.[1].unique, true);
});

test('contract record schema exposes five categories and the canonical Excel fields', () => {
  assert.deepEqual(Object.values(SupplierContractRecord.CONTRACT_RECORD_CATEGORIES), [
    'SUPPLIER_INFO',
    'MAIN_SERVICE_AGREEMENT',
    'LOGISTICS_FEE_AGREEMENT',
    'TURNOVER_EQUIPMENT_SERVICE',
    'EQUIPMENT_RENTAL'
  ]);
  assert.deepEqual(Object.values(SupplierContractRecord.CONTRACT_SIGNING_STATUSES), [
    'SIGNED',
    'UNSIGNED'
  ]);

  const paths = SupplierContractRecord.schema.path('details').schema.paths;
  for (const field of [
    'supplyStatus',
    'hasInvoiceInfo',
    'invoiceInfoText',
    'contacts',
    'reconciliationEmails',
    'unsignedReason',
    'remarks',
    'supplierSignedDate',
    'companySignedDate',
    'returnDate',
    'courierNumber',
    'deliveredBusinessDate',
    'deliveredFactoryDate',
    'warehouseServiceRate',
    'overstorageServiceRate',
    'overstorageDays',
    'settlementCycle',
    'equipmentType',
    'equipmentServicePrice',
    'specification',
    'productionBatch',
    'color',
    'quantity'
  ]) {
    assert.ok(paths[field], `missing details.${field}`);
  }

  assert.equal(
    SupplierContractRecord.schema.indexes().some(([, options]) => options.unique === true),
    false,
    'contract history must allow repeated supplier/category rows'
  );
});

test('contract overstorage days accepts ordinary text instead of a fixed enum', async () => {
  const record = new SupplierContractRecord({
    teamId: objectId(),
    supplierId: objectId(),
    category: SupplierContractRecord.CONTRACT_RECORD_CATEGORIES.LOGISTICS_FEE_AGREEMENT,
    signingStatus: SupplierContractRecord.CONTRACT_SIGNING_STATUSES.SIGNED,
    details: { overstorageDays: '  免超储费  ' },
    ...auditFields()
  });

  await record.validate();
  assert.equal(record.details.overstorageDays, '免超储费');
  assert.equal(record.schema.path('details.overstorageDays').options.enum, undefined);
});

test('supplier information rejects contract-only fields and empty contacts', async () => {
  const record = new SupplierContractRecord({
    teamId: objectId(),
    supplierId: objectId(),
    category: SupplierContractRecord.CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO,
    signingStatus: SupplierContractRecord.CONTRACT_SIGNING_STATUSES.SIGNED,
    details: { contacts: [{ name: '', phone: '' }] },
    ...auditFields()
  });

  await assert.rejects(record.validate(), (error) => {
    assert.ok(error.errors.category);
    assert.ok(error.errors['details.contacts.0.name']);
    return true;
  });
});

test('contract rows require signing status and preserve customer-provided date order', async () => {
  const base = {
    teamId: objectId(),
    supplierId: objectId(),
    category: SupplierContractRecord.CONTRACT_RECORD_CATEGORIES.MAIN_SERVICE_AGREEMENT,
    effectiveDate: new Date('2026-08-02T00:00:00.000Z'),
    expiryDate: new Date('2026-08-01T00:00:00.000Z'),
    ...auditFields()
  };

  await assert.rejects(new SupplierContractRecord(base).validate(), (error) => {
    assert.ok(error.errors.signingStatus);
    return true;
  });

  const valid = new SupplierContractRecord({
    ...base,
    signingStatus: SupplierContractRecord.CONTRACT_SIGNING_STATUSES.SIGNED,
    autoRenew: true,
    details: {
      contacts: [{ name: '张三', phone: '13800000000' }],
      quantity: '30个',
      equipmentServicePrice: '10元/个/次'
    }
  });
  await valid.validate();
  assert.equal(valid.expiryDate.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(valid.autoRenew, true);
  assert.equal(valid.details.quantity, '30个');
  assert.equal(valid.details.equipmentServicePrice, '10元/个/次');
});

test('settlement schema validates month and non-negative amounts with team-month-code uniqueness', async () => {
  const valid = new SupplierSettlementFee({
    teamId: objectId(),
    supplierId: objectId(),
    month: '2026-08',
    supplierName: '供应商甲',
    supplierCode: '001078',
    productLaunchAmount: 100.25,
    warehousingLogisticsFee: 10,
    overstorageProductAmount: 20,
    overstorageLogisticsFee: 2.5,
    ...auditFields()
  });
  await valid.validate();
  assert.equal(valid.supplierCode, '001078');

  const invalid = new SupplierSettlementFee({
    ...valid.toObject(),
    _id: undefined,
    month: '2026-13',
    productLaunchAmount: -1
  });
  await assert.rejects(invalid.validate(), (error) => {
    assert.ok(error.errors.month);
    assert.ok(error.errors.productLaunchAmount);
    return true;
  });

  const uniqueIndex = SupplierSettlementFee.schema.indexes().find(([, options]) => (
    options.name === 'uq_supplier_settlement_team_month_code'
  ));
  assert.deepEqual(uniqueIndex?.[0], { teamId: 1, month: 1, supplierCode: 1 });
  assert.equal(uniqueIndex?.[1].unique, true);
});
