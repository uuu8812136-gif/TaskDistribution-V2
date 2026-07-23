import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ATTENDANCE_NAMED_FIELDS,
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  TRANSPORT_LOAD_FIELDS,
  aggregateDriverMonthly,
  attendanceNamesText,
  attendanceQualityIssueMessage,
  buildAttendancePayload,
  buildDailySchedulePayload,
  buildMonthlySchedulePayload,
  buildTransportPayload,
  createDailyTemplate,
  copyPlainText,
  dailyReportSourceSummary,
  dailyCountText,
  emptyTransportLoadDetails,
  naturalMonthRange,
  transportChangedFields
} from '../src/utils/reporting.js'

test('attendance payload keeps the fixed two-shift template and normalized names', () => {
  const payload = buildAttendancePayload({
    orgUnitId: 'org-1',
    reportDate: '2026-07-14',
    authorizedHeadcount: '12',
    registeredHeadcount: 13,
    dayShift: {
      actualAttendanceCount: '11',
      leave: { count: '2', names: '张三、 李四，张三' }
    },
    nightShift: {},
    support: { destination: ' 物流技术部 ', count: '1', names: '测试人员乙' },
    otherRemark: ' 测试 ',
    reason: ' 修正 '
  })

  assert.equal(payload.authorizedHeadcount, 12)
  assert.equal(payload.dayShift.actualAttendanceCount, 11)
  assert.deepEqual(payload.dayShift.leave, { count: 2, names: ['张三', '李四'] })
  assert.equal(Object.keys(payload.dayShift).length, ATTENDANCE_NAMED_FIELDS.length + 1)
  assert.equal(payload.nightShift.pendingDeparture.count, 0)
  assert.deepEqual(payload.support.names, ['测试人员乙'])
  assert.equal(payload.otherRemark, '测试')
  assert.equal('teamId' in payload, false)
  assert.equal(attendanceNamesText(payload.dayShift.leave.names), '张三、李四')
})

test('attendance monthly view downloads the reviewed-only fixed A:R workbook', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/src/api/reporting.js`, 'utf8')
  const viewSource = fs.readFileSync(`${root}/src/views/reporting/AttendanceReports.vue`, 'utf8')

  assert.match(apiSource, /attendance-submissions\/summary\/monthly\/export/)
  assert.match(apiSource, /responseType:\s*'blob'/)
  assert.match(viewSource, /导出 A:R 月报/)
  assert.match(viewSource, /exportAttendanceMonthlySummary/)
  assert.match(viewSource, /仅包含已审核日报/)
})

test('attendance quality issues never expose untrusted English messages', () => {
  assert.equal(attendanceQualityIssueMessage({
    code: 'SOURCE_REGISTERED_TOTAL_MISMATCH',
    message: 'source mismatch'
  }), '在册人数汇总与分部明细不一致，等待客户确认')
  assert.equal(attendanceQualityIssueMessage({
    code: 'SOURCE_DAY_ACTUAL_TOTAL_MISMATCH',
    message: 'source mismatch'
  }), '白班实际出勤汇总与分部明细不一致，等待客户确认')
  assert.equal(attendanceQualityIssueMessage({
    code: 'SOURCE_PENDING_DEPARTURE_TOTAL_MISMATCH',
    message: 'source mismatch'
  }), '待离职人数汇总与分部明细不一致，等待客户确认')
  assert.equal(attendanceQualityIssueMessage({
    code: 'FUTURE_IMPORT_ISSUE',
    message: 'unexpected source data'
  }), '出勤数据存在待确认差异，请核对原始提报表并联系管理员确认。')
  assert.equal(attendanceQualityIssueMessage({
    code: 'FUTURE_IMPORT_ISSUE',
    message: '客户原始汇总值需要确认'
  }), '客户原始汇总值需要确认')
  assert.equal(attendanceQualityIssueMessage(), '出勤数据存在待确认差异，请核对原始提报表并联系管理员确认。')

  const root = fileURLToPath(new URL('..', import.meta.url))
  const viewSource = fs.readFileSync(`${root}/src/views/reporting/AttendanceReports.vue`, 'utf8')
  assert.doesNotMatch(viewSource, /\{\{\s*issue\.message\s*\}\}/)
  assert.equal((viewSource.match(/attendanceQualityIssueMessage\(issue\)/g) || []).length, 2)
})

test('attendance views clear incompatible data and only accept their latest requests', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const viewSource = fs.readFileSync(`${root}/src/views/reporting/AttendanceReports.vue`, 'utf8')

  for (const requestName of ['options', 'records', 'daily', 'monthly', 'detail']) {
    const requestId = `${requestName}RequestId`
    assert.match(viewSource, new RegExp(`let ${requestId} = 0`))
    assert.match(viewSource, new RegExp(`requestId !== ${requestId}`))
  }
  assert.match(viewSource, /if \(requestId === recordsRequestId\) loading\.value = false/)
  assert.match(viewSource, /if \(requestId === dailyRequestId\) dailyLoading\.value = false/)
  assert.match(viewSource, /if \(requestId === monthlyRequestId\) monthlyLoading\.value = false/)
  assert.match(viewSource, /if \(requestId === detailRequestId\) detailLoading\.value = false/)
  assert.match(viewSource, /async function handleViewChange\(\)[\s\S]*records\.value = \[\][\s\S]*dailySummary\.value = \{\}[\s\S]*monthlySummaries\.value = \[\]/)
  assert.match(viewSource, /async function handleTeamChange\(\)[\s\S]*detailVisible\.value = false/)
})

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
    vehiclePlate: ' TEST-PLATE-02 ',
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

test('production daily report exposes traceable sources and copies final text only', async () => {
  const source = dailyReportSourceSummary({
    ruleVersion: 'fallback',
    sourceSnapshot: {
      rule: { version: 'production-daily-text-v1-2026-07-17' },
      attendance: {
        currentDate: {
          reviewId: 'review-today',
          reviewedAt: '2026-07-15T01:00:00.000Z',
          submissions: Array.from({ length: 7 }, (_, index) => ({ submissionId: `today-${index}` }))
        },
        previousNaturalDate: {
          reviewId: 'review-yesterday',
          reviewedAt: '2026-07-14T01:00:00.000Z',
          submissions: Array.from({ length: 7 }, (_, index) => ({ submissionId: `yesterday-${index}` }))
        }
      },
      production: {
        previousNaturalDate: '2026-07-14',
        requiredMonths: ['2025-01', '2026-07'],
        schedules: [{ scheduleId: 'schedule-1' }]
      }
    }
  })
  assert.equal(source.ruleVersion, 'production-daily-text-v1-2026-07-17')
  assert.equal(source.attendanceRecordCount, 14)
  assert.equal(source.productionScheduleCount, 1)
  assert.equal(source.previousNaturalDate, '2026-07-14')

  let copied = ''
  await copyPlainText('最终日报文字', {
    clipboard: { async writeText(value) { copied = value } }
  })
  assert.equal(copied, '最终日报文字')
})

test('production daily report page wires fixed generation, versions, tracing and copy controls', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/src/api/reporting.js`, 'utf8')
  const viewSource = fs.readFileSync(`${root}/src/views/reporting/GeneratedDailyReports.vue`, 'utf8')
  const requestSource = fs.readFileSync(`${root}/src/utils/request.js`, 'utf8')
  const requestErrorMessagesSource = fs.readFileSync(`${root}/src/utils/requestErrorMessages.js`, 'utf8')
  const routerSource = fs.readFileSync(`${root}/src/router/index.js`, 'utf8')

  assert.match(apiSource, /generated-daily-reports/)
  assert.match(apiSource, /generateDailyReport/)
  assert.match(viewSource, /report\.daily\.generate/)
  assert.match(viewSource, /复制文字/)
  assert.match(viewSource, /来源追溯/)
  assert.match(viewSource, /availableVersions/)
  assert.match(viewSource, /requestErrorMessage\(error, '生产日报生成失败。'\)/)
  for (const code of [
    'DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED',
    'DAILY_REPORT_ATTENDANCE_INCOMPLETE',
    'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING',
    'DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED',
    'DAILY_REPORT_VERSION_LIMIT_REACHED'
  ]) {
    assert.match(requestErrorMessagesSource, new RegExp(`${code}: '[^']+'`))
  }
  assert.match(requestErrorMessagesSource, /containsChineseText\(message\)/)
  assert.match(requestErrorMessagesSource, /REQUEST_ERROR_CODE_MESSAGES\[code\]/)
  assert.match(requestSource, /localizeRequestError\(error, fallback\)/)
  assert.match(requestSource, /if \(status === 401 && hadToken && !isLoginRequest\)/)
  assert.match(requestSource, /return Promise\.reject\(localizedError\)/)
  assert.match(routerSource, /GeneratedDailyReports/)
})

test('production daily list and detail discard stale team, date and page responses', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const viewSource = fs.readFileSync(`${root}/src/views/reporting/GeneratedDailyReports.vue`, 'utf8')

  assert.match(viewSource, /let listRequestId = 0/)
  assert.match(viewSource, /let detailRequestId = 0/)
  assert.match(viewSource, /const requestId = \+\+listRequestId[\s\S]*reports\.value = \[\][\s\S]*if \(requestId !== listRequestId\) return/)
  assert.match(viewSource, /if \(requestId === listRequestId\) listLoading\.value = false/)
  assert.match(viewSource, /const requestId = \+\+detailRequestId[\s\S]*report\.value = null[\s\S]*if \(requestId !== detailRequestId\) return/)
  assert.match(viewSource, /if \(requestId === detailRequestId\) loading\.value = false/)
  assert.match(viewSource, /async function handleTeamChange\(teamId\)[\s\S]*report\.value = null[\s\S]*reports\.value = \[\]/)
  assert.match(viewSource, /const pageLoading = computed\(\(\) => loading\.value \|\| listLoading\.value\)/)
})
