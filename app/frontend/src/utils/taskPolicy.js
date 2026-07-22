export function taskEntityId(value) {
  const candidate = value && typeof value === 'object' ? value._id : value
  return candidate === undefined || candidate === null ? '' : String(candidate)
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

function canManageTaskWorkflow({
  task,
  userId,
  isTeamMode,
  isReadOnly,
  hasReviewPermission,
  isSuperAdmin,
  membershipRole,
  status
} = {}) {
  return Boolean(
    task &&
    task.status === status &&
    isTeamMode &&
    !isReadOnly &&
    hasReviewPermission &&
    (
      isTaskCreator(task, userId) ||
      canAdministrateTask({ isSuperAdmin, membershipRole })
    )
  )
}

export function canConfirmTask({
  task,
  userId,
  isTeamMode,
  isReadOnly,
  isSuperAdmin,
  membershipRole
} = {}) {
  const allSubTasksFinished = task?.isMainTask !== true || (
    Array.isArray(task?.subTasks) &&
    task.subTasks.every((subTask) => subTask?.status === 'finished')
  )
  return Boolean(
    task &&
    task.status === 'pending_confirm' &&
    allSubTasksFinished &&
    isTeamMode &&
    !isReadOnly &&
    (
      isTaskCreator(task, userId) ||
      canAdministrateTask({ isSuperAdmin, membershipRole })
    )
  )
}

export function canApproveTaskExtension(options = {}) {
  return canManageTaskWorkflow({ ...options, status: 'extension_pending' })
}

export function canApproveExtensionRequest({
  request,
  userId,
  isTeamMode,
  isReadOnly,
  hasReviewPermission,
  isSuperAdmin,
  membershipRole
} = {}) {
  const actorId = taskEntityId(userId)
  return Boolean(
    request &&
    actorId &&
    request.status === 'pending' &&
    request.task?.status === 'extension_pending' &&
    isTeamMode &&
    !isReadOnly &&
    hasReviewPermission &&
    (
      taskEntityId(request.approver) === actorId ||
      canAdministrateTask({ isSuperAdmin, membershipRole })
    )
  )
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
  userId,
  isTeamMode,
  isReadOnly,
  hasReviewPermission,
  hasReviewed = false
} = {}) {
  const actorId = taskEntityId(userId)
  const isCcUser = Boolean(
    actorId &&
    Array.isArray(task?.ccUsers) &&
    task.ccUsers.some((user) => taskEntityId(user) === actorId)
  )
  return Boolean(
    task &&
    isTeamMode &&
    !isReadOnly &&
    hasReviewPermission &&
    !hasReviewed &&
    isCcUser &&
    task.status === 'pending_review'
  )
}

export function buildTaskReviewPayload(form = {}, attachments = []) {
  if (!['approved', 'rejected'].includes(form.result)) {
    throw new TypeError('Task review result must be approved or rejected')
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
