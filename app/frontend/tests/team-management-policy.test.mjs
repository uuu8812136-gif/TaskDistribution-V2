import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMBERSHIP_ROLES,
  PERMISSION_GROUPS,
  buildMemberCreatePayload,
  buildMemberUpdatePayload,
  buildOrgUnitPayload,
  buildOrgUnitTree,
  canManageMembership,
  isModeAllowed,
  managementErrorMessage
} from '../src/utils/teamManagement.js'

test('fixed permission catalog exposes the 31 backend permission keys without duplicates', () => {
  const keys = PERMISSION_GROUPS.flatMap((group) => group.options.map((option) => option.value))
  assert.equal(keys.length, 31)
  assert.equal(new Set(keys).size, 31)
  assert.deepEqual(PERMISSION_GROUPS.map((group) => group.key), [
    'task',
    'equipment',
    'report',
    'team',
    'audit'
  ])
})

test('member create includes the one-time password while update contains membership fields only', () => {
  const form = {
    username: 'tester',
    password: 'one-time-secret',
    name: '测试用户',
    phone: '13800138000',
    email: 'tester@example.com',
    orgUnitId: 'org-a',
    role: MEMBERSHIP_ROLES.MEMBER,
    positionKey: 'EMPLOYEE',
    positionLevel: 1,
    functionalRoleKeys: ['ASSET_ADMIN'],
    permissionKeys: ['task.view'],
    moduleDataScopes: [{ moduleKey: 'task', scope: 'TEAM' }],
    status: 'ACTIVE',
    reason: '测试'
  }

  const createPayload = buildMemberCreatePayload(form)
  const updatePayload = buildMemberUpdatePayload(form)

  assert.equal(createPayload.password, 'one-time-secret')
  assert.equal(createPayload.username, 'tester')
  assert.equal('password' in updatePayload, false)
  assert.equal('username' in updatePayload, false)
  assert.equal('name' in updatePayload, false)
  assert.equal('positionLevel' in updatePayload, false)
  assert.equal('moduleDataScopes' in updatePayload, false)
  assert.deepEqual(updatePayload.permissionKeys, ['task.view'])
})

test('organization payload never submits server-derived level or path', () => {
  const payload = buildOrgUnitPayload({
    parentId: 'parent-a',
    type: 'SUB_DEPARTMENT',
    code: 'LOGISTICS',
    name: '物流分部',
    status: 'ACTIVE',
    sortOrder: 20,
    reason: '调整组织',
    level: 5,
    path: '/untrusted/'
  })

  assert.deepEqual(payload, {
    parentId: 'parent-a',
    type: 'SUB_DEPARTMENT',
    code: 'LOGISTICS',
    name: '物流分部',
    status: 'ACTIVE',
    sortOrder: 20,
    reason: '调整组织'
  })
})

test('organization tree nests by parent and sorts siblings by sortOrder', () => {
  const tree = buildOrgUnitTree([
    { _id: 'child-b', parentId: 'root', name: '乙', sortOrder: 20 },
    { _id: 'root', parentId: null, name: '根', sortOrder: 0 },
    { _id: 'child-a', parentId: 'root', name: '甲', sortOrder: 10 },
    { _id: 'orphan', parentId: 'missing', name: '孤立', sortOrder: 30 }
  ])

  assert.deepEqual(tree.map((node) => node._id), ['root', 'orphan'])
  assert.deepEqual(tree[0].children.map((node) => node._id), ['child-a', 'child-b'])
})

test('project administrators cannot maintain another project administrator', () => {
  const projectAdminContext = {
    isTeamMode: true,
    isReadOnly: false,
    isSuperAdmin: false,
    membershipRole: MEMBERSHIP_ROLES.PROJECT_ADMIN,
    permissionKeys: ['member.manage']
  }
  const superAdminContext = { ...projectAdminContext, isSuperAdmin: true }

  assert.equal(canManageMembership(projectAdminContext, { role: MEMBERSHIP_ROLES.MEMBER }), true)
  assert.equal(canManageMembership(projectAdminContext, { role: MEMBERSHIP_ROLES.PROJECT_ADMIN }), false)
  assert.equal(canManageMembership(superAdminContext, { role: MEMBERSHIP_ROLES.PROJECT_ADMIN }), true)
  assert.equal(canManageMembership({ ...superAdminContext, isReadOnly: true }, { role: MEMBERSHIP_ROLES.MEMBER }), false)
  assert.equal(canManageMembership({
    ...projectAdminContext,
    membershipRole: MEMBERSHIP_ROLES.MEMBER
  }, { role: MEMBERSHIP_ROLES.MEMBER }), false)
})

test('management route mode checks are explicit', () => {
  assert.equal(isModeAllowed('TEAM', ['TEAM']), true)
  assert.equal(isModeAllowed('GLOBAL_READ_ONLY', ['TEAM']), false)
  assert.equal(isModeAllowed('GLOBAL_READ_ONLY', ['GLOBAL_READ_ONLY', 'TEAM']), true)
  assert.equal(isModeAllowed('TEAM_SELECTION', []), true)
})

test('global username conflicts have a clear localized message', () => {
  const error = { response: { data: { code: 'USERNAME_EXISTS' } } }
  assert.match(managementErrorMessage(error), /全系统必须唯一/)
})
