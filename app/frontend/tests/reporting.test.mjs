import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  TRANSPORT_LOAD_FIELDS,
  aggregateDriverMonthly,
  buildDailySchedulePayload,
  buildMonthlySchedulePayload,
  buildTransportPayload,
  createDailyTemplate,
  dailyCountText,
  emptyTransportLoadDetails,
  naturalMonthRange,
  transportChangedFields
} from '../src/utils/reporting.js'

test('transport payload emits only the fixed form and opaque photo ids', () => {
  const loadDetails = emptyTransportLoadDetails()
  loadDetails.woodenBox = '3'
  const payload = buildTransportPayload({
    orgUnitId: 'org-1',
    reportDate: '2026-07-16',
    shift: '白班',
    tripLabel: ' 第1趟 ',
    route: ' 工厂至仓库 ',
    dispatchType: '配送',
    vehiclePlate: ' 鲁A12345 ',
    vehicleType: ' 4.2米厢货 ',
    driverName: ' 张三 ',
    loadDetails,
    remark: ' 正常 ',
    reason: ' 修正 '
  }, ['64b000000000000000000001', '64b000000000000000000002'])

  assert.equal(Object.keys(payload.loadDetails).length, TRANSPORT_LOAD_FIELDS.length)
  assert.equal(payload.loadDetails.woodenBox, 3)
  assert.equal(payload.tripLabel, '第1趟')
  assert.equal(payload.driverName, '张三')
  assert.deepEqual(payload.photoFileIds, [
    '64b000000000000000000001',
    '64b000000000000000000002'
  ])
  assert.equal('teamId' in payload, false)
})

test('driver monthly summary groups the fixed business key and counts each date', () => {
  const rows = aggregateDriverMonthly([
    {
      driverName: '张三', route: '北线', vehiclePlate: '鲁A1', vehicleType: '厢货',
      dispatchType: '配送', reportDate: '2026-07-01', remark: '早班'
    },
    {
      driverName: '张三', route: '北线', vehiclePlate: '鲁A1', vehicleType: '厢货',
      dispatchType: '配送', reportDate: '2026-07-01', remark: '早班'
    },
    {
      driverName: '张三', route: '北线', vehiclePlate: '鲁A1', vehicleType: '厢货',
      dispatchType: '配送', reportDate: '2026-07-02', remark: ''
    }
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].totalTrips, 3)
  assert.deepEqual(rows[0].dailyCounts, { '2026-07-01': 2, '2026-07-02': 1 })
  assert.equal(dailyCountText(rows[0]), '1日 2趟，2日 1趟')
})

test('natural month and daily template preserve real leap-year dates', () => {
  assert.deepEqual(naturalMonthRange('2024-02'), {
    dateFrom: '2024-02-01',
    dateTo: '2024-02-29'
  })
  const template = createDailyTemplate('2024-02')
  assert.equal(template.length, 29)
  assert.equal(template.at(-1).date, '2024-02-29')
  assert.equal(template[0].total, 0)
})

test('schedule payloads normalize blank quantities to null and exclude totals', () => {
  const dailyEntries = createDailyTemplate('2026-07')
  dailyEntries[0].aLineDay = '12'
  const daily = buildDailySchedulePayload({
    orgUnitId: 'org-1',
    dailyEntries,
    productionPlanForecast: '',
    teamId: 'must-not-leak'
  }, ' 保存 ')
  assert.equal(daily.dailyEntries[0].aLineDay, 12)
  assert.equal(daily.dailyEntries[0].aLineNight, null)
  assert.equal('total' in daily.dailyEntries[0], false)
  assert.equal(Object.keys(daily.dailyEntries[0]).length, DAILY_SCHEDULE_FIELDS.length + 1)
  assert.equal('teamId' in daily, false)

  const monthly = buildMonthlySchedulePayload({
    orgUnitId: 'org-1',
    monthlyTotals: { aLine: '4', northLine: '', total: 999 },
    reason: ''
  })
  assert.equal(monthly.monthlyTotals.aLine, 4)
  assert.equal(monthly.monthlyTotals.northLine, null)
  assert.equal(Object.keys(monthly.monthlyTotals).length, MONTHLY_SCHEDULE_FIELDS.length)
  assert.equal('total' in monthly.monthlyTotals, false)
})

test('transport history labels only changed business fields', () => {
  assert.deepEqual(transportChangedFields({ before: null }), ['创建记录'])
  assert.deepEqual(transportChangedFields({
    before: { route: '北线', remark: '', updatedAt: 'old' },
    after: { route: '南线', remark: '', updatedAt: 'new' }
  }), ['路线'])
})
