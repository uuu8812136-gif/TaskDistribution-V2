const LOCAL_API_BASE_URL = 'http://127.0.0.1:18099/api'
const LIVE_HOSTS = ['www.horselink.cn', 'horselink.cn', '82.156.67.62']
const LIVE_API_PORTS = ['8099']

const viteEnv = import.meta.env || {}
const nodeEnv = typeof process !== 'undefined' && process.env ? process.env : {}
const buildMode = viteEnv.MODE || nodeEnv.NODE_ENV || 'development'
const isProduction = buildMode === 'production'

function normalizeHttpUrl(value, variableName) {
  const normalized = value.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`${variableName} must be an absolute http(s) URL.`)
  }
  return normalized
}

function assertIsolatedEndpoint(value, variableName) {
  if (isProduction) {
    return
  }

  const endpoint = value.match(/^https?:\/\/([^/:]+)(?::(\d+))?/i)
  const hostname = endpoint?.[1]?.toLowerCase() || ''
  const port = endpoint?.[2] || ''
  if (LIVE_HOSTS.includes(hostname)) {
    throw new Error(`${variableName} cannot target a live endpoint in ${buildMode} mode.`)
  }
  if (LIVE_API_PORTS.includes(port)) {
    throw new Error(`${variableName} cannot target live API port ${port} in ${buildMode} mode.`)
  }
}

const configuredApiBaseURL = (
  viteEnv.VITE_API_BASE_URL || nodeEnv.VUE_APP_API_BASE_URL || ''
).trim()
if (isProduction && !configuredApiBaseURL) {
  throw new Error('VITE_API_BASE_URL is required for a production mini-program build.')
}

const baseURL = normalizeHttpUrl(
  configuredApiBaseURL || LOCAL_API_BASE_URL,
  'VITE_API_BASE_URL'
)
assertIsolatedEndpoint(baseURL, 'VITE_API_BASE_URL')

const configuredUploadURL = (
  viteEnv.VITE_UPLOAD_BASE_URL || nodeEnv.VUE_APP_UPLOAD_BASE_URL || ''
).trim()
const uploadURL = normalizeHttpUrl(
  configuredUploadURL || baseURL.replace(/\/api$/, ''),
  'VITE_UPLOAD_BASE_URL'
)
assertIsolatedEndpoint(uploadURL, 'VITE_UPLOAD_BASE_URL')

export default {
  mode: buildMode,
  baseURL,
  uploadURL
}

