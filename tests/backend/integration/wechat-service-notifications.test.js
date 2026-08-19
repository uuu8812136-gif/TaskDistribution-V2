'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '../../../app');
const appRequire = (moduleName) => require(require.resolve(moduleName, { paths: [appRoot] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const WechatMiniProgramBinding = require('../../../app/models/WechatMiniProgramBinding');
const {
  createWechatServiceNotificationService
} = require('../../../app/services/wechatServiceNotificationService');

const TEMPLATE_ID = 'template-1';
let mongoServer;

test.before(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: 'wechat_service_notification_v2_test' }
  });
  await mongoose.connect(mongoServer.getUri('wechat_service_notification_v2_test'));
  await WechatMiniProgramBinding.syncIndexes();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test.beforeEach(async () => {
  await WechatMiniProgramBinding.deleteMany({});
});

function serviceFor(client) {
  return createWechatServiceNotificationService({
    enabled: true,
    templateId: TEMPLATE_ID,
    page: 'pages/message/index'
  }, { client });
}

test('concurrent accepted authorizations accumulate without a lost update', async () => {
  const userId = new mongoose.Types.ObjectId();
  await WechatMiniProgramBinding.create({ userId, openId: 'openid-auth', subscriptions: [] });
  const service = serviceFor({});

  await Promise.all(Array.from({ length: 25 }, () => service.recordAuthorization({
    userId,
    templateId: TEMPLATE_ID,
    result: 'accept'
  })));

  const binding = await WechatMiniProgramBinding.findOne({ userId }).select('+subscriptions').lean();
  assert.equal(binding.subscriptions.length, 1);
  assert.equal(binding.subscriptions[0].remainingCount, 25);
  assert.equal(binding.subscriptions[0].lastResult, 'accept');
});

test('concurrent deliveries cannot consume one grant twice', async () => {
  const userId = new mongoose.Types.ObjectId();
  await WechatMiniProgramBinding.create({
    userId,
    openId: 'openid-delivery',
    subscriptions: [{
      templateId: TEMPLATE_ID,
      remainingCount: 1,
      lastResult: 'accept'
    }]
  });
  let sends = 0;
  const service = serviceFor({
    async sendSubscriptionMessage() { sends += 1; }
  });
  const message = {
    recipient: userId,
    title: '设备维修待办',
    createdAt: new Date()
  };

  const results = await Promise.allSettled([service.deliver(message), service.deliver(message)]);
  assert.equal(sends, 1);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(
    results.find(({ status }) => status === 'rejected').reason.code,
    'WECHAT_SUBSCRIPTION_NOT_AVAILABLE'
  );
});

test('an ambiguous send consumes the reserved grant instead of retrying a duplicate', async () => {
  const userId = new mongoose.Types.ObjectId();
  await WechatMiniProgramBinding.create({
    userId,
    openId: 'openid-ambiguous',
    subscriptions: [{
      templateId: TEMPLATE_ID,
      remainingCount: 1,
      lastResult: 'accept'
    }]
  });
  const service = serviceFor({
    async sendSubscriptionMessage() {
      const error = new Error('response lost');
      error.code = 'WECHAT_NETWORK_ERROR';
      error.transient = true;
      error.deliveryOutcomeUnknown = true;
      throw error;
    }
  });

  await assert.rejects(
    service.deliver({ recipient: userId, title: '设备点检待办', createdAt: new Date() }),
    (error) => error.code === 'WECHAT_DELIVERY_OUTCOME_UNKNOWN' && error.transient === false
  );
  const binding = await WechatMiniProgramBinding.findOne({ userId }).select('+subscriptions').lean();
  assert.equal(binding.subscriptions[0].remainingCount, 0);
  assert.equal(binding.subscriptions[0].lastResult, 'consumed');
});
