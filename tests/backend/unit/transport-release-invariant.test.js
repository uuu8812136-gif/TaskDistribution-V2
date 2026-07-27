'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTransportReleaseState
} = require('../../../ops/lib/transportReleaseInvariant');

test('transport release invariant permits unreferenced configurable load types', () => {
  const baseline = {
    format: 'task-distribution-v2-transport-reference-baseline/v1',
    fullyBound: true,
    bindings: [{ recordId: 'record-1', field: 'tripMasterId', referenceId: 'trip-1' }],
    masterIds: ['trip-1']
  };
  const result = validateTransportReleaseState({
    baseline,
    records: [{
      id: 'record-1',
      teamId: 'team-1',
      tripLabel: '第1车',
      tripMasterId: 'trip-1'
    }],
    masters: [
      { id: 'trip-1', teamId: 'team-1', kind: 'TRIP' },
      { id: 'load-1', teamId: 'team-1', kind: 'LOAD_TYPE' }
    ]
  });

  assert.equal(result.status, 'TRANSPORT_REFERENCE_INVARIANTS_OK');
  assert.equal(result.mismatchCount, 0);
});

test('transport release invariant still rejects referenced master changes', () => {
  const baseline = {
    format: 'task-distribution-v2-transport-reference-baseline/v1',
    fullyBound: true,
    bindings: [],
    masterIds: ['trip-1']
  };
  const result = validateTransportReleaseState({
    baseline,
    records: [],
    masters: [{ id: 'load-1', teamId: 'team-1', kind: 'LOAD_TYPE' }]
  });

  assert.equal(result.status, 'TRANSPORT_REFERENCE_INVARIANTS_FAILED');
  assert.deepEqual(result.mismatches, [{
    code: 'MASTER_SET_CHANGED_FOR_FULLY_BOUND_BASELINE',
    added: [],
    removed: ['trip-1']
  }]);
});
