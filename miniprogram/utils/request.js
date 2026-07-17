import config from '@/config/index.js'
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
  if (typeof url !== 'string' || !url) throw new TypeError('Request URL is required')
  if (/^https?:\/\//i.test(url)) {
    if (url !== config.baseURL && !url.startsWith(`${config.baseURL}/`)) {
      throw new Error('Authenticated requests cannot target an external origin')
    }
    return url
  }
  return `${config.baseURL}${url}`
}

function notifyError(statusCode, data, options) {
  if (options.silentError === true) return
  let title = data?.message || '请求失败'
  if (statusCode === 403 && !data?.message) title = '没有权限'
  if (statusCode === 404 && !data?.message) title = '请求的资源不存在'
  if (statusCode >= 500 && !data?.message) title = '服务器错误'
  uni.showToast({ title, icon: 'none', duration: 2000 })
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

  if (statusCode === 401 && handleUnauthorized(options, requestContext)) {
    throw Object.assign(new Error(data?.message || '登录已过期'), {
      statusCode,
      code: data?.code || 'AUTH_UNAUTHORIZED'
    })
  }

  notifyError(statusCode, data, options)
  throw Object.assign(new Error(data?.message || '请求失败'), {
    statusCode,
    code: data?.code
  })
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
          if (!isStaleContextResponseError(error) && options.silentError !== true) {
            uni.showToast({ title: '网络错误，请检查网络连接', icon: 'none' })
          }
          reject(error)
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
          reject(error)
        }
      },
      fail: (error) => {
        try {
          tracker.assertCurrent(requestContext)
          if (options.silentError !== true) {
            uni.showToast({ title: '上传失败', icon: 'none' })
          }
          reject(error)
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
          if (options.silentError !== true) {
            uni.showToast({ title: '下载失败', icon: 'none' })
          }
          reject(error)
        } catch (staleError) {
          reject(staleError)
        }
      },
      complete: () => hideLoading(options)
    })
  })
}

export default request
