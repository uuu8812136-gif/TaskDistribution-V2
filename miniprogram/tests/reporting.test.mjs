import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ATTENDANCE_NAMED_FIELDS,
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  TRANSPORT_LOAD_FIELDS,
  attendanceEffectiveActualCount,
  attendanceOtherRemarkRows,
  buildOrgUnitOptions,
  buildAttendancePayload,
  buildTransportFields,
  buildTransportPayload,
  businessNaturalDate,
  dailyReportSourceSummary,
  scopedReportingParams
} from '../utils/reporting.js'

test('attendance form emits the fixed two-shift payload and keeps named exceptions', () => {
  const payload = buildAttendancePayload({
    orgUnitId: '64b000000000000000000010',
    reportDate: '2026-07-14',
    authorizedHeadcount: '12',
    registeredHeadcount: '13',
    dayShift: {
      actualAttendanceCount: '11',
      pendingDeparture: { count: '1', names: '测试人员甲、测试人员甲' },
      temporaryWorker: { count: '2', names: '临时甲、临时乙' }
    },
    nightShift: {},
    support: { destination: '物流技术部', count: '1', names: '测试人员乙' },
    otherRemark: ' 测试 ',
    reason: ' 补报 '
  })

  assert.equal(Object.keys(payload.dayShift).length, ATTENDANCE_NAMED_FIELDS.length + 1)
  assert.deepEqual(payload.dayShift.pendingDeparture, { count: 1, names: ['测试人员甲'] })
  assert.deepEqual(payload.dayShift.temporaryWorker, { count: 2, names: ['临时甲', '临时乙'] })
  assert.equal(payload.nightShift.sickLeave.count, 0)
  assert.deepEqual(payload.nightShift.temporaryWorker, { count: 0, names: [] })
  assert.deepEqual(payload.support.names, ['测试人员乙'])
  assert.equal(payload.otherRemark, '测试')
  assert.equal(payload.reason, '补报')
  assert.equal(payload.teamId, undefined)
})

test('attendance summary remarks keep their sub-department labels and old strings remain readable', () => {
  const orgUnits = [{ _id: 'org-1', name: '一分部' }]
  assert.deepEqual(attendanceOtherRemarkRows([
    { orgUnitId: 'org-1', remark: '设备点检' },
    { orgUnitId: 'org-2', remark: '临时调岗' },
    { orgUnitId: 'org-1', remark: '' }
  ], orgUnits), [
    { orgUnitName: '一分部', remark: '设备点检' },
    { orgUnitName: '组织 org-2', remark: '临时调岗' }
  ])
  assert.deepEqual(attendanceOtherRemarkRows([' 旧备注 '], orgUnits), [
    { orgUnitName: '', remark: '旧备注' }
  ])
})

test('attendance cards show effective actuals and retain old-response compatibility', () => {
  assert.equal(attendanceEffectiveActualCount({
    actualAttendanceCount: 122,
    notYetEmployed: { count: 1 },
    temporaryWorker: { count: 2 }
  }), 125)
  assert.equal(attendanceEffectiveActualCount({
    actualAttendanceCount: 122,
    effectiveActualAttendanceCount: 125
  }), 125)
})

const FILE_IDS = [
  '64b000000000000000000001',
  '64b000000000000000000002'
]

function validForm() {
  return {
    teamId: '64b000000000000000000099',
    orgUnitId: '64b000000000000000000010',
    reportDate: '2026-07-16',
    shift: '白班',
    tripLabel: '第1车',
    route: '仓库-工厂',
    dispatchType: '配送',
    vehiclePlate: 'TEST-PLATE-01',
    vehicleTypeMasterId: '64b000000000000000000012',
    vehicleType: '厢式货车',
    driverName: '测试司机',
    loadDetails: {
      standardPlasticPallet: '4',
      woodenBox: ''
    },
    remark: ' 正常 '
  }
}

test('transport form uses the server fixed template and never accepts client team identity', () => {
  assert.equal(TRANSPORT_LOAD_FIELDS.length, 14)
  const fields = buildTransportFields(validForm())
  assert.equal(fields.loadDetails.standardPlasticPallet, 4)
  assert.equal(fields.loadDetails.woodenBox, 0)
  assert.equal(fields.loadDetails.other, 0)
  assert.equal(fields.teamId, undefined)

  const payload = buildTransportPayload(validForm(), FILE_IDS)
  assert.deepEqual(payload.photoFileIds, FILE_IDS)
  assert.equal(payload.remark, '正常')
  assert.equal(payload.teamId, undefined)
})

test('transport submission enforces 2 to 10 private FileAsset ids', () => {
  assert.equal(buildTransportPayload(validForm(), FILE_IDS).photoFileIds.length, 2)
  const tenFileIds = Array.from({ length: 10 }, (_, index) => (
    `64b0000000000000000000${String(index).padStart(2, '0')}`
  ))
  assert.equal(buildTransportPayload(validForm(), tenFileIds).photoFileIds.length, 10)
  assert.throws(() => buildTransportPayload(validForm(), [FILE_IDS[0]]), /2至10张/)
  assert.throws(
    () => buildTransportPayload(validForm(), Array.from({ length: 11 }, (_, index) => (
      `64b0000000000000000000${String(index).padStart(2, '0')}`
    ))),
    /2至10张/
  )
  assert.throws(() => buildTransportPayload(validForm(), ['https://example.test/a.jpg', FILE_IDS[1]]), /无效文件/)
  assert.throws(
    () => buildTransportPayload({ ...validForm(), reportDate: '2026-02-30' }, FILE_IDS),
    /日期格式/
  )
})

test('report reads only include teamId in explicit global read-only mode', () => {
  const teamId = '64b000000000000000000099'
  assert.deepEqual(
    scopedReportingParams('TEAM', teamId, { page: 2, teamId: 'spoofed' }),
    { page: 2 }
  )
  assert.deepEqual(
    scopedReportingParams('GLOBAL_READ_ONLY', teamId, { month: '2026-07' }),
    { month: '2026-07', teamId }
  )
  assert.throws(() => scopedReportingParams('GLOBAL_READ_ONLY', '', {}), /选择/)
})

test('reporting helpers preserve Shanghai natural dates and fixed schedule columns', () => {
  assert.equal(businessNaturalDate(new Date('2026-07-15T16:30:00.000Z')), '2026-07-16')
  assert.deepEqual(
    DAILY_SCHEDULE_FIELDS.map(({ key }) => key),
    ['aLineDay', 'aLineNight', 'northLine', 'transferCaseLine', 'bLineDay', 'bLineNight']
  )
  assert.deepEqual(
    MONTHLY_SCHEDULE_FIELDS.map(({ key }) => key),
    ['aLine', 'northLine', 'transferCaseLine', 'bLineDay', 'bLineNight']
  )
})

test('organization options are scoped, active and deduplicated', () => {
  assert.deepEqual(buildOrgUnitOptions(
    [
      { _id: 'org-a', name: 'A分部', status: 'ACTIVE' },
      { _id: 'org-disabled', name: '停用分部', status: 'DISABLED' }
    ],
    [
      { department: 'A分部旧名', membership: { orgUnitId: 'org-a' } },
      { department: 'B分部', membership: { orgUnitId: 'org-b' } }
    ]
  ), [
    { value: 'org-a', label: 'A分部' },
    { value: 'org-b', label: 'B分部' }
  ])
})

test('production daily source summary keeps review and schedule trace counts', () => {
  const source = dailyReportSourceSummary({
    sourceSnapshot: {
      rule: { version: 'production-daily-text-v1-2026-07-17' },
      attendance: {
        currentDate: {
          reviewId: 'today-review',
          submissions: Array.from({ length: 7 }, (_, index) => ({ id: index }))
        },
        previousNaturalDate: {
          reviewId: 'previous-review',
          submissions: Array.from({ length: 7 }, (_, index) => ({ id: index }))
        }
      },
      production: {
        requiredMonths: ['2025-01', '2026-07'],
        schedules: [{ scheduleId: 'schedule-1' }, { scheduleId: 'schedule-2' }]
      }
    }
  })
  assert.equal(source.ruleVersion, 'production-daily-text-v1-2026-07-17')
  assert.equal(source.currentReviewId, 'today-review')
  assert.equal(source.attendanceRecordCount, 14)
  assert.equal(source.productionScheduleCount, 2)
})

test('mini-program reporting pages use authenticated file APIs and are registered', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')
  const formSource = fs.readFileSync(`${root}/pages/reporting/transport-form.vue`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/reporting/transport-detail.vue`, 'utf8')
  const reportingIndexSource = fs.readFileSync(`${root}/pages/reporting/index.vue`, 'utf8')
  const attendanceSource = fs.readFileSync(`${root}/pages/reporting/attendance.vue`, 'utf8')
  const attendanceFormSource = fs.readFileSync(`${root}/pages/reporting/attendance-form.vue`, 'utf8')
  const dailyReportSource = fs.readFileSync(`${root}/pages/reporting/daily-report.vue`, 'utf8')
  const pages = JSON.parse(fs.readFileSync(`${root}/pages.json`, 'utf8'))
  const registered = new Set(pages.pages.map(({ path }) => path))

  assert.match(apiSource, /upload\('\/files'/)
  assert.doesNotMatch(formSource, /\/uploads\//)
  assert.match(formSource, /sourceType:\s*\['camera',\s*'album'\]/)
  assert.match(detailSource, /downloadPrivateFile/)
  assert.equal(registered.has('pages/reporting/transport-list'), true)
  assert.equal(registered.has('pages/reporting/transport-form'), true)
  assert.equal(registered.has('pages/reporting/transport-detail'), true)
  assert.equal(registered.has('pages/reporting/schedule'), true)
  assert.equal(registered.has('pages/reporting/attendance'), true)
  assert.equal(registered.has('pages/reporting/attendance-form'), true)
  assert.equal(registered.has('pages/reporting/daily-report'), true)
  assert.match(reportingIndexSource, /openAttendance/)
  assert.match(attendanceSource, /getAttendanceDailySummary/)
  assert.match(attendanceSource, /createLatestRequestGate/)
  assert.match(attendanceSource, /date: request\.date/)
  assert.match(attendanceSource, /requestGate\.isCurrent\(request\)/)
  assert.match(attendanceSource, /reviewAttendanceDailySummary/)
  assert.match(attendanceSource, /setClipboardData/)
  assert.deepEqual(
    ATTENDANCE_NAMED_FIELDS.map(({ label }) => label),
    ['请假', '休班', '病假', '旷工', '未入职', '待离职', '临时工']
  )
  assert.match(attendanceSource, /record-shift-details/)
  assert.match(attendanceSource, /v-for="item in namedFields"/)
  assert.match(attendanceSource, /otherRemarkRows/)
  assert.match(attendanceSource, /attendanceSummaryItemText/)
  assert.match(attendanceFormSource, /buildAttendancePayload/)
  assert.match(attendanceFormSource, /createAttendanceSubmission/)
  assert.match(attendanceFormSource, /updateAttendanceSubmission/)
  assert.match(reportingIndexSource, /openDailyReport/)
  assert.match(apiSource, /generated-daily-reports/)
  assert.match(dailyReportSource, /report\.daily\.generate/)
  assert.match(dailyReportSource, /setClipboardData/)
  assert.match(dailyReportSource, /availableVersions/)
  assert.match(dailyReportSource, /来源追溯/)
})
