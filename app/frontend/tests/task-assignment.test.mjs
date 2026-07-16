import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaskOrgUnitOptions,
  filterTaskParticipants,
  membershipOrgUnitId
} from '../src/utils/taskAssignment.js'

const users = [
  { _id: 'u1', name: '甲', department: 'A分部', membership: { orgUnitId: 'org-1' } },
  { _id: 'u2', name: '乙', department: 'B分部', membership: { orgUnitId: 'org-2' } },
  { _id: 'u3', name: '丙', department: 'A分部', membership: { orgUnitId: 'org-1' } }
]

test('task organization options are deduplicated from scoped team members', () => {
  assert.equal(membershipOrgUnitId(users[0]), 'org-1')
  assert.deepEqual(buildTaskOrgUnitOptions(users), [
    { value: 'org-1', label: 'A分部' },
    { value: 'org-2', label: 'B分部' }
  ])
})

test('team-wide assignment lists only members from the selected organization', () => {
  assert.deepEqual(
    filterTaskParticipants(users, 'org-1', true).map((user) => user._id),
    ['u1', 'u3']
  )
  assert.deepEqual(filterTaskParticipants(users, '', true), [])
  assert.equal(filterTaskParticipants(users, '', false), users)
})
