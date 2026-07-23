import config from '@/config/index.js'
import {
  REQUEST_ERROR_CODE_MESSAGES,
  localizeRequestError,
  resolveRequestErrorMessage
} from './requestErrorMessages.js'
import {
  createRequestContextTracker,
  isStaleContextResponseError
} from './sessionCore.js'
import {
  clearAuthToken,
  clearLegacyCredentialCaches,
  clearScopedCaches,
  clearSessionSnapshot,
  readAuthToken
} from './sessionRuntime.js'

const tracker = createRequestContextTracker(readAuthToken)
let unauthorizedHandler = null
let loadingCount = 0

export const getRequestContextEpoch = () => tracker.getEpoch()
export const advanceRequestContextEpoch = () => tracker.advance()
export { isStaleContextResponseError }
export { REQUEST_ERROR_CODE_MESSAGES }

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null
}

function showLoading(options) {
  if (options.showLoading === false) return
  loadingCount += 1
  if (loadingCount === 1) {
    uni.showLoading({ title: options.loadingText || '加载中...', mask: true })
  }
}

function hideLoading(options) {
  if (options.showLoading === false) return
  loadingCount = Math.max(0, loadingCount - 1)
  if (loadingCount === 0) uni.hideLoading()
}

function buildHeaders(options, token) {
  const headers = { ...(options.header || {}) }
  if (options.contentType !== false) headers['Content-Type'] = 'application/json'
  delete headers.teamId
  delete headers['Team-Id']
  delete headers['X-Team-Id']
  delete headers['x-team-id']
  delete headers.Authorization
  delete headers.authorization
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`
  return headers
}

function resolveUrl(url) {
  if (typeof url !== 'string' || !url) throw new TypeError('请求地址不能为空')
  if (/^https?:\/\//i.test(url)) {
    if (url !== config.baseURL && !url.startsWith(`${config.baseURL}/`)) {
      throw Object.assign(new Error('认证请求不能访问系统 API 以外的地址'), {
        code: 'REQUEST_EXTERNAL_ORIGIN_DENIED'
      })
    }
    return url
  }
  return `${config.baseURL}${url}`
}

function responseFallback(statusCode, options) {
  if (typeof options.errorMessage === 'string' && options.errorMessage.trim()) {
    return options.errorMessage.trim()
  }
  if (statusCode === 401) return '登录状态已失效，请重新登录'
  if (statusCode === 403) return '没有执行该操作的权限'
  if (statusCode === 404) return '请求的记录不存在或已被删除'
  if (statusCode >= 500) return '服务器暂时无法处理请求，请稍后重试'
  return '请求失败，请稍后重试'
}

function responseErrorMessage(statusCode, data, options) {
  return resolveRequestErrorMessage({
    code: data?.code,
    message: data?.message,
    statusCode
  }, responseFallback(statusCode, options))
}

function notifyError(title, options) {
  if (options.silentError === true) return
  uni.showToast({ title, icon: 'none', duration: 2000 })
}

function createResponseError(statusCode, data, options) {
  const message = responseErrorMessage(statusCode, data, options)
  return Object.assign(new Error(message), {
    statusCode,
    code: data?.code,
    data: data && typeof data === 'object' ? { ...data, message } : { message }
  })
}

function handleUnauthorized(options, requestContext) {
  tracker.assertCurrent(requestContext)
  if (options.auth === false || !requestContext.token) return false
  if (unauthorizedHandler) unauthorizedHandler()
  else {
    tracker.advance()
    clearAuthToken()
    clearSessionSnapshot()
    clearLegacyCredentialCaches()
    clearScopedCaches()
    uni.removeTabBarBadge({ index: 3 })
    uni.$emit('auth-context-changed', { reason: 'unauthorized' })
    uni.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
    setTimeout(() => uni.reLaunch({ url: '/pages/login/index' }), 300)
  }
  return true
}

function handleResponse(response, options, requestContext) {
  tracker.assertCurrent(requestContext)
  const { statusCode, data } = response
  if (statusCode >= 200 && statusCode < 300) return data

  const responseError = createResponseError(statusCode, data, options)

  if (statusCode === 401 && handleUnauthorized(options, requestContext)) {
    if (!responseError.code) responseError.code = 'AUTH_UNAUTHORIZED'
    throw responseError
  }

  notifyError(responseError.message, options)
  throw responseError
}

const request = (rawOptions) => {
  const options = { ...rawOptions }
  const requestContext = tracker.capture(options.contextScoped !== false)
  const token = options.auth === false ? '' : requestContext.token
  options.url = resolveUrl(options.url)
  options.header = buildHeaders(options, token)

  return new Promise((resolve, reject) => {
    showLoading(options)
    uni.request({
      ...options,
      success: (response) => {
        try {
          resolve(handleResponse(response, options, requestContext))
        } catch (error) {
          reject(error)
        }
      },
      fail: (error) => {
        try {
          tracker.assertCurrent(requestContext)
          const localizedError = localizeRequestError(
            error,
            options.errorMessage || '网络错误，请检查网络连接'
          )
          if (!isStaleContextResponseError(localizedError) && options.silentError !== true) {
            uni.showToast({ title: localizedError.message, icon: 'none' })
          }
          reject(localizedError)
        } catch (staleError) {
          reject(staleError)
        }
      },
      complete: () => hideLoading(options)
    })
  })
}

export const get = (url, params = {}, options = {}) => request({
  url,
  method: 'GET',
  data: params,
  ...options
})

export const post = (url, data = {}, options = {}) => request({
  url,
  method: 'POST',
  data,
  ...options
})

export const put = (url, data = {}, options = {}) => request({
  url,
  method: 'PUT',
  data,
  ...options
})

export const patch = (url, data = {}, options = {}) => request({
  url,
  method: 'PATCH',
  data,
  ...options
})

export const del = (url, data = {}, options = {}) => request({
  url,
  method: 'DELETE',
  data,
  ...options
})

export const upload = (url, filePath, formData = {}, options = {}) => {
  const requestContext = tracker.capture(options.contextScoped !== false)
  const token = options.auth === false ? '' : requestContext.token

  return new Promise((resolve, reject) => {
    showLoading({ loadingText: '上传中...', ...options })
    uni.uploadFile({
      url: resolveUrl(url),
      filePath,
      name: options.name || 'file',
      formData,
      header: buildHeaders({ ...options, contentType: false, header: options.header }, token),
      success: (response) => {
        try {
          const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
          resolve(handleResponse({ ...response, data }, options, requestContext))
        } catch (error) {
          const localizedError = error?.statusCode
            ? error
            : localizeRequestError(error, options.errorMessage || '上传响应异常，请稍后重试')
          if (!error?.statusCode && options.silentError !== true) {
            uni.showToast({ title: localizedError.message, icon: 'none' })
          }
          reject(localizedError)
        }
      },
      fail: (error) => {
        try {
          tracker.assertCurrent(requestContext)
          const localizedError = localizeRequestError(
            error,
            options.errorMessage || '上传失败，请检查网络后重试'
          )
          if (options.silentError !== true) {
            uni.showToast({ title: localizedError.message, icon: 'none' })
          }
          reject(localizedError)
        } catch (staleError) {
          reject(staleError)
        }
      },
      complete: () => hideLoading(options)
    })
  })
}

export const download = (url, options = {}) => {
  const requestContext = tracker.capture(options.contextScoped !== false)
  const token = options.auth === false ? '' : requestContext.token

  return new Promise((resolve, reject) => {
    showLoading({ loadingText: '下载中...', ...options })
    uni.downloadFile({
      url: resolveUrl(url),
      header: buildHeaders({ ...options, contentType: false, header: options.header }, token),
      success: (response) => {
        try {
          tracker.assertCurrent(requestContext)
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({
              tempFilePath: response.tempFilePath,
              statusCode: response.statusCode
            })
            return
          }
          let data = response.data
          if (typeof data === 'string') {
            try { data = JSON.parse(data) } catch { data = {} }
          }
          handleResponse({ ...response, data: data || {} }, options, requestContext)
        } catch (error) {
          reject(error)
        }
      },
      fail: (error) => {
        try {
          tracker.assertCurrent(requestContext)
          const localizedError = localizeRequestError(
            error,
            options.errorMessage || '下载失败，请检查网络后重试'
          )
          if (options.silentError !== true) {
            uni.showToast({ title: localizedError.message, icon: 'none' })
          }
          reject(localizedError)
        } catch (staleError) {
          reject(staleError)
        }
      },
      complete: () => hideLoading(options)
    })
  })
}

export default request
