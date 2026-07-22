import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskDetailSource = readFileSync(
  new URL('../src/views/tasks/TaskDetail.vue', import.meta.url),
  'utf8'
)
const messageListSource = readFileSync(
  new URL('../src/views/messages/MessageList.vue', import.meta.url),
  'utf8'
)
const taskBoardSource = readFileSync(
  new URL('../src/views/tasks/TaskBoard.vue', import.meta.url),
  'utf8'
)

test('task review UI distinguishes CC review from final confirmation and supports legacy records', () => {
  assert.match(taskDetailSource, /getReviewStageText\(review\.stage\)/)
  assert.match(taskDetailSource, /stage === 'confirmation' \? '最终确认' : '抄送审核'/)
  assert.doesNotMatch(taskDetailSource, /抄送者确认任务/)
  assert.match(taskDetailSource, />\s*最终确认\s*</)
})

test('task detail exposes a retry action after the initial request fails', () => {
  assert.match(taskDetailSource, /v-if="loadError && !task"/)
  assert.match(taskDetailSource, /@click="fetchData">重新加载/)
  assert.match(taskDetailSource, /task\.value = null/)
})

test('task action uploads synchronize removals before preparing attachment references', () => {
  assert.equal((taskDetailSource.match(/v-model:file-list="(?:complete|review|confirm)Form\.attachments"/g) || []).length, 3)
  assert.match(taskDetailSource, /:on-remove="handleCompleteFileChange"/)
  assert.match(taskDetailSource, /:on-remove="handleReviewFileChange"/)
  assert.match(taskDetailSource, /:on-remove="handleConfirmFileChange"/)
})

test('task mutations remain locked until the refreshed task state is available', () => {
  assert.match(taskDetailSource, /const actionSubmitting = computed/)
  assert.equal((taskDetailSource.match(/await fetchData\(\)/g) || []).length >= 5, true)
  assert.match(taskDetailSource, /:disabled="actionSubmitting"/)
  assert.doesNotMatch(taskDetailSource, /ElMessage\.error\('(提交|审核|确认|申请|审批)失败'\)/)
  assert.match(taskDetailSource, /if \(error\?\.config \|\| error\?\.code === 'ERR_AUTH_CONTEXT_STALE'\) return/)
})

test('task detail never presents a stale completion time for a pending executor round', () => {
  assert.match(
    taskDetailSource,
    /completion\.status === 'completed' && completion\.completedAt/
  )
})

test('opening an unread writable-team message marks it read before navigation', () => {
  assert.match(messageListSource, /const openRelatedResource = async \(row\)/)
  assert.match(
    messageListSource,
    /if \(canModifyMessages\.value && !row\.isRead\)[\s\S]*await markRowAsRead\(row\)[\s\S]*await router\.push\(location\)/
  )
  assert.match(messageListSource, /if \(!row\.isRead\) \{[\s\S]*row\.isRead = true[\s\S]*decreaseUnreadCount\(\)/)
  assert.match(
    messageListSource,
    /catch \(error\) \{\s+console\.error\('打开消息前标记已读失败:'[\s\S]*ElMessage\.error\([\s\S]*return\s+\} finally \{[\s\S]*await router\.push\(location\)/
  )
})

test('message list ignores stale page or tab responses and keeps the newest loading state', () => {
  assert.match(messageListSource, /let listRequestId = 0/)
  assert.match(messageListSource, /const requestId = \+\+listRequestId/)
  assert.match(messageListSource, /messageList\.value = \[\]\s+pagination\.total = 0/)
  assert.match(messageListSource, /if \(requestId !== listRequestId\) return/)
  assert.match(messageListSource, /if \(requestId === listRequestId\) loading\.value = false/)
})

test('message mutations expose row and bulk pending guards', () => {
  assert.match(messageListSource, /const bulkAction = ref\(''\)/)
  assert.match(messageListSource, /const pendingRows = reactive\(\{\}\)/)
  assert.match(messageListSource, /:loading="rowAction\(row\) === 'delete'"/)
  assert.match(messageListSource, /:loading="bulkAction === 'read-all'"/)
  assert.match(messageListSource, /if \(isRowPending\(row\) \|\| bulkAction\.value\) return/)
  assert.match(messageListSource, /bulkAction\.value = 'confirm-read-all'/)
  assert.match(messageListSource, /setRowAction\(row, 'confirm-delete'\)/)
})

test('task board cards are native keyboard-operable buttons', () => {
  assert.match(taskBoardSource, /<button[\s\S]*v-for="task in getTasksByStatus\(status\.value\)"[\s\S]*type="button"[\s\S]*class="task-card"/)
  assert.match(taskBoardSource, /&:focus-visible/)
})

test('task board loads every paginated task state and exposes honest loading and retry states', () => {
  for (const status of [
    'pending',
    'in_progress',
    'partial_completed',
    'extension_pending',
    'extension_approved',
    'completed',
    'pending_review',
    'pending_confirm',
    'finished'
  ]) {
    assert.match(taskBoardSource, new RegExp(`value: '${status}'`))
  }
  assert.match(taskBoardSource, /const TASK_PAGE_SIZE = 500/)
  assert.match(taskBoardSource, /for \(let page = 2; page <= totalPages; page \+= 1\)/)
  assert.match(taskBoardSource, /page, limit: TASK_PAGE_SIZE/)
  assert.match(taskBoardSource, /title="任务看板加载失败"/)
  assert.match(taskBoardSource, /@click="fetchData">重新加载/)
  assert.doesNotMatch(taskBoardSource, /limit: 100/)
})

test('global read-only board cards show the task team using the accessible team context', () => {
  assert.match(taskBoardSource, /v-if="session\.isGlobalReadOnly" class="task-team"/)
  assert.match(taskBoardSource, /session\.teams\.find/)
  assert.match(taskBoardSource, /getTaskTeamName\(task\)/)
})
