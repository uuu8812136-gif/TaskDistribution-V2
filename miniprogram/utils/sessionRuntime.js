import { belongsToScopedIdentity, createScopedCacheKey } from './sessionCore.js'

const TOKEN_KEY = 'token'
const SESSION_SNAPSHOT_KEY = 'v2:session-snapshot'
const SCOPED_CACHE_INDEX_KEY = 'v2:scoped-cache-index'
const LEGACY_SECRET_KEYS = ['savedPassword', 'rememberPassword']

function readStorage(key, fallback = null) {
  try {
    const value = uni.getStorageSync(key)
    return value === '' || value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

export function readAuthToken() {
  return readStorage(TOKEN_KEY, '') || ''
}

export function replaceAuthToken(token) {
  if (token) uni.setStorageSync(TOKEN_KEY, token)
  else uni.removeStorageSync(TOKEN_KEY)
}

export function clearAuthToken() {
  uni.removeStorageSync(TOKEN_KEY)
}

export function readSessionSnapshot() {
  const snapshot = readStorage(SESSION_SNAPSHOT_KEY, null)
  return snapshot && typeof snapshot === 'object' ? snapshot : null
}

export function writeSessionSnapshot(snapshot) {
  if (!snapshot) {
    uni.removeStorageSync(SESSION_SNAPSHOT_KEY)
    return
  }
  const { user, teams, mode, activeTeamId, context } = snapshot
  uni.setStorageSync(SESSION_SNAPSHOT_KEY, { user, teams, mode, activeTeamId, context })
}

export function clearSessionSnapshot() {
  uni.removeStorageSync(SESSION_SNAPSHOT_KEY)
  uni.removeStorageSync('userInfo')
}

export function clearLegacyCredentialCaches() {
  LEGACY_SECRET_KEYS.forEach((key) => uni.removeStorageSync(key))
}

export function toCacheIdentity(userId, activeTeamId, mode) {
  if (!userId) return null
  return {
    userId,
    activeTeamId: activeTeamId || (mode === 'GLOBAL_READ_ONLY' ? 'GLOBAL_READ_ONLY' : null)
  }
}

function readScopedCacheIndex() {
  const index = readStorage(SCOPED_CACHE_INDEX_KEY, [])
  return Array.isArray(index) ? index.filter((key) => typeof key === 'string') : []
}

function writeScopedCacheIndex(index) {
  if (index.length > 0) uni.setStorageSync(SCOPED_CACHE_INDEX_KEY, [...new Set(index)])
  else uni.removeStorageSync(SCOPED_CACHE_INDEX_KEY)
}

export function setScopedCache(namespace, identity, value) {
  if (!identity?.userId || identity.activeTeamId == null) return false
  const key = createScopedCacheKey(namespace, identity)
  uni.setStorageSync(key, value)
  writeScopedCacheIndex([...readScopedCacheIndex(), key])
  return true
}

export function getScopedCache(namespace, identity, fallback = null) {
  if (!identity?.userId || identity.activeTeamId == null) return fallback
  return readStorage(createScopedCacheKey(namespace, identity), fallback)
}

export function clearScopedCaches(identity) {
  const index = readScopedCacheIndex()
  const keysToRemove = identity
    ? index.filter((key) => belongsToScopedIdentity(key, identity))
    : index
  keysToRemove.forEach((key) => uni.removeStorageSync(key))
  writeScopedCacheIndex(index.filter((key) => !keysToRemove.includes(key)))
}
