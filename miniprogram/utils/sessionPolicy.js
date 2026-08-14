export const SESSION_MODES = Object.freeze({
  TEAM_SELECTION: 'TEAM_SELECTION',
  TEAM: 'TEAM',
  GLOBAL_READ_ONLY: 'GLOBAL_READ_ONLY'
})

const SESSION_MODE_VALUES = new Set(Object.values(SESSION_MODES))

export function normalizeSessionMode(mode) {
  return SESSION_MODE_VALUES.has(mode) ? mode : null
}

export function normalizePermissionKeys(permissionKeys) {
  if (!Array.isArray(permissionKeys)) return []
  return [...new Set(permissionKeys.filter((key) => typeof key === 'string' && key))]
}

export function normalizeModuleDataScopes(moduleDataScopes) {
  if (Array.isArray(moduleDataScopes)) {
    return Object.fromEntries(
      moduleDataScopes
        .filter((item) => item?.moduleKey && item?.scope)
        .map((item) => [item.moduleKey, item.scope])
    )
  }

  if (!moduleDataScopes || typeof moduleDataScopes !== 'object') return {}
  return { ...moduleDataScopes }
}

export function createEmptyContext(mode = null, activeTeamId = null) {
  const normalizedMode = normalizeSessionMode(mode)
  const canAccessBusiness = [
    SESSION_MODES.TEAM,
    SESSION_MODES.GLOBAL_READ_ONLY
  ].includes(normalizedMode)

  return {
    mode: normalizedMode,
    activeTeamId: activeTeamId || null,
    isSuperAdmin: false,
    team: null,
    membership: null,
    orgUnit: null,
    permissionKeys: [],
    moduleDataScopes: {},
    readOnly: normalizedMode !== SESSION_MODES.TEAM,
    canAccessBusiness
  }
}

export function normalizeSessionContext(context = {}, fallback = {}) {
  const mode = normalizeSessionMode(context.mode ?? fallback.mode)
  const activeTeamId = context.activeTeamId ?? fallback.activeTeamId ?? null
  const canAccessBusiness = [
    SESSION_MODES.TEAM,
    SESSION_MODES.GLOBAL_READ_ONLY
  ].includes(mode)

  return {
    ...createEmptyContext(mode, activeTeamId),
    ...context,
    mode,
    activeTeamId,
    isSuperAdmin: context.isSuperAdmin === true,
    permissionKeys: normalizePermissionKeys(context.permissionKeys),
    moduleDataScopes: normalizeModuleDataScopes(context.moduleDataScopes),
    readOnly: context.readOnly ?? mode !== SESSION_MODES.TEAM,
    canAccessBusiness: context.canAccessBusiness ?? canAccessBusiness
  }
}

export function hasPermission(permissionKeys, permission, match = 'all') {
  const requested = (Array.isArray(permission) ? permission : [permission]).filter(Boolean)
  if (requested.length === 0) return true

  const available = new Set(normalizePermissionKeys(permissionKeys))
  const predicate = (key) => available.has(key)
  return match === 'any' ? requested.some(predicate) : requested.every(predicate)
}

export function canUsePermission(context, permission, options = {}) {
  const normalized = normalizeSessionContext(context)
  if (options.teamRequired && normalized.mode !== SESSION_MODES.TEAM) return false
  if (options.write && normalized.readOnly) return false
  if (!normalized.canAccessBusiness && options.business !== false) return false
  // Team-scoped super administrators have permanent access to every
  // configured feature; GLOBAL_READ_ONLY remains read-only and uses its
  // server-provided read catalog.
  if (normalized.isSuperAdmin && normalized.mode === SESSION_MODES.TEAM) return true
  return hasPermission(normalized.permissionKeys, permission, options.match)
}

export function getSessionEntryRoute(mode) {
  return normalizeSessionMode(mode) === SESSION_MODES.TEAM_SELECTION
    ? '/pages/team/select'
    : '/pages/task/received'
}
