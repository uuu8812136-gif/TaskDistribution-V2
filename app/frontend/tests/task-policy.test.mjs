import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTaskReviewPayload,
  canApproveExtensionRequest,
  canApproveTaskExtension,
  canCompleteAssignedTask,
  canConfirmTask,
  canRequestTaskExtension,
  canReviewAssignedTask,
  hasReviewedTaskRound,
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

test('a task review action requires both task.review and CC assignment', () => {
  const reviewTask = { ...task, status: 'pending_review' }
  const base = { task: reviewTask, isTeamMode: true, isReadOnly: false, hasReviewed: false }
  assert.equal(canReviewAssignedTask({ ...base, userId: 'reviewer-1', hasReviewPermission: true }), true)
  assert.equal(canReviewAssignedTask({ ...base, userId: 'reviewer-1', hasReviewPermission: false }), false)
  assert.equal(canReviewAssignedTask({ ...base, userId: 'outsider', hasReviewPermission: true }), false)
  assert.equal(canReviewAssignedTask({
    ...base,
    task: { ...reviewTask, status: 'completed' },
    userId: 'reviewer-1',
    hasReviewPermission: true
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

test('final confirmation allows the creator or an administrator without task.review', () => {
  const base = {
    task: { ...task, creator: { _id: 'creator-1' }, status: 'pending_confirm' },
    isTeamMode: true,
    isReadOnly: false,
    hasReviewPermission: false
  }
  assert.equal(canConfirmTask({ ...base, userId: 'creator-1' }), true)
  assert.equal(canConfirmTask({ ...base, userId: 'reviewer-1' }), false)
  assert.equal(canConfirmTask({ ...base, userId: 'reviewer-1', membershipRole: 'PROJECT_ADMIN' }), true)
  assert.equal(canConfirmTask({ ...base, userId: 'reviewer-1', isSuperAdmin: true }), true)
  assert.equal(canConfirmTask({ ...base, userId: 'creator-1', isReadOnly: true }), false)
  assert.equal(canConfirmTask({
    ...base,
    task: {
      ...base.task,
      isMainTask: true,
      subTasks: [{ status: 'finished' }, { status: 'pending_confirm' }]
    },
    userId: 'creator-1'
  }), false)
  assert.equal(canConfirmTask({
    ...base,
    task: {
      ...base.task,
      isMainTask: true,
      subTasks: [{ status: 'finished' }, { status: 'finished' }]
    },
    userId: 'creator-1'
  }), true)

  const extensionBase = {
    ...base,
    task: { ...base.task, status: 'extension_pending' }
  }
  assert.equal(canApproveTaskExtension({ ...extensionBase, userId: 'creator-1' }), false)
  assert.equal(canApproveTaskExtension({ ...extensionBase, userId: 'creator-1', hasReviewPermission: true }), true)
  assert.equal(canApproveTaskExtension({ ...extensionBase, userId: 'reviewer-1' }), false)
})

test('the extension list exposes approval only to the recorded approver or an administrator', () => {
  const request = {
    status: 'pending',
    approver: { _id: 'creator-1' },
    task: { status: 'extension_pending' }
  }
  const base = {
    request,
    isTeamMode: true,
    isReadOnly: false,
    hasReviewPermission: true
  }

  assert.equal(canApproveExtensionRequest({ ...base, userId: 'creator-1' }), true)
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'applicant-1' }), false)
  assert.equal(canApproveExtensionRequest({
    ...base,
    userId: 'project-admin',
    membershipRole: 'PROJECT_ADMIN'
  }), true)
  assert.equal(canApproveExtensionRequest({
    ...base,
    userId: 'creator-1',
    request: { ...request, status: 'approved' }
  }), false)
  assert.equal(canApproveExtensionRequest({
    ...base,
    userId: 'creator-1',
    request: { ...request, task: { status: 'in_progress' } }
  }), false)
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'creator-1', isReadOnly: true }), false)
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
    /approved or rejected/
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
