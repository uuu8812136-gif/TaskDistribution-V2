import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  EQUIPMENT_SCAN_CONTEXT_STATUS,
  equipmentScanPath,
  equipmentScanTeamIdFromRedirect,
  normalizeEquipmentQrToken,
  resolveEquipmentScanContext
} from '../src/utils/equipmentQr.js'
import { safeInternalRedirect, teamSelectionLocation } from '../src/utils/internalRedirect.js'

const token = 'A'.repeat(43)
const teamA = '507f1f77bcf86cd799439011'
const teamB = '507f1f77bcf86cd799439012'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const apiSource = source('../src/api/equipment.js')
const detailSource = source('../src/views/equipment/EquipmentDetail.vue')
const landingSource = source('../src/views/equipment/EquipmentScanLanding.vue')
const loginSource = source('../src/views/Login.vue')
const mainSource = source('../src/main.js')
const routerSource = source('../src/router/index.js')
const teamSelectSource = source('../src/views/TeamSelect.vue')

test('equipment QR payload extracts only an opaque V1 token or a raw compatible token', () => {
  assert.equal(normalizeEquipmentQrToken(token), token)
  assert.equal(normalizeEquipmentQrToken(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token
  })), token)
  assert.equal(normalizeEquipmentQrToken(JSON.stringify({
    v: 1,
    type: 'EQUIPMENT_ASSET',
    token,
    teamId: teamA
  })), '')
  assert.equal(normalizeEquipmentQrToken(`https://example.invalid/equipment-scan/${token}`), '')
  assert.equal(normalizeEquipmentQrToken('short'), '')
})

test('generated QR deep links use a root-local scan route and a validated optional team', () => {
  assert.equal(equipmentScanPath(token), `/equipment-scan/${token}`)
  assert.equal(
    equipmentScanPath(token, teamA.toUpperCase()),
    `/equipment-scan/${token}?teamId=${teamA}`
  )
  assert.throws(() => equipmentScanPath('short', teamA), /二维码令牌无效/)
  assert.throws(() => equipmentScanPath(token, 'not-a-team'), /团队编号无效/)
})

test('internal redirects preserve equipment scans without allowing an external origin', () => {
  const scan = `/equipment-scan/${token}?teamId=${teamA}`
  assert.equal(safeInternalRedirect(scan), scan)
  assert.equal(safeInternalRedirect(` ${scan} `), scan)
  assert.equal(safeInternalRedirect('https://evil.invalid/path'), '')
  assert.equal(safeInternalRedirect('//evil.invalid/path'), '')
  assert.equal(safeInternalRedirect('/\\evil.invalid/path'), '')
  assert.deepEqual(teamSelectionLocation(scan), {
    name: 'TeamSelect',
    query: { redirect: scan }
  })
  assert.equal(equipmentScanTeamIdFromRedirect(scan), teamA)
  assert.equal(equipmentScanTeamIdFromRedirect(`/equipment/${token}?teamId=${teamA}`), '')
  assert.equal(equipmentScanTeamIdFromRedirect(`/equipment-scan/${token}?teamId=bad`), '')
})

test('equipment scan team resolution fails closed and switches only to an accessible team', () => {
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'TEAM',
    activeTeamId: teamA,
    requestedTeamId: teamA,
    accessibleTeamIds: []
  }), {
    status: EQUIPMENT_SCAN_CONTEXT_STATUS.READY,
    teamId: teamA,
    switchTeamId: '',
    requestParams: {}
  })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'TEAM',
    activeTeamId: teamA,
    requestedTeamId: teamB,
    accessibleTeamIds: [teamA, teamB]
  }), {
    status: EQUIPMENT_SCAN_CONTEXT_STATUS.READY,
    teamId: teamB,
    switchTeamId: teamB,
    requestParams: {}
  })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'TEAM',
    activeTeamId: teamA,
    requestedTeamId: teamB,
    accessibleTeamIds: [teamA]
  }), { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_FORBIDDEN })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'TEAM',
    activeTeamId: teamA,
    requestedTeamId: ['bad'],
    accessibleTeamIds: [teamA]
  }), { status: EQUIPMENT_SCAN_CONTEXT_STATUS.INVALID_TEAM })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'GLOBAL_READ_ONLY',
    requestedTeamId: teamB,
    accessibleTeamIds: [teamB]
  }), {
    status: EQUIPMENT_SCAN_CONTEXT_STATUS.READY,
    teamId: teamB,
    switchTeamId: '',
    requestParams: { teamId: teamB }
  })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'GLOBAL_READ_ONLY',
    accessibleTeamIds: [teamB]
  }), { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_REQUIRED })
  assert.deepEqual(resolveEquipmentScanContext({
    mode: 'TEAM_SELECTION',
    requestedTeamId: teamA,
    accessibleTeamIds: [teamA]
  }), { status: EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_SELECTION_REQUIRED })
})

test('web QR rendering, authenticated lookup and landing route stay wired together', () => {
  assert.match(detailSource, /normalizeEquipmentQrToken\(result\?\.qrCode\?\.payload\)/)
  assert.match(detailSource, /name: 'EquipmentScan'/)
  assert.match(detailSource, /query: \{ teamId: session\.activeTeamId \}/)
  assert.match(detailSource, /new URL\(scanLocation\.href, window\.location\.origin\)/)
  assert.match(detailSource, /QRCode\.toDataURL\(qrLink\.value/)
  assert.match(detailSource, /二维码绑定当前系统环境，正式上线后请在正式系统重新生成打印/)
  assert.match(apiSource, /url: `\/equipment\/qr\/\$\{encodeURIComponent\(qrToken\)\}`/)
  assert.match(apiSource, /suppressGlobalError: true/)
  assert.match(routerSource, /path: 'equipment-scan\/:qrToken'/)
  assert.match(routerSource, /component: \(\) => import\('@\/views\/equipment\/EquipmentScanLanding\.vue'\)/)
  assert.match(landingSource, /session\.switchTeam\(context\.switchTeamId\)/)
  assert.match(landingSource, /getEquipmentByQrToken\(qrToken, context\.requestParams\)/)
  assert.match(landingSource, /name: 'EquipmentDetail'/)
  assert.doesNotMatch(landingSource, /equipment\/qr\/|axios|fetch\(/)
})

test('login and team selection preserve the original authenticated scan redirect', () => {
  assert.match(loginSource, /const redirect = safeInternalRedirect\(route\.query\.redirect\)/)
  assert.match(loginSource, /teamSelectionLocation\(redirect\)/)
  assert.match(loginSource, /equipmentScanTeamIdFromRedirect\(redirect\)/)
  assert.match(teamSelectSource, /const redirectTarget = computed\(\(\) => safeInternalRedirect\(route\.query\.redirect\)\)/)
  assert.match(teamSelectSource, /continueToTarget\(\)/)
  assert.match(routerSource, /return teamSelectionLocation\(to\.fullPath\)/)
  assert.match(mainSource, /currentRoute\.name === 'TeamSelect'/)
  assert.match(mainSource, /query: \{ redirect \}/)
})
