const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i
const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/

export const ROUTINE_TYPES = Object.freeze({
  INSPECTION: 'INSPECTION',
  MAINTENANCE: 'MAINTENANCE'
})

export const ROUTINE_RESULT_OPTIONS = Object.freeze({
  INSPECTION: Object.freeze([
    { value: 'NORMAL', label: '正常' },
    { value: 'ABNORMAL', label: '异常' },
    { value: 'SKIPPED', label: '不适用' }
  ]),
  MAINTENANCE: Object.freeze([
    { value: 'COMPLETED', label: '已完成' },
    { value: 'ABNORMAL', label: '异常' },
    { value: 'SKIPPED', label: '不适用' }
  ])
})

const DUE_STATE_LABELS = Object.freeze({
  DUE: '待执行',
  UPCOMING: '未到期',
  OVERDUE: '已逾期',
  ON_DEMAND: '按需执行',
  WAITING_FOR_READING: '待录入运行小时'
})

function requiredObjectId(value, field) {
  const normalized = String(value || '').trim()
  if (!OBJECT_ID_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid`)
  return normalized.toLowerCase()
}

function normalizedPhotoIds(value) {
  const ids = Array.isArray(value) ? value.map((item) => requiredObjectId(item, 'photoFileId')) : []
  if (ids.length > 10 || new Set(ids).size !== ids.length) {
    throw new TypeError('Photo file ids are invalid')
  }
  return ids
}

export function parseEquipmentQrPayload(rawValue) {
  let payload
  try {
    payload = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue
  } catch {
    throw new TypeError('无法识别设备二维码')
  }
  if (
    !payload ||
    payload.v !== 1 ||
    payload.type !== 'EQUIPMENT_ASSET' ||
    typeof payload.token !== 'string' ||
    !QR_TOKEN_PATTERN.test(payload.token) ||
    Object.keys(payload).some((key) => !['v', 'type', 'token'].includes(key))
  ) {
    throw new TypeError('无法识别设备二维码')
  }
  return { token: payload.token }
}

export function routineTypeLabel(value) {
  return value === ROUTINE_TYPES.MAINTENANCE ? '保养' : '点检'
}

export function dueStateLabel(value) {
  return DUE_STATE_LABELS[value] || value || '-'
}

export function dueStateTone(value) {
  if (value === 'OVERDUE') return 'danger'
  if (value === 'DUE') return 'warning'
  if (value === 'UPCOMING') return 'success'
  return 'info'
}

export function scheduleDescription(schedule = {}) {
  const mode = schedule.mode
  const calendar = schedule.calendar || {}
  const runtime = schedule.runtime || {}
  const unitLabel = { DAY: '天', WEEK: '周', MONTH: '月' }[calendar.unit]
  const parts = []
  if (['CALENDAR', 'COMBINED'].includes(mode) && unitLabel) {
    parts.push(`每 ${Number(calendar.interval) || 1} ${unitLabel}`)
  }
  if (['RUNTIME_HOURS', 'COMBINED'].includes(mode) && Number(runtime.intervalHours) > 0) {
    parts.push(`每运行 ${Number(runtime.intervalHours)} 小时`)
  }
  if (mode === 'MANUAL' || parts.length === 0) return '按需执行'
  if (parts.length === 1) return parts[0]
  return `${parts.join('；')}（${schedule.duePolicy === 'ALL' ? '全部达到' : '任一先到'}）`
}

export function normalizeRoutineSchedules(response = {}) {
  const values = response.schedules || response.rules || response.plans || []
  if (!Array.isArray(values)) return []
  return values.map((entry) => {
    const rule = entry.rule || entry.template || entry
    return {
      ...entry,
      rule,
      ruleId: rule?._id || entry.ruleId || '',
      routineType: rule?.routineType || entry.routineType,
      dueState: entry.status || entry.dueState || 'UPCOMING',
      lastRecord: entry.latestRecord || entry.lastRecord || null
    }
  }).filter((entry) => entry.ruleId)
}

export function resultOptionsFor(routineType, item = null) {
  const values = ROUTINE_RESULT_OPTIONS[routineType] || ROUTINE_RESULT_OPTIONS.INSPECTION
  return item?.required === false
    ? values
    : values.filter(({ value }) => value !== 'SKIPPED')
}

export function buildRoutineRecordPayload({
  rule,
  results,
  abnormalSummary = '',
  runtimeHours = null,
  photoFileIds = [],
  idempotencyKey = ''
}) {
  const ruleId = requiredObjectId(rule?._id, 'ruleId')
  const routineType = rule?.routineType
  if (!Object.values(ROUTINE_TYPES).includes(routineType)) {
    throw new TypeError('Routine type is invalid')
  }
  const items = Array.isArray(rule.checklistItems) ? rule.checklistItems : []
  if (items.length === 0) throw new TypeError('规则没有可执行项目')
  const resultMap = results && typeof results === 'object' ? results : {}
  const allowed = new Set((ROUTINE_RESULT_OPTIONS[routineType] || []).map(({ value }) => value))
  const photos = normalizedPhotoIds(photoFileIds)
  const normalizedAbnormalSummary = String(abnormalSummary || '').trim()
  let hasAbnormal = false

  const itemResults = items.map((item) => {
    const itemKey = String(item.key || '').trim()
    if (!itemKey) throw new TypeError('检查项标识缺失')
    const source = resultMap[itemKey] || {}
    if (!allowed.has(source.result)) throw new TypeError(`请完成“${item.name}”`)
    if (item.required !== false && source.result === 'SKIPPED') {
      throw new TypeError(`“${item.name}”为必填项目`)
    }
    const itemNote = String(source.note || '').trim()
    if (source.result === 'ABNORMAL') {
      hasAbnormal = true
      if (rule.abnormalNoteRequired !== false && !itemNote && !normalizedAbnormalSummary) {
        throw new TypeError(`请填写“${item.name}”的异常说明`)
      }
    }
    return {
      itemKey,
      result: source.result,
      note: itemNote
    }
  })

  if (rule.photoPolicy === 'ALWAYS' && photos.length === 0) {
    throw new TypeError('请上传现场照片')
  }
  if (rule.photoPolicy === 'ON_ABNORMAL' && hasAbnormal && photos.length === 0) {
    throw new TypeError('异常项目必须上传现场照片')
  }

  const payload = {
    ruleId,
    itemResults,
    abnormalSummary: normalizedAbnormalSummary,
    photoFileIds: photos
  }
  const runtimeRequired = ['RUNTIME_HOURS', 'COMBINED'].includes(rule.schedule?.mode)
  if (
    runtimeRequired &&
    (runtimeHours === '' || runtimeHours === null || runtimeHours === undefined)
  ) {
    throw new TypeError('请填写本次累计运行小时')
  }
  if (runtimeHours !== '' && runtimeHours !== null && runtimeHours !== undefined) {
    const hours = Number(runtimeHours)
    if (!Number.isFinite(hours) || hours < 0) throw new TypeError('运行小时必须是非负数字')
    payload.runtimeHours = hours
  }
  if (idempotencyKey) payload.idempotencyKey = String(idempotencyKey).slice(0, 128)
  return payload
}

export function buildRuntimeReadingPayload({ hours, reason = '' }) {
  if (hours === '' || hours === null || hours === undefined) {
    throw new TypeError('请填写累计运行小时')
  }
  const normalizedHours = Number(hours)
  if (!Number.isFinite(normalizedHours) || normalizedHours < 0) {
    throw new TypeError('运行小时必须是非负数字')
  }
  return {
    hours: normalizedHours,
    reason: String(reason || '').trim()
  }
}

export function teamQuery(teamId) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
}
