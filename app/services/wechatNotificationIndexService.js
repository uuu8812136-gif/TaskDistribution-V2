'use strict';

const INDEXES = Object.freeze([
  {
    collection: 'wechatminiprogrambindings',
    key: { userId: 1 },
    options: { unique: true, name: 'uq_wechat_binding_user' }
  },
  {
    collection: 'wechatminiprogrambindings',
    key: { openId: 1 },
    options: { unique: true, name: 'uq_wechat_binding_openid' }
  },
  {
    collection: 'messages',
    key: { teamId: 1, 'wechatDelivery.status': 1, 'wechatDelivery.nextAttemptAt': 1, createdAt: 1 },
    options: { name: 'ix_message_wechat_delivery' }
  }
]);

async function ensureWechatNotificationIndexes(database) {
  const names = [];
  for (const definition of INDEXES) {
    const name = await database.collection(definition.collection)
      .createIndex(definition.key, definition.options);
    names.push(`${definition.collection}.${name}`);
  }
  return Object.freeze({ format: 'wechat-notification-indexes/v1', indexes: names });
}

module.exports = { INDEXES, ensureWechatNotificationIndexes };
