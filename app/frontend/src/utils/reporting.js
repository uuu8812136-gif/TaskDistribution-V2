export const TRANSPORT_SHIFT_OPTIONS = Object.freeze(['白班', '夜班', '中班'])
export const TRANSPORT_DISPATCH_OPTIONS = Object.freeze(['配送', '返架'])

export const TRANSPORT_LOAD_FIELDS = Object.freeze([
  { key: 'standardPlasticPallet', label: '标准*塑料托盘' },
  { key: 'standardIronPallet', label: '标准*铁托盘' },
  { key: 'woodenPallet', label: '木托盘' },
  { key: 'woodenBox', label: '木箱' },
  { key: 'ironCage', label: '铁笼子' },
  { key: 'ironRack', label: '铁架子' },
  { key: 'housingPlasticPallet', label: '壳体专用*塑料托盘' },
  { key: 'housingIronPallet', label: '壳体专用*铁托盘' },
  { key: 'housingLinerPallet', label: '壳体专用*内衬托盘' },
  { key: 'housingBlackPlasticTray', label: '壳体专用*黑色塑盘' },
  { key: 'turnoverBoxBlue', label: '周转料盒（常用蓝色）' },
  { key: 'turnoverBoxGray', label: '周转料盒（质检灰色）' },
  { key: 'turnoverBoxWhite', label: '周转料盒（线下白色）' },
  { key: 'other', label: '其他' }
])

export const DAILY_SCHEDULE_FIELDS = Object.freeze([
  { key: 'aLineDay', label: 'A线（白班）' },
  { key: 'aLineNight', label: 'A线（夜班）' },
  { key: 'northLine', label: '北线' },
  { key: 'transferCaseLine', label: '分动器线' },
  { key: 'bLineDay', label: 'B线（白班）' },
  { key: 'bLineNight', label: 'B线（夜班）' }
])

export const MONTHLY_SCHEDULE_FIELDS = Object.freeze([
  { key: 'aLine', label: 'A线' },
  { key: 'northLine', label: '北线' },
  { key: 'transferCaseLine', label: '分动器线' },
  { key: 'bLineDay', label: 'B线（白班）' },
  { key: 'bLineNight', label: 'B线（夜班）' }
])

export const ATTENDANCE_NAMED_FIELDS = Object.freeze([
  { key: 'leave', label: '请假' },
  { key: 'rest', label: '休班' },
  { key: 'sickLeave', label: '病假' },
  { key: 'absenteeism', label: '旷工' },
  { key: 'notYetEmployed', label: '未入职' },
  { key: 'pendingDeparture', label: '待离职' }
])

export const ATTENDANCE_QUALITY_STATUSES = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION'
})

const ATTENDANCE_QUALITY_ISSUE_MESSAGES = Object.freeze({
  SOURCE_REGISTERED_TOTAL_MISMATCH: '在册人数汇总与分部明细不一致，等待客户确认',
  SOURCE_DAY_ACTUAL_TOTAL_MISMATCH: '白班实际出勤汇总与分部明细不一致，等待客户确认',
  SOURCE_PENDING_DEPARTURE_TOTAL_MISMATCH: '待离职人数汇总与分部明细不一致，等待客户确认'
})

const TRANSPORT_FIELD_LABELS = Object.freeze({
  orgUnitId: '所属组织',
  reportDate: '提报日期',
  shift: '班次',
  tripLabel: '趟次',
  route: '路线',
  dispatchType: '出车类型',
  vehiclePlate: '车牌号',
  vehicleType: '车型',
  driverName: '司机',
  loadDetails: '装载明细',
  photoFileIds: '现场照片',
  remark: '备注'
})

function integerOrZero(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function nullableInteger(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function splitNames(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[、,，;；\n]/)
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]
}

function attendanceNamedValue(value = {}) {
  return {
    count: integerOrZero(value.count),
    names: splitNames(value.names)
  }
}

function attendanceShiftValue(value = {}) {
  return {
    actualAttendanceCount: integerOrZero(value.actualAttendanceCount),
    ...Object.fromEntries(ATTENDANCE_NAMED_FIELDS.map(({ key }) => [
      key,
      attendanceNamedValue(value[key])
    ]))
  }
}

export function emptyAttendanceShift() {
  return {
    actualAttendanceCount: 0,
    ...Object.fromEntries(ATTENDANCE_NAMED_FIELDS.map(({ key }) => [
      key,
      { count: 0, names: '' }
    ]))
  }
}

export function emptyAttendanceForm(reportDate = '') {
  return {
    orgUnitId: '',
    reportDate,
    authorizedHeadcount: 0,
    registeredHeadcount: 0,
    dayShift: emptyAttendanceShift(),
    nightShift: emptyAttendanceShift(),
    support: { destination: '', count: 0, names: '' },
    otherRemark: '',
    reason: ''
  }
}

export function buildAttendancePayload(form) {
  return {
    orgUnitId: form.orgUnitId,
    reportDate: form.reportDate,
    authorizedHeadcount: integerOrZero(form.authorizedHeadcount),
    registeredHeadcount: integerOrZero(form.registeredHeadcount),
    dayShift: attendanceShiftValue(form.dayShift),
    nightShift: attendanceShiftValue(form.nightShift),
    support: {
      destination: String(form.support?.destination || '').trim(),
      count: integerOrZero(form.support?.count),
      names: splitNames(form.support?.names)
    },
    otherRemark: String(form.otherRemark || '').trim(),
    reason: String(form.reason || '').trim() || null
  }
}

export function attendanceNamesText(value) {
  return splitNames(value).join('、') || '-'
}

export function attendanceQualityIssueMessage(issue = {}) {
  const code = String(issue?.code || '').trim()
  const suppliedMessage = String(issue?.message || '').trim()
  if (/[\u3400-\u9fff]/u.test(suppliedMessage)) return suppliedMessage
  if (ATTENDANCE_QUALITY_ISSUE_MESSAGES[code]) return ATTENDANCE_QUALITY_ISSUE_MESSAGES[code]
  return '出勤数据存在待确认差异，请核对原始提报表并联系管理员确认。'
}

export function attendanceShiftSummary(shift = {}) {
  return ATTENDANCE_NAMED_FIELDS.reduce((result, { key }) => {
    result[key] = integerOrZero(shift[key]?.count)
    return result
  }, { actualAttendanceCount: integerOrZero(shift.actualAttendanceCount) })
}

export function emptyTransportLoadDetails() {
  return Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, 0]))
}

export function buildTransportPayload(form, photoFileIds) {
  return {
    orgUnitId: form.orgUnitId,
    reportDate: form.reportDate,
    shift: form.shift,
    tripLabel: form.tripLabel.trim(),
    route: form.route.trim(),
    dispatchType: form.dispatchType,
    vehiclePlate: form.vehiclePlate.trim(),
    vehicleType: form.vehicleType.trim(),
    driverName: form.driverName.trim(),
    loadDetails: Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [
      key,
      integerOrZero(form.loadDetails?.[key])
    ])),
    photoFileIds: [...photoFileIds],
    remark: form.remark.trim(),
    reason: form.reason.trim() || null
  }
}

export function naturalMonthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '')
  if (!match) throw new TypeError('月份必须使用 YYYY-MM 格式')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  if (monthNumber < 1 || monthNumber > 12) throw new TypeError('月份无效，请选择1月至12月')
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return {
    dateFrom: `${month}-01`,
    dateTo: `${month}-${String(lastDay).padStart(2, '0')}`
  }
}

export function aggregateDriverMonthly(records = []) {
  const groups = new Map()
  for (const record of records) {
    const values = [
      record.driverName,
      record.route,
      record.vehiclePlate,
      record.vehicleType || '',
      record.dispatchType
    ]
    const key = JSON.stringify(values)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        driverName: values[0],
        route: values[1],
        vehiclePlate: values[2],
        vehicleType: values[3],
        dispatchType: values[4],
        dailyCounts: {},
        totalTrips: 0,
        remarks: []
      })
    }
    const group = groups.get(key)
    group.dailyCounts[record.reportDate] = (group.dailyCounts[record.reportDate] || 0) + 1
    group.totalTrips += 1
    if (record.remark && !group.remarks.includes(record.remark)) group.remarks.push(record.remark)
  }
  return [...groups.values()].sort((left, right) => (
    left.driverName.localeCompare(right.driverName, 'zh-CN') ||
    left.route.localeCompare(right.route, 'zh-CN') ||
    left.vehiclePlate.localeCompare(right.vehiclePlate, 'zh-CN')
  ))
}

export function dailyCountText(group) {
  return Object.entries(group?.dailyCounts || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, count]) => `${Number(date.slice(-2))}日 ${count}趟`)
    .join('，') || '-'
}

export function createDailyTemplate(month) {
  const { dateTo } = naturalMonthRange(month)
  const dayCount = Number(dateTo.slice(-2))
  return Array.from({ length: dayCount }, (_, index) => ({
    date: `${month}-${String(index + 1).padStart(2, '0')}`,
    ...Object.fromEntries(DAILY_SCHEDULE_FIELDS.map(({ key }) => [key, null])),
    total: 0
  }))
}

export function buildDailySchedulePayload(schedule, reason = '') {
  return {
    orgUnitId: schedule.orgUnitId,
    dailyEntries: (schedule.dailyEntries || []).map((entry) => ({
      date: entry.date,
      ...Object.fromEntries(DAILY_SCHEDULE_FIELDS.map(({ key }) => [
        key,
        nullableInteger(entry[key])
      ]))
    })),
    productionPlanForecast: nullableInteger(schedule.productionPlanForecast),
    reason: reason.trim() || null
  }
}

export function buildMonthlySchedulePayload(form) {
  return {
    orgUnitId: form.orgUnitId,
    monthlyTotals: Object.fromEntries(MONTHLY_SCHEDULE_FIELDS.map(({ key }) => [
      key,
      nullableInteger(form.monthlyTotals?.[key])
    ])),
    reason: form.reason.trim() || null
  }
}

export function rowQuantityTotal(row, fields) {
  return fields.reduce((total, { key }) => total + (Number(row?.[key]) || 0), 0)
}

export function transportChangedFields(change) {
  if (!change?.before) return ['创建记录']
  return Object.keys(TRANSPORT_FIELD_LABELS)
    .filter((key) => JSON.stringify(change.before?.[key]) !== JSON.stringify(change.after?.[key]))
    .map((key) => TRANSPORT_FIELD_LABELS[key])
}

export function entityName(items, id, fallback = '-') {
  return items.find((item) => item._id === id)?.name || fallback
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function dailyReportSourceSummary(report) {
  const source = report?.sourceSnapshot || {}
  const attendance = source.attendance || {}
  const production = source.production || {}
  return {
    ruleVersion: source.rule?.version || report?.ruleVersion || '-',
    currentReviewId: attendance.currentDate?.reviewId || '',
    currentReviewedAt: attendance.currentDate?.reviewedAt || null,
    previousReviewId: attendance.previousNaturalDate?.reviewId || '',
    previousReviewedAt: attendance.previousNaturalDate?.reviewedAt || null,
    attendanceRecordCount: (
      (attendance.currentDate?.submissions?.length || 0) +
      (attendance.previousNaturalDate?.submissions?.length || 0)
    ),
    productionScheduleCount: production.schedules?.length || 0,
    requiredMonths: production.requiredMonths || [],
    previousNaturalDate: production.previousNaturalDate || ''
  }
}

export async function copyPlainText(value, dependencies = {}) {
  const text = String(value || '')
  if (!text) throw new TypeError('没有可复制的文字内容')
  const clipboard = dependencies.clipboard || globalThis.navigator?.clipboard
  if (clipboard?.writeText) {
    await clipboard.writeText(text)
    return true
  }
  const documentRef = dependencies.document || globalThis.document
  if (!documentRef?.createElement || !documentRef.body) {
    throw new Error('当前浏览器无法使用剪贴板')
  }
  const textarea = documentRef.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  documentRef.body.appendChild(textarea)
  textarea.select()
  const copied = documentRef.execCommand?.('copy') === true
  textarea.remove()
  if (!copied) throw new Error('复制失败，请使用系统复制功能')
  return true
}
