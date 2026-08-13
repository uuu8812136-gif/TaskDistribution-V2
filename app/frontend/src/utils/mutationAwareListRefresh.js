import { getSuccessfulMutationRevision } from './successfulMutationRevision.js'

function normalizeRevision(value) {
  const revision = Number(value)
  return Number.isInteger(revision) && revision >= 0 ? revision : 0
}

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : [scopes]
  return [...new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean))]
}

export function createMutationAwareListRefreshTracker({
  scopes,
  readRevision = getSuccessfulMutationRevision
} = {}) {
  if (typeof readRevision !== 'function') {
    throw new TypeError('readRevision must be a function')
  }
  const subscribedScopes = normalizeScopes(scopes)
  if (!subscribedScopes.length) {
    throw new TypeError('at least one mutation scope must be subscribed')
  }

  let handledRevision = normalizeRevision(readRevision(subscribedScopes))
  let refreshPromise = null

  const currentRevision = () => normalizeRevision(readRevision(subscribedScopes))

  const markThrough = (revision = currentRevision()) => {
    handledRevision = Math.max(handledRevision, normalizeRevision(revision))
    return handledRevision
  }

  const refreshIfNeeded = (refresh) => {
    if (typeof refresh !== 'function') {
      return Promise.reject(new TypeError('refresh must be a function'))
    }
    if (refreshPromise) return refreshPromise

    const targetRevision = currentRevision()
    if (targetRevision <= handledRevision) return Promise.resolve(false)

    refreshPromise = Promise.resolve()
      .then(refresh)
      .then((result) => {
        if (result !== true) return false
        markThrough(targetRevision)
        return true
      })
      .finally(() => {
        refreshPromise = null
      })
    return refreshPromise
  }

  return {
    currentRevision,
    handledRevision: () => handledRevision,
    markThrough,
    refreshIfNeeded,
    scopes: () => [...subscribedScopes],
    shouldRefresh: () => currentRevision() > handledRevision
  }
}
