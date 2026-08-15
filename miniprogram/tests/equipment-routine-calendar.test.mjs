import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  normalizeRoutineCalendarMonth,
  routineCalendarDaysInMonth,
  routineCalendarGrid,
  routineCalendarMonthLabel,
  routineCalendarShanghaiDate,
  routineCalendarStatusLabel,
  routineCalendarStatusTone,
  shiftRoutineCalendarMonth
} from '../utils/equipmentRoutineCalendar.js'

const pages = JSON.parse(readFileSync(new URL('../pages.json', import.meta.url), 'utf8'))
const apiSource = readFileSync(new URL('../api/index.js', import.meta.url), 'utf8')
const scanSource = readFileSync(new URL('../pages/equipment/scan.vue', import.meta.url), 'utf8')
const detailSource = readFileSync(new URL('../pages/equipment/detail.vue', import.meta.url), 'utf8')
const calendarSource = readFileSync(new URL('../pages/equipment/routine-calendar.vue', import.meta.url), 'utf8')

test('routine calendar month arithmetic is timezone-independent and Monday-first', () => {
  assert.equal(normalizeRoutineCalendarMonth('2032-02'), '2032-02')
  assert.equal(shiftRoutineCalendarMonth('2030-01', -1), '2029-12')
  assert.equal(shiftRoutineCalendarMonth('2030-12', 1), '2031-01')
  assert.equal(routineCalendarMonthLabel('2030-08'), '2030年8月')
  assert.equal(routineCalendarDaysInMonth('2032-02'), 29)
  assert.throws(() => normalizeRoutineCalendarMonth('2030-13'), /月份格式/)

  const grid = routineCalendarGrid(
    '2026-08',
    [{ date: '2026-08-01', status: 'PENDING' }],
    '2030-01-01T00:00:00.000Z'
  )
  assert.equal(grid.length, 42)
  assert.deepEqual(grid.slice(0, 5), [null, null, null, null, null])
  assert.equal(grid[5].date, '2026-08-01')
  assert.equal(grid[5].summary.status, 'PENDING')
  assert.equal(grid[6].date, '2026-08-02')
  assert.equal(routineCalendarShanghaiDate('2026-08-14T12:00:00.000Z'), '2026-08-14')
  assert.equal(routineCalendarShanghaiDate('2026-08-14T15:59:59.999Z'), '2026-08-14')
  assert.equal(routineCalendarShanghaiDate('2026-08-14T16:00:00.000Z'), '2026-08-15')

  const futurePlan = { date: '2026-08-16', status: 'PENDING', planCount: 2 }
  const currentGrid = routineCalendarGrid('2026-08', [
    { date: '2026-08-14', status: 'NO_PLAN' },
    { date: '2026-08-15', status: 'NO_PLAN' },
    futurePlan,
    { date: '2026-08-17', status: 'REST_DAY' },
    { date: '2026-08-18', status: 'NORMAL' },
    { date: '2026-08-19', status: 'ABNORMAL' }
  ], '2026-08-14T12:00:00.000Z')
  const currentDays = new Map(currentGrid.filter(Boolean).map((cell) => [cell.date, cell.summary]))
  assert.equal(currentDays.get('2026-08-14').status, 'NO_PLAN')
  assert.equal(currentDays.get('2026-08-15').status, 'UPCOMING')
  assert.equal(currentDays.get('2026-08-16').status, 'UPCOMING')
  assert.equal(currentDays.get('2026-08-16').planCount, 2)
  assert.equal(currentDays.get('2026-08-17').status, 'REST_DAY')
  assert.equal(currentDays.get('2026-08-18').status, 'NORMAL')
  assert.equal(currentDays.get('2026-08-19').status, 'ABNORMAL')
  assert.equal(futurePlan.status, 'PENDING')
  assert.notEqual(currentDays.get('2026-08-16'), futurePlan)
})

test('routine calendar exposes the five customer-facing states', () => {
  assert.equal(routineCalendarStatusTone('NORMAL'), 'normal')
  assert.equal(routineCalendarStatusTone('PENDING'), 'pending')
  assert.equal(routineCalendarStatusTone('ABNORMAL'), 'abnormal')
  assert.equal(routineCalendarStatusTone('REST_DAY'), 'rest')
  assert.equal(routineCalendarStatusTone('UPCOMING'), 'upcoming')
  assert.equal(routineCalendarStatusTone('NO_PLAN'), 'rest')
  assert.equal(routineCalendarStatusLabel('PENDING'), '未点检/逾期')
  assert.equal(routineCalendarStatusLabel('UPCOMING'), '未到期')
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
  for (const label of ['正常完成', '未点检/逾期', '点检异常', '休班无计划', '未到期']) {
    assert.ok(calendarSource.includes(label), `missing calendar legend: ${label}`)
  }
  assert.match(calendarSource, /@click="loadCalendar">重新加载<\/button>/)
  assert.match(calendarSource, /teamId\.value \? \{ teamId: teamId\.value \}/)
})

test('calendar, detail, and scan equipment headings identify fixed asset code and plate number explicitly', () => {
  for (const source of [calendarSource, detailSource, scanSource]) {
    assert.match(source, /equipment(?:\?\.|\.)assetCode/)
    assert.match(source, /固定资产编号：\{\{ equipment(?:\?\.|\.)assetCode \|\| '-' \}\}/)
    assert.match(source, /equipment(?:\?\.|\.)plateNumber/)
    assert.match(source, /车牌号：\{\{ equipment(?:\?\.|\.)plateNumber \|\| '-' \}\}/)
  }
})

test('calendar uses the final customer colors with stronger green and red contrast', () => {
  assert.match(calendarSource, /\.day-normal \{ border-color: #2f9e5b; background: #c8ead4; \}/)
  assert.match(calendarSource, /\.day-abnormal \{ border-color: #d94a42; background: #ffd6d2; \}/)
  assert.match(calendarSource, /\.day-rest \{ border-color: #3b82f6; background: #dbeafe; \}/)
  assert.match(calendarSource, /\.day-upcoming \{ border-color: #94a3b8; background: #f1f5f9; \}/)
  assert.match(calendarSource, /\.day-pending \{ border-color: #cbd5e1; background: #fff; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-normal \{ background: #c8ead4; border-color: #2f9e5b; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-abnormal \{ background: #ffd6d2; border-color: #d94a42; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-rest \{ background: #dbeafe; border-color: #3b82f6; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-upcoming \{ background: #f1f5f9; border-color: #94a3b8; \}/)
  assert.match(calendarSource, /\.legend-dot\.day-pending \{ background: #fff; border-color: #cbd5e1; \}/)
})
