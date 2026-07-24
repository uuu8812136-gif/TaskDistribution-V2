import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { validateTransportReleaseState } = require('../lib/transportReleaseInvariant')

function baseState() {
  return {
    records: [{
      id: 'record-1',
      teamId: 'team-1',
      tripLabel: '第十车',
      tripMasterId: 'trip-1',
      route: '',
      routeMasterId: null,
      vehiclePlate: '',
      vehiclePlateMasterId: null,
      vehicleType: '',
      vehicleTypeMasterId: null,
      driverName: '',
      driverMasterId: null
    }],
    masters: [{ id: 'trip-1', teamId: 'team-1', kind: 'TRIP', name: '第十车' }],
    baseline: {
      format: 'task-distribution-v2-transport-reference-baseline/v1',
      fullyBound: true,
      bindings: [{ recordId: 'record-1', field: 'tripMasterId', referenceId: 'trip-1' }],
      masterIds: ['trip-1']
    }
  }
}

test('master rename is valid because historical snapshot text is immutable, not name-equal', () => {
  const state = baseState()
  state.masters[0].name = '第十车（新名称）'
  const result = validateTransportReleaseState(state)
  assert.equal(result.status, 'TRANSPORT_REFERENCE_INVARIANTS_OK')
  assert.equal(result.nameComparisonsPerformed, false)
  assert.equal(result.mismatchCount, 0)
})

test('an existing historical reference cannot be rebound after a master rename', () => {
  const state = baseState()
  state.masters.push({ id: 'trip-old-name', teamId: 'team-1', kind: 'TRIP', name: '第十车' })
  state.records[0].tripMasterId = 'trip-old-name'
  state.baseline.fullyBound = false
  const result = validateTransportReleaseState(state)
  assert.ok(result.mismatches.some(({ code }) => code === 'EXISTING_REFERENCE_CHANGED'))
})

test('repeat backfill cannot recreate an old-name master for a fully bound baseline', () => {
  const state = baseState()
  state.masters[0].name = '第十车（新名称）'
  state.masters.push({ id: 'trip-old-name', teamId: 'team-1', kind: 'TRIP', name: '第十车' })
  const result = validateTransportReleaseState(state)
  assert.ok(result.mismatches.some(({ code }) => (
    code === 'MASTER_SET_CHANGED_FOR_FULLY_BOUND_BASELINE'
  )))
})

test('references must exist and retain the expected team and kind', () => {
  const missing = baseState()
  missing.records[0].tripMasterId = 'missing'
  missing.baseline.fullyBound = false
  assert.ok(validateTransportReleaseState(missing).mismatches.some(({ code }) => code === 'MASTER_MISSING'))

  const wrongTeam = baseState()
  wrongTeam.masters[0].teamId = 'team-2'
  assert.ok(validateTransportReleaseState(wrongTeam).mismatches.some(({ code }) => code === 'MASTER_TEAM_MISMATCH'))

  const wrongKind = baseState()
  wrongKind.masters[0].kind = 'ROUTE'
  assert.ok(validateTransportReleaseState(wrongKind).mismatches.some(({ code }) => code === 'MASTER_KIND_MISMATCH'))
})
