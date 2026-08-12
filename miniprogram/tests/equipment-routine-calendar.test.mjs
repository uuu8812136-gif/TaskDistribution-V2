import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  normalizeRoutineCalendarMonth,
  routineCalendarDaysInMonth,
  routineCalendarGrid,
  routineCalendarMonthLabel,
  routineCalendarStatusLabel,
  routineCalendarStatusTone,
  shiftRoutineCalendarMonth
} from '../utils/equipmentRoutineCalendar.js'

const pages = JSON.parse(readFileSync(new URL('../pages.json', import.meta.url), 'utf8'))
const apiSource = readFileSync(new URL('../api/index.js', import.meta.url), 'utf8')
const scanSource = readFileSync(new URL('../pages/equipment/scan.vue', import.meta.url), 'utf8')
const calendarSource = readFileSync(new URL('../pages/equipment/routine-calendar.vue', import.meta.url), 'utf8')

test('routine calendar month arithmetic is timezone-independent and Monday-first', () => {
  assert.equal(normalizeRoutineCalendarMonth('2032-02'), '2032-02')
  assert.equal(shiftRoutineCalendarMonth('2030-01', -1), '2029-12')
  assert.equal(shiftRoutineCalendarMonth('2030-12', 1), '2031-01')
  assert.equal(routineCalendarMonthLabel('2030-08'), '2030年8月')
  assert.equal(routineCalendarDaysInMonth('2032-02'), 29)
  assert.throws(() => normalizeRoutineCalendarMonth('2030-13'), /月份格式/)

  const grid = routineCalendarGrid('2026-08', [{ date: '2026-08-01', status: 'PENDING' }])
  assert.equal(grid.length, 42)
  assert.deepEqual(grid.slice(0, 5), [null, null, null, null, null])
  assert.equal(grid[5].date, '2026-08-01')
  assert.equal(grid[5].summary.status, 'PENDING')
  assert.equal(grid[6].date, '2026-08-02')
})

test('routine calendar exposes the four customer-facing states', () => {
  assert.equal(routineCalendarStatusTone('NORMAL'), 'normal')
  assert.equal(routineCalendarStatusTone('PENDING'), 'pending')
  assert.equal(routineCalendarStatusTone('ABNORMAL'), 'abnormal')
  assert.equal(routineCalendarStatusTone('REST_DAY'), 'rest')
  assert.equal(routineCalendarStatusTone('NO_PLAN'), 'rest')
  assert.equal(routineCalendarStatusLabel('PENDING'), '未点检/逾期')
})

test('scan page places the calendar in the open grid slot and refreshes after execution', () => {
  assert.ok(pages.pages.some(({ path }) => path === 'pages/equipment/routine-calendar'))
  assert.match(apiSource, /getEquipmentRoutineCalendar\s*=\s*\(equipmentId/)
  assert.match(apiSource, /equipment\/\$\{equipmentId\}\/routine-calendar/)
  const maintenanceIndex = scanSource.indexOf('>保养记录</button>')
  const calendarIndex = scanSource.indexOf('>点检日历</button>')
  const restDayIndex = scanSource.indexOf('>所选计划设为休班</button>')
  assert.ok(maintenanceIndex >= 0 && maintenanceIndex < calendarIndex)
  assert.ok(calendarIndex < restDayIndex)
  assert.match(scanSource, /pages\/equipment\/routine-calendar\?\$\{query\}/)
  assert.match(scanSource, /onShow\(\(\) => \{[\s\S]*refreshLoadedEquipment\(\)/)
  const refreshSource = scanSource.slice(
    scanSource.indexOf('const refreshLoadedEquipment = async'),
    scanSource.indexOf('const requireQueryContext')
  )
  assert.match(refreshSource, /getEquipmentRoutineSchedule\(equipment\.value\._id/)
  assert.match(refreshSource, /let scheduleRefreshError = ''/)
  assert.match(refreshSource, /scheduleRefreshError = requestErrorMessage\(error, '设备计划暂时无法刷新'\)/)
  assert.match(refreshSource, /activityError\.value = scheduleRefreshError/)
  assert.doesNotMatch(refreshSource, /activityLoading\.value = true\s+activityError\.value = ''/)
})

test('calendar page includes month navigation, Monday-first headings, retry, and legend', () => {
  assert.match(calendarSource, /月度点检日历/)
  assert.match(calendarSource, />上月<\/button>/)
  assert.match(calendarSource, />下月<\/button>/)
  assert.match(calendarSource, /const weekLabels = \['一', '二', '三', '四', '五', '六', '日'\]/)
  for (const label of ['正常完成', '未点检/逾期', '点检异常', '休班无计划']) {
    assert.ok(calendarSource.includes(label), `missing calendar legend: ${label}`)
  }
  assert.match(calendarSource, /@click="loadCalendar">重新加载<\/button>/)
  assert.match(calendarSource, /teamId\.value \? \{ teamId: teamId\.value \}/)
})

test('calendar uses the final customer colors with stronger green and red contrast', () => {
  assert.match(calendarSource, /\.day-normal \{ border-color: #2f9e5b; background: #c8ead4; \}/)
  assert.match(calendarSource, /\.day-abnormal \{ border-color: #d94a42; background: #ffd6d2; \}/)
  assert.match(calendarSource, /\.day-rest \{ border-color: #3b82f6; background: #dbeafe; \}/)
  assert.match(calendarSource, /\.day-pending \{ border-color: #cbd5e1; background: #fff; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-normal \{ background: #c8ead4; border-color: #2f9e5b; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-abnormal \{ background: #ffd6d2; border-color: #d94a42; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-rest \{ background: #dbeafe; border-color: #3b82f6; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-pending \{ background: #fff; border-color: #cbd5e1; \}/)
})
