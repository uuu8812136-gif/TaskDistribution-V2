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

export function createRequestContextTracker(readToken, initialEpoch = 0) {
  if (typeof readToken !== 'function') throw new TypeError('readToken must be a function')

  let epoch = initialEpoch
  return {
    capture(contextScoped = true) {
      return { epoch, token: readToken() || '', contextScoped }
    },
    getEpoch() {
      return epoch
    },
    advance() {
      epoch += 1
      return epoch
    },
    assertCurrent(snapshot) {
      if (snapshot?.contextScoped === false) return
      if (!snapshot || snapshot.epoch !== epoch || snapshot.token !== (readToken() || '')) {
        throw new StaleContextResponseError()
      }
    }
  }
}

function encodeKeyPart(value) {
  return encodeURIComponent(String(value))
}

export function createScopedCacheKey(namespace, identity) {
  const userId = identity?.userId
  const activeTeamId = identity?.activeTeamId
  if (!namespace || !userId || activeTeamId === undefined || activeTeamId === null) {
    throw new TypeError('Scoped cache keys require namespace, userId and activeTeamId')
  }
  return `v2:business:${encodeKeyPart(userId)}:${encodeKeyPart(activeTeamId)}:${encodeKeyPart(namespace)}`
}

export function belongsToScopedIdentity(key, identity) {
  if (typeof key !== 'string' || !identity?.userId || identity.activeTeamId == null) return false
  const prefix = `v2:business:${encodeKeyPart(identity.userId)}:${encodeKeyPart(identity.activeTeamId)}:`
  return key.startsWith(prefix)
}
