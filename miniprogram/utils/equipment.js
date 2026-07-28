import { requestErrorMessage } from './requestErrorMessages.js'

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i
const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,86}$/
const QR_PAYLOAD_KEYS = Object.freeze(['token', 'type', 'v'])
const QR_URL_TOKEN_KEYS = Object.freeze(['token', 'qrToken', 'qr_token'])
const OBJECT_ID_FIELD_LABELS = Object.freeze({
  photoFileId: '照片文件编号',
  planId: '执行计划编号',
  ruleId: '点检保养规则编号'
})

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
  if (!OBJECT_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${OBJECT_ID_FIELD_LABELS[field] || '记录编号'}无效`)
  }
  return normalized.toLowerCase()
}

function normalizedPhotoIds(value) {
  const ids = Array.isArray(value) ? value.map((item) => requiredObjectId(item, 'photoFileId')) : []
  if (ids.length > 10 || new Set(ids).size !== ids.length) {
    throw new TypeError('现场照片文件无效、重复或数量超出限制')
  }
  return ids
}

function invalidQrPayload() {
  return new TypeError('无法识别设备二维码')
}

function decodeQrPart(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim()
  } catch {
    throw invalidQrPayload()
  }
}

function tokenFromEquipmentUrl(rawValue) {
  const source = String(rawValue || '').trim()
  if (!/^(?:https?:\/\/|\/)/i.test(source) || source.length > 4096) return ''

  const candidates = []
  const parameterPattern = /[?&#]([^=&#]+)=([^&#]*)/g
  let match
  while ((match = parameterPattern.exec(source)) !== null) {
    const key = decodeQrPart(match[1])
    if (QR_URL_TOKEN_KEYS.includes(key)) candidates.push(decodeQrPart(match[2]))
  }

  const pathPattern = /\/(?:equipment\/(?:qr|scan)|equipment-scan)\/([A-Za-z0-9_-]{43,86})(?:[/?#]|$)/ig
  while ((match = pathPattern.exec(source)) !== null) candidates.push(match[1])

  if (candidates.length === 0 || candidates.some((value) => !QR_TOKEN_PATTERN.test(value))) return ''
  const validTokens = [...new Set(candidates)]
  return validTokens.length === 1 ? validTokens[0] : ''
}

export function parseEquipmentQrPayload(rawValue) {
  if (rawValue && typeof rawValue === 'object') {
    const keys = Object.keys(rawValue).sort()
    if (
      rawValue.v === 1 &&
      rawValue.type === 'EQUIPMENT_ASSET' &&
      typeof rawValue.token === 'string' &&
      QR_TOKEN_PATTERN.test(rawValue.token) &&
      keys.length === QR_PAYLOAD_KEYS.length &&
      keys.every((key, index) => key === QR_PAYLOAD_KEYS[index])
    ) {
      return { token: rawValue.token }
    }
    throw invalidQrPayload()
  }

  const source = String(rawValue || '').trim()
  if (!source || source.length > 4096) throw invalidQrPayload()
  if (QR_TOKEN_PATTERN.test(source)) return { token: source }

  if (source.startsWith('{')) {
    try {
      return parseEquipmentQrPayload(JSON.parse(source))
    } catch (error) {
      if (error instanceof TypeError) throw error
      throw invalidQrPayload()
    }
  }

  const urlToken = tokenFromEquipmentUrl(source)
  if (urlToken) return { token: urlToken }
  throw invalidQrPayload()
}

export function equipmentScanFailureMessage(error) {
  const outcome = classifyEquipmentScanFailure(error)
  return outcome.status === 'cancelled' ? '' : outcome.message
}

export function classifyEquipmentScanFailure(error) {
  const text = String(error?.errMsg || error?.message || error || '').toLowerCase()
  if (text.includes('cancel')) {
    return {
      status: 'cancelled',
      message: '已取消扫码',
      permissionDenied: false
    }
  }
  const permissionDenied = (
    text.includes('auth deny') ||
    text.includes('denied') ||
    text.includes('authorize') ||
    text.includes('permission') ||
    text.includes('camera') ||
    text.includes('相机')
  )
  return {
    status: 'error',
    message: permissionDenied
      ? '无法使用相机，请在微信设置中允许相机权限'
      : '扫码失败，请重试或手动粘贴二维码内容',
    permissionDenied
  }
}

export function equipmentLookupFailureMessage(error) {
  if (Number(error?.statusCode) === 404) return '未找到设备，或该设备不属于当前团队'
  if (Number(error?.statusCode) === 403) return '当前账号无权查看该设备'
  return requestErrorMessage(error, '设备查询失败，请检查网络后重试')
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

const ROUTINE_PLAN_DUE_STATE_MAP = Object.freeze({
  PLANNED: 'UPCOMING',
  IN_WINDOW: 'DUE'
})

export function effectiveRoutineDueState(entry = {}) {
  const raw = entry.planStatus || entry.dueState || entry.status || 'UPCOMING'
  return ROUTINE_PLAN_DUE_STATE_MAP[raw] || raw
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
      dueState: effectiveRoutineDueState(entry),
      lastRecord: entry.latestRecord || entry.lastRecord || null
    }
  }).filter((entry) => entry.ruleId)
}

export function selectExecutableRoutinePlan(plans = []) {
  const candidates = Array.isArray(plans)
    ? plans.filter((plan) => ['OVERDUE', 'IN_WINDOW'].includes(plan?.status))
    : []
  const statusRank = { OVERDUE: 0, IN_WINDOW: 1 }
  const timestamp = (value) => {
    const parsed = Date.parse(value || '')
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
  }
  return [...candidates].sort((left, right) => (
    (statusRank[left.status] - statusRank[right.status]) ||
    (timestamp(left.dueAt) - timestamp(right.dueAt)) ||
    (timestamp(left.scheduledFor) - timestamp(right.scheduledFor)) ||
    String(left._id || '').localeCompare(String(right._id || ''))
  ))[0] || null
}

export function isRoutineScheduleExecutable(entry = {}) {
  if (entry?.rule?.schedule?.mode === 'MANUAL') return true
  if (typeof entry?.executable === 'boolean') return entry.executable
  return Boolean(selectExecutableRoutinePlan(entry?.plans))
}

export function routineExecutionStatusLabel(entry = {}) {
  const status = entry?.executionStatus || ''
  if (status === 'PERIOD_COMPLETED') return '本周期已完成'
  if (status === 'WAITING_FOR_READING') return '待录入运行小时'
  if (status === 'NOT_DUE') return '未到执行周期'
  return isRoutineScheduleExecutable(entry) ? '' : '当前不可执行'
}

export function groupRoutineSchedules(schedules = []) {
  const values = Array.isArray(schedules) ? schedules : normalizeRoutineSchedules(schedules)
  const definitions = [
    { routineType: ROUTINE_TYPES.INSPECTION, label: '点检' },
    { routineType: ROUTINE_TYPES.MAINTENANCE, label: '保养' }
  ]
  const groups = definitions.map((definition) => ({
    ...definition,
    entries: values.filter((entry) => entry.routineType === definition.routineType)
  })).filter(({ entries }) => entries.length > 0)
  const knownTypes = new Set(definitions.map(({ routineType }) => routineType))
  const otherEntries = values.filter((entry) => !knownTypes.has(entry.routineType))
  if (otherEntries.length > 0) {
    groups.push({ routineType: 'OTHER', label: '其他作业', entries: otherEntries })
  }
  return groups
}

export function equipmentBusinessMonthRange(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError('日期格式无效')
  const shanghai = new Date(date.getTime() + (8 * 60 * 60 * 1000))
  const year = shanghai.getUTCFullYear()
  const month = shanghai.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const pad = (value) => String(value).padStart(2, '0')
  return {
    month: `${year}-${pad(month)}`,
    from: `${year}-${pad(month)}-01T00:00:00+08:00`,
    to: `${year}-${pad(month)}-${pad(lastDay)}T23:59:59.999+08:00`
  }
}

export async function loadEquipmentMonthlyActivity(equipmentId, {
  teamId = '',
  fetchRecords,
  fetchRepairs,
  now = new Date()
} = {}) {
  if (typeof fetchRecords !== 'function' || typeof fetchRepairs !== 'function') {
    throw new TypeError('设备活动查询服务配置异常')
  }
  const range = equipmentBusinessMonthRange(now)
  const common = {
    ...(teamId ? { teamId } : {}),
    equipmentId,
    page: 1,
    pageSize: 20
  }
  const [routineResult, repairResult] = await Promise.all([
    fetchRecords({ ...common, from: range.from, to: range.to }),
    fetchRepairs({ ...common, startDate: range.from, endDate: range.to })
  ])
  return {
    month: range.month,
    routineRecords: routineResult?.records || [],
    routineTotal: Number(routineResult?.total) || 0,
    repairs: repairResult?.repairs || [],
    repairTotal: Number(repairResult?.total) || 0
  }
}

export async function lookupEquipmentFromQr(rawValue, {
  teamId = '',
  fetchEquipment,
  fetchSchedule
} = {}) {
  if (typeof fetchEquipment !== 'function' || typeof fetchSchedule !== 'function') {
    throw new TypeError('设备扫码查询服务配置异常')
  }
  const { token } = parseEquipmentQrPayload(rawValue)
  const params = teamId ? { teamId } : {}
  const response = await fetchEquipment(token, params, {
    showLoading: false,
    silentError: true
  })
  if (!response?.equipment?._id) {
    throw Object.assign(new Error('设备不存在'), { statusCode: 404 })
  }
  const scheduleResponse = await fetchSchedule(response.equipment._id, params, {
    showLoading: false,
    silentError: true
  })
  return {
    equipment: {
      ...response.equipment,
      ...(scheduleResponse?.equipment || {})
    },
    schedules: normalizeRoutineSchedules(scheduleResponse)
  }
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
    photoEvidence = null,
    planId = '',
    idempotencyKey = ''
}) {
  const ruleId = requiredObjectId(rule?._id, 'ruleId')
  const routineType = rule?.routineType
  if (!Object.values(ROUTINE_TYPES).includes(routineType)) {
    throw new TypeError('点检保养类型无效')
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
    if (planId) payload.planId = requiredObjectId(planId, 'planId')
    if (Array.isArray(photoEvidence)) {
      if (photoEvidence.length !== photos.length) {
        throw new TypeError('现场照片与拍摄信息数量不一致')
      }
      payload.photoEvidence = photoEvidence.map((evidence, index) => ({
        fileId: photos[index],
        sourceType: 'CAMERA',
        capturedAt: evidence.capturedAt || null,
        locationStatus: evidence.locationStatus || 'PENDING_CONFIRMATION',
        longitude: evidence.longitude ?? null,
        latitude: evidence.latitude ?? null,
        accuracyMeters: evidence.accuracyMeters ?? null,
        address: String(evidence.address || '').trim()
      }))
    }
    return payload
}

export function buildRuntimeReadingPayload({ hours, reason = '', currentHours = null }) {
  if (hours === '' || hours === null || hours === undefined) {
    throw new TypeError('请填写累计运行小时')
  }
  const normalizedHours = Number(hours)
  if (!Number.isFinite(normalizedHours) || normalizedHours < 0) {
    throw new TypeError('运行小时必须是非负数字')
  }
  if (currentHours !== '' && currentHours !== null && currentHours !== undefined) {
    const normalizedCurrentHours = Number(currentHours)
    if (Number.isFinite(normalizedCurrentHours) && normalizedHours < normalizedCurrentHours) {
      throw new TypeError(`累计运行小时不能小于当前读数 ${normalizedCurrentHours}`)
    }
  }
  return {
    hours: normalizedHours,
    reason: String(reason || '').trim()
  }
}

export function teamQuery(teamId) {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
}
