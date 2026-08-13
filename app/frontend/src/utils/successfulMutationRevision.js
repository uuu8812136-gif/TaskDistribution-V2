export const SUCCESSFUL_MUTATION_SCOPES = Object.freeze({
  GLOBAL: 'global',
  CONTRACT_SUPPLIERS: 'contract-suppliers',
  CONTRACT_EXPIRY_ALERTS: 'contract-expiry-alerts',
  CONTRACT_SETTLEMENTS: 'contract-settlements',
  EQUIPMENT: 'equipment',
  EQUIPMENT_CATEGORIES: 'equipment-categories',
  EQUIPMENT_RULES: 'equipment-rules',
  EQUIPMENT_ROUTINES: 'equipment-routines',
  EQUIPMENT_INVENTORIES: 'equipment-inventories',
  EQUIPMENT_REPAIRS: 'equipment-repairs',
  EQUIPMENT_STATUS_APPLICATIONS: 'equipment-status-applications',
  TASKS: 'tasks',
  EXTENSIONS: 'extensions',
  TRANSPORT_RECORDS: 'transport-records',
  ATTENDANCE_REPORTS: 'attendance-reports',
  PRODUCTION_SCHEDULES: 'production-schedules',
  GENERATED_DAILY_REPORTS: 'generated-daily-reports',
  TEAM_MEMBERS: 'team-members',
  ORGANIZATION: 'organization',
  TEAMS: 'teams',
  USERS: 'users',
  MESSAGES: 'messages'
})

const S = SUCCESSFUL_MUTATION_SCOPES
let successfulMutationSequence = 0
const revisionsByScope = new Map()

function normalizeMethod(method) {
  return String(method || 'get').trim().toLowerCase()
}

function normalizeRequestPath(url) {
  const rawUrl = String(url || '').trim()
  if (!rawUrl) return ''
  try {
    return new URL(rawUrl, 'http://localhost').pathname.replace(/^\/api(?=\/)/, '')
  } catch {
    return rawUrl.split(/[?#]/, 1)[0].replace(/^\/api(?=\/)/, '')
  }
}

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes) ? scopes : [scopes]
  return [...new Set(values.map((scope) => String(scope || '').trim()).filter(Boolean))]
}

const NO_INVALIDATION_PATHS = [
  /^\/auth(?:\/|$)/,
  /^\/files(?:\/|$)/,
  /^\/equipment\/[^/]+\/qrcode\/?$/,
  /^\/equipment\/imports\/?$/,
  /^\/equipment\/imports\/[^/]+\/cancel\/?$/,
  /\/(?:download|export)\/?$/
]

const EQUIPMENT_ENTITY_SCOPES = [S.EQUIPMENT]
const CONTRACT_SOURCE_SCOPES = [
  S.CONTRACT_SUPPLIERS,
  S.CONTRACT_EXPIRY_ALERTS,
  S.CONTRACT_SETTLEMENTS
]

const SCOPE_RULES = [
  [/^\/contracts\/settlements(?:\/|$)/, [S.CONTRACT_SETTLEMENTS]],
  [/^\/contracts\/(?:suppliers|records)(?:\/|$)/, CONTRACT_SOURCE_SCOPES],
  [/^\/equipment\/status-applications\/[^/]+\/actions\/?$/, [
    S.EQUIPMENT_STATUS_APPLICATIONS,
    S.EQUIPMENT,
    S.EQUIPMENT_ROUTINES
  ]],
  [/^\/equipment\/status-applications(?:\/|$)/, [S.EQUIPMENT_STATUS_APPLICATIONS]],
  [/^\/equipment\/repairs(?:\/|$)/, [S.EQUIPMENT_REPAIRS]],
  [/^\/equipment\/inventories(?:\/|$)/, [S.EQUIPMENT_INVENTORIES]],
  [/^\/equipment\/routine-rules(?:\/|$)/, [S.EQUIPMENT_RULES, S.EQUIPMENT_ROUTINES]],
  [/^\/equipment\/(?:routine-plans|routine-exceptions|routine-worker|routine-records)(?:\/|$)/, [S.EQUIPMENT_ROUTINES]],
  [/^\/equipment\/[^/]+\/(?:routine-records|runtime-readings)(?:\/|$)/, [S.EQUIPMENT_ROUTINES]],
  [/^\/equipment\/categories(?:\/|$)/, [S.EQUIPMENT_CATEGORIES, S.EQUIPMENT_RULES]],
  [/^\/equipment\/imports\/[^/]+\/confirm\/?$/, EQUIPMENT_ENTITY_SCOPES],
  [/^\/equipment(?:\/[^/]+)?\/?$/, EQUIPMENT_ENTITY_SCOPES],
  [/^\/tasks(?:\/|$)/, [S.TASKS]],
  [/^\/extensions(?:\/|$)/, [S.EXTENSIONS, S.TASKS]],
  [/^\/transport-records(?:\/|$)/, [S.TRANSPORT_RECORDS]],
  [/^\/attendance-submissions(?:\/|$)/, [S.ATTENDANCE_REPORTS]],
  [/^\/production-schedules(?:\/|$)/, [S.PRODUCTION_SCHEDULES]],
  [/^\/generated-daily-reports(?:\/|$)/, [S.GENERATED_DAILY_REPORTS]],
  [/^\/team-members(?:\/|$)/, [S.TEAM_MEMBERS]],
  [/^\/org-units(?:\/|$)/, [S.ORGANIZATION]],
  [/^\/teams(?:\/|$)/, [S.TEAMS]],
  [/^\/users(?:\/|$)/, [S.USERS]],
  [/^\/messages(?:\/|$)/, [S.MESSAGES]]
]

function explicitScopes(config) {
  const override = config.trackSuccessfulMutation
  if (override === false) return []
  if (typeof override === 'string' || Array.isArray(override)) {
    return normalizeScopes(override)
  }
  if (override === true) {
    const configured = normalizeScopes(config.successfulMutationScopes)
    return configured.length ? configured : null
  }
  return null
}

export function resolveSuccessfulMutationScopes(configOrMethod, requestUrl = '') {
  const config = configOrMethod && typeof configOrMethod === 'object'
    ? configOrMethod
    : { method: configOrMethod, url: requestUrl }
  const method = normalizeMethod(config.method)
  if (method === 'get' || method === 'head' || method === 'options') return []

  const overridden = explicitScopes(config)
  if (overridden) return overridden
  if (config.trackSuccessfulMutation === false) return []

  const path = normalizeRequestPath(config.url)
  if (!path) return config.trackSuccessfulMutation === true ? [S.GLOBAL] : []
  if (NO_INVALIDATION_PATHS.some((pattern) => pattern.test(path))) {
    return config.trackSuccessfulMutation === true ? [S.GLOBAL] : []
  }

  const matched = SCOPE_RULES.find(([pattern]) => pattern.test(path))
  if (matched) return [...matched[1]]
  return [S.GLOBAL]
}

export function isBusinessMutationRequest(configOrMethod, requestUrl = '') {
  return resolveSuccessfulMutationScopes(configOrMethod, requestUrl).length > 0
}

export function getSuccessfulMutationRevision(scopes) {
  const subscribedScopes = normalizeScopes(scopes)
  if (!subscribedScopes.length) return 0
  return subscribedScopes.reduce(
    (latest, scope) => Math.max(latest, revisionsByScope.get(scope) || 0),
    0
  )
}

export function recordSuccessfulMutationRequest(configOrMethod, requestUrl = '') {
  const scopes = resolveSuccessfulMutationScopes(configOrMethod, requestUrl)
  if (!scopes.length) return false
  successfulMutationSequence += 1
  for (const scope of scopes) revisionsByScope.set(scope, successfulMutationSequence)
  return true
}
