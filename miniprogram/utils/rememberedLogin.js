const REMEMBERED_LOGIN_KEY = 'v2:remembered-login'

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

export function normalizeRememberedLogin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const teamId = cleanText(value.teamId, 100)
  const username = cleanText(value.username, 50)
  const password = typeof value.password === 'string' ? value.password.slice(0, 128) : ''
  if (!teamId || !username || !password) return null
  return { teamId, username, password }
}

export function readRememberedLogin() {
  try {
    return normalizeRememberedLogin(uni.getStorageSync(REMEMBERED_LOGIN_KEY))
  } catch {
    return null
  }
}

export function writeRememberedLogin(value) {
  const normalized = normalizeRememberedLogin(value)
  if (!normalized) {
    clearRememberedLogin()
    return false
  }
  try {
    uni.setStorageSync(REMEMBERED_LOGIN_KEY, normalized)
    return true
  } catch {
    return false
  }
}

export function clearRememberedLogin() {
  try {
    uni.removeStorageSync(REMEMBERED_LOGIN_KEY)
  } catch {
    // Storage can be unavailable during teardown; the next write will retry.
  }
}

export { REMEMBERED_LOGIN_KEY }
