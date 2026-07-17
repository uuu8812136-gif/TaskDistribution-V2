import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  defaultLoginTeamId,
  normalizeLoginTeams
} from '../utils/loginTeams.js'

test('login team options are normalized and default to gearbox logistics or the first API option', () => {
  const teams = normalizeLoginTeams([
    { _id: ' engine ', code: ' ENGINE_LOGISTICS ', name: ' 发动机物流部 ' },
    { _id: 'gearbox', code: 'GEARBOX_LOGISTICS', name: '变速箱物流部' },
    { _id: 'engine', code: 'DUPLICATE', name: '重复团队' },
    { _id: '', code: 'INVALID', name: '无编号团队' }
  ])

  assert.deepEqual(teams, [
    { _id: 'engine', code: 'ENGINE_LOGISTICS', name: '发动机物流部' },
    { _id: 'gearbox', code: 'GEARBOX_LOGISTICS', name: '变速箱物流部' }
  ])
  assert.equal(defaultLoginTeamId(teams), 'gearbox')
  assert.equal(defaultLoginTeamId([teams[0]]), 'engine')
  assert.equal(defaultLoginTeamId([]), '')
})

test('mini-program login loads public teams and submits the selected teamId', () => {
  const apiSource = readFileSync(new URL('../api/index.js', import.meta.url), 'utf8')
  const storeSource = readFileSync(new URL('../stores/user.js', import.meta.url), 'utf8')
  const loginSource = readFileSync(new URL('../pages/login/index.vue', import.meta.url), 'utf8')

  assert.match(apiSource, /getLoginTeams[\s\S]*?['"]\/auth\/login-teams['"]/)
  assert.match(apiSource, /getLoginTeams[\s\S]*?auth:\s*false[\s\S]*?contextScoped:\s*false/)
  assert.match(storeSource, /async loadLoginTeams\(\)/)
  assert.match(loginSource, /<picker[\s\S]*?range-key="name"[\s\S]*?@change="handleTeamChange"/)
  assert.match(loginSource, /teamId:\s*form\.value\.teamId/)
  assert.match(loginSource, /getSessionEntryRoute\(userStore\.mode\)/)
  assert.match(loginSource, /重新加载/)
  assert.match(loginSource, /暂无可登录的项目团队/)
})
