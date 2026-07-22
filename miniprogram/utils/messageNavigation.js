import { taskDetailUrl, taskEntityId } from './taskPolicy.js'

const ATTENDANCE_MESSAGE_TYPES = new Set([
  'attendance_missing',
  'attendance_reviewed'
])

function validNaturalDate(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match) return ''
  const [, year, month, day] = match.map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? normalized
    : ''
}

function appendQuery(path, entries) {
  const query = entries
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return query.length ? `${path}${path.includes('?') ? '&' : '?'}${query.join('&')}` : path
}

function teamEntry(message, includeTeamId) {
  const teamId = taskEntityId(message?.teamId)
  return includeTeamId && teamId ? [['teamId', teamId]] : []
}

function taskViewType(messageType) {
  if (messageType === 'task_completed') return 'cc'
  if (messageType === 'task_reviewed' || messageType === 'extension_applied') return 'created'
  return 'executor'
}

export function messageResourceUrl(message, { includeTeamId = false } = {}) {
  if (message?.relatedTask) {
    return taskDetailUrl(message.relatedTask, {
      type: taskViewType(message.type),
      includeTeamId,
      teamId: message.teamId
    })
  }

  const extraData = message?.extraData || {}
  const scopedTeam = teamEntry(message, includeTeamId)
  const statusApplicationId = taskEntityId(extraData.statusApplicationId)
  if (message?.type === 'equipment_status' && statusApplicationId) {
    return appendQuery('/pages/equipment/status-application-detail', [
      ['applicationId', statusApplicationId],
      ...scopedTeam
    ])
  }

  const repairId = taskEntityId(extraData.repairId)
  if (extraData.resourceType === 'REPAIR_ORDER' && repairId) {
    return appendQuery('/pages/equipment/repair-detail', [
      ['repairId', repairId],
      ...scopedTeam
    ])
  }

  if (extraData.resourceType === 'EQUIPMENT_ROUTINE_EXCEPTION') {
    const exceptionId = taskEntityId(extraData.exceptionId)
    if (!exceptionId) return ''
    return appendQuery('/pages/equipment/routine-exception', [
      ['exceptionId', exceptionId],
      ...scopedTeam
    ])
  }

  if (extraData.resourceType === 'EQUIPMENT_ROUTINE_PLAN') {
    const planId = taskEntityId(extraData.planId)
    if (!planId) return ''
    return appendQuery('/pages/equipment/routine-workbench', [
      ['tab', 'plans'],
      ['planId', planId],
      ...scopedTeam
    ])
  }

  if (
    ATTENDANCE_MESSAGE_TYPES.has(message?.type) &&
    extraData.page === '/pages/reporting/attendance'
  ) {
    return appendQuery('/pages/reporting/attendance', [
      ...scopedTeam,
      ['reportDate', validNaturalDate(extraData.reportDate)]
    ])
  }

  return ''
}

export function hasMessageResource(message) {
  return Boolean(messageResourceUrl(message))
}
