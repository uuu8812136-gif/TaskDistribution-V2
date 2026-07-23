import axios from 'axios'
import { ElMessage } from 'element-plus'
import {
  REQUEST_ERROR_CODE_MESSAGES,
  localizeRequestError,
  requestErrorMessage
} from './requestErrorMessages.js'

export { REQUEST_ERROR_CODE_MESSAGES, requestErrorMessage }

const TOKEN_STORAGE_KEY = 'token'
const configuredApiBaseURL = import.meta.env.VITE_API_BASE_URL?.trim()
const apiBaseURL = configuredApiBaseURL
  ? configuredApiBaseURL.replace(/\/+$/, '')
  : '/api'

let contextEpoch = 0
let unauthorizedHandler = null

export class StaleContextResponseError extends Error {
  constructor() {
    super('Response belongs to an inactive authentication context')
    this.name = 'StaleContextResponseError'
    this.code = 'ERR_AUTH_CONTEXT_STALE'
  }
}

export function isStaleContextResponseError(error) {
  return error?.code === 'ERR_AUTH_CONTEXT_STALE'
}

export function getRequestContextEpoch() {
  return contextEpoch
}

export function advanceRequestContextEpoch() {
  contextEpoch += 1
  return contextEpoch
}

export function readAuthToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || ''
}

export function replaceAuthToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  }
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY)
  localStorage.removeItem('userInfo')
}

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null
}

function assertCurrentContext(config) {
  if (
    config?.contextScoped !== false &&
    Number.isInteger(config?.authContextEpoch) &&
    config.authContextEpoch !== contextEpoch
  ) {
    throw new StaleContextResponseError()
  }
}

const request = axios.create({
  baseURL: apiBaseURL,
  timeout: 30000
})

request.interceptors.request.use((config) => {
  if (/^https?:\/\//i.test(config.url || '')) {
    return Promise.reject(Object.assign(
      new Error('认证请求必须使用系统配置的 API 地址'),
      { code: 'REQUEST_EXTERNAL_ORIGIN_DENIED' }
    ))
  }
  config.authContextEpoch = contextEpoch
  const token = readAuthToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

request.interceptors.response.use(
  (response) => {
    assertCurrentContext(response.config)
    return response.data
  },
  (error) => {
    try {
      assertCurrentContext(error.config)
    } catch (staleError) {
      return Promise.reject(staleError)
    }

    const status = error.response?.status
    const hadToken = Boolean(readAuthToken())
    const isLoginRequest = error.config?.url === '/auth/login'
    let fallback = '请求失败，请稍后重试'
    if (!error.response) fallback = '网络错误，请检查网络连接'
    if (status === 401) fallback = isLoginRequest ? '登录失败' : '登录状态已失效，请重新登录'
    if (status === 403) fallback = '没有执行该操作的权限'
    if (status === 404) fallback = '请求的记录不存在或已被删除'
    if (status >= 500) fallback = '服务器暂时无法处理请求，请稍后重试'
    const localizedError = error.code === 'ERR_CANCELED'
      ? error
      : localizeRequestError(error, fallback)

    if (status === 401 && hadToken && !isLoginRequest) {
      clearAuthToken()
      if (unauthorizedHandler) {
        unauthorizedHandler(localizedError)
      } else {
        advanceRequestContextEpoch()
      }
      ElMessage.error('登录已过期，请重新登录')
    } else if (status === 403) {
      ElMessage.error(localizedError.message)
    } else if (status === 404) {
      ElMessage.error(localizedError.message)
    } else if (status >= 500) {
      ElMessage.error(localizedError.message)
    } else if (status && !isLoginRequest) {
      ElMessage.error(localizedError.message)
    } else if (!error.response && error.code !== 'ERR_CANCELED') {
      ElMessage.error(localizedError.message)
    }

    return Promise.reject(localizedError)
  }
)

export default request
