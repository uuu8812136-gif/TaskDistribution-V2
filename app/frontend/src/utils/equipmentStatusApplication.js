export const STATUS_APPLICATION_TYPES = Object.freeze([
  { value: 'IN_USE', label: '在用' },
  { value: 'IDLE', label: '闲置' },
  { value: 'STOPPED', label: '停用' },
  { value: 'SCRAPPED', label: '报废' }
])

const WORKFLOW_LABELS = Object.freeze({
  DEPUTY_REVIEW_PENDING: '待副经理/经理助理审核',
  MANAGER_REVIEW_PENDING: '待部门经理终审',
  RETURNED_TO_CREATOR: '已退回发起人',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  VOIDED: '已作废'
})

const ACTION_LABELS = Object.freeze({
  CREATE: '发起申请',
  RESUBMIT: '修改后重提',
  DEPUTY_APPROVE: '审核通过',
  MANAGER_APPROVE: '终审通过',
  RETURN_TO_CREATOR: '退回修改',
  REJECT: '驳回终止',
  VOID: '作废申请'
})

export function statusApplicationTypeLabel(value) {
  return STATUS_APPLICATION_TYPES.find((item) => item.value === value)?.label || value || '-'
}

export function statusApplicationWorkflowLabel(value) {
  return WORKFLOW_LABELS[value] || value || '-'
}

export function statusApplicationWorkflowTone(value) {
  if (value === 'APPROVED') return 'success'
  if (value === 'REJECTED' || value === 'VOIDED') return 'danger'
  if (value === 'RETURNED_TO_CREATOR') return 'warning'
  return 'primary'
}

export function statusApplicationActionLabel(value) {
  return ACTION_LABELS[value] || value || '-'
}

export function statusApplicationActionTone(value) {
  if (value === 'REJECT' || value === 'VOID') return 'danger'
  if (value === 'RETURN_TO_CREATOR') return 'warning'
  return 'primary'
}
