export const STATUS_APPLICATION_TYPES = Object.freeze([
  { value: 'IDLE', label: '闲置' },
  { value: 'STOPPED', label: '停用' },
  { value: 'SCRAPPED', label: '报废' }
])

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
