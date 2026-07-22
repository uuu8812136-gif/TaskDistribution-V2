import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canApproveTaskExtension,
  canApproveExtensionRequest,
  canCompleteAssignedTask,
  canConfirmTask,
  canRequestTaskExtension,
  canReviewAssignedTask,
  hasReviewedTaskRound,
  hasSubmittedTaskCompletion,
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

test('mini-program review and approval actions match backend resource authorization', () => {
  const reviewTask = {
    ...task,
    creator: 'creator-1',
    ccUsers: [{ _id: 'reviewer-1' }],
    status: 'pending_review'
  }
  const reviewBase = {
    task: reviewTask,
    userId: 'reviewer-1',
    isTeamMode: true,
    isReadOnly: false,
    hasReviewPermission: true
  }
  assert.equal(canReviewAssignedTask(reviewBase), true)
  assert.equal(canReviewAssignedTask({
    ...reviewBase,
    task: { ...reviewTask, status: 'completed' }
  }), false)

  const confirmationBase = {
    ...reviewBase,
    task: { ...reviewTask, status: 'pending_confirm' },
    hasReviewPermission: false
  }
  assert.equal(canConfirmTask({ ...confirmationBase, userId: 'creator-1' }), true)
  assert.equal(canConfirmTask(confirmationBase), false)
  assert.equal(canConfirmTask({ ...confirmationBase, membershipRole: 'PROJECT_ADMIN' }), true)
  assert.equal(canConfirmTask({ ...confirmationBase, isSuperAdmin: true }), true)
  assert.equal(canConfirmTask({
    ...confirmationBase,
    task: {
      ...confirmationBase.task,
      isMainTask: true,
      subTasks: [{ status: 'finished' }, { status: 'pending_review' }]
    },
    userId: 'creator-1'
  }), false)
  assert.equal(canConfirmTask({
    ...confirmationBase,
    task: {
      ...confirmationBase.task,
      isMainTask: true,
      subTasks: [{ status: 'finished' }, { status: 'finished' }]
    },
    userId: 'creator-1'
  }), true)

  const extensionBase = {
    ...confirmationBase,
    task: { ...reviewTask, status: 'extension_pending' }
  }
  assert.equal(canApproveTaskExtension({ ...extensionBase, userId: 'creator-1' }), false)
  assert.equal(canApproveTaskExtension({ ...extensionBase, userId: 'creator-1', hasReviewPermission: true }), true)
  assert.equal(canApproveTaskExtension(extensionBase), false)
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

test('mini-program extension list only exposes approval to the task creator or project admin', () => {
  const request = {
    status: 'pending',
    task: { status: 'extension_pending' },
    applicant: 'executor-1',
    approver: { _id: 'creator-1' }
  }
  const base = {
    request,
    isTeamMode: true,
    isReadOnly: false,
    hasReviewPermission: true
  }
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'creator-1' }), true)
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'executor-1' }), false)
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'executor-1', membershipRole: 'PROJECT_ADMIN' }), true)
  assert.equal(canApproveExtensionRequest({ ...base, userId: 'creator-1', isReadOnly: true }), false)
  assert.equal(canApproveExtensionRequest({ ...base, request: { ...request, status: 'approved' }, userId: 'creator-1' }), false)
  assert.equal(canApproveExtensionRequest({
    ...base,
    request: { ...request, task: { status: 'in_progress' } },
    userId: 'creator-1'
  }), false)
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

test('mini-program task detail hides stale completion timestamps for pending executor rounds', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const source = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  assert.match(source, /completion\.status === 'completed' && completion\.completedAt/)
})
