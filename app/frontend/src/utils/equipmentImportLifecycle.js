const STORAGE_KEY_PREFIX = 'equipmentImportPreviewJobId'

function normalizeContextKey(value) {
  return String(value || '').trim()
}

export function equipmentImportPreviewStorageKey(contextKey) {
  const normalized = normalizeContextKey(contextKey)
  return normalized ? `${STORAGE_KEY_PREFIX}:${encodeURIComponent(normalized)}` : ''
}

export function createEquipmentImportLifecycleGate(initialContextKey = '') {
  let contextKey = normalizeContextKey(initialContextKey)
  let revision = 0
  const requestIds = new Map()

  return {
    get contextKey() {
      return contextKey
    },

    begin(kind) {
      const normalizedKind = String(kind || '').trim()
      if (!normalizedKind) throw new TypeError('Equipment import request kind is required')
      const requestId = (requestIds.get(normalizedKind) || 0) + 1
      requestIds.set(normalizedKind, requestId)
      return Object.freeze({
        kind: normalizedKind,
        requestId,
        revision,
        contextKey
      })
    },

    isCurrent(ticket) {
      return Boolean(
        ticket &&
        ticket.revision === revision &&
        ticket.contextKey === contextKey &&
        requestIds.get(ticket.kind) === ticket.requestId
      )
    },

    invalidate(nextContextKey = contextKey) {
      contextKey = normalizeContextKey(nextContextKey)
      revision += 1
      requestIds.clear()
      return revision
    }
  }
}

export function createEquipmentImportAbortManager() {
  let activeController = null

  return {
    begin() {
      activeController?.abort()
      activeController = new AbortController()
      return activeController
    },

    abort() {
      if (!activeController) return false
      activeController.abort()
      activeController = null
      return true
    },

    clear(controller) {
      if (activeController !== controller) return false
      activeController = null
      return true
    }
  }
}

export const LEGACY_EQUIPMENT_IMPORT_STORAGE_KEY = STORAGE_KEY_PREFIX
