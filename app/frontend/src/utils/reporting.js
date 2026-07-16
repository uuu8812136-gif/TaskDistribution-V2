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
  if (!match) throw new TypeError('month must use YYYY-MM format')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  if (monthNumber < 1 || monthNumber > 12) throw new TypeError('month is invalid')
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
