import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AUDIT_ACTION_OPTIONS,
  AUDIT_RESOURCE_TYPE_OPTIONS,
  buildAuditQuery,
  canViewAudit,
  formatAuditSnapshot
} from '../src/utils/auditLog.js'

test('audit option catalogs are unique and include backend workflow values', () => {
  const actions = AUDIT_ACTION_OPTIONS.map((item) => item.value)
  const resources = AUDIT_RESOURCE_TYPE_OPTIONS.map((item) => item.value)
  assert.equal(new Set(actions).size, actions.length)
  assert.equal(new Set(resources).size, resources.length)
  assert.ok(actions.includes('IMPORT_EXCEPTION_CONFIRM'))
  assert.ok(resources.includes('ATTENDANCE_MONTHLY_SUMMARY'))
  assert.ok(resources.includes('GENERATED_DAILY_REPORT'))
  assert.ok(resources.includes('SUPPLIER'))
  assert.ok(resources.includes('SUPPLIER_CONTRACT_RECORD'))
  assert.ok(resources.includes('SUPPLIER_SETTLEMENT_FEE'))
})

test('audit visibility requires an administrator role and audit.view', () => {
  const permissionKeys = ['audit.view']
  assert.equal(canViewAudit({ isSuperAdmin: true, isGlobalReadOnly: true, permissionKeys }), true)
  assert.equal(canViewAudit({ isSuperAdmin: true, isTeamMode: true, permissionKeys }), true)
  assert.equal(canViewAudit({ isSuperAdmin: true, isTeamMode: true, permissionKeys: [] }), true)
  assert.equal(canViewAudit({
    isTeamMode: true,
    membershipRole: 'PROJECT_ADMIN',
    permissionKeys
  }), true)
  assert.equal(canViewAudit({
    isTeamMode: true,
    membershipRole: 'MEMBER',
    permissionKeys
  }), false)
  assert.equal(canViewAudit({
    isTeamMode: true,
    membershipRole: 'PROJECT_ADMIN',
    permissionKeys: []
  }), false)
})

test('audit query builder trims identifiers and only sends team filters globally', () => {
  const filters = {
    timeRange: ['2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.000Z'],
    targetTeamId: ' team-a ',
    actorUserId: ' actor-a ',
    resourceType: 'TASK',
    action: 'UPDATE',
    resourceId: ' task-a ',
    requestId: ' req-a ',
    page: 2,
    pageSize: 50
  }

  assert.deepEqual(buildAuditQuery(filters, { global: true }), {
    startTime: '2026-07-01T00:00:00.000Z',
    endTime: '2026-07-31T23:59:59.000Z',
    actorUserId: 'actor-a',
    targetTeamId: 'team-a',
    resourceType: 'TASK',
    action: 'UPDATE',
    resourceId: 'task-a',
    requestId: 'req-a',
    page: 2,
    pageSize: 50
  })
  assert.equal(Object.hasOwn(buildAuditQuery(filters), 'targetTeamId'), false)
  assert.equal(formatAuditSnapshot(undefined), '无快照')
})

test('audit route and menu retain administrator, permission, and mode guards', () => {
  const routerSource = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/layouts/MainLayout.vue', import.meta.url), 'utf8')
  const pageSource = readFileSync(new URL('../src/views/audit/AuditLogs.vue', import.meta.url), 'utf8')

  assert.match(routerSource, /path: 'audit-logs'/)
  assert.match(routerSource, /permission: 'audit\.view'/)
  assert.match(routerSource, /teamAdminRequired: true/)
  assert.match(routerSource, /SESSION_MODES\.GLOBAL_READ_ONLY, SESSION_MODES\.TEAM/)
  assert.match(layoutSource, /v-if="canViewAuditLogs" index="\/audit-logs"/)
  assert.doesNotMatch(pageSource, /导出/)
})

test('audit table and pagination stay unambiguous and operable on narrow screens', () => {
  const pageSource = readFileSync(new URL('../src/views/audit/AuditLogs.vue', import.meta.url), 'utf8')

  assert.match(pageSource, /label="操作类型"/)
  assert.match(pageSource, /label="详情" width="86" fixed="right"/)
  assert.match(pageSource, /:pager-count="5"/)
  assert.match(pageSource, /class="audit-pagination"/)
  assert.match(pageSource, /\.audit-pagination :deep\(\.el-pagination__sizes\)/)
  assert.match(pageSource, /:column="detailColumns"/)
  assert.match(pageSource, /const detailColumns = computed\(\(\) => compactDetail\.value \? 1 : 2\)/)
  assert.match(pageSource, /window\.matchMedia\('\(max-width: 680px\)'\)/)
})

test('audit list and detail only accept the latest request', () => {
  const pageSource = readFileSync(new URL('../src/views/audit/AuditLogs.vue', import.meta.url), 'utf8')

  assert.match(pageSource, /let listRequestId = 0/)
  assert.match(pageSource, /let detailRequestId = 0/)
  assert.match(pageSource, /const requestId = \+\+listRequestId[\s\S]*if \(requestId !== listRequestId\) return/)
  assert.match(pageSource, /if \(requestId === listRequestId\) loading\.value = false/)
  assert.match(pageSource, /const requestId = \+\+detailRequestId[\s\S]*if \(requestId !== detailRequestId\) return/)
  assert.match(pageSource, /if \(requestId === detailRequestId\) detailLoading\.value = false/)
})
