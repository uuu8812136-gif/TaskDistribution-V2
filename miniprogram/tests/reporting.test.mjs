import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  TRANSPORT_LOAD_FIELDS,
  buildOrgUnitOptions,
  buildTransportFields,
  buildTransportPayload,
  businessNaturalDate,
  scopedReportingParams
} from '../utils/reporting.js'

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
    vehiclePlate: '鲁A12345',
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

test('mini-program reporting pages use authenticated file APIs and are registered', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')
  const formSource = fs.readFileSync(`${root}/pages/reporting/transport-form.vue`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/reporting/transport-detail.vue`, 'utf8')
  const pages = JSON.parse(fs.readFileSync(`${root}/pages.json`, 'utf8'))
  const registered = new Set(pages.pages.map(({ path }) => path))

  assert.match(apiSource, /upload\('\/files'/)
  assert.doesNotMatch(formSource, /\/uploads\//)
  assert.match(detailSource, /downloadPrivateFile/)
  assert.equal(registered.has('pages/reporting/transport-list'), true)
  assert.equal(registered.has('pages/reporting/transport-form'), true)
  assert.equal(registered.has('pages/reporting/transport-detail'), true)
  assert.equal(registered.has('pages/reporting/schedule'), true)
})
