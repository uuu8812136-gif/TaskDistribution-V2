'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const User = require('../../../app/models/User');

const TEST_DATABASE_NAME = `identity_${randomUUID().replaceAll('-', '')}_v2_test`;
let mongoServer;

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await User.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
});

test('username normalization is globally unique and preserves legacy fields', async () => {
  const first = await User.create({
    username: ' Admin ',
    password: 'test-password-1',
    name: 'First Admin',
    roles: ['admin'],
    department: 'Legacy Department'
  });

  assert.equal(first.username, 'Admin');
  assert.equal(first.usernameNormalized, 'admin');
  assert.equal(first.isSuperAdmin, false);
  assert.equal(first.tokenVersion, 0);
  assert.equal(await first.comparePassword('test-password-1'), true);
  assert.equal(await first.comparePassword('wrong-password'), false);
  assert.equal(first.toJSON().password, undefined);
  assert.deepEqual(first.roles, ['admin']);

  await assert.rejects(
    User.create({
      username: 'admin',
      password: 'test-password-2',
      name: 'Duplicate Admin'
    }),
    (error) => error?.code === 11000
  );
});

test('changing username recomputes the normalized identity key', async () => {
  const user = await User.create({
    username: 'OriginalUser',
    password: 'test-password-3',
    name: 'Original User'
  });

  user.username = '  RenamedUser  ';
  await user.save();

  assert.equal(user.username, 'RenamedUser');
  assert.equal(user.usernameNormalized, 'renameduser');
});
