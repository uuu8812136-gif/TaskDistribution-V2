import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { STATUS_APPLICATION_TYPES, actionLabel, workflowLabel } from '../utils/equipmentStatusApplication.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('mini program exposes fixed status types and approval chain labels', () => {
  assert.deepEqual(STATUS_APPLICATION_TYPES.map((item) => item.value), ['IDLE', 'STOPPED', 'SCRAPPED'])
  assert.equal(workflowLabel('DEPUTY_REVIEW_PENDING'), '待副经理/经理助理审核')
  assert.equal(workflowLabel('MANAGER_REVIEW_PENDING'), '待部门经理终审')
  assert.equal(actionLabel('RETURN_TO_CREATOR'), '退回修改')
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
  assert.match(form, /uploadEquipmentStatusAttachment/)
  assert.match(detail, /existingAttachments/)
  assert.match(detail, /downloadPrivateFile/)
  assert.match(equipment, /openStatusApplication/)
})
