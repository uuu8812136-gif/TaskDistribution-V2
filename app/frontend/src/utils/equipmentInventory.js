export const INVENTORY_STATUS_OPTIONS = Object.freeze([
  { value: 'DRAFT', label: '盘点中', type: 'info' },
  { value: 'PENDING_SUB_DEPARTMENT_MANAGER', label: '待分部经理审核', type: 'warning' },
  { value: 'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT', label: '待副经理/经理助理审核', type: 'warning' },
  { value: 'PENDING_DEPARTMENT_MANAGER', label: '待部门经理终审', type: 'warning' },
  { value: 'RETURNED', label: '已退回修改', type: 'danger' },
  { value: 'COMPLETED', label: '已完成', type: 'success' }
])

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

export const INVENTORY_STAGE_LABELS = Object.freeze({
  INVENTORY_PERSON: '盘点人提交',
  SUB_DEPARTMENT_MANAGER: '分部经理审核',
  DEPARTMENT_DEPUTY_OR_ASSISTANT: '部门副经理/经理助理审核',
  DEPARTMENT_MANAGER: '部门经理终审'
})

export function inventoryStatusOption(value) {
  return INVENTORY_STATUS_OPTIONS.find((item) => item.value === value) || {
    value,
    label: value || '-',
    type: 'info'
  }
}

export function equipmentStatusLabel(value) {
  return EQUIPMENT_STATUS_OPTIONS.find((item) => item.value === value)?.label || value || '-'
}

export function inventoryDifferenceText(types = []) {
  return types.map((value) => INVENTORY_DIFFERENCE_LABELS[value] || value).join('、') || '账实一致'
}

export function inventoryProgress(session = {}) {
  const itemCount = Number(session.itemCount || 0)
  const checkedCount = Math.min(itemCount, Number(session.checkedCount || 0))
  return {
    checkedCount,
    itemCount,
    percent: itemCount > 0 ? Math.round(checkedCount * 100 / itemCount) : 0
  }
}

export function buildInventoryItemPayload(form, photoFileIds = []) {
  return {
    actualPresent: form.actualPresent === true,
    actualStatus: form.actualPresent === true ? form.actualStatus : null,
    actualQuantity: form.actualPresent === true ? form.actualQuantity : null,
    actualLocation: form.actualPresent === true ? String(form.actualLocation || '').trim() : '',
    differenceNote: String(form.differenceNote || '').trim(),
    photoFileIds: [...photoFileIds],
    expectedVersion: Number(form.expectedVersion)
  }
}

export function inventoryPendingStatusForPosition(positionKey) {
  return {
    SUB_DEPARTMENT_MANAGER: 'PENDING_SUB_DEPARTMENT_MANAGER',
    DEPARTMENT_DEPUTY_MANAGER: 'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT',
    DEPARTMENT_MANAGER_ASSISTANT: 'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT',
    DEPARTMENT_MANAGER: 'PENDING_DEPARTMENT_MANAGER'
  }[positionKey] || ''
}

export function saveInventoryWorkbook(blob, filename = '设备盘点明细.xlsx') {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
