'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTRACT_INDEX_FORMAT,
  CONTRACT_INDEX_SPECS,
  ensureContractIndexes,
  validateIndex
} = require('../../../app/services/contractIndexService');

function fakeDatabase() {
  const collections = new Map();
  const createCalls = [];
  return {
    createCalls,
    collection(name) {
      if (!collections.has(name)) {
        const indexes = new Map([['_id_', { name: '_id_', key: { _id: 1 } }]]);
        collections.set(name, {
          async createIndex(key, options) {
            createCalls.push({ name, key, options });
            indexes.set(options.name, { name: options.name, key, unique: options.unique });
            return options.name;
          },
          listIndexes() {
            return { toArray: async () => [...indexes.values()] };
          }
        });
      }
      return collections.get(name);
    }
  };
}

test('contract startup creates and verifies every declared production index', async () => {
  const database = fakeDatabase();
  const result = await ensureContractIndexes(database);

  assert.equal(result.format, CONTRACT_INDEX_FORMAT);
  assert.equal(result.indexes.length, CONTRACT_INDEX_SPECS.length);
  assert.equal(database.createCalls.length, CONTRACT_INDEX_SPECS.length);
  assert.deepEqual(
    database.createCalls.map(({ name, options }) => `${name}.${options.name}`),
    result.indexes
  );
  assert.deepEqual(
    database.createCalls.filter(({ options }) => options.unique === true).map(({ options }) => options.name),
    ['uq_supplier_team_code', 'uq_supplier_settlement_team_month_code']
  );
});

test('contract index verification rejects key or uniqueness drift', () => {
  const uniqueSpec = CONTRACT_INDEX_SPECS.find(({ unique }) => unique === true);
  assert.equal(validateIndex(uniqueSpec, {
    name: uniqueSpec.name,
    key: { ...uniqueSpec.key },
    unique: true
  }), true);
  assert.equal(validateIndex(uniqueSpec, {
    name: uniqueSpec.name,
    key: { ...uniqueSpec.key },
    unique: false
  }), false);
  assert.equal(validateIndex(uniqueSpec, {
    name: uniqueSpec.name,
    key: { teamId: 1 },
    unique: true
  }), false);
});
