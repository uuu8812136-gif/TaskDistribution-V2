import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaskReviewPayload,
  canApproveExtensionRequest,
  canApproveTaskExtension,
  canCompleteAssignedTask,
  canConfirmTask,
  canCreateTask,
  canDeleteTask,
  canEditTask,
  canRequestTaskExtension,
  canReviewAssignedTask,
  hasReviewedTaskRound,
  hasServerCapability,
  isTaskLeadershipCandidateContext,
  taskDetailLocation,
  taskReadParams
} from '../src/utils/taskPolicy.js'

const task = {
  _id: 'task-1',
  teamId: { _id: 'team-1' },
  status: 'in_progress',
  executor: [{ _id: 'executor-1' }, { _id: 'executor-2' }],
  executorCompletions: [
    { executor: { _id: 'executor-1' }, status: 'pending' },
    { executor: { _id: 'executor-2' }, status: 'completed' }
  ],
  ccUsers: [{ _id: 'reviewer-1' }]
}

test('an assigned executor can submit only their pending completion in writable team mode', () => {
  const base = { task, isTeamMode: true, isReadOnly: false, isOverdue: false }
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1' }), true)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-2' }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'outsider' }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1', isReadOnly: true }), false)
  assert.equal(canCompleteAssignedTask({ ...base, userId: 'executor-1', isOverdue: true }), false)
})

test('a main executor can complete a partial main task only after every subtask is complete', () => {
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

test('task review UI trusts only the fresh server capability and the active review round', () => {
  const reviewTask = {
    ...task,
    status: 'pending_review',
    capabilities: { canReview: true }
  }
  assert.equal(canReviewAssignedTask({ task: reviewTask, hasReviewed: false }), true)
  assert.equal(canReviewAssignedTask({ task: reviewTask, hasReviewed: true }), false)
  assert.equal(canReviewAssignedTask({ task: { ...reviewTask, capabilities: {} } }), false)
  assert.equal(canReviewAssignedTask({ task: { ...reviewTask, capabilities: { canReview: false } } }), false)
  assert.equal(canReviewAssignedTask({
    task: { ...reviewTask, capabilities: { canReview: 'true' } }
  }), false)
})

test('review history only blocks the same reviewer in the active CC review round', () => {
  const reviews = [
    { reviewer: 'reviewer-1', stage: 'review', reviewRound: 1 },
    { reviewer: { _id: 'reviewer-1' }, stage: 'confirmation', reviewRound: 2 },
    { reviewer: 'reviewer-2', stage: 'review', reviewRound: 2 }
  ]
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-1', 2), false)
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-1', 1), true)
  assert.equal(hasReviewedTaskRound([
    { reviewer: 'reviewer-1' }
  ], 'reviewer-1', 1), true)
  assert.equal(hasReviewedTaskRound(reviews, 'reviewer-2', 2), true)
})

test('confirmation and extension approval use server task capabilities without client role inference', () => {
  const privilegedTask = {
    ...task,
    creator: { _id: 'creator-1' },
    capabilities: {
      canConfirm: true,
      canApproveExtension: true
    }
  }
  assert.equal(canConfirmTask({ task: privilegedTask }), true)
  assert.equal(canApproveTaskExtension({ task: privilegedTask }), true)
  assert.equal(canConfirmTask({ task: { ...privilegedTask, capabilities: {} } }), false)
  assert.equal(canApproveTaskExtension({ task: { ...privilegedTask, capabilities: {} } }), false)
  assert.equal(canConfirmTask({
    task: { ...privilegedTask, capabilities: { canConfirm: false } },
    userId: 'creator-1',
    membershipRole: 'PROJECT_ADMIN',
    isSuperAdmin: true
  }), false)
})

test('the extension list exposes approval only through its server capability', () => {
  const request = {
    status: 'pending',
    approver: { _id: 'creator-1' },
    task: { status: 'extension_pending' },
    capabilities: { canApprove: true }
  }
  assert.equal(canApproveExtensionRequest({ request }), true)
  assert.equal(canApproveExtensionRequest({ request: { ...request, capabilities: {} } }), false)
  assert.equal(canApproveExtensionRequest({
    request: { ...request, capabilities: { canApprove: false } },
    userId: 'creator-1',
    membershipRole: 'PROJECT_ADMIN',
    isSuperAdmin: true
  }), false)
})

test('task list mutations and creation fail closed for legacy or malformed capability payloads', () => {
  const response = { capabilities: { canCreate: true } }
  const row = { capabilities: { canEdit: true, canDelete: true } }

  assert.equal(canCreateTask(response), true)
  assert.equal(canEditTask(row), true)
  assert.equal(canDeleteTask(row), true)
  assert.equal(hasServerCapability(row, 'canEdit'), true)

  for (const legacy of [null, {}, { capabilities: {} }]) {
    assert.equal(canCreateTask(legacy), false)
    assert.equal(canEditTask(legacy), false)
    assert.equal(canDeleteTask(legacy), false)
  }
  assert.equal(canEditTask({ capabilities: { canEdit: 1 } }), false)
  assert.equal(canDeleteTask({ capabilities: { canDelete: 'true' } }), false)
})

test('only active team leadership positions receive the candidate navigation entry', () => {
  const activeSupervisor = {
    mode: 'TEAM',
    readOnly: false,
    membership: { status: 'ACTIVE', positionKey: 'SUPERVISOR' }
  }
  for (const positionKey of [
    'SUB_DEPARTMENT_MANAGER',
    'SUB_DEPARTMENT_DEPUTY_MANAGER',
    'SUPERVISOR'
  ]) {
    assert.equal(isTaskLeadershipCandidateContext({
      ...activeSupervisor,
      membership: { ...activeSupervisor.membership, positionKey }
    }), true)
  }
  assert.equal(isTaskLeadershipCandidateContext({
    ...activeSupervisor,
    membership: { status: 'DISABLED', positionKey: 'SUPERVISOR' }
  }), false)
  assert.equal(isTaskLeadershipCandidateContext({
    ...activeSupervisor,
    membership: { status: 'ACTIVE', positionKey: 'EMPLOYEE' }
  }), false)
  assert.equal(isTaskLeadershipCandidateContext({ ...activeSupervisor, mode: 'GLOBAL_READ_ONLY' }), false)
  assert.equal(isTaskLeadershipCandidateContext({ ...activeSupervisor, readOnly: true }), false)
})

test('an extension request is scoped to the responsible owner without task.edit', () => {
  const mainTask = {
    ...task,
    isMainTask: true,
    mainExecutor: { _id: 'executor-1' },
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

  const subTask = {
    ...mainTask,
    isMainTask: false,
    parentTask: { mainExecutor: 'parent-owner' }
  }
  assert.equal(canRequestTaskExtension({ ...base, task: subTask, userId: 'parent-owner' }), true)
})

test('the Web review payload preserves the explicit approve or reject decision', () => {
  assert.deepEqual(buildTaskReviewPayload({
    content: '存在问题，请管理者确认',
    result: 'rejected',
    rating: 2
  }, [{ fileId: 'file-1' }]), {
    content: '存在问题，请管理者确认',
    result: 'rejected',
    rating: 2,
    attachments: [{ fileId: 'file-1' }]
  })
  assert.throws(
    () => buildTaskReviewPayload({ content: 'invalid', result: 'pending' }),
    /任务审核结果必须选择通过或驳回/
  )
})

test('global read-only task navigation preserves an explicit team context', () => {
  assert.deepEqual(taskDetailLocation(task, { includeTeamId: true }), {
    name: 'TaskDetail',
    params: { id: 'task-1' },
    query: { teamId: 'team-1' }
  })
  assert.deepEqual(taskDetailLocation(task), {
    name: 'TaskDetail',
    params: { id: 'task-1' },
    query: {}
  })
  assert.deepEqual(taskReadParams({ _id: 'team-1' }), { teamId: 'team-1' })
})
