import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildTransportFields,
  buildTransportPayload,
  createEmptyTransportLoad,
  optionalVehicleTypeOptions
} from '../utils/reporting.js'

const pageSource = readFileSync(
  new URL('../pages/reporting/transport-form.vue', import.meta.url),
  'utf8'
)
const listSource = readFileSync(
  new URL('../pages/reporting/transport-list.vue', import.meta.url),
  'utf8'
)
const reportingIndexSource = readFileSync(
  new URL('../pages/reporting/index.vue', import.meta.url),
  'utf8'
)
const apiSource = readFileSync(new URL('../api/index.js', import.meta.url), 'utf8')

test('mini-program transport form loads five independent master-data choices', () => {
  assert.match(pageSource, /getTransportMasterData/)
  assert.match(pageSource, /:range="tripOptions"/)
  assert.match(pageSource, /:range="routeOptions"/)
  assert.match(pageSource, /:range="vehiclePlateOptions"/)
  assert.match(pageSource, /:range="vehicleTypeOptions"/)
  assert.match(pageSource, /data-testid="transport-vehicle-type-picker"/)
  assert.match(pageSource, /:range="driverOptions"/)
  for (const kind of ['TRIP', 'ROUTE', 'VEHICLE_PLATE', 'DRIVER']) {
    assert.match(pageSource, new RegExp(`optionsFor\\('${kind}'\\)`))
  }
  assert.match(pageSource, /optionalVehicleTypeOptions\(masterData\.value\)/)
  assert.doesNotMatch(pageSource, /<input v-model="form\.vehiclePlate"/)
  assert.doesNotMatch(pageSource, /<input v-model="form\.driverName"/)
  assert.match(apiSource, /get\('\/transport-records\/master-data', params\)/)
  assert.match(pageSource, /requestErrorMessage\(error, '运输基础资料加载失败，请稍后重试'\)/)
  assert.match(pageSource, /uni\.showToast/)
})

test('mini-program transport create entries require the transport reporter role', () => {
  assert.match(pageSource, /if \(!canSubmit\.value\)/)
  assert.match(pageSource, /functionalRoleKeys\?\.includes\('TRANSPORT_REPORTER'\)/)
  assert.match(listSource, /v-if="canSubmit" class="create-button"/)
  assert.match(listSource, /functionalRoleKeys\?\.includes\('TRANSPORT_REPORTER'\)/)
  assert.match(reportingIndexSource, /functionalRoleKeys\?\.includes\('TRANSPORT_REPORTER'\)/)
})

test('mini-program transport payload keeps master ids and linked snapshots', () => {
  const fields = buildTransportFields({
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
    loadDetails: createEmptyTransportLoad(),
    remark: ''
  })

  assert.equal(fields.tripMasterId, 'trip-1')
  assert.equal(fields.routeMasterId, 'route-1')
  assert.equal(fields.vehiclePlateMasterId, 'plate-1')
  assert.equal(fields.vehicleTypeMasterId, 'type-1')
  assert.equal(fields.driverMasterId, 'driver-1')
  assert.equal(fields.vehiclePlate, '鲁AA2991')
  assert.equal(fields.driverName, '张师傅')
})

test('optional vehicle type options expose a clear choice and exclude inactive or unrelated data', () => {
  const activeVehicleType = {
    _id: 'type-active',
    kind: 'VEHICLE_TYPE',
    status: 'ACTIVE',
    name: '厢式货车'
  }
  const options = optionalVehicleTypeOptions([
    activeVehicleType,
    { _id: 'type-disabled', kind: 'VEHICLE_TYPE', status: 'DISABLED', name: '停用车型' },
    { _id: 'driver-active', kind: 'DRIVER', status: 'ACTIVE', name: '张师傅' }
  ])

  assert.deepEqual(options.map(({ value, label }) => ({ value, label })), [
    { value: '', label: '无车型（清空）' },
    { value: 'type-active', label: '厢式货车' }
  ])
  assert.equal(options[0].item, null)
  assert.equal(options[1].item, activeVehicleType)
})

test('choosing the clear vehicle type option submits null id and empty snapshot', () => {
  const clearOption = optionalVehicleTypeOptions([
    { _id: 'type-active', kind: 'VEHICLE_TYPE', status: 'ACTIVE', name: '厢式货车' }
  ])[0]
  const form = {
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
    vehicleTypeMasterId: clearOption.value || '',
    vehicleType: clearOption.item?.name || '',
    driverMasterId: 'driver-1',
    driverName: '张师傅',
    loadDetails: createEmptyTransportLoad(),
    remark: ''
  }

  const payload = buildTransportPayload(form, [
    'aaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbb'
  ])

  assert.equal(payload.vehicleTypeMasterId, null)
  assert.equal(payload.vehicleType, '')
  assert.match(pageSource, /form\.vehicleTypeMasterId = selected\?\.value \|\| ''/)
  assert.match(pageSource, /form\.vehicleType = selected\?\.item\?\.name \|\| ''/)
})
