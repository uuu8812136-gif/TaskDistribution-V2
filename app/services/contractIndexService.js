'use strict';

const CONTRACT_INDEX_FORMAT = 'task-distribution-v2-contract-indexes/v1';

const CONTRACT_INDEX_SPECS = Object.freeze([
  Object.freeze({
    collection: 'suppliers',
    name: 'uq_supplier_team_code',
    key: Object.freeze({ teamId: 1, code: 1 }),
    unique: true
  }),
  Object.freeze({
    collection: 'suppliers',
    name: 'ix_supplier_team_name_code',
    key: Object.freeze({ teamId: 1, name: 1, code: 1 })
  }),
  Object.freeze({
    collection: 'suppliercontractrecords',
    name: 'ix_supplier_contract_team_supplier_category_latest',
    key: Object.freeze({
      teamId: 1,
      supplierId: 1,
      category: 1,
      effectiveDate: -1,
      expiryDate: -1,
      createdAt: -1
    })
  }),
  Object.freeze({
    collection: 'suppliercontractrecords',
    name: 'ix_supplier_contract_team_expiry',
    key: Object.freeze({ teamId: 1, category: 1, expiryDate: 1, autoRenew: 1 })
  }),
  Object.freeze({
    collection: 'suppliersettlementfees',
    name: 'uq_supplier_settlement_team_month_code',
    key: Object.freeze({ teamId: 1, month: 1, supplierCode: 1 }),
    unique: true
  }),
  Object.freeze({
    collection: 'suppliersettlementfees',
    name: 'ix_supplier_settlement_team_month_supplier',
    key: Object.freeze({ teamId: 1, month: -1, supplierName: 1, supplierCode: 1 })
  })
]);

function sameIndexKey(actual, expected) {
  return JSON.stringify(Object.entries(actual || {})) === JSON.stringify(Object.entries(expected));
}

function validateIndex(spec, index) {
  return Boolean(index) &&
    sameIndexKey(index.key, spec.key) &&
    (spec.unique === true ? index.unique === true : index.unique !== true);
}

async function ensureContractIndexes(database) {
  if (!database || typeof database.collection !== 'function') {
    throw new TypeError('A connected MongoDB database is required to ensure contract indexes');
  }

  for (const spec of CONTRACT_INDEX_SPECS) {
    await database.collection(spec.collection).createIndex(spec.key, {
      name: spec.name,
      ...(spec.unique === true ? { unique: true } : {})
    });
  }

  const byCollection = new Map();
  for (const spec of CONTRACT_INDEX_SPECS) {
    if (!byCollection.has(spec.collection)) {
      const indexes = await database.collection(spec.collection).listIndexes().toArray();
      byCollection.set(spec.collection, new Map(indexes.map((index) => [index.name, index])));
    }
    const index = byCollection.get(spec.collection).get(spec.name);
    if (!validateIndex(spec, index)) {
      const error = new Error(`Contract index is missing or incompatible: ${spec.collection}.${spec.name}`);
      error.code = 'CONTRACT_INDEX_VALIDATION_FAILED';
      throw error;
    }
  }

  return Object.freeze({
    format: CONTRACT_INDEX_FORMAT,
    indexes: Object.freeze(CONTRACT_INDEX_SPECS.map(({ collection, name }) => `${collection}.${name}`))
  });
}

module.exports = {
  CONTRACT_INDEX_FORMAT,
  CONTRACT_INDEX_SPECS,
  ensureContractIndexes,
  sameIndexKey,
  validateIndex
};
