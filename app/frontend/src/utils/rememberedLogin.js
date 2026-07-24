const REMEMBERED_LOGIN_STORAGE_KEY = 'horselink:remembered-login:v1'

function resolveStorage(storage) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function normalizeRememberedLogin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const username = String(value.username || '').trim()
  const teamId = String(value.teamId || '').trim()
  if (!username || !teamId) return null
  return { username, teamId }
}

function readRememberedLoginState(storage) {
  const target = resolveStorage(storage)
  if (!target) return { remembered: null, storageAvailable: false }
  let serialized
  try {
    serialized = target.getItem(REMEMBERED_LOGIN_STORAGE_KEY)
  } catch {
    try {
      target.removeItem(REMEMBERED_LOGIN_STORAGE_KEY)
    } catch {
      // Storage can be blocked by browser privacy settings.
    }
    return { remembered: null, storageAvailable: false }
  }
  try {
    return {
      remembered: normalizeRememberedLogin(JSON.parse(serialized || 'null')),
      storageAvailable: true
    }
  } catch {
    try {
      target.removeItem(REMEMBERED_LOGIN_STORAGE_KEY)
    } catch {
      // Storage can be blocked by browser privacy settings.
    }
    return { remembered: null, storageAvailable: true }
  }
}

export function readRememberedLogin(storage) {
  return readRememberedLoginState(storage).remembered
}

export function writeRememberedLogin(value, storage) {
  const target = resolveStorage(storage)
  const normalized = normalizeRememberedLogin(value)
  if (!target || !normalized) return false
  try {
    target.setItem(REMEMBERED_LOGIN_STORAGE_KEY, JSON.stringify(normalized))
    return true
  } catch {
    return false
  }
}

export function clearRememberedLogin(storage) {
  const target = resolveStorage(storage)
  if (!target) return false
  try {
    target.removeItem(REMEMBERED_LOGIN_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

function credentialsRuntime() {
  try {
    if (typeof navigator === 'undefined' || !navigator.credentials) return null
    return navigator.credentials
  } catch {
    return null
  }
}

function credentialRuntime() {
  try {
    if (typeof window === 'undefined') return null
    if (typeof window.PasswordCredential !== 'function') return null
    const credentials = credentialsRuntime()
    if (!credentials) return null
    return { PasswordCredential: window.PasswordCredential, credentials }
  } catch {
    return null
  }
}

export async function readPasswordCredential(expectedUsername = '') {
  const runtime = credentialRuntime()
  if (!runtime?.credentials?.get) return null
  try {
    const credential = await runtime.credentials.get({ password: true, mediation: 'optional' })
    if (!credential || typeof credential.id !== 'string' || typeof credential.password !== 'string') {
      return null
    }
    if (expectedUsername && credential.id !== expectedUsername) return null
    return { username: credential.id, password: credential.password }
  } catch {
    return null
  }
}

export async function storePasswordCredential({ username, password }) {
  const runtime = credentialRuntime()
  if (!runtime?.credentials?.store || !username || !password) return false
  try {
    const credential = new runtime.PasswordCredential({
      id: username,
      name: username,
      password
    })
    await runtime.credentials.store(credential)
    return true
  } catch {
    return false
  }
}

export async function preventSilentCredentialAccess() {
  const credentials = credentialsRuntime()
  if (typeof credentials?.preventSilentAccess !== 'function') return false
  try {
    await credentials.preventSilentAccess()
    return true
  } catch {
    return false
  }
}

export async function forgetRememberedLogin(storage) {
  const metadataCleared = clearRememberedLogin(storage)
  const silentAccessPrevented = await preventSilentCredentialAccess()
  return {
    remembered: false,
    metadataCleared,
    silentAccessPrevented,
    reason: metadataCleared ? null : 'METADATA_UNAVAILABLE'
  }
}

export async function rememberLoginPassword({ username, teamId, password }, storage) {
  const remembered = normalizeRememberedLogin({ username, teamId })
  if (!remembered || typeof password !== 'string' || !password) {
    await forgetRememberedLogin(storage)
    return { remembered: false, reason: 'INVALID_INPUT' }
  }

  if (!(await storePasswordCredential({ username: remembered.username, password }))) {
    const cleanup = await forgetRememberedLogin(storage)
    return { ...cleanup, reason: 'CREDENTIAL_UNAVAILABLE' }
  }
  if (!writeRememberedLogin(remembered, storage)) {
    const cleanup = await forgetRememberedLogin(storage)
    return { ...cleanup, reason: 'METADATA_UNAVAILABLE' }
  }
  return { remembered: true, reason: null }
}

export async function synchronizeRememberedPassword({ username, password }, storage) {
  const normalizedUsername = String(username || '').trim()
  const rememberedState = readRememberedLoginState(storage)
  if (!rememberedState.storageAvailable) {
    const cleanup = await forgetRememberedLogin(storage)
    return {
      attempted: true,
      updated: false,
      forgotten: cleanup.metadataCleared,
      metadataCleared: cleanup.metadataCleared,
      silentAccessPrevented: cleanup.silentAccessPrevented,
      reason: 'METADATA_UNAVAILABLE'
    }
  }
  const remembered = rememberedState.remembered
  if (
    !remembered ||
    remembered.username.toLocaleLowerCase('en-US') !== normalizedUsername.toLocaleLowerCase('en-US')
  ) {
    return { attempted: false, updated: false, forgotten: false }
  }
  if (await storePasswordCredential({ username: remembered.username, password })) {
    return { attempted: true, updated: true, forgotten: false }
  }
  const cleanup = await forgetRememberedLogin(storage)
  return {
    attempted: true,
    updated: false,
    forgotten: cleanup.metadataCleared,
    metadataCleared: cleanup.metadataCleared,
    silentAccessPrevented: cleanup.silentAccessPrevented
  }
}

export { REMEMBERED_LOGIN_STORAGE_KEY }
