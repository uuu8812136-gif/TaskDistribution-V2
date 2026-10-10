import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath) => readFileSync(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8'
)

const taskListSource = read('src/views/tasks/TaskList.vue')
const taskTableSource = read('src/views/tasks/components/TaskTable.vue')
const taskDetailSource = read('src/views/tasks/TaskDetail.vue')
const taskFormatSource = read('src/utils/format.js')
const taskFormSource = read('src/views/tasks/TaskForm.vue')
const extensionListSource = read('src/views/extensions/ExtensionList.vue')
const mainLayoutSource = read('src/layouts/MainLayout.vue')
const routerSource = read('src/router/index.js')
const taskApiSource = read('src/api/task.js')
const fileApiSource = read('src/api/file.js')

test('task list uses aggregate and row server capabilities with a stable action column', () => {
  assert.match(taskListSource, /const canCreate = ref\(false\)/)
  assert.match(taskListSource, /canCreate\.value = canCreateTask\(result\)/)
  assert.match(taskListSource, /const canEditRow = \(task\) => canEditTask\(task\)/)
  assert.match(taskListSource, /const canDeleteRow = \(task\) => canDeleteTask\(task\)/)
  assert.match(taskListSource, /v-if="canEditRow\(row\)"/)
  assert.match(taskListSource, /v-if="canDeleteRow\(row\)"/)
  assert.match(taskListSource, /label="操作" width="170"/)
  assert.doesNotMatch(taskListSource, /const can(?:Create|Edit) = computed\(\(\) => session\.can\('task\./)
  assert.match(taskListSource, /loading\.value = true[\s\S]*?canCreate\.value = false/)
  assert.match(taskListSource, /catch \(error\) \{[\s\S]*?canCreate\.value = false/)
  assert.match(taskListSource, /if \(!canEditRow\(row\)\) return/)
  assert.match(taskListSource, /if \(!canDeleteRow\(row\)\) return/)
  assert.match(taskListSource, /console\.error\('删除失败:'[\s\S]*?await fetchData\(\)/)
  assert.match(taskListSource, /label="是否逾期" width="90"/)
  assert.match(taskListSource, /label="逾期天数" width="90"/)
  assert.match(taskListSource, /rowIsOverdue\(row\)/)
  assert.match(taskListSource, /rowOverdueDays\(row\)/)
  assert.match(taskFormatSource, /overdue: '已逾期'/)
  assert.match(taskFormatSource, /overdue: 'danger'/)
})

test('my-task table renders the same overdue state and days as the task list', () => {
  assert.match(taskTableSource, /label="是否逾期" width="90"/)
  assert.match(taskTableSource, /label="逾期天数" width="90"/)
  assert.match(taskTableSource, /typeof task\?\.isOverdue === 'boolean'/)
  assert.match(taskTableSource, /getTaskOverdueDays\(/)
  assert.match(taskTableSource, /isTaskOverdue\(/)
})

test('task detail privileged actions use fresh server capabilities without CC or session permission gates', () => {
  assert.match(taskDetailSource, /v-if="canReview"[\s\S]*?\{\{ reviewActionLabel \}\}/)
  assert.doesNotMatch(taskDetailSource, /v-if="canReview && isCCUser"/)
  assert.doesNotMatch(taskDetailSource, /session\.can\('task\.review'/)
  assert.match(taskDetailSource, /canReviewAssignedTask\(\{\s+task: task\.value,\s+hasReviewed\s+\}\)/)
  assert.match(taskDetailSource, /!loading\.value && canConfirmTask\(\{ task: task\.value \}\)/)
  assert.match(taskDetailSource, /!loading\.value && canApproveTaskExtension\(\{ task: task\.value \}\)/)
  assert.match(taskDetailSource, /if \(reviewSubmitting\.value \|\| !canReview\.value\) return/)
  assert.match(taskDetailSource, /if \(confirmSubmitting\.value \|\| !canConfirm\.value\) return/)
  assert.match(taskDetailSource, /if \(extensionApprovalSubmitting\.value \|\| !canApproveExtension\.value\) return/)
  assert.equal((taskDetailSource.match(/await refreshAfterMutationError\(error,/g) || []).length, 5)
  assert.match(taskDetailSource, /title="该任务已逾期！"/)
  assert.match(taskDetailSource, /已逾期 \$\{overdueDays\} 天/)
  assert.match(taskDetailSource, /typeof task\.value\.isOverdue === 'boolean'/)
})

test('extension list uses per-request capabilities and revokes stale dialogs on refresh failure', () => {
  assert.match(extensionListSource, /canApproveExtensionRequest\(\{\s+request\s+\}\)/)
  assert.doesNotMatch(extensionListSource, /session\.can\('task\.review'/)
  assert.match(extensionListSource, /currentExtension\.value = \{ \.\.\.currentExtension\.value, capabilities: \{\} \}/)
  assert.match(extensionListSource, /const canApproveCurrent = computed\(\(\) => !loading\.value/)
  assert.match(extensionListSource, /if \(!canApproveRow\(row\)\) return/)
  assert.match(extensionListSource, /console\.error\('审批失败:'[\s\S]*?await fetchData\(\)/)
  assert.match(extensionListSource, /currentExtension\.value = null\s+approveDialogVisible\.value = false/)
})

test('active leadership candidates can reach capability-backed task routes but not static-only views', () => {
  assert.match(mainLayoutSource, /v-if="canAccessAllTasks" index="\/tasks"/)
  assert.match(mainLayoutSource, /isTaskLeadershipCandidateContext\(session\.context\)/)
  assert.match(mainLayoutSource, /session\.hasPermission\('task\.view'\) \|\| canAccessTaskLeadership\.value/)
  assert.match(mainLayoutSource, /v-if="session\.hasPermission\('task\.view'\)" index="\/tasks\/my"/)
  assert.match(mainLayoutSource, /v-if="session\.hasPermission\('task\.view'\)" index="\/tasks\/board"/)

  assert.equal((routerSource.match(/taskLeadershipCandidateAllowed: true/g) || []).length, 5)
  assert.match(routerSource, /isTaskLeadershipCandidateContext\(session\.context\)/)
  assert.match(
    routerSource,
    /!session\.hasPermission\(to\.meta\.permission, to\.meta\.permissionMatch\) &&\s+!taskLeadershipCandidateAllowed/
  )
})

test('task form remains hidden until the server grants create or row edit capability', () => {
  assert.match(taskFormSource, /v-else-if="formReady"/)
  assert.match(taskFormSource, /const formAuthorized = ref\(false\)/)
  assert.match(taskFormSource, /\? canEditTask\(response\.task\)\s+: canCreateTask\(response\)/)
  assert.match(taskFormSource, /if \(submitting\.value \|\| !formAuthorized\.value\) return/)
  assert.match(taskFormSource, /await refreshFormAuthorization\(\)/)
  assert.match(taskFormSource, /当前负责人已接管，您现在没有维护该任务的权限。/)
})

test('task forms and privileged task actions use scoped participant and upload endpoints', () => {
  assert.match(taskFormSource, /getTaskAssignableUsers\(\{ limit: 1000 \}\)/)
  assert.match(taskFormSource, /prepareAttachmentReferences\(fileList\.value, uploadTaskAttachment\)/)
  assert.match(taskApiSource, /url: '\/tasks\/assignable-users'/)
  assert.match(fileApiSource, /url: '\/files\/task-temporary'/)
  assert.match(taskDetailSource, /const uploadTaskActionFile/)
  assert.equal(
    (taskDetailSource.match(/\), uploadTaskActionFile\)/g) || []).length,
    2
  )
})
