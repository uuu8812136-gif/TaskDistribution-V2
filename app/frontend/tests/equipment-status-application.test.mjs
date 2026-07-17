import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  STATUS_APPLICATION_TYPES,
  statusApplicationActionLabel,
  statusApplicationWorkflowLabel,
  statusApplicationWorkflowTone
} from '../src/utils/equipmentStatusApplication.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('web exposes the three fixed status types and fixed approval labels', () => {
  assert.deepEqual(STATUS_APPLICATION_TYPES.map((item) => item.value), ['IDLE', 'STOPPED', 'SCRAPPED'])
  assert.equal(statusApplicationWorkflowLabel('DEPUTY_REVIEW_PENDING'), '待副经理/经理助理审核')
  assert.equal(statusApplicationWorkflowLabel('MANAGER_REVIEW_PENDING'), '待部门经理终审')
  assert.equal(statusApplicationActionLabel('RESUBMIT'), '修改后重提')
  assert.equal(statusApplicationWorkflowTone('APPROVED'), 'success')
})

test('web status application routes, attachment flow, and equipment entry are wired', () => {
  const api = fs.readFileSync(path.join(root, 'src/api/equipment.js'), 'utf8')
  const router = fs.readFileSync(path.join(root, 'src/router/index.js'), 'utf8')
  const list = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentStatusApplications.vue'), 'utf8')
  const detail = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentStatusApplicationDetail.vue'), 'utf8')
  const equipmentDetail = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentDetail.vue'), 'utf8')
  assert.match(api, /\/equipment\/status-applications/)
  assert.match(router, /EquipmentStatusApplicationDetail/)
  assert.match(list, /prepareAttachmentReferences/)
  assert.match(detail, /RESUBMIT/)
  assert.match(detail, /existingAttachmentFileList/)
  assert.match(equipmentDetail, /createStatusApplication/)
})
