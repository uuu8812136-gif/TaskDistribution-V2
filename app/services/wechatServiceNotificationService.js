'use strict';

const WechatMiniProgramBinding = require('../models/WechatMiniProgramBinding');
const { createWechatMiniProgramClient } = require('./wechatMiniProgramClient');

const SUBSCRIPTION_RESULTS = new Set(['accept', 'reject', 'ban']);
const MAX_RECORDED_GRANTS = 100;
const PROGRESS_LABELS = Object.freeze({
  pending: '待开始',
  in_progress: '进行中',
  partial_completed: '部分完成',
  extension_pending: '延期审批中',
  extension_approved: '延期已通过',
  completed: '待审核',
  pending_review: '待审核',
  pending_confirm: '待确认',
  finished: '已完成',
  SUB_DEPARTMENT_REVIEW_PENDING: '待分部负责人审核',
  SUB_DEPARTMENT_ACCEPTANCE_PENDING: '待分部负责人验收',
  ASSET_ADMIN_RECEIPT_PENDING: '待设备管理员接单',
  ASSET_ADMIN_PRICING_PENDING: '待确认配件价格',
  DEPUTY_APPROVAL_PENDING: '待副经理或助理审批',
  MANAGER_APPROVAL_PENDING: '待部门经理终审',
  RETURNED_TO_CREATOR: '已退回创建人',
  COMPLETED: '已完成',
  VOIDED: '已作废',
  PLANNED: '待执行',
  IN_WINDOW: '执行中',
  OVERDUE: '已逾期'
});

class WechatServiceNotificationError extends Error {
  constructor(status, code, message, { transient = false, deliveryOutcomeUnknown = false } = {}) {
    super(message);
    this.name = 'WechatServiceNotificationError';
    this.status = status;
    this.code = code;
    this.transient = transient;
    this.deliveryOutcomeUnknown = deliveryOutcomeUnknown;
  }
}

function compactText(value, maximum = 20) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return [...normalized].slice(0, maximum).join('') || '待办事项';
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shanghaiDateTime(value) {
  const date = validDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function messageDeadline(message) {
  const task = message.relatedTask && typeof message.relatedTask === 'object'
    ? message.relatedTask
    : {};
  const extra = message.extraData || {};
  return validDate(
    task.extendedCompletionTime ||
    task.plannedCompletionTime ||
    extra.dueAt ||
    extra.deadline ||
    extra.plannedCompletionTime
  );
}

function messageProgress(message) {
  const task = message.relatedTask && typeof message.relatedTask === 'object'
    ? message.relatedTask
    : {};
  const extra = message.extraData || {};
  const candidate =
    extra.progressLabel ||
    extra.workflowStatus ||
    extra.currentStage ||
    extra.status ||
    extra.level ||
    task.status;
  if (candidate && PROGRESS_LABELS[candidate]) return PROGRESS_LABELS[candidate];
  if (candidate && !/^[A-Za-z0-9_-]+$/.test(String(candidate))) return compactText(candidate);
  return '待处理';
}

function buildTemplateData(message) {
  const deadline = shanghaiDateTime(messageDeadline(message));
  const data = {
    thing1: { value: compactText(message.relatedTask?.taskName || message.title) },
    thing5: { value: messageProgress(message) },
    time3: { value: shanghaiDateTime(message.createdAt || new Date()) },
    thing2: { value: '进入小程序查看处理' }
  };
  if (deadline) data.time4 = { value: deadline };
  return data;
}

function normalizePlatformError(error) {
  const platformCode = Number(error?.platformCode);
  if (platformCode === 43101) {
    return new WechatServiceNotificationError(
      409,
      'WECHAT_SUBSCRIPTION_NOT_AVAILABLE',
      'No authorized subscription is available'
    );
  }
  if (error?.deliveryOutcomeUnknown === true) {
    return new WechatServiceNotificationError(
      502,
      'WECHAT_DELIVERY_OUTCOME_UNKNOWN',
      'WeChat service notification delivery outcome is unknown',
      { deliveryOutcomeUnknown: true }
    );
  }
  return new WechatServiceNotificationError(
    502,
    error?.code || 'WECHAT_DELIVERY_FAILED',
    'WeChat service notification delivery failed',
    { transient: error?.transient === true }
  );
}

function createWechatServiceNotificationService(config, {
  BindingModel = WechatMiniProgramBinding,
  client = config.enabled ? createWechatMiniProgramClient(config) : null,
  now = () => new Date()
} = {}) {
  function requireEnabled() {
    if (!config.enabled) {
      throw new WechatServiceNotificationError(
        503,
        'WECHAT_SERVICE_NOTIFICATION_DISABLED',
        '微信服务通知暂未启用'
      );
    }
  }

  function publicConfig() {
    return {
      enabled: config.enabled,
      templateId: config.enabled ? config.templateId : null
    };
  }

  async function bindUser({ userId, code }) {
    requireEnabled();
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{6,256}$/.test(code)) {
      throw new WechatServiceNotificationError(400, 'WECHAT_LOGIN_CODE_INVALID', '微信登录凭证无效');
    }
    let identity;
    try {
      identity = await client.exchangeLoginCode(code);
    } catch (error) {
      throw normalizePlatformError(error);
    }
    const conflict = await BindingModel.findOne({ openId: identity.openId }).select('_id userId').lean();
    if (conflict && String(conflict.userId) !== String(userId)) {
      throw new WechatServiceNotificationError(
        409,
        'WECHAT_ACCOUNT_ALREADY_BOUND',
        '当前微信已绑定其他系统账号'
      );
    }
    const timestamp = now();
    const currentBinding = await BindingModel.findOne({ userId }).select('+openId').lean();
    const changedWechatAccount = Boolean(
      currentBinding?.openId && currentBinding.openId !== identity.openId
    );
    try {
      const binding = await BindingModel.findOneAndUpdate(
        { userId },
        {
          $set: {
            openId: identity.openId,
            lastBoundAt: timestamp,
            ...(changedWechatAccount ? { subscriptions: [] } : {})
          },
          $setOnInsert: { boundAt: timestamp, subscriptions: [] }
        },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      return { bound: true, boundAt: binding.boundAt, lastBoundAt: binding.lastBoundAt };
    } catch (error) {
      if (error?.code === 11000) {
        throw new WechatServiceNotificationError(
          409,
          'WECHAT_ACCOUNT_ALREADY_BOUND',
          '当前微信已绑定其他系统账号'
        );
      }
      throw error;
    }
  }

  async function recordAuthorization({ userId, templateId, result }) {
    requireEnabled();
    if (templateId !== config.templateId) {
      throw new WechatServiceNotificationError(400, 'WECHAT_TEMPLATE_INVALID', '订阅消息模板无效');
    }
    if (!SUBSCRIPTION_RESULTS.has(result)) {
      throw new WechatServiceNotificationError(400, 'WECHAT_SUBSCRIPTION_RESULT_INVALID', '订阅结果无效');
    }
    const timestamp = now();
    const acceptedCount = result === 'accept' ? 1 : 0;
    const binding = await BindingModel.findOneAndUpdate(
      { userId },
      [{
        $set: {
          subscriptions: {
            $let: {
              vars: { current: { $ifNull: ['$subscriptions', []] } },
              in: {
                $cond: [
                  {
                    $in: [
                      templateId,
                      {
                        $map: {
                          input: '$$current',
                          as: 'subscription',
                          in: '$$subscription.templateId'
                        }
                      }
                    ]
                  },
                  {
                    $map: {
                      input: '$$current',
                      as: 'subscription',
                      in: {
                        $cond: [
                          { $eq: ['$$subscription.templateId', templateId] },
                          {
                            $mergeObjects: [
                              '$$subscription',
                              {
                                remainingCount: result === 'accept'
                                  ? {
                                      $min: [
                                        MAX_RECORDED_GRANTS,
                                        { $add: [{ $ifNull: ['$$subscription.remainingCount', 0] }, 1] }
                                      ]
                                    }
                                  : 0,
                                lastResult: result,
                                updatedAt: timestamp
                              }
                            ]
                          },
                          '$$subscription'
                        ]
                      }
                    }
                  },
                  {
                    $concatArrays: [
                      '$$current',
                      [{
                        templateId,
                        remainingCount: acceptedCount,
                        lastResult: result,
                        updatedAt: timestamp
                      }]
                    ]
                  }
                ]
              }
            }
          }
        }
      }],
      { new: true }
    ).select('+subscriptions');
    if (!binding) {
      throw new WechatServiceNotificationError(409, 'WECHAT_ACCOUNT_NOT_BOUND', '请先绑定当前微信');
    }
    const subscription = binding.subscriptions.find((item) => item.templateId === templateId);
    return {
      bound: true,
      result,
      remainingCount: subscription?.remainingCount || 0,
      updatedAt: timestamp
    };
  }

  async function getStatus(userId) {
    const base = publicConfig();
    if (!config.enabled) return { ...base, bound: false, remainingCount: 0 };
    const binding = await BindingModel.findOne({ userId }).select('+subscriptions').lean();
    const subscription = binding?.subscriptions?.find((item) => item.templateId === config.templateId);
    return {
      ...base,
      bound: Boolean(binding),
      remainingCount: subscription?.remainingCount || 0,
      lastResult: subscription?.lastResult || null,
      updatedAt: subscription?.updatedAt || null
    };
  }

  async function deliver(message) {
    requireEnabled();
    const timestamp = now();
    const binding = await BindingModel.findOneAndUpdate({
      userId: message.recipient,
      subscriptions: {
        $elemMatch: {
          templateId: config.templateId,
          remainingCount: { $gt: 0 },
          lastResult: 'accept'
        }
      }
    }, {
      $inc: { 'subscriptions.$.remainingCount': -1 },
      $set: { 'subscriptions.$.updatedAt': timestamp }
    }, { new: true }).select('+openId +subscriptions');
    if (!binding) {
      const exists = await BindingModel.exists({ userId: message.recipient });
      throw new WechatServiceNotificationError(
        409,
        exists ? 'WECHAT_SUBSCRIPTION_NOT_AVAILABLE' : 'WECHAT_ACCOUNT_NOT_BOUND',
        exists ? 'No authorized subscription is available' : 'No WeChat binding'
      );
    }
    const subscription = binding.subscriptions.find((item) => item.templateId === config.templateId);
    try {
      await client.sendSubscriptionMessage({
        touser: binding.openId,
        template_id: config.templateId,
        page: config.page,
        miniprogram_state: 'formal',
        lang: 'zh_CN',
        data: buildTemplateData(message)
      });
    } catch (error) {
      const normalized = normalizePlatformError(error);
      if (
        normalized.code === 'WECHAT_SUBSCRIPTION_NOT_AVAILABLE' ||
        normalized.deliveryOutcomeUnknown === true
      ) {
        await BindingModel.updateOne(
          {
            _id: binding._id,
            subscriptions: {
              $elemMatch: {
                templateId: config.templateId,
                remainingCount: 0
              }
            }
          },
          {
            $set: {
              'subscriptions.$.lastResult': 'consumed',
              'subscriptions.$.updatedAt': now()
            }
          }
        );
      } else {
        await BindingModel.updateOne(
          {
            _id: binding._id,
            subscriptions: {
              $elemMatch: {
                templateId: config.templateId,
                remainingCount: { $lt: MAX_RECORDED_GRANTS }
              }
            }
          },
          {
            $inc: { 'subscriptions.$.remainingCount': 1 },
            $set: {
              'subscriptions.$.lastResult': 'accept',
              'subscriptions.$.updatedAt': now()
            }
          }
        );
      }
      throw normalized;
    }
    if ((subscription?.remainingCount || 0) === 0) {
      await BindingModel.updateOne(
        {
          _id: binding._id,
          subscriptions: {
            $elemMatch: {
              templateId: config.templateId,
              remainingCount: 0
            }
          }
        },
        {
          $set: {
            'subscriptions.$.lastResult': 'consumed',
            'subscriptions.$.updatedAt': now()
          }
        }
      );
    }
    return { sent: true };
  }

  return Object.freeze({ bindUser, deliver, getStatus, publicConfig, recordAuthorization });
}

module.exports = {
  WechatServiceNotificationError,
  buildTemplateData,
  compactText,
  createWechatServiceNotificationService,
  shanghaiDateTime
};
