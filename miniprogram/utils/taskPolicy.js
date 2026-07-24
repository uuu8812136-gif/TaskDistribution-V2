export function taskEntityId(value) {
  const candidate = value && typeof value === 'object' ? value._id : value
  return candidate === undefined || candidate === null ? '' : String(candidate)
}

const TASK_LEADERSHIP_POSITION_KEYS = new Set([
  'SUB_DEPARTMENT_MANAGER',
  'SUB_DEPARTMENT_DEPUTY_MANAGER',
  'SUPERVISOR'
])

export function hasServerCapability(resource, capability) {
  if (!resource || typeof resource !== 'object' || typeof capability !== 'string') return false
  const capabilities = resource.capabilities
  return Boolean(
    capabilities &&
    typeof capabilities === 'object' &&
    Object.prototype.hasOwnProperty.call(capabilities, capability) &&
    capabilities[capability] === true
  )
}

export function isTaskLeadershipCandidate(context) {
  return Boolean(
    context?.mode === 'TEAM' &&
    context?.readOnly !== true &&
    context?.activeTeamId &&
    context?.membership?.status === 'ACTIVE' &&
    TASK_LEADERSHIP_POSITION_KEYS.has(context.membership.positionKey)
  )
}

export function canEnterTaskManagement({ context, hasTaskViewPermission = false } = {}) {
  return hasTaskViewPermission === true || isTaskLeadershipCandidate(context)
}

export function taskTeamId(task) {
  return taskEntityId(task?.teamId)
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

export function taskDetailUrl(task, {
  type = '',
  includeTeamId = false,
  teamId = ''
} = {}) {
  const taskId = taskEntityId(task)
  if (!taskId) throw new TypeError('任务编号缺失')

  const query = [`id=${encodeURIComponent(taskId)}`]
  if (type) query.push(`type=${encodeURIComponent(type)}`)
  const resolvedTeamId = taskEntityId(teamId) || taskTeamId(task)
  if (includeTeamId && resolvedTeamId) {
    query.push(`teamId=${encodeURIComponent(resolvedTeamId)}`)
  }
  return `/pages/task/detail?${query.join('&')}`
}

export function taskReadParams(teamId) {
  const normalizedTeamId = taskEntityId(teamId)
  return normalizedTeamId ? { teamId: normalizedTeamId } : {}
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

export function canConfirmTask({ task } = {}) {
  return hasServerCapability(task, 'canConfirm')
}

export function canApproveTaskExtension(options = {}) {
  return hasServerCapability(options.task, 'canApproveExtension')
}

export function canApproveExtensionRequest({ request } = {}) {
  return hasServerCapability(request, 'canApprove')
}

export function canReviewAssignedTask({
  task,
  hasReviewed = false
} = {}) {
  return hasServerCapability(task, 'canReview') && hasReviewed !== true
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
