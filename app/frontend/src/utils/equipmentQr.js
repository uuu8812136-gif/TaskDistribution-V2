import { safeInternalRedirect } from './internalRedirect.js'

export const EQUIPMENT_QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/
export const TEAM_ID_PATTERN = /^[0-9a-f]{24}$/i

export const EQUIPMENT_SCAN_CONTEXT_STATUS = Object.freeze({
  READY: 'READY',
  INVALID_TEAM: 'INVALID_TEAM',
  TEAM_FORBIDDEN: 'TEAM_FORBIDDEN',
  TEAM_REQUIRED: 'TEAM_REQUIRED',
  TEAM_SELECTION_REQUIRED: 'TEAM_SELECTION_REQUIRED'
})

function scalarQueryValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeEquipmentQrToken(value) {
  const source = typeof value === 'string' ? value.trim() : ''
  if (EQUIPMENT_QR_TOKEN_PATTERN.test(source)) return source

  try {
    const parsed = JSON.parse(source)
    const keys = Object.keys(parsed || {}).sort()
    if (
      parsed?.v === 1 &&
      parsed.type === 'EQUIPMENT_ASSET' &&
      typeof parsed.token === 'string' &&
      EQUIPMENT_QR_TOKEN_PATTERN.test(parsed.token) &&
      keys.length === 3 &&
      keys[0] === 'token' && keys[1] === 'type' && keys[2] === 'v'
    ) {
      return parsed.token
    }
  } catch {
    // The backend may return a raw token in a future compatible revision.
  }
  return ''
}

export function normalizeTeamId(value) {
  const source = scalarQueryValue(value)
  return TEAM_ID_PATTERN.test(source) ? source.toLowerCase() : ''
}

export function equipmentScanPath(qrToken, teamId = '') {
  const token = normalizeEquipmentQrToken(qrToken)
  if (!token) throw new TypeError('设备二维码令牌无效')

  const rawTeamId = scalarQueryValue(teamId)
  const normalizedTeamId = normalizeTeamId(rawTeamId)
  if (rawTeamId && !normalizedTeamId) throw new TypeError('项目团队编号无效')

  const path = `/equipment-scan/${encodeURIComponent(token)}`
  return normalizedTeamId ? `${path}?teamId=${encodeURIComponent(normalizedTeamId)}` : path
}

export function equipmentScanTeamIdFromRedirect(redirect) {
  const target = safeInternalRedirect(redirect)
  if (!target) return ''

  const parsed = new URL(target, 'https://internal.horselink.invalid')
  if (!/^\/equipment-scan\/[A-Za-z0-9_-]{43,86}$/.test(parsed.pathname)) return ''
  return normalizeTeamId(parsed.searchParams.get('teamId'))
}

export function resolveEquipmentScanContext({
  mode,
  activeTeamId,
  requestedTeamId,
  accessibleTeamIds = []
} = {}) {
  if (requestedTeamId !== undefined && requestedTeamId !== null && typeof requestedTeamId !== 'string') {
    return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.INVALID_TEAM }
  }
  const rawRequestedTeamId = scalarQueryValue(requestedTeamId)
  const teamId = normalizeTeamId(rawRequestedTeamId)
  if (rawRequestedTeamId && !teamId) {
    return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.INVALID_TEAM }
  }

  const accessible = new Set(
    accessibleTeamIds.map((value) => normalizeTeamId(value)).filter(Boolean)
  )

  if (mode === 'TEAM') {
    const currentTeamId = normalizeTeamId(activeTeamId)
    if (teamId && teamId !== currentTeamId && !accessible.has(teamId)) {
      return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_FORBIDDEN }
    }
    return {
      status: EQUIPMENT_SCAN_CONTEXT_STATUS.READY,
      teamId: teamId || currentTeamId,
      switchTeamId: teamId && teamId !== currentTeamId ? teamId : '',
      requestParams: {}
    }
  }

  if (mode === 'GLOBAL_READ_ONLY') {
    if (!teamId) return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_REQUIRED }
    if (!accessible.has(teamId)) {
      return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_FORBIDDEN }
    }
    return {
      status: EQUIPMENT_SCAN_CONTEXT_STATUS.READY,
      teamId,
      switchTeamId: '',
      requestParams: { teamId }
    }
  }

  if (teamId && !accessible.has(teamId)) {
    return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_FORBIDDEN }
  }
  return { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_SELECTION_REQUIRED }
}
