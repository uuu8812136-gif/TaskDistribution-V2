import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { reconcileExpandedOrgUnitIds } from '../src/utils/teamManagement.js'
import { resolveRequestErrorMessage } from '../src/utils/requestErrorMessages.js'

const organizationSource = readFileSync(
  new URL('../src/views/organization/OrgUnitManagement.vue', import.meta.url),
  'utf8'
)
const managementApiSource = readFileSync(
  new URL('../src/api/teamManagement.js', import.meta.url),
  'utf8'
)

test('organization expansion defaults to roots and preserves only valid manual expansion', () => {
  const units = [
    { _id: 'root', parentId: null, level: 1 },
    { _id: 'division-a', parentId: 'root', level: 2 },
    { _id: 'group-a', parentId: 'division-a', level: 3 },
    { _id: 'division-b', parentId: 'root', level: 2 }
  ]

  assert.deepEqual(reconcileExpandedOrgUnitIds(units), ['root'])
  assert.deepEqual(
    reconcileExpandedOrgUnitIds(units, ['root', 'division-a', 'removed']),
    ['root', 'division-a']
  )
  assert.deepEqual(reconcileExpandedOrgUnitIds(units, []), [])
})

test('organization table uses level colors, controlled expansion and guarded delete action', () => {
  const tableOpeningTag = organizationSource.match(/<el-table\s[\s\S]*?>/)?.[0] || ''
  assert.doesNotMatch(tableOpeningTag, /default-expand-all/)
  assert.match(organizationSource, /:expand-row-keys="expandedRowKeys"/)
  assert.match(organizationSource, /@expand-change="handleExpandChange"/)
  assert.match(organizationSource, /<el-table-column label="操作" width="292" fixed="right" align="center">/)
  for (let level = 1; level <= 5; level += 1) {
    assert.match(organizationSource, new RegExp(`org-row--level-${level}`))
    assert.match(
      organizationSource,
      new RegExp(`org-row--level-${level}[\\s\\S]*?background: #[0-9a-f]{6} !important;`)
    )
  }
  assert.match(organizationSource, /@click="removeOrgUnit\(row\)"/)
  assert.doesNotMatch(organizationSource, /永久删除/)
  assert.match(organizationSource, /历史记录和审计信息会继续保留/)
  assert.match(organizationSource, /组织已移出当前组织树，历史记录与审计信息已保留/)
  assert.match(organizationSource, /仅无下级、无成员且无业务数据的组织可以删除/)
  assert.match(managementApiSource, /method: 'delete'/)
})

test('organization delete conflicts are presented in Chinese', () => {
  assert.equal(resolveRequestErrorMessage({
    code: 'ORG_UNIT_DELETE_HAS_CHILDREN',
    message: 'technical message',
    statusCode: 409
  }), '该组织仍有下级组织，请先删除下级组织')
  assert.equal(resolveRequestErrorMessage({
    code: 'ORG_UNIT_DELETE_HAS_REFERENCES',
    message: 'technical message',
    statusCode: 409
  }), '该组织仍有关联成员或业务数据，不能删除')
})
