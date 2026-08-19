import {
  bindWechatServiceNotificationAccount,
  getWechatServiceNotificationConfig,
  getWechatServiceNotificationStatus,
  recordWechatServiceNotificationAuthorization,
} from '@/api/index.js'

let cachedConfig = null

function uniCall(method, options = {}) {
  return new Promise((resolve, reject) => {
    method({ ...options, success: resolve, fail: reject })
  })
}

export function normalizeSubscriptionResult(value) {
  return value === 'accept' || value === 'reject' || value === 'ban' ? value : 'reject'
}

export async function loadWechatServiceNotificationState({ refresh = false } = {}) {
  if (!refresh && cachedConfig) return cachedConfig
  const config = await getWechatServiceNotificationConfig()
  if (!config?.enabled || !config?.templateId) {
    cachedConfig = { enabled: false, templateId: '', bound: false, remainingCount: 0 }
    return cachedConfig
  }
  let status = {}
  try {
    status = await getWechatServiceNotificationStatus()
  } catch (error) {
    console.error('加载微信提醒状态失败:', error)
  }
  cachedConfig = {
    enabled: true,
    templateId: config.templateId,
    bound: status.bound === true,
    remainingCount: Number(status.remainingCount) || 0,
    lastResult: status.lastResult || null,
  }
  return cachedConfig
}

export async function requestWechatServiceNotificationSubscription(config = cachedConfig) {
  if (!config?.enabled || !config?.templateId) {
    throw Object.assign(new Error('微信服务通知暂未启用'), {
      code: 'WECHAT_SERVICE_NOTIFICATION_DISABLED',
    })
  }

  // #ifdef MP-WEIXIN
  const subscription = await uniCall(uni.requestSubscribeMessage, {
    tmplIds: [config.templateId],
  })
  const result = normalizeSubscriptionResult(subscription?.[config.templateId])
  if (result !== 'accept') return { result, remainingCount: 0 }

  const login = await uniCall(uni.login, { provider: 'weixin' })
  if (!login?.code) throw new Error('微信登录凭证获取失败')
  await bindWechatServiceNotificationAccount(login.code)
  const recorded = await recordWechatServiceNotificationAuthorization(config.templateId, result)
  cachedConfig = {
    ...config,
    bound: true,
    remainingCount: Number(recorded.remainingCount) || 1,
    lastResult: result,
  }
  return { result, remainingCount: cachedConfig.remainingCount }
  // #endif

  // #ifndef MP-WEIXIN
  throw Object.assign(new Error('请在微信小程序中开启提醒'), {
    code: 'WECHAT_CLIENT_UNAVAILABLE',
  })
  // #endif
}

export function clearWechatServiceNotificationCache() {
  cachedConfig = null
}
