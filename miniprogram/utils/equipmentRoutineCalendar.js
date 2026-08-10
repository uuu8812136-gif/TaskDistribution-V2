const MONTH_PATTERN = /^(\d{4})-(\d{2})$/

export const ROUTINE_CALENDAR_STATUSES = Object.freeze([
  'NORMAL',
  'PENDING',
  'ABNORMAL',
  'REST_DAY',
  'NO_PLAN'
])

function parseMonth(month) {
  const match = MONTH_PATTERN.exec(String(month || '').trim())
  if (!match) throw new TypeError('月份格式不正确')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  if (monthNumber < 1 || monthNumber > 12) throw new TypeError('月份格式不正确')
  return { year, month: monthNumber }
}

export function normalizeRoutineCalendarMonth(month, fallback = '') {
  const parsed = parseMonth(month || fallback)
  return `${parsed.year}-${String(parsed.month).padStart(2, '0')}`
}

export function shiftRoutineCalendarMonth(month, delta) {
  const parsed = parseMonth(month)
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1 + Number(delta), 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function routineCalendarMonthLabel(month) {
  const parsed = parseMonth(month)
  return `${parsed.year}年${parsed.month}月`
}

export function routineCalendarDaysInMonth(month) {
  const parsed = parseMonth(month)
  return new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate()
}

export function routineCalendarGrid(month, days = []) {
  const parsed = parseMonth(month)
  const dayByDate = new Map((Array.isArray(days) ? days : []).map((day) => [day?.date, day]))
  const count = routineCalendarDaysInMonth(month)
  const leading = (new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).getUTCDay() + 6) % 7
  const cells = Array.from({ length: leading }, () => null)
  for (let day = 1; day <= count; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`
    cells.push({
      date,
      day,
      summary: dayByDate.get(date) || { date, status: 'NO_PLAN' }
    })
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function routineCalendarStatusTone(status) {
  return {
    NORMAL: 'normal',
    PENDING: 'pending',
    ABNORMAL: 'abnormal',
    REST_DAY: 'rest',
    NO_PLAN: 'rest'
  }[status] || 'rest'
}

export function routineCalendarStatusLabel(status) {
  return {
    NORMAL: '正常完成',
    PENDING: '未点检/逾期',
    ABNORMAL: '点检异常',
    REST_DAY: '休班无计划',
    NO_PLAN: '休班无计划'
  }[status] || '休班无计划'
}
