import { equipmentBusinessMonthRange } from './equipment.js'

const ROUTINE_TYPES = new Set(['INSPECTION', 'MAINTENANCE'])
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const RECORD_CACHE_TTL_MS = 5 * 60 * 1000
const RECORD_CACHE_LIMIT = 20
const recordCache = new Map()

function normalizedDateKey(value, fieldLabel) {
  const source = String(value || '').trim()
  const match = DATE_KEY_PATTERN.exec(source)
  if (!match) throw new TypeError(`${fieldLabel}格式不正确`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TypeError(`${fieldLabel}不是有效日期`)
  }
  return source
}

export function defaultRoutineRecordDateFilters(now = new Date()) {
  const range = equipmentBusinessMonthRange(now)
  return {
    startDate: range.from.slice(0, 10),
    endDate: range.to.slice(0, 10)
  }
}

export function routineRecordDateRange(startDate, endDate) {
  const start = normalizedDateKey(startDate, '开始日期')
  const end = normalizedDateKey(endDate, '结束日期')
  if (start > end) throw new TypeError('开始日期不能晚于结束日期')
  return {
    from: `${start}T00:00:00+08:00`,
    to: `${end}T23:59:59.999+08:00`
  }
}

export function normalizedRoutineType(value) {
  const normalized = String(value || '').trim().toUpperCase()
  return ROUTINE_TYPES.has(normalized) ? normalized : ''
}

export function routineRecordRule(record) {
  return record?.rule || record?.ruleSnapshot || record?.routineRule || {}
}

export function routineRecordRuleName(record) {
  return routineRecordRule(record).name || record?.ruleName || '-'
}

export function routineRecordItemName(record, item, index = 0) {
  const configured = routineRecordRule(record).checklistItems?.find((entry) => (
    entry?.key === item?.itemKey
  ))
  return configured?.name || `项目 ${Number(index) + 1}`
}

export function routineRecordItemRows(record) {
  const configuredItems = (Array.isArray(routineRecordRule(record).checklistItems)
    ? routineRecordRule(record).checklistItems
    : [])
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      Number(left.item?.sortOrder ?? left.index) - Number(right.item?.sortOrder ?? right.index)
    ))
    .map(({ item }) => item)
  const resultItems = Array.isArray(record?.itemResults) ? record.itemResults : []
  const resultByKey = new Map(resultItems.map((item) => [item?.itemKey, item]))
  const rows = configuredItems.map((configured) => ({
    ...(resultByKey.get(configured?.key) || {
      itemKey: configured?.key || '',
      result: 'UNRECORDED',
      note: ''
    }),
    itemName: configured?.name || '',
    itemDescription: configured?.description || ''
  }))
  const configuredKeys = new Set(configuredItems.map((item) => item?.key))
  for (const item of resultItems) {
    if (!configuredKeys.has(item?.itemKey)) rows.push({ ...item, itemName: '', itemDescription: '' })
  }
  return rows
}

export function routineRecordPlanStart(record) {
  return record?.planScheduledFor || record?.plan?.scheduledFor || record?.scheduledFor || null
}

export function routineRecordPlanDue(record) {
  return record?.planDueAt || record?.plan?.dueAt || null
}

export function routineRecordEquipment(record) {
  return record?.equipment || record?.equipmentSnapshot || {}
}

export function routineRecordPlateNumber(record) {
  const equipment = routineRecordEquipment(record)
  return equipment.plateNumber || record?.plateNumber || '-'
}

export function routineRecordOperatorName(record) {
  const operator = record?.executor || record?.operator || record?.performedByUser || record?.performedBy
  if (operator && typeof operator === 'object') {
    return operator.name || operator.displayName || operator.username || '-'
  }
  return record?.performedByName || record?.operatorName || '-'
}

export function routineRecordAbnormalCount(record) {
  return (Array.isArray(record?.itemResults) ? record.itemResults : [])
    .filter((item) => item?.result === 'ABNORMAL')
    .length
}

export function routineRecordPhotos(record) {
  const evidence = Array.isArray(record?.photoEvidence) ? record.photoEvidence : []
  const byId = new Map()
  for (const item of evidence) {
    const fileId = String(item?.fileId || '').trim()
    if (fileId && !byId.has(fileId)) byId.set(fileId, { ...item, fileId })
  }
  for (const value of Array.isArray(record?.photoFileIds) ? record.photoFileIds : []) {
    const fileId = String(value || '').trim()
    if (fileId && !byId.has(fileId)) byId.set(fileId, { fileId })
  }
  return [...byId.values()]
}

function normalizedCacheIdentity(cacheIdentity) {
  if (cacheIdentity && typeof cacheIdentity === 'object') {
    const userId = String(cacheIdentity.userId || '').trim()
    const activeTeamId = String(cacheIdentity.activeTeamId || '').trim()
    return userId && activeTeamId ? JSON.stringify([userId, activeTeamId]) : ''
  }
  return String(cacheIdentity || '').trim()
}

function cacheKey(recordId, teamId, cacheIdentity) {
  const normalizedRecordId = String(recordId || '').trim()
  const normalizedTeamId = String(teamId || '').trim()
  const identity = normalizedCacheIdentity(cacheIdentity)
  if (!normalizedRecordId || !normalizedTeamId || !identity) return ''
  return JSON.stringify([identity, normalizedTeamId, normalizedRecordId])
}

export function cacheRoutineRecord(record, { teamId = '', cacheIdentity = '', now = Date.now() } = {}) {
  const recordId = String(record?._id || '').trim()
  const key = cacheKey(recordId, teamId, cacheIdentity)
  if (!key) return
  recordCache.set(key, {
    record,
    expiresAt: Number(now) + RECORD_CACHE_TTL_MS
  })
  while (recordCache.size > RECORD_CACHE_LIMIT) {
    recordCache.delete(recordCache.keys().next().value)
  }
}

export function readCachedRoutineRecord(recordId, { teamId = '', cacheIdentity = '', now = Date.now() } = {}) {
  const key = cacheKey(recordId, teamId, cacheIdentity)
  if (!key) return null
  const cached = recordCache.get(key)
  if (!cached) return null
  if (cached.expiresAt < Number(now)) {
    recordCache.delete(key)
    return null
  }
  return cached.record
}
