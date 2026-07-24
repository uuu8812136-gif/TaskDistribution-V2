export const INVENTORY_STATUS_LABELS = Object.freeze({
  DRAFT: '盘点中',
  PENDING_SUB_DEPARTMENT_MANAGER: '待分部负责人审核',
  PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT: '待副经理/经理助理审核',
  PENDING_DEPARTMENT_MANAGER: '待部门经理终审',
  RETURNED: '已退回修改',
  COMPLETED: '已完成'
})

export const EQUIPMENT_STATUS_OPTIONS = Object.freeze([
  { value: 'IN_USE', label: '在用' },
  { value: 'IDLE', label: '闲置' },
  { value: 'STOPPED', label: '停用' },
  { value: 'SCRAPPED', label: '报废' }
])

export const INVENTORY_DIFFERENCE_LABELS = Object.freeze({
  MISSING: '现场未找到',
  STATUS_MISMATCH: '状态不一致',
  QUANTITY_MISMATCH: '数量不一致',
  LOCATION_MISMATCH: '位置不一致'
})

export function inventoryStatusLabel(value) {
  return INVENTORY_STATUS_LABELS[value] || value || '-'
}

export function inventoryStatusTone(value) {
  if (value === 'COMPLETED') return 'success'
  if (value === 'RETURNED') return 'danger'
  if (value === 'DRAFT') return 'neutral'
  return 'warning'
}

export function inventoryDifferenceText(values = []) {
  return values.map((value) => INVENTORY_DIFFERENCE_LABELS[value] || value).join('、') || '账实一致'
}

export function inventoryItemPayload(form, photoFileIds) {
  return {
    actualPresent: form.actualPresent === true,
    actualStatus: form.actualPresent === true ? form.actualStatus : null,
    actualQuantity: form.actualPresent === true ? Number(form.actualQuantity) : null,
    actualLocation: form.actualPresent === true ? String(form.actualLocation || '').trim() : '',
    differenceNote: String(form.differenceNote || '').trim(),
    photoFileIds: [...photoFileIds],
    expectedVersion: Number(form.expectedVersion)
  }
}

export function approvalStageLabel(value) {
  return {
    INVENTORY_PERSON: '盘点人提交',
    SUB_DEPARTMENT_MANAGER: '分部负责人审核',
    DEPARTMENT_DEPUTY_OR_ASSISTANT: '部门副经理/经理助理审核',
    DEPARTMENT_MANAGER: '部门经理终审'
  }[value] || value || '-'
}
