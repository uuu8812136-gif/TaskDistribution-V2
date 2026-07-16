import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const LOCAL_API_TARGET = 'http://127.0.0.1:18099'
const LIVE_HOSTS = new Set(['www.horselink.cn', 'horselink.cn', '82.156.67.62'])
const LIVE_API_PORTS = new Set(['8099'])

function normalizeUrl(value) {
  return value?.trim().replace(/\/+$/, '') || ''
}

function assertHttpUrl(value, variableName, { allowRelative = false } = {}) {
  if (allowRelative && value.startsWith('/') && !value.startsWith('//')) {
    return
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${variableName} must be an absolute http(s) URL${allowRelative ? ' or a root-relative path' : ''}.`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} must use http or https.`)
  }
}

function assertIsolatedEndpoint(value, variableName, mode) {
  if (!value || mode === 'production' || (value.startsWith('/') && !value.startsWith('//'))) {
    return
  }

  const { hostname, port } = new URL(value)
  if (LIVE_HOSTS.has(hostname.toLowerCase())) {
    throw new Error(`${variableName} cannot target a live endpoint in ${mode} mode.`)
  }
  if (LIVE_API_PORTS.has(port)) {
    throw new Error(`${variableName} cannot target live API port ${port} in ${mode} mode.`)
  }
}

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const apiBaseUrl = normalizeUrl(env.VITE_API_BASE_URL)
  const proxyTarget = normalizeUrl(env.VITE_DEV_PROXY_TARGET) || LOCAL_API_TARGET

  if (command === 'build' && !apiBaseUrl) {
    throw new Error('VITE_API_BASE_URL is required for every frontend build. Use the isolated test API for test builds.')
  }

  if (apiBaseUrl) {
    assertHttpUrl(apiBaseUrl, 'VITE_API_BASE_URL', { allowRelative: true })
    assertIsolatedEndpoint(apiBaseUrl, 'VITE_API_BASE_URL', mode)
  }
  assertHttpUrl(proxyTarget, 'VITE_DEV_PROXY_TARGET')
  assertIsolatedEndpoint(proxyTarget, 'VITE_DEV_PROXY_TARGET', mode)

  const allowedHosts = (env.VITE_DEV_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host: '0.0.0.0',
      port: 3001,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true
        }
      },
      allowedHosts: ['localhost', '127.0.0.1', ...allowedHosts]
    }
  }
})

