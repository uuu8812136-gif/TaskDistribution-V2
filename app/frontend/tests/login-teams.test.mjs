import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultLoginTeamId,
  normalizeLoginTeams
} from '../src/utils/loginTeams.js'

test('login teams are normalized without hard-coded option data', () => {
  const teams = normalizeLoginTeams([
    { _id: ' engine ', code: ' ENGINE_LOGISTICS ', name: ' 发动机物流部 ' },
    { _id: 'engine', code: 'DUPLICATE', name: '重复团队' },
    { _id: '', code: 'INVALID', name: '无编号团队' },
    { _id: 'missing-name', code: 'INVALID', name: '  ' },
    null
  ])

  assert.deepEqual(teams, [
    { _id: 'engine', code: 'ENGINE_LOGISTICS', name: '发动机物流部' }
  ])
})

test('gearbox logistics is preferred and otherwise the first API team is selected', () => {
  const teams = normalizeLoginTeams([
    { _id: 'engine', code: 'ENGINE_LOGISTICS', name: '发动机物流部' },
    { _id: 'gearbox', code: 'GEARBOX_LOGISTICS', name: '变速箱物流部' }
  ])

  assert.equal(defaultLoginTeamId(teams), 'gearbox')
  assert.equal(defaultLoginTeamId([teams[0]]), 'engine')
  assert.equal(defaultLoginTeamId([]), '')
  assert.equal(defaultLoginTeamId(null), '')
})
