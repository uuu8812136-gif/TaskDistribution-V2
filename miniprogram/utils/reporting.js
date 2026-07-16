export const REPORTING_MODULE_SCOPES = Object.freeze({
  TRANSPORT: 'report.transport',
  PRODUCTION: 'report.production'
})

export const TRANSPORT_SHIFT_OPTIONS = Object.freeze(['白班', '夜班', '中班'])
export const TRANSPORT_DISPATCH_OPTIONS = Object.freeze(['配送', '返架'])

export const TRANSPORT_LOAD_FIELDS = Object.freeze([
  Object.freeze({ key: 'standardPlasticPallet', label: '标准*塑料托盘' }),
  Object.freeze({ key: 'standardIronPallet', label: '标准*铁托盘' }),
  Object.freeze({ key: 'woodenPallet', label: '木托盘' }),
  Object.freeze({ key: 'woodenBox', label: '木箱' }),
  Object.freeze({ key: 'ironCage', label: '铁笼子' }),
  Object.freeze({ key: 'ironRack', label: '铁架子' }),
  Object.freeze({ key: 'housingPlasticPallet', label: '壳体专用*塑料托盘' }),
  Object.freeze({ key: 'housingIronPallet', label: '壳体专用*铁托盘' }),
  Object.freeze({ key: 'housingLinerPallet', label: '壳体专用*内衬托盘' }),
  Object.freeze({ key: 'housingBlackPlasticTray', label: '壳体专用*黑色塑盘' }),
  Object.freeze({ key: 'turnoverBoxBlue', label: '周转料盒（常用蓝色）' }),
  Object.freeze({ key: 'turnoverBoxGray', label: '周转料盒（质检灰色）' }),
  Object.freeze({ key: 'turnoverBoxWhite', label: '周转料盒（线下白色）' }),
  Object.freeze({ key: 'other', label: '其他' })
])

export const DAILY_SCHEDULE_FIELDS = Object.freeze([
  Object.freeze({ key: 'aLineDay', label: 'A线白班' }),
  Object.freeze({ key: 'aLineNight', label: 'A线夜班' }),
  Object.freeze({ key: 'northLine', label: '北线' }),
  Object.freeze({ key: 'transferCaseLine', label: '分动器线' }),
  Object.freeze({ key: 'bLineDay', label: 'B线白班' }),
  Object.freeze({ key: 'bLineNight', label: 'B线夜班' })
])

export const MONTHLY_SCHEDULE_FIELDS = Object.freeze([
  Object.freeze({ key: 'aLine', label: 'A线' }),
  Object.freeze({ key: 'northLine', label: '北线' }),
  Object.freeze({ key: 'transferCaseLine', label: '分动器线' }),
  Object.freeze({ key: 'bLineDay', label: 'B线白班' }),
  Object.freeze({ key: 'bLineNight', label: 'B线夜班' })
])

const FILE_ID_PATTERN = /^[0-9a-f]{24}$/i
const GLOBAL_READ_ONLY = 'GLOBAL_READ_ONLY'

function requiredText(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new TypeError(`请填写${label}`)
  return normalized
}

function quantity(value, label) {
  if (value === '' || value === undefined || value === null) return 0
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 2147483647) {
    throw new TypeError(`${label}必须是非负整数`)
  }
  return normalized
}

function isNaturalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
}

export function businessNaturalDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date')
  return new Date(date.getTime() + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10)
}

export function businessNaturalMonth(now = new Date()) {
  return businessNaturalDate(now).slice(0, 7)
}

export function createEmptyTransportLoad() {
  return Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, '']))
}

export function scopedReportingParams(mode, selectedTeamId, params = {}) {
  const scoped = { ...params }
  delete scoped.teamId
  if (mode !== GLOBAL_READ_ONLY) return scoped
  if (typeof selectedTeamId !== 'string' || !FILE_ID_PATTERN.test(selectedTeamId)) {
    throw new TypeError('请先选择要查看的项目团队')
  }
  return { ...scoped, teamId: selectedTeamId.toLowerCase() }
}

export function buildTransportFields(form) {
  const reportDate = requiredText(form?.reportDate, '运输日期')
  if (!isNaturalDate(reportDate)) throw new TypeError('运输日期格式不正确')
  if (!TRANSPORT_SHIFT_OPTIONS.includes(form?.shift)) throw new TypeError('请选择运输班次')
  if (!TRANSPORT_DISPATCH_OPTIONS.includes(form?.dispatchType)) {
    throw new TypeError('请选择出车类型')
  }

  const fields = {
    reportDate,
    shift: form.shift,
    tripLabel: requiredText(form.tripLabel, '运输车次'),
    route: requiredText(form.route, '运输路线'),
    dispatchType: form.dispatchType,
    vehiclePlate: requiredText(form.vehiclePlate, '车牌号'),
    vehicleType: typeof form.vehicleType === 'string' ? form.vehicleType.trim() : '',
    driverName: requiredText(form.driverName, '司机姓名'),
    loadDetails: Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key, label }) => [
      key,
      quantity(form.loadDetails?.[key], label)
    ])),
    remark: typeof form.remark === 'string' ? form.remark.trim() : ''
  }
  if (form.orgUnitId) fields.orgUnitId = String(form.orgUnitId)
  return fields
}

export function buildTransportPayload(form, photoFileIds) {
  if (!Array.isArray(photoFileIds) || photoFileIds.length < 2 || photoFileIds.length > 10) {
    throw new TypeError('现场照片必须为2至10张')
  }
  const normalizedPhotoIds = photoFileIds.map((fileId) => {
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
      throw new TypeError('现场照片包含无效文件')
    }
    return fileId.toLowerCase()
  })
  if (new Set(normalizedPhotoIds).size !== normalizedPhotoIds.length) {
    throw new TypeError('现场照片不能重复')
  }
  return {
    ...buildTransportFields(form),
    photoFileIds: normalizedPhotoIds
  }
}

export function transportLoadTotal(loadDetails = {}) {
  return TRANSPORT_LOAD_FIELDS.reduce((total, { key }) => {
    const value = Number(loadDetails[key])
    return total + (Number.isFinite(value) ? value : 0)
  }, 0)
}

export function orgUnitLabel(orgUnitId, options = [], fallbackOrgUnit = null) {
  const id = String(orgUnitId || '')
  const matched = options.find((option) => String(option.value) === id)
  if (matched?.label) return matched.label
  if (fallbackOrgUnit && String(fallbackOrgUnit._id) === id) return fallbackOrgUnit.name || id
  return id ? `组织 ${id.slice(-6)}` : '未分配组织'
}

export function buildOrgUnitOptions(orgUnits = [], users = []) {
  const candidates = [
    ...orgUnits.map((unit) => ({ value: unit?._id, label: unit?.name, status: unit?.status })),
    ...users.map((user) => ({
      value: user?.membership?.orgUnitId,
      label: user?.department,
      status: 'ACTIVE'
    }))
  ]
  const byId = new Map()
  for (const candidate of candidates) {
    const value = typeof candidate.value === 'string'
      ? candidate.value
      : candidate.value?._id ? String(candidate.value._id) : ''
    if (!value || candidate.status === 'DISABLED' || byId.has(value)) continue
    byId.set(value, {
      value,
      label: candidate.label || `组织 ${value.slice(-6)}`
    })
  }
  return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
}
