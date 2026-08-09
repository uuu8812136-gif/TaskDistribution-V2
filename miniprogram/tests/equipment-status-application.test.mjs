import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  STATUS_APPLICATION_CREATE_REQUIREMENT,
  STATUS_APPLICATION_RETENTION_NOTICE,
  STATUS_APPLICATION_TYPES,
  actionLabel,
  availableStatusTarget,
  isSameStatusTarget,
  statusApplicationEmptyText,
  workflowLabel
} from '../utils/equipmentStatusApplication.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('mini program exposes fixed status types and approval chain labels', () => {
  assert.deepEqual(STATUS_APPLICATION_TYPES.map((item) => item.value), ['IDLE', 'STOPPED', 'SCRAPPED'])
  assert.equal(workflowLabel('DEPUTY_REVIEW_PENDING'), '待副经理/经理助理审核')
  assert.equal(workflowLabel('MANAGER_REVIEW_PENDING'), '待部门经理终审')
  assert.equal(actionLabel('RETURN_TO_CREATOR'), '退回修改')
  assert.equal(statusApplicationEmptyText(false), '暂无状态申请')
  assert.equal(statusApplicationEmptyText(true), '暂无我的待办')
  assert.equal(isSameStatusTarget('IDLE', 'IDLE'), true)
  assert.equal(isSameStatusTarget('IN_USE', 'IDLE'), false)
  assert.equal(availableStatusTarget('IDLE', 'IDLE'), 'STOPPED')
  assert.equal(availableStatusTarget('IN_USE', 'IDLE'), 'IDLE')
  assert.equal(STATUS_APPLICATION_CREATE_REQUIREMENT, '发起申请需进入具体团队，并同时配置“设备管理员”和“状态申请”权限。')
  assert.match(STATUS_APPLICATION_RETENTION_NOTICE, /不直接删除.*作废申请.*保留完整审批记录/)
})

test('mini program wires create, todo approval, resubmit attachments, and equipment entry', () => {
  const pages = fs.readFileSync(path.join(root, 'pages.json'), 'utf8')
  const api = fs.readFileSync(path.join(root, 'api/index.js'), 'utf8')
  const list = fs.readFileSync(path.join(root, 'pages/equipment/status-application-list.vue'), 'utf8')
  const form = fs.readFileSync(path.join(root, 'pages/equipment/status-application-form.vue'), 'utf8')
  const detail = fs.readFileSync(path.join(root, 'pages/equipment/status-application-detail.vue'), 'utf8')
  const equipment = fs.readFileSync(path.join(root, 'pages/equipment/detail.vue'), 'utf8')
  assert.match(pages, /pages\/equipment\/status-application-list/)
  assert.match(pages, /pages\/equipment\/status-application-detail/)
  assert.match(api, /transitionEquipmentStatusApplication/)
  assert.match(list, /todo: true/)
  assert.match(list, /当前仅可查看/)
  assert.match(list, /requestVersion/)
  assert.match(list, /failedLoadKind/)
  assert.match(list, /const previousPage = page\.value/)
  assert.match(list, /if \(!succeeded && page\.value === previousPage \+ 1\) page\.value = previousPage/)
  assert.match(list, /retryLoad/)
  assert.match(list, /requestErrorMessage/)
  assert.match(form, /uploadEquipmentStatusAttachment/)
  assert.match(form, /:disabled="isSameStatusTarget\(equipment\?\.status, item\.value\)"/)
  assert.match(form, /目标状态不能与当前状态相同/)
  assert.match(form, /if \(!canCreate\.value\) return/)
  assert.match(form, /returnToPreviousPage/)
  assert.match(detail, /existingAttachments/)
  assert.match(detail, /downloadPrivateFile/)
  assert.match(detail, /STATUS_APPLICATION_RETENTION_NOTICE/)
  assert.match(detail, /状态申请不存在或当前账号无权查看/)
  assert.match(detail, /loadError/)
  assert.match(detail, /retryLoad/)
  assert.match(equipment, /openStatusApplication/)
})
