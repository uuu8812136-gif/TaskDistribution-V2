import { taskDetailLocation, taskEntityId } from './taskPolicy.js'

const ATTENDANCE_MESSAGE_TYPES = new Set(['attendance_missing', 'attendance_reviewed'])
const ATTENDANCE_PAGE = '/pages/reporting/attendance'

function scopedQuery(message, includeTeamId) {
  const teamId = taskEntityId(message?.teamId)
  return includeTeamId && teamId ? { teamId } : {}
}

export function messageResourceLocation(message, { includeTeamId = false } = {}) {
  if (message?.relatedTask) {
    return taskDetailLocation(message.relatedTask, {
      includeTeamId,
      teamId: message.teamId
    })
  }

  const extraData = message?.extraData || {}
  const query = scopedQuery(message, includeTeamId)
  const statusApplicationId = taskEntityId(extraData.statusApplicationId)
  if (message?.type === 'equipment_status' && statusApplicationId) {
    return {
      name: 'EquipmentStatusApplicationDetail',
      params: { applicationId: statusApplicationId },
      query
    }
  }

  const reportDate = String(extraData.reportDate || '')
  if (
    ATTENDANCE_MESSAGE_TYPES.has(message?.type) &&
    extraData.page === ATTENDANCE_PAGE &&
    /^\d{4}-\d{2}-\d{2}$/.test(reportDate)
  ) {
    return {
      name: 'AttendanceReports',
      query: { ...query, reportDate }
    }
  }

  const repairId = taskEntityId(extraData.repairId)
  if (extraData.resourceType === 'REPAIR_ORDER' && repairId) {
    return {
      name: 'EquipmentRepairDetail',
      params: { repairId },
      query
    }
  }

  const equipmentId = taskEntityId(extraData.equipmentId)
  if (extraData.resourceType === 'EQUIPMENT_ROUTINE_EXCEPTION') {
    const exceptionId = taskEntityId(extraData.exceptionId)
    if (!exceptionId) return null
    return {
      name: 'EquipmentRoutineWorkbench',
      query: {
        ...query,
        tab: 'exceptions',
        exceptionId,
        ...(equipmentId ? { equipmentId } : {})
      }
    }
  }

  if (extraData.resourceType === 'EQUIPMENT_ROUTINE_PLAN') {
    const planId = taskEntityId(extraData.planId)
    if (!planId) return null
    return {
      name: 'EquipmentRoutineWorkbench',
      query: {
        ...query,
        tab: 'plans',
        planId,
        ...(equipmentId ? { equipmentId } : {})
      }
    }
  }

  return null
}

export function hasMessageResource(message) {
  return Boolean(messageResourceLocation(message))
}
