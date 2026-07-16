'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const AuditLog = require('../../../app/models/AuditLog');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const { createAuditService } = require('../../../app/services/auditService');
const {
  provisionDeveloperAccount,
  provisioningAuditQuery,
  resolveProvisioningOptions
} = require('../../../app/script/provisionDeveloperAccount');

const TEST_DATABASE_NAME = `developer_account_${randomUUID().replaceAll('-', '')}_v2_test`;
const FIRST_PASSWORD = `Test-only-${randomUUID()}`;
const SECOND_PASSWORD = `Changed-test-only-${randomUUID()}`;
let mongoServer;

function uniqueUsername(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

async function createSystemAccount({
  username,
  password = FIRST_PASSWORD,
  status = 'inactive',
  isSuperAdmin = false
}) {
  return User.create({
    username,
    password,
    name: 'System Maintenance',
    roles: ['admin'],
    isSystemAccount: true,
    isSuperAdmin,
    tokenVersion: 0,
    status
  });
}

before(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  await Promise.all([
    User.syncIndexes(),
    TeamMembership.syncIndexes(),
    AuditLog.syncIndexes()
  ]);
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
});

test('environment options are required and retain the normal six-character minimum', () => {
  assert.throws(() => resolveProvisioningOptions({}), /MONGODB_URI is required/);
  assert.throws(
    () => resolveProvisioningOptions({ MONGODB_URI: 'mongodb://localhost/test' }),
    /DEVELOPER_ACCOUNT_USERNAME is required/
  );
  assert.throws(
    () => resolveProvisioningOptions({
      MONGODB_URI: 'mongodb://localhost/test',
      DEVELOPER_ACCOUNT_USERNAME: 'developer'
    }),
    /DEVELOPER_ACCOUNT_PASSWORD is required/
  );
  assert.throws(
    () => resolveProvisioningOptions({
      MONGODB_URI: 'mongodb://localhost/test',
      DEVELOPER_ACCOUNT_USERNAME: 'developer',
      DEVELOPER_ACCOUNT_PASSWORD: 'short'
    }),
    /6-128 characters/
  );

  const options = resolveProvisioningOptions({
    MONGODB_URI: 'mongodb://localhost/test',
    DEVELOPER_ACCOUNT_USERNAME: '  DevUser  ',
    DEVELOPER_ACCOUNT_PASSWORD: FIRST_PASSWORD
  });
  assert.equal(options.username, 'DevUser');
  assert.equal(options.password, FIRST_PASSWORD);
});

test('audits a pending account before activating the system super-admin', async () => {
  const username = uniqueUsername('developer');
  const persistentAuditService = createAuditService();
  let pendingObserved = false;
  const result = await provisionDeveloperAccount({
    username,
    password: FIRST_PASSWORD,
    auditService: {
      async recordSystem(input) {
        const pending = await User.findById(input.resourceId);
        assert.equal(pending.status, 'inactive');
        assert.equal(pending.isSuperAdmin, false);
        pendingObserved = true;
        return persistentAuditService.recordSystem(input);
      }
    }
  });

  assert.equal(result.created, true);
  assert.equal(pendingObserved, true);
  assert.equal(JSON.stringify(result).includes(FIRST_PASSWORD), false);

  const user = await User.findOne({ usernameNormalized: username.toLowerCase() });
  assert.ok(user);
  assert.equal(user.name, 'System Maintenance');
  assert.equal(user.isSystemAccount, true);
  assert.equal(user.isSuperAdmin, true);
  assert.equal(user.status, 'active');
  assert.equal(user.tokenVersion, 0);
  assert.deepEqual(user.roles, ['admin']);
  assert.equal(await user.comparePassword(FIRST_PASSWORD), true);
  assert.equal(await TeamMembership.countDocuments({ userId: user._id }), 0);

  const audits = await AuditLog.find(provisioningAuditQuery(user._id)).lean();
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits[0]).includes(FIRST_PASSWORD), false);
  assert.equal(Object.hasOwn(audits[0].after, 'username'), false);
  assert.equal(Object.hasOwn(audits[0].after, 'password'), false);
});

test('same-password rerun is idempotent and preserves the password hash', async () => {
  const username = uniqueUsername('idempotent');
  const first = await provisionDeveloperAccount({
    username,
    password: FIRST_PASSWORD
  });
  const before = await User.findById(first.userId).lean();
  await User.updateOne(
    { _id: first.userId },
    { $set: { name: 'Legacy Developer Label' } }
  );

  const second = await provisionDeveloperAccount({
    username: username.toUpperCase(),
    password: FIRST_PASSWORD
  });
  const afterRecord = await User.findById(first.userId);

  assert.equal(second.created, false);
  assert.equal(second.userId, first.userId);
  assert.equal(afterRecord.password, before.password);
  assert.equal(afterRecord.name, 'System Maintenance');
  assert.equal(await afterRecord.comparePassword(FIRST_PASSWORD), true);
  assert.equal(await AuditLog.countDocuments(provisioningAuditQuery(first.userId)), 1);
});

test('different-password rerun fails without changing an active account', async () => {
  const username = uniqueUsername('password_mismatch');
  const first = await provisionDeveloperAccount({
    username,
    password: FIRST_PASSWORD
  });
  const before = await User.findById(first.userId).lean();

  await assert.rejects(
    provisionDeveloperAccount({ username, password: SECOND_PASSWORD }),
    /password does not match/
  );

  const unchanged = await User.findById(first.userId);
  assert.equal(unchanged.password, before.password);
  assert.equal(unchanged.status, 'active');
  assert.equal(unchanged.isSuperAdmin, true);
  assert.equal(await AuditLog.countDocuments(provisioningAuditQuery(first.userId)), 1);
});

test('recovers a valid pending account by adding its missing audit and activating it', async () => {
  const username = uniqueUsername('pending');
  const pending = await createSystemAccount({ username });
  const pendingHash = pending.password;

  const result = await provisionDeveloperAccount({
    username,
    password: FIRST_PASSWORD
  });

  const recovered = await User.findById(pending._id);
  assert.equal(result.created, false);
  assert.equal(recovered.password, pendingHash);
  assert.equal(recovered.status, 'active');
  assert.equal(recovered.isSuperAdmin, true);
  assert.equal(await AuditLog.countDocuments(provisioningAuditQuery(pending._id)), 1);
});

test('deletes a newly created pending account when its audit cannot be persisted', async () => {
  const username = uniqueUsername('audit_failure');
  await assert.rejects(
    provisionDeveloperAccount({
      username,
      password: FIRST_PASSWORD,
      auditService: {
        async recordSystem() {
          throw new Error('simulated audit failure');
        }
      }
    }),
    /simulated audit failure/
  );

  assert.equal(await User.countDocuments({ usernameNormalized: username.toLowerCase() }), 0);
});

test('disables an active system account when its provisioning audit is missing', async () => {
  const username = uniqueUsername('missing_audit');
  const unaudited = await createSystemAccount({
    username,
    status: 'active',
    isSuperAdmin: true
  });

  await assert.rejects(
    provisionDeveloperAccount({ username, password: FIRST_PASSWORD }),
    /missing its provisioning audit and was disabled/
  );

  const disabled = await User.findById(unaudited._id);
  assert.equal(disabled.status, 'inactive');
  assert.equal(disabled.isSuperAdmin, false);
  assert.equal(await AuditLog.countDocuments(provisioningAuditQuery(unaudited._id)), 0);
});

test('rejects a system developer account that has a team membership', async () => {
  const username = uniqueUsername('membership');
  const provisioned = await provisionDeveloperAccount({
    username,
    password: FIRST_PASSWORD
  });
  const userId = new mongoose.Types.ObjectId(provisioned.userId);
  await mongoose.connection.db.collection('teammemberships').insertOne({ userId });

  await assert.rejects(
    provisionDeveloperAccount({ username, password: FIRST_PASSWORD }),
    /must not have a team membership/
  );
});

test('fails closed when the normalized username belongs to a non-system account', async () => {
  const username = uniqueUsername('collision');
  const original = await User.create({
    username,
    password: FIRST_PASSWORD,
    name: 'Existing User',
    roles: ['executor'],
    isSuperAdmin: false,
    status: 'active'
  });
  const originalHash = original.password;

  await assert.rejects(
    provisionDeveloperAccount({
      username: username.toUpperCase(),
      password: SECOND_PASSWORD
    }),
    /non-system account/
  );

  const unchanged = await User.findById(original._id);
  assert.equal(unchanged.password, originalHash);
  assert.equal(unchanged.isSuperAdmin, false);
  assert.equal(unchanged.isSystemAccount, false);
  assert.equal(await AuditLog.countDocuments(provisioningAuditQuery(original._id)), 0);
});
