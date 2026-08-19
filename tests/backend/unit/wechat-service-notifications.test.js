'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Message = require('../../../app/models/Message');
const WechatMiniProgramBinding = require('../../../app/models/WechatMiniProgramBinding');
const {
  buildTemplateData,
  compactText,
  createWechatServiceNotificationService,
  shanghaiDateTime
} = require('../../../app/services/wechatServiceNotificationService');
const { createWechatMiniProgramClient } = require('../../../app/services/wechatMiniProgramClient');
const {
  createWechatServiceNotificationWorker
} = require('../../../app/services/wechatServiceNotificationWorker');

test('message outbox defaults to pending and remains hidden from normal projections', () => {
  const message = new Message({
    teamId: '64b000000000000000000001',
    type: 'system',
    title: '维修待办',
    content: '请处理',
    recipient: '64b000000000000000000002'
  });
  assert.equal(message.wechatDelivery.status, 'PENDING');
  assert.equal(message.wechatDelivery.attempts, 0);
  assert.equal(Message.schema.path('wechatDelivery').options.select, false);
});

test('binding OpenID and subscription grants are private model fields', () => {
  assert.equal(WechatMiniProgramBinding.schema.path('openId').options.select, false);
  assert.equal(WechatMiniProgramBinding.schema.path('subscriptions').options.select, false);
});

test('template data uses the exact approved keyword mapping and Shanghai time', () => {
  const data = buildTemplateData({
    title: '设备点检保养维修待办提醒文字会截断',
    content: '请及时处理',
    createdAt: new Date('2026-08-19T01:02:03.000Z'),
    relatedTask: {
      taskName: '防火安全考试与企业入驻审核',
      status: 'pending_review',
      plannedCompletionTime: new Date('2026-08-20T09:30:00.000Z')
    },
    extraData: {}
  });
  assert.deepEqual(Object.keys(data), ['thing1', 'thing5', 'time3', 'thing2', 'time4']);
  assert.equal(data.thing1.value, '防火安全考试与企业入驻审核');
  assert.equal(data.time4.value, '2026-08-20 17:30:00');
  assert.equal(data.thing5.value, '待审核');
  assert.equal(data.time3.value, '2026-08-19 09:02:03');
  assert.equal(data.thing2.value, '进入小程序查看处理');
  assert.equal(compactText('一段很长的内容超出', 6), '一段很长的内');
  assert.equal(shanghaiDateTime('invalid'), null);
});

test('template omits deadline instead of inventing one for a deadline-free workflow', () => {
  const data = buildTemplateData({
    title: '维修审批待办',
    content: '请审批',
    createdAt: new Date('2026-08-19T01:02:03.000Z'),
    extraData: { workflowStatus: 'DEPARTMENT_REVIEW' }
  });
  assert.equal(data.time4, undefined);
  assert.equal(data.thing5.value, '待处理');
});

test('WeChat client exchanges a login code and reuses a cached access token', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('jscode2session')) {
      return { ok: true, status: 200, json: async () => ({ openid: 'openid-1' }) };
    }
    if (String(url).includes('/token?')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'token-1', expires_in: 7200 }) };
    }
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
  };
  const client = createWechatMiniProgramClient({
    appId: 'wx0123456789abcdef',
    appSecret: '0123456789abcdef0123456789abcdef',
    fetchImpl,
    now: () => 1000
  });
  assert.deepEqual(await client.exchangeLoginCode('code-123'), { openId: 'openid-1', unionId: null });
  await client.sendSubscriptionMessage({ touser: 'openid-1', template_id: 'template-1', data: {} });
  await client.sendSubscriptionMessage({ touser: 'openid-1', template_id: 'template-1', data: {} });
  assert.equal(calls.filter(({ url }) => url.includes('/token?')).length, 1);
  assert.equal(calls.filter(({ url }) => url.includes('/subscribe/send?')).length, 2);
});

test('WeChat client marks an interrupted send response as an ambiguous delivery outcome', async () => {
  const client = createWechatMiniProgramClient({
    appId: 'wx0123456789abcdef',
    appSecret: '0123456789abcdef0123456789abcdef',
    fetchImpl: async (url) => {
      if (String(url).includes('/token?')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'token-1', expires_in: 7200 }) };
      }
      throw new Error('connection reset after request');
    }
  });
  await assert.rejects(
    client.sendSubscriptionMessage({ touser: 'openid-1', template_id: 'template-1', data: {} }),
    (error) => error.code === 'WECHAT_NETWORK_ERROR' && error.deliveryOutcomeUnknown === true
  );
});

test('authorization grants are accumulated by one atomic database update', async () => {
  let captured = null;
  const BindingModel = {
    findOneAndUpdate(filter, update, options) {
      captured = { filter, update, options };
      return {
        select: async () => ({
          subscriptions: [{
            templateId: 'template-1',
            remainingCount: 2,
            lastResult: 'accept',
            updatedAt: new Date('2026-08-19T03:00:00.000Z')
          }]
        })
      };
    }
  };
  const service = createWechatServiceNotificationService({
    enabled: true,
    templateId: 'template-1'
  }, {
    BindingModel,
    client: {},
    now: () => new Date('2026-08-19T03:00:00.000Z')
  });
  const result = await service.recordAuthorization({
    userId: 'user-1',
    templateId: 'template-1',
    result: 'accept'
  });
  assert.equal(result.remainingCount, 2);
  assert.deepEqual(captured.filter, { userId: 'user-1' });
  assert.equal(Array.isArray(captured.update), true);
  assert.deepEqual(captured.options, { new: true });
});

test('one recorded grant can be reserved by only one concurrent delivery', async () => {
  let remainingCount = 1;
  let sends = 0;
  const writes = [];
  const BindingModel = {
    findOneAndUpdate() {
      const reserved = remainingCount > 0;
      if (reserved) remainingCount -= 1;
      return {
        select: async () => reserved
          ? {
              _id: 'binding-1',
              openId: 'openid-1',
              subscriptions: [{
                templateId: 'template-1',
                remainingCount,
                lastResult: 'accept'
              }]
            }
          : null
      };
    },
    exists: async () => true,
    async updateOne(filter, update) {
      writes.push({ filter, update });
      return { modifiedCount: 1 };
    }
  };
  const service = createWechatServiceNotificationService({
    enabled: true,
    templateId: 'template-1',
    page: 'pages/message/index'
  }, {
    BindingModel,
    client: { async sendSubscriptionMessage() { sends += 1; } },
    now: () => new Date('2026-08-19T03:00:00.000Z')
  });
  const message = {
    recipient: 'user-1',
    title: '设备维修待办',
    createdAt: new Date('2026-08-19T02:00:00.000Z')
  };
  const results = await Promise.allSettled([service.deliver(message), service.deliver(message)]);
  assert.equal(sends, 1);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = results.find(({ status }) => status === 'rejected');
  assert.equal(rejection.reason.code, 'WECHAT_SUBSCRIPTION_NOT_AVAILABLE');
  assert.equal(writes.length, 1);
});

function createWorkerFixture(deliver, { loseLease = false } = {}) {
  const queue = [{
    _id: 'message-1',
    recipient: 'user-1',
    createdAt: new Date('2026-08-19T02:00:00.000Z'),
    wechatDelivery: { attempts: 1 },
    async populate() {}
  }];
  const writes = [];
  const MessageModel = {
    findOneAndUpdate(filter, update) {
      const message = queue.shift() || null;
      if (message) {
        message.wechatDelivery = {
          ...message.wechatDelivery,
          leaseToken: update.$set['wechatDelivery.leaseToken']
        };
      }
      return { select: async () => message };
    },
    async updateOne(filter, update) {
      writes.push({ filter, update });
      return { modifiedCount: loseLease ? 0 : 1 };
    }
  };
  return {
    worker: createWechatServiceNotificationWorker({
      MessageModel,
      service: { deliver },
      activatedAt: new Date('2026-08-19T00:00:00.000Z'),
      now: () => new Date('2026-08-19T03:00:00.000Z')
    }),
    writes
  };
}

test('notification worker marks a delivered message sent exactly once', async () => {
  let deliveries = 0;
  const fixture = createWorkerFixture(async () => { deliveries += 1; });
  const summary = await fixture.worker.runOnce();
  assert.equal(deliveries, 1);
  assert.deepEqual(summary, {
    claimed: 1,
    sent: 1,
    retry: 0,
    failed: 0,
    skippedUnbound: 0,
    skippedUnsubscribed: 0,
    leaseLost: 0
  });
  assert.match(fixture.writes[0].filter['wechatDelivery.leaseToken'], /^[0-9a-f-]{36}$/);
  assert.equal(fixture.writes[0].update.$set['wechatDelivery.status'], 'SENT');
});

test('notification worker skips only WeChat delivery when no grant exists', async () => {
  const fixture = createWorkerFixture(async () => {
    throw Object.assign(new Error('no grant'), { code: 'WECHAT_SUBSCRIPTION_NOT_AVAILABLE' });
  });
  const summary = await fixture.worker.runOnce();
  assert.equal(summary.skippedUnsubscribed, 1);
  assert.equal(fixture.writes[0].update.$set['wechatDelivery.status'], 'SKIPPED_UNSUBSCRIBED');
});

test('an expired worker lease cannot overwrite the result of its successor', async () => {
  const fixture = createWorkerFixture(async () => {}, { loseLease: true });
  const summary = await fixture.worker.runOnce();
  assert.equal(summary.sent, 0);
  assert.equal(summary.leaseLost, 1);
  assert.match(fixture.writes[0].filter['wechatDelivery.leaseToken'], /^[0-9a-f-]{36}$/);
});
