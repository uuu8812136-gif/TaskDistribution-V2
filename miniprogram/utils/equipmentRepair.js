export const REPAIR_TYPES = Object.freeze([
  Object.freeze({ value: 'FAULT_REPORT', label: '故障报修', shortLabel: '故障报修' }),
  Object.freeze({ value: 'PARTS_REPAIR', label: '需更换配件维修', shortLabel: '更换配件' }),
  Object.freeze({ value: 'NO_PARTS_REPAIR', label: '不需换件维修', shortLabel: '无需换件' })
])

export const REPAIR_STATUS_LABELS = Object.freeze({
  SUB_DEPARTMENT_REVIEW_PENDING: '待分部负责人审核',
  SUB_DEPARTMENT_ACCEPTANCE_PENDING: '待分部负责人验收',
  ASSET_ADMIN_RECEIPT_PENDING: '待设备管理员接单',
  ASSET_ADMIN_PRICING_PENDING: '待设备管理员确认价格',
  DEPUTY_APPROVAL_PENDING: '待副经理/经理助理审批',
  MANAGER_APPROVAL_PENDING: '待部门经理终审',
  RETURNED_TO_CREATOR: '已退回创建人',
  COMPLETED: '已完成',
  VOIDED: '已作废'
})

export const REPAIR_ACTION_LABELS = Object.freeze({
  CREATE: '创建并提交',
  RESUBMIT: '修改后重新提交',
  SUB_DEPARTMENT_APPROVE: '审核通过',
  ACCEPT_RECEIPT: '确认报修接单',
  CONFIRM_PRICING: '确认配件和价格',
  DEPUTY_APPROVE: '签署意见并通过',
  MANAGER_APPROVE: '最终审核通过',
  REJECT_TO_CREATOR: '驳回创建人',
  REJECT_TO_PREVIOUS: '驳回上一级',
  VOID: '作废流程'
})

export const REPAIR_POSITION_LABELS = Object.freeze({
  SUPER_ADMIN: '超级管理员',
  DEPARTMENT_MANAGER: '部门经理',
  DEPARTMENT_DEPUTY_MANAGER: '部门副经理',
  DEPARTMENT_MANAGER_ASSISTANT: '部门经理助理',
  SUB_DEPARTMENT_MANAGER: '分部经理',
  SUB_DEPARTMENT_DEPUTY_MANAGER: '分部副经理',
  SUPERVISOR: '主管',
  TEAM_LEADER: '班组长',
  EMPLOYEE: '员工'
})

export const repairTypeLabel = (value) => (
  REPAIR_TYPES.find((item) => item.value === value)?.label || value || '-'
)

export const repairStatusLabel = (value) => REPAIR_STATUS_LABELS[value] || value || '-'
export const repairActionLabel = (value) => REPAIR_ACTION_LABELS[value] || value || '-'
export const repairPositionLabel = (value) => REPAIR_POSITION_LABELS[value] || '未标注岗位'

export function repairStatusTone(value) {
  if (value === 'COMPLETED') return 'success'
  if (value === 'VOIDED' || value === 'RETURNED_TO_CREATOR') return 'danger'
  return 'warning'
}

let partSequence = 0

export function createRepairPart(index = 0) {
  return {
    itemKey: `part-${Date.now()}-${index}-${++partSequence}`,
    name: '',
    specification: '',
    remark: '',
    quantity: 1,
    unitPrice: 0
  }
}

export function repairLineAmount(item) {
  return Math.round((Number(item?.quantity) || 0) * (Number(item?.unitPrice) || 0) * 100) / 100
}
