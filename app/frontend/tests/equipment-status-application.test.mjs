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

test('web exposes the four fixed status types and fixed approval labels', () => {
  assert.deepEqual(STATUS_APPLICATION_TYPES.map((item) => item.value), ['IN_USE', 'IDLE', 'STOPPED', 'SCRAPPED'])
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

test('web status application UX explains access, empty states, retry, and void retention', () => {
  const list = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentStatusApplications.vue'), 'utf8')
  const detail = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentStatusApplicationDetail.vue'), 'utf8')

  assert.match(list, /发起条件：进入具体团队，并同时配置“设备管理员”和“状态申请”权限/)
  assert.match(list, /当前账号仅可查看/)
  assert.match(list, /暂无需要您处理的状态申请/)
  assert.match(list, /状态申请加载失败，请重新加载/)
  assert.match(list, /@click="retryLoad">重新加载/)
  assert.match(list, /failedPage\.value = requestedPage[\s\S]*page\.value = lastLoadedPage\.value/)
  assert.match(list, /page\.value = failedPage\.value \|\| page\.value[\s\S]*await load\(\)/)
  assert.match(list, /const requestedTeamId = session\.isGlobalReadOnly[\s\S]*requestedTeamId !== \(session\.isGlobalReadOnly/)
  assert.match(list, /async function handleTeamChange\(teamId\) \{\s*\+\+listRequestId[\s\S]*await router\.replace/)
  assert.match(list, /String\(teamId \|\| ''\) !== String\(selectedTeamId\.value \|\| ''\)/)
  assert.match(list, /disabled: item\.value === selectedSourceStatus\.value/)
  assert.match(list, /目标状态不能与设备当前状态相同/)
  assert.match(list, /请说明恢复在用、闲置、停用或报废原因/)
  assert.match(list, /申请不支持删除；填写有误时，由原发起设备管理员在详情中选择“作废申请”/)

  assert.match(detail, /v-else-if="loadError"/)
  assert.match(detail, /状态申请不存在或当前账号无权查看/)
  assert.match(detail, /原发起设备管理员可在申请结束前选择“作废申请”/)
  assert.match(detail, /loadError\.value = requestErrorMessage\(error, '状态申请加载失败，请稍后重试'\)/)
})

test('status application submission suppresses stale UI updates and navigation', () => {
  const list = fs.readFileSync(path.join(root, 'src/views/equipment/EquipmentStatusApplications.vue'), 'utf8')

  assert.match(list, /let submitRequestId = 0/)
  assert.match(list, /function currentPageContext\(\) \{[\s\S]*routeName:[\s\S]*routeTeamId:[\s\S]*contextEpoch: session\.contextEpoch[\s\S]*teamId: currentTeamContextId\(\)/)
  assert.match(list, /const requestId = \+\+submitRequestId\s*const context = currentPageContext\(\)\s*const detailQuery =/)
  assert.match(list, /prepareAttachmentReferences[\s\S]*requestId !== submitRequestId \|\| !isCurrentPageContext\(context\)[\s\S]*cleanupTemporaryFiles\(uploadedFileIds, deleteFile\)[\s\S]*return/)
  assert.match(list, /createEquipmentStatusApplication[\s\S]*requestId !== submitRequestId \|\| !isCurrentPageContext\(context\)\) return[\s\S]*ElMessage\.success[\s\S]*query: detailQuery/)
  assert.match(list, /cleanupTemporaryFiles\(\s*\[\.\.\.uploadedFileIds, \.\.\.\(error\.uploadedFileIds \|\| \[\]\)\],\s*deleteFile\s*\)/)
  assert.match(list, /async function handleTeamChange\(teamId\) \{[\s\S]*\+\+submitRequestId/)
  assert.match(list, /if \(routedTeamId && routedTeamId !== selectedTeamId\.value\) \{[\s\S]*submitRequestId \+= 1[\s\S]*createVisible\.value = false/)
  assert.match(list, /function deactivateStatusApplications\(\) \{[\s\S]*submitRequestId \+= 1[\s\S]*submitting\.value = false/)
  assert.match(list, /onBeforeUnmount\(deactivateStatusApplications\)/)
})
