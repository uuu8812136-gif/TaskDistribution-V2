import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canApproveTaskExtension,
  canApproveExtensionRequest,
  canCompleteAssignedTask,
  canConfirmTask,
  canEnterTaskManagement,
  canRequestTaskExtension,
  canReviewAssignedTask,
  hasServerCapability,
  hasReviewedTaskRound,
  hasSubmittedTaskCompletion,
  isTaskLeadershipCandidate,
  isTaskExecutor,
  taskDetailUrl,
  taskReadParams
} from '../utils/taskPolicy.js'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const task = {
  status: 'in_progress',
  executor: [{ _id: 'executor-1' }, 'executor-2'],
  executorCompletions: [
    { executor: { _id: 'executor-1' }, status: 'pending' },
    { executor: 'executor-2', status: 'completed' }
  ]
}

test('mini-program executor identity handles populated and raw ids', () => {
  assert.equal(isTaskExecutor(task, 'executor-1'), true)
  assert.equal(isTaskExecutor(task, { _id: 'executor-2' }), true)
  assert.equal(isTaskExecutor(task, 'outsider'), false)
  assert.equal(hasSubmittedTaskCompletion(task, 'executor-2'), true)
})

test('mini-program completion entry is resource-scoped instead of task.edit-scoped', () => {
  const base = { task, isTeamMode: true, isReadOnly: false }
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1' }), true)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-2' }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'outsider' }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1', isReadOnly: true }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1', isOverdue: true }), false)
})

test('mini-program enables partial main-task completion only when all subtasks are complete', () => {
  const readyMainTask = {
    ...task,
    isMainTask: true,
    status: 'partial_completed',
    subTasks: [
      { status: 'finished' },
      { status: 'pending_confirm' },
      { status: 'pending_review' }
    ]
  }
  const base = { task: readyMainTask, isTeamMode: true, isReadOnly: false }

  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1' }), true)
  assert.equal(canCompleteAssignedTask({
    ...base,
    task: { ...readyMainTask, subTasks: [{ status: 'finished' }, { status: 'in_progress' }] },
    userId: 'executor-1'
  }), false)
  assert.equal(canCompleteAssignedTask({
    ...base,
    task: { ...readyMainTask, isMainTask: false },
    userId: 'executor-1'
  }), false)
})

test('mini-program extension entry uses responsible-owner resource authorization', () => {
  const mainTask = {
    ...task,
    isMainTask: true,
    mainExecutor: 'executor-1',
    executorCompletions: [],
    hasExtensionRequest: false
  }
  const base = { task: mainTask, isTeamMode: true, isReadOnly: false }
  assert.equal(canRequestTaskExtension({ ...base, userId: 'executor-1' }), true)
  assert.equal(canRequestTaskExtension({ ...base, userId: 'executor-2' }), false)
  assert.equal(canRequestTaskExtension({ ...base, userId: 'executor-1', isReadOnly: true }), false)
  assert.equal(canRequestTaskExtension({
    ...base,
    task: { ...mainTask, executorCompletions: [{ status: 'completed' }] },
    userId: 'executor-1'
  }), false)
})

test('mini-program management actions trust only explicit backend capabilities', () => {
  const capableTask = {
    ...task,
    capabilities: {
      canReview: true,
      canConfirm: true,
      canApproveExtension: true
    }
  }
  assert.equal(canReviewAssignedTask({ task: capableTask }), true)
  assert.equal(canReviewAssignedTask({ task: capableTask, hasReviewed: true }), false)
  assert.equal(canConfirmTask({ task: capableTask }), true)
  assert.equal(canApproveTaskExtension({ task: capableTask }), true)

  const staleTask = {
    ...capableTask,
    capabilities: {
      canReview: false,
      canConfirm: false,
      canApproveExtension: false
    }
  }
  assert.equal(canReviewAssignedTask({ task: staleTask }), false)
  assert.equal(canConfirmTask({ task: staleTask }), false)
  assert.equal(canApproveTaskExtension({ task: staleTask }), false)
  assert.equal(canConfirmTask({ task: { ...task, creator: 'actor-1' } }), false)
})

test('mini-program review history is scoped to the current CC review round', () => {
  const reviews = [
    { reviewer: 'reviewer-1', stage: 'review', reviewRound: 1 },
    { reviewer: 'reviewer-1', stage: 'confirmation', reviewRound: 2 },
    { reviewer: 'reviewer-2', stage: 'review', reviewRound: 2 }
  ]
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-1', 2), false)
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-1', 1), true)
  assert.equal(hasReviewedTaskRound([{ reviewer: 'reviewer-1' }], 'reviewer-1', 1), true)
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-2', 2), true)
})

test('mini-program extension approval fails closed without an explicit server capability', () => {
  assert.equal(canApproveExtensionRequest({
    request: { capabilities: { canApprove: true } }
  }), true)
  assert.equal(canApproveExtensionRequest({
    request: { capabilities: { canApprove: false } }
  }), false)
  assert.equal(canApproveExtensionRequest({ request: {} }), false)
  assert.equal(canApproveExtensionRequest({
    request: { status: 'pending', approver: 'actor-1' },
    userId: 'actor-1',
    membershipRole: 'PROJECT_ADMIN'
  }), false)
})

test('server capability parsing accepts only an own literal true value', () => {
  assert.equal(hasServerCapability({ capabilities: { canCreate: true } }, 'canCreate'), true)
  assert.equal(hasServerCapability({ capabilities: { canCreate: false } }, 'canCreate'), false)
  assert.equal(hasServerCapability({ capabilities: { canCreate: 1 } }, 'canCreate'), false)
  assert.equal(hasServerCapability({ capabilities: { canCreate: 'true' } }, 'canCreate'), false)
  assert.equal(hasServerCapability({}, 'canCreate'), false)

  const inherited = Object.create({ canCreate: true })
  assert.equal(hasServerCapability({ capabilities: inherited }, 'canCreate'), false)
})

test('fixed sub-department leaders may enter task management without stored permissions', () => {
  const context = {
    mode: 'TEAM',
    readOnly: false,
    activeTeamId: 'team-1',
    membership: { status: 'ACTIVE', positionKey: 'SUPERVISOR' }
  }
  for (const positionKey of [
    'SUB_DEPARTMENT_MANAGER',
    'SUB_DEPARTMENT_DEPUTY_MANAGER',
    'SUPERVISOR'
  ]) {
    const candidate = {
      ...context,
      membership: { ...context.membership, positionKey }
    }
    assert.equal(isTaskLeadershipCandidate(candidate), true)
    assert.equal(canEnterTaskManagement({ context: candidate }), true)
  }

  assert.equal(canEnterTaskManagement({
    context: {
      ...context,
      membership: { ...context.membership, positionKey: 'EMPLOYEE' }
    }
  }), false)
  assert.equal(canEnterTaskManagement({ context: {}, hasTaskViewPermission: true }), true)
  assert.equal(isTaskLeadershipCandidate({ ...context, mode: 'GLOBAL_READ_ONLY' }), false)
  assert.equal(isTaskLeadershipCandidate({ ...context, readOnly: true }), false)
  assert.equal(isTaskLeadershipCandidate({
    ...context,
    membership: { ...context.membership, status: 'DISABLED' }
  }), false)
})

test('a refreshed false capability immediately revokes a previously visible action', () => {
  const beforeRestore = { capabilities: { canEdit: true, canDelete: true } }
  const afterRestore = { capabilities: { canEdit: false, canDelete: false } }
  assert.equal(hasServerCapability(beforeRestore, 'canEdit'), true)
  assert.equal(hasServerCapability(afterRestore, 'canEdit'), false)
  assert.equal(hasServerCapability(afterRestore, 'canDelete'), false)
})

test('mini-program global task navigation and reads preserve an explicit team context', () => {
  const globalTask = { _id: 'task-1', teamId: { _id: 'team-2' } }
  assert.equal(
    taskDetailUrl(globalTask, { type: 'created', includeTeamId: true }),
    '/pages/task/detail?id=task-1&type=created&teamId=team-2'
  )
  assert.equal(
    taskDetailUrl(globalTask, { type: 'created' }),
    '/pages/task/detail?id=task-1&type=created'
  )
  assert.deepEqual(taskReadParams('team-2'), { teamId: 'team-2' })
  assert.deepEqual(taskReadParams(''), {})
})

test('mini-program final confirmation posts an explicit confirmation opinion', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  assert.match(apiSource, /confirmTask = \(id, data = \{\}\)/)
  assert.match(apiSource, /post\(`\/tasks\/\$\{id\}\/confirm`, data\)/)
  assert.match(detailSource, /Promise\.all\(\[loadTaskDetail\(\), loadReviewRecords\(\)\]\)/)
  assert.match(detailSource, /confirmTask\(taskId\.value, \{ content: '已确认任务完成' \}\)/)
})

test('mini-program message pagination reads the backend pagination envelope', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = fs.readFileSync(`${root}/pages/message/index.vue`, 'utf8')
  assert.match(source, /res\.pagination\?\.total \?\? res\.total \?\? 0/)
  assert.match(source, /messages\.value\.length < total/)
})

test('mini-program task pagination reads the backend pagination envelope', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = fs.readFileSync(`${root}/pages/task/manage.vue`, 'utf8')
  assert.match(source, /res\.pagination\?\.total \?\? res\.total \?\? 0/)
  assert.match(source, /taskList\.value\.length < total/)
})

test('mini-program task actions are authorized by resource identity rather than navigation tab', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  assert.doesNotMatch(source, /viewType\.value/)
  assert.match(source, /canCompleteAssignedTask\(/)
  assert.match(source, /canReviewAssignedTask\(/)
  assert.match(source, /canRequestTaskExtension\(/)
})

test('mini-program task management routes use live capabilities without static-permission fallback', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manageSource = fs.readFileSync(`${root}/pages/task/manage.vue`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  const formSource = fs.readFileSync(`${root}/pages/task/form.vue`, 'utf8')
  const reviewSource = fs.readFileSync(`${root}/pages/task/review.vue`, 'utf8')
  const extensionListSource = fs.readFileSync(`${root}/pages/extension/list.vue`, 'utf8')
  const approvalSource = fs.readFileSync(`${root}/pages/task/approve-extension.vue`, 'utf8')
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')

  assert.match(manageSource, /canEnterTaskManagement\(/)
  assert.match(manageSource, /hasServerCapability\(res, 'canCreate'\)/)
  assert.doesNotMatch(manageSource, /userStore\.can\('task\.create'/)
  assert.doesNotMatch(manageSource, /if \(!userStore\.can\('task\.view'\)\)/)

  assert.match(detailSource, /hasServerCapability\(taskDetail\.value, 'canEdit'\)/)
  assert.match(detailSource, /hasServerCapability\(taskDetail\.value, 'canDelete'\)/)
  assert.match(detailSource, /capabilities: \{\}/)
  assert.match(detailSource, /detailRequestGate\.begin\(/)
  assert.match(detailSource, /detailRequestGate\.isCurrent\(request\)/)
  assert.match(detailSource, /onUnmounted\(\(\) => detailRequestGate\.invalidate\(\)\)/)
  assert.doesNotMatch(detailSource, /userStore\.can\('task\.(?:edit|review)'/)

  assert.match(formSource, /getAllTasks\(\{ page: 1, limit: 1 \}\)/)
  assert.match(formSource, /getTaskAssignableUsers\(\{/)
  assert.match(formSource, /limit: includeUsers \? 1000 : 1/)
  assert.doesNotMatch(formSource, /userStore\.can\('task\.assign'/)
  assert.match(formSource, /uploadTaskScopedAttachment\(file, isEdit\.value/)
  assert.match(formSource, /\? \{ taskId: taskId\.value \}/)
  assert.match(formSource, /: \{ orgUnitId: orgUnitId\.value \}/)
  assert.match(formSource, /fetchCurrentCapability\(\)/)
  assert.match(formSource, /hasServerCapability\(task, 'canEdit'\)/)
  assert.doesNotMatch(formSource, /requiredPermissions/)

  assert.match(reviewSource, /getTaskDetail\(taskId\.value\)/)
  assert.match(reviewSource, /getTaskReviews\(taskId\.value\)/)
  assert.match(reviewSource, /refreshAuthorizedTask\(\)/)
  assert.match(reviewSource, /uploadTaskScopedAttachment\(file, \{/)
  assert.match(reviewSource, /taskId: taskId\.value/)
  assert.doesNotMatch(reviewSource, /userStore\.can\('task\.review'/)

  assert.match(extensionListSource, /canApproveExtensionRequest\(\{ request \}\)/)
  assert.match(extensionListSource, /getExtensionRequest\(ext\._id\)/)
  assert.doesNotMatch(extensionListSource, /userStore\.can\('task\.review'/)

  assert.match(approvalSource, /getExtensionRequest\(requestId\)/)
  assert.match(approvalSource, /refreshAuthorizedRequest\(\{ preserveApprovedDays: true \}\)/)
  assert.doesNotMatch(approvalSource, /userStore\.can\('task\.review'/)
  assert.match(apiSource, /getExtensionRequest = \(id\)/)
  assert.match(apiSource, /get\(`\/extensions\/\$\{id\}`\)/)
  assert.match(apiSource, /getTaskAssignableUsers = \(params = \{\}\)/)
  assert.match(apiSource, /get\('\/tasks\/assignable-users', params\)/)
  assert.match(apiSource, /uploadTaskScopedAttachment = async/)
  assert.match(apiSource, /upload\(taskTemporaryUploadUrl\(\{ taskId, orgUnitId \}\)/)
})

test('mini-program task detail hides stale completion timestamps for pending executor rounds', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  assert.match(source, /completion\.status === 'completed' && completion\.completedAt/)
})
