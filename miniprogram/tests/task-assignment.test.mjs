import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaskOrgUnitOptions,
  filterTaskParticipants
} from '../utils/taskAssignment.js'

const users = [
  { _id: 'u1', department: 'A分部', membership: { orgUnitId: 'org-1' } },
  { _id: 'u2', department: 'B分部', membership: { orgUnitId: 'org-2' } },
  { _id: 'u3', department: 'A分部', membership: { orgUnitId: 'org-1' } }
]

test('mini-program task organization choices are deduplicated', () => {
  assert.deepEqual(buildTaskOrgUnitOptions(users), [
    { value: 'org-1', label: 'A分部' },
    { value: 'org-2', label: 'B分部' }
  ])
})

test('mini-program assignment follows the selected task organization', () => {
  assert.deepEqual(
    filterTaskParticipants(users, 'org-2', true).map((user) => user._id),
    ['u2']
  )
  assert.deepEqual(filterTaskParticipants(users, null, true), [])
})
