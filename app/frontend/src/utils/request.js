import axios from 'axios'
import { ElMessage } from 'element-plus'

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
    return Promise.reject(new Error('Authenticated requests must use the configured API base URL'))
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
    const data = error.response?.data
    const hadToken = Boolean(readAuthToken())
    const isLoginRequest = error.config?.url === '/auth/login'

    if (status === 401 && hadToken && !isLoginRequest) {
      clearAuthToken()
      if (unauthorizedHandler) {
        unauthorizedHandler(error)
      } else {
        advanceRequestContextEpoch()
      }
      ElMessage.error('登录已过期，请重新登录')
    } else if (status === 403) {
      ElMessage.error(data?.message || '没有权限')
    } else if (status === 404) {
      ElMessage.error(data?.message || '请求的资源不存在')
    } else if (status >= 500) {
      ElMessage.error(data?.message || '服务器错误')
    } else if (status && !isLoginRequest) {
      ElMessage.error(data?.message || '请求失败')
    } else if (!error.response && error.code !== 'ERR_CANCELED') {
      ElMessage.error('网络错误，请检查网络连接')
    }

    return Promise.reject(error)
  }
)

export default request
