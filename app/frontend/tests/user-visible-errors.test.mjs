import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { prepareAttachmentReferences } from '../src/utils/attachments.js'
import {
  buildEquipmentImportConfirmation,
  buildRoutineRecordPayload,
  buildRoutineRulePayload,
  buildRuntimeReadingPayload
} from '../src/utils/equipment.js'
import { naturalMonthRange } from '../src/utils/reporting.js'
import { buildTaskReviewPayload } from '../src/utils/taskPolicy.js'
import { managementErrorMessage } from '../src/utils/teamManagement.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Web local validation errors use actionable Chinese messages', async () => {
  await assert.rejects(
    prepareAttachmentReferences({}, async () => ({})),
    /附件列表格式不正确/
  )
  await assert.rejects(
    prepareAttachmentReferences([{ name: 'missing-file.png' }], async () => ({})),
    /所选附件缺少文件数据，请重新选择/
  )

  assert.throws(() => buildRoutineRulePayload({
    routineType: 'INSPECTION',
    categoryId: 'category-1',
    name: '点检规则',
    checklistItems: [{ name: '检查制动' }],
    schedule: { mode: 'RUNTIME_HOURS', runtime: { intervalHours: 0 } },
    photoPolicy: 'ON_ABNORMAL'
  }), /运行小时间隔必须大于0/)
  assert.throws(() => buildRoutineRecordPayload({
    ruleId: 'rule-1',
    itemResults: [{ itemKey: 'brake', result: '' }]
  }), /请选择规则并填写所有检查项目结果/)
  assert.throws(
    () => buildRuntimeReadingPayload({ hours: -1 }),
    /运行小时读数必须为大于或等于0的数值/
  )
  assert.throws(
    () => buildEquipmentImportConfirmation({ status: 'FAILED', version: 1 }, [], '确认'),
    /只能确认已经生成预览的导入任务/
  )
  assert.throws(
    () => buildTaskReviewPayload({ result: '' }),
    /任务审核结果必须选择通过或驳回/
  )
  assert.throws(() => naturalMonthRange('2026-13'), /月份无效，请选择1月至12月/)
})

test('management errors never expose an unmapped English server message', () => {
  const error = {
    response: {
      status: 500,
      data: {
        code: 'UNMAPPED_SERVER_FAILURE',
        message: 'Internal Server Error'
      }
    }
  }
  assert.equal(managementErrorMessage(error, '团队管理操作失败'), '团队管理操作失败')
})

test('critical Web error surfaces use the shared localized message helper', () => {
  const files = [
    'src/components/AuthenticatedAttachments.vue',
    'src/views/messages/MessageList.vue',
    'src/views/tasks/TaskBoard.vue',
    'src/views/tasks/TaskDetail.vue',
    'src/views/tasks/TaskList.vue',
    'src/views/equipment/EquipmentInventoryDetail.vue',
    'src/views/equipment/EquipmentRepairDetail.vue',
    'src/views/equipment/EquipmentRepairs.vue',
    'src/views/equipment/EquipmentStatusApplicationDetail.vue',
    'src/views/equipment/EquipmentStatusApplications.vue',
    'src/views/equipment/components/EquipmentRuleDialog.vue',
    'src/views/equipment/components/RoutineExecutionDialog.vue',
    'src/views/equipment/components/RuntimeReadingDialog.vue'
  ]
  const directRawMessage = /ElMessage\.(?:error|warning)\([^\n]*(?:error(?:\?\.|\.)message|response(?:\?\.|\.)data(?:\?\.|\.)message)/

  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(source, /requestErrorMessage\(error,/, `${file} must use requestErrorMessage`)
    assert.doesNotMatch(source, directRawMessage, `${file} must not render raw error messages`)
  }
})
