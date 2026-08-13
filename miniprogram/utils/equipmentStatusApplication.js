export const STATUS_APPLICATION_TYPES = Object.freeze([
  { value: 'IN_USE', label: '在用' },
  { value: 'IDLE', label: '闲置' },
  { value: 'STOPPED', label: '停用' },
  { value: 'SCRAPPED', label: '报废' }
])

export const STATUS_APPLICATION_CREATE_REQUIREMENT = '发起申请需进入具体团队，并同时配置“设备管理员”和“状态申请”权限。'

export const STATUS_APPLICATION_RETENTION_NOTICE = '错误申请不直接删除；由原发起设备管理员在流程结束前选择“作废申请”，系统保留完整审批记录。'

export const STATUS_APPLICATION_ACTIONS = Object.freeze({
  CREATE: '发起申请',
  RESUBMIT: '修改后重提',
  DEPUTY_APPROVE: '审核通过',
  MANAGER_APPROVE: '终审通过',
  RETURN_TO_CREATOR: '退回修改',
  REJECT: '驳回终止',
  VOID: '作废申请'
})

export function typeLabel(value) {
  return STATUS_APPLICATION_TYPES.find((item) => item.value === value)?.label || value || '-'
}

export function workflowLabel(value) {
  return ({
    DEPUTY_REVIEW_PENDING: '待副经理/经理助理审核',
    MANAGER_REVIEW_PENDING: '待部门经理终审',
    RETURNED_TO_CREATOR: '已退回发起人',
    APPROVED: '已通过',
    REJECTED: '已驳回',
    VOIDED: '已作废'
  }[value] || value || '-')
}

export function actionLabel(value) {
  return STATUS_APPLICATION_ACTIONS[value] || value || '-'
}

export function statusTone(value) {
  if (value === 'APPROVED') return 'success'
  if (value === 'REJECTED' || value === 'VOIDED') return 'danger'
  if (value === 'RETURNED_TO_CREATOR') return 'warning'
  return 'info'
}

export function statusApplicationEmptyText(todoOnly) {
  return todoOnly ? '暂无我的待办' : '暂无状态申请'
}

export function isSameStatusTarget(currentStatus, targetStatus) {
  return Boolean(currentStatus && targetStatus && currentStatus === targetStatus)
}

export function availableStatusTarget(currentStatus, preferredStatus = 'IDLE') {
  if (!isSameStatusTarget(currentStatus, preferredStatus)) return preferredStatus
  return STATUS_APPLICATION_TYPES.find((item) => item.value !== currentStatus)?.value || ''
}
