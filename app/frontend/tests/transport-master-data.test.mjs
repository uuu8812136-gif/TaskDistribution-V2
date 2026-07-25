import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildTransportPayload, emptyTransportLoadDetails } from '../src/utils/reporting.js'

const viewSource = readFileSync(
  new URL('../src/views/reporting/TransportRecords.vue', import.meta.url),
  'utf8'
)
const detailSource = readFileSync(
  new URL('../src/views/reporting/TransportRecordDetail.vue', import.meta.url),
  'utf8'
)
const apiSource = readFileSync(new URL('../src/api/reporting.js', import.meta.url), 'utf8')

test('web transport form exposes five independently maintained master-data dropdowns', () => {
  for (const field of [
    'tripMasterId',
    'routeMasterId',
    'vehiclePlateMasterId',
    'vehicleTypeMasterId',
    'driverMasterId'
  ]) {
    assert.match(viewSource, new RegExp(`v-model="form\\.${field}"`))
  }
  for (const kind of ['TRIP', 'ROUTE', 'VEHICLE_PLATE', 'VEHICLE_TYPE', 'DRIVER']) {
    assert.match(viewSource, new RegExp(`value: '${kind}'`))
  }
  assert.doesNotMatch(viewSource, /v-model="form\.vehiclePlate" readonly/)
  assert.doesNotMatch(viewSource, /v-model="form\.vehicleType" readonly/)
  assert.doesNotMatch(viewSource, /v-model="form\.driverName" readonly/)
  assert.match(viewSource, /vehicleTypeMasterId: \[\{ required: true, message: '请选择车型'/)
  assert.doesNotMatch(viewSource, /车型（选填）/)
  assert.match(viewSource, /基础资料/)
  assert.match(viewSource, /TRANSPORT_REPORTER/)
})

test('web transport create and edit entries require the transport reporter role', () => {
  assert.match(viewSource, /v-if="canSubmit" type="primary" @click="openCreate"/)
  assert.match(viewSource, /v-if="canSubmit" text type="primary" @click="openEdit/)
  assert.match(viewSource, /functionalRoleKeys\?\.includes\('TRANSPORT_REPORTER'\)/)
  assert.match(detailSource, /v-if="canSubmit && record"/)
  assert.match(detailSource, /functionalRoleKeys\?\.includes\('TRANSPORT_REPORTER'\)/)
})

test('web transport master-data maintenance has its own fixed permission', () => {
  assert.match(viewSource, /v-if="canManageMasterData" @click="openMasterData"/)
  assert.match(viewSource, /session\.can\('report\.transport\.master\.manage', \{ write: true, teamRequired: true \}\)/)
  assert.doesNotMatch(viewSource, /const canManageMasterData = computed\(\(\) => canSubmit\.value\)/)
})

test('web master-data name limits match transport snapshot model limits', () => {
  for (const [kind, maxLength] of Object.entries({
    TRIP: 50,
    ROUTE: 200,
    VEHICLE_PLATE: 50,
    VEHICLE_TYPE: 100,
    DRIVER: 100
  })) {
    assert.match(viewSource, new RegExp(`${kind}: ${maxLength}`))
  }
  assert.match(viewSource, /:maxlength="masterNameMaxLength"/)
  assert.doesNotMatch(viewSource, /masterKind === 'ROUTE' \? 200 : 100/)
})

test('web transport API exposes team master-data list and maintenance endpoints', () => {
  assert.match(apiSource, /url: '\/transport-records\/master-data'/)
  assert.match(apiSource, /`\/transport-records\/master-data\/\$\{masterDataId\}`/)
  assert.match(apiSource, /`\/transport-records\/master-data\/\$\{masterDataId\}\/status`/)
})

test('web transport payload carries all five master ids with historical snapshots', () => {
  const payload = buildTransportPayload({
    orgUnitId: 'org-1',
    reportDate: '2026-07-16',
    shift: '白班',
    tripMasterId: 'trip-1',
    tripLabel: '第十车',
    routeMasterId: 'route-1',
    route: '仓库至工厂',
    dispatchType: '配送',
    vehiclePlateMasterId: 'plate-1',
    vehiclePlate: '鲁AA2991',
    vehicleTypeMasterId: 'type-1',
    vehicleType: '厢式货车',
    driverMasterId: 'driver-1',
    driverName: '张师傅',
    loadDetails: emptyTransportLoadDetails(),
    remark: '',
    reason: ''
  }, ['64b000000000000000000001', '64b000000000000000000002'])

  assert.equal(payload.tripMasterId, 'trip-1')
  assert.equal(payload.routeMasterId, 'route-1')
  assert.equal(payload.vehiclePlateMasterId, 'plate-1')
  assert.equal(payload.vehicleTypeMasterId, 'type-1')
  assert.equal(payload.driverMasterId, 'driver-1')
  assert.equal(payload.vehiclePlate, '鲁AA2991')
  assert.equal(payload.driverName, '张师傅')
})
