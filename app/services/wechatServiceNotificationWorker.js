'use strict';

const { randomUUID } = require('node:crypto');
const Message = require('../models/Message');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60 * 1000;
const BATCH_LIMIT = 50;

function createWechatServiceNotificationWorker({
  MessageModel = Message,
  service,
  activatedAt,
  now = () => new Date()
}) {
  if (!service || typeof service.deliver !== 'function') {
    throw new TypeError('service.deliver is required');
  }
  const activation = activatedAt instanceof Date ? activatedAt : new Date(activatedAt);
  if (Number.isNaN(activation.getTime())) throw new TypeError('activatedAt is invalid');

  async function claimOne() {
    const timestamp = now();
    const leaseToken = randomUUID();
    const query = MessageModel.findOneAndUpdate({
      createdAt: { $gte: activation },
      'wechatDelivery.attempts': { $lt: MAX_ATTEMPTS },
      $or: [
        {
          'wechatDelivery.status': { $in: ['PENDING', 'RETRY'] },
          $or: [
            { 'wechatDelivery.nextAttemptAt': null },
            { 'wechatDelivery.nextAttemptAt': { $exists: false } },
            { 'wechatDelivery.nextAttemptAt': { $lte: timestamp } }
          ]
        },
        {
          'wechatDelivery.status': 'PROCESSING',
          'wechatDelivery.leaseUntil': { $lte: timestamp }
        }
      ]
    }, {
      $set: {
        'wechatDelivery.status': 'PROCESSING',
        'wechatDelivery.leaseUntil': new Date(timestamp.getTime() + LEASE_MS),
        'wechatDelivery.leaseToken': leaseToken,
        'wechatDelivery.nextAttemptAt': null,
        'wechatDelivery.lastErrorCode': null
      },
      $inc: { 'wechatDelivery.attempts': 1 }
    }, {
      new: true,
      sort: { createdAt: 1 }
    }).select('+wechatDelivery');
    const message = await query;
    if (message?.relatedTask) {
      await message.populate('relatedTask', 'taskName status plannedCompletionTime extendedCompletionTime');
    }
    return message;
  }

  async function finish(message, status, errorCode = null, retryAt = null) {
    const update = {
      $set: {
        'wechatDelivery.status': status,
        'wechatDelivery.leaseUntil': null,
        'wechatDelivery.leaseToken': null,
        'wechatDelivery.nextAttemptAt': retryAt,
        'wechatDelivery.lastErrorCode': errorCode,
        ...(status === 'SENT' ? { 'wechatDelivery.sentAt': now() } : {})
      }
    };
    const result = await MessageModel.updateOne(
      {
        _id: message._id,
        'wechatDelivery.status': 'PROCESSING',
        'wechatDelivery.leaseToken': message.wechatDelivery?.leaseToken
      },
      update
    );
    return result.modifiedCount === 1;
  }

  async function deliverOne(message) {
    try {
      await service.deliver(message);
      return await finish(message, 'SENT') ? 'SENT' : 'LEASE_LOST';
    } catch (error) {
      if (error?.code === 'WECHAT_ACCOUNT_NOT_BOUND') {
        return await finish(message, 'SKIPPED_UNBOUND', error.code)
          ? 'SKIPPED_UNBOUND'
          : 'LEASE_LOST';
      }
      if (error?.code === 'WECHAT_SUBSCRIPTION_NOT_AVAILABLE') {
        return await finish(message, 'SKIPPED_UNSUBSCRIBED', error.code)
          ? 'SKIPPED_UNSUBSCRIBED'
          : 'LEASE_LOST';
      }
      const attempts = Number(message.wechatDelivery?.attempts) || 1;
      if (error?.transient === true && attempts < MAX_ATTEMPTS) {
        const delayMs = Math.min(15 * 60 * 1000, 30 * 1000 * (2 ** (attempts - 1)));
        return await finish(
          message,
          'RETRY',
          error.code || 'WECHAT_DELIVERY_RETRY',
          new Date(now().getTime() + delayMs)
        ) ? 'RETRY' : 'LEASE_LOST';
      }
      return await finish(message, 'FAILED', error?.code || 'WECHAT_DELIVERY_FAILED')
        ? 'FAILED'
        : 'LEASE_LOST';
    }
  }

  async function runOnce() {
    const summary = {
      claimed: 0,
      sent: 0,
      retry: 0,
      failed: 0,
      skippedUnbound: 0,
      skippedUnsubscribed: 0,
      leaseLost: 0
    };
    for (let index = 0; index < BATCH_LIMIT; index += 1) {
      const message = await claimOne();
      if (!message) break;
      summary.claimed += 1;
      const result = await deliverOne(message);
      if (result === 'SENT') summary.sent += 1;
      else if (result === 'RETRY') summary.retry += 1;
      else if (result === 'FAILED') summary.failed += 1;
      else if (result === 'SKIPPED_UNBOUND') summary.skippedUnbound += 1;
      else if (result === 'SKIPPED_UNSUBSCRIBED') summary.skippedUnsubscribed += 1;
      else if (result === 'LEASE_LOST') summary.leaseLost += 1;
    }
    return summary;
  }

  return Object.freeze({ runOnce });
}

function startWechatServiceNotificationScheduler({
  enabled,
  intervalMs,
  worker,
  logger = console
}) {
  if (!enabled) return Object.freeze({ enabled: false, stop() {} });
  if (!worker || typeof worker.runOnce !== 'function') throw new TypeError('worker.runOnce is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new TypeError('intervalMs must be at least 1000');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await worker.runOnce();
      if (summary.claimed > 0) logger.log(`WeChat service notifications: ${JSON.stringify(summary)}`);
    } catch (error) {
      logger.error('WeChat service notification worker failed:', error?.code || error?.message || 'unknown');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return Object.freeze({ enabled: true, stop() { clearInterval(timer); } });
}

module.exports = {
  createWechatServiceNotificationWorker,
  startWechatServiceNotificationScheduler
};
