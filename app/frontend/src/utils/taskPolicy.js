export function taskEntityId(value) {
  const candidate = value && typeof value === 'object' ? value._id : value
  return candidate === undefined || candidate === null ? '' : String(candidate)
}

export function taskTeamId(task) {
  return taskEntityId(task?.teamId)
}

export function hasServerCapability(resource, capability) {
  return resource?.capabilities?.[capability] === true
}

export function canCreateTask(listResponse) {
  return hasServerCapability(listResponse, 'canCreate')
}

export function canEditTask(task) {
  return hasServerCapability(task, 'canEdit')
}

export function canDeleteTask(task) {
  return hasServerCapability(task, 'canDelete')
}

const TASK_LEADERSHIP_POSITION_KEYS = new Set([
  'SUB_DEPARTMENT_MANAGER',
  'SUB_DEPARTMENT_DEPUTY_MANAGER',
  'SUPERVISOR'
])

export function isTaskLeadershipCandidateContext(context) {
  return Boolean(
    context?.mode === 'TEAM' &&
    context?.readOnly !== true &&
    context?.membership?.status === 'ACTIVE' &&
    TASK_LEADERSHIP_POSITION_KEYS.has(context.membership.positionKey)
  )
}

export function hasReviewedTaskRound(reviews, userId, reviewRound = 1) {
  const actorId = taskEntityId(userId)
  const activeRound = Number(reviewRound || 1)
  if (!actorId || !Array.isArray(reviews)) return false
  return reviews.some((review) => (
    taskEntityId(review?.reviewer) === actorId &&
    (!review?.stage || review.stage === 'review') &&
    Number(review?.reviewRound || 1) === activeRound
  ))
}

export function isTaskExecutor(task, userId) {
  const actorId = taskEntityId(userId)
  return Boolean(
    actorId &&
    Array.isArray(task?.executor) &&
    task.executor.some((executor) => taskEntityId(executor) === actorId)
  )
}

export function isTaskCreator(task, userId) {
  const actorId = taskEntityId(userId)
  return Boolean(actorId && taskEntityId(task?.creator) === actorId)
}

export function canAdministrateTask({ isSuperAdmin, membershipRole } = {}) {
  return isSuperAdmin === true || membershipRole === 'PROJECT_ADMIN'
}

export function canConfirmTask({ task } = {}) {
  return hasServerCapability(task, 'canConfirm')
}

export function canApproveTaskExtension(options = {}) {
  return hasServerCapability(options.task, 'canApproveExtension')
}

export function canApproveExtensionRequest({ request } = {}) {
  return hasServerCapability(request, 'canApprove')
}

export function hasSubmittedTaskCompletion(task, userId) {
  const actorId = taskEntityId(userId)
  if (!actorId || !Array.isArray(task?.executorCompletions)) return false
  return task.executorCompletions.some((completion) => (
    taskEntityId(completion?.executor) === actorId && completion?.status === 'completed'
  ))
}

export function taskExtensionOwnerId(task) {
  return taskEntityId(
    task?.isMainTask === false
      ? task?.parentTask?.mainExecutor
      : task?.mainExecutor
  )
}

export function canRequestTaskExtension({
  task,
  userId,
  isTeamMode,
  isReadOnly
} = {}) {
  const actorId = taskEntityId(userId)
  const hasCompletion = Array.isArray(task?.executorCompletions) &&
    task.executorCompletions.some((completion) => completion?.status === 'completed')
  return Boolean(
    task &&
    actorId &&
    isTeamMode &&
    !isReadOnly &&
    task.status === 'in_progress' &&
    !task.hasExtensionRequest &&
    !hasCompletion &&
    taskExtensionOwnerId(task) === actorId
  )
}

export function canCompleteAssignedTask({
  task,
  userId,
  isTeamMode,
  isReadOnly,
  isOverdue = false
} = {}) {
  const completedSubTaskStatuses = new Set(['finished', 'pending_review', 'pending_confirm'])
  const mainTaskReadyAfterPartialCompletion = Boolean(
    task?.isMainTask === true &&
    task?.status === 'partial_completed' &&
    Array.isArray(task?.subTasks) &&
    task.subTasks.length > 0 &&
    task.subTasks.every((subTask) => completedSubTaskStatuses.has(subTask?.status))
  )
  return Boolean(
    task &&
    isTeamMode &&
    !isReadOnly &&
    !isOverdue &&
    (task.status === 'in_progress' || mainTaskReadyAfterPartialCompletion) &&
    isTaskExecutor(task, userId) &&
    !hasSubmittedTaskCompletion(task, userId)
  )
}

export function canReviewAssignedTask({
  task,
  hasReviewed = false
} = {}) {
  return hasServerCapability(task, 'canReview') && hasReviewed !== true
}

export function buildTaskReviewPayload(form = {}, attachments = []) {
  if (!['approved', 'rejected'].includes(form.result)) {
    throw new TypeError('任务审核结果必须选择通过或驳回')
  }
  return {
    content: form.content,
    result: form.result,
    rating: form.rating,
    attachments
  }
}

export function taskDetailLocation(task, { includeTeamId = false, teamId = '' } = {}) {
  const resolvedTeamId = taskEntityId(teamId) || taskTeamId(task)
  return {
    name: 'TaskDetail',
    params: { id: taskEntityId(task) },
    query: includeTeamId && resolvedTeamId ? { teamId: resolvedTeamId } : {}
  }
}

export function taskReadParams(teamId) {
  const normalizedTeamId = taskEntityId(teamId)
  return normalizedTeamId ? { teamId: normalizedTeamId } : {}
}
