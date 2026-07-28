import request from '@/utils/request'

export const getEquipmentList = (params) => request({
  url: '/equipment',
  method: 'get',
  params
})

export const getEquipmentDetail = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}`,
  method: 'get',
  params
})

export const createEquipment = (data) => request({
  url: '/equipment',
  method: 'post',
  data
})

export const updateEquipment = (equipmentId, data) => request({
  url: `/equipment/${equipmentId}`,
  method: 'patch',
  data
})

export const deleteEquipment = (equipmentId, data = {}) => request({
  url: `/equipment/${equipmentId}`,
  method: 'delete',
  data
})

export const getEquipmentOptions = (params) => request({
  url: '/equipment/options',
  method: 'get',
  params
})

export const getEquipmentCategories = (params) => request({
  url: '/equipment/categories',
  method: 'get',
  params
})

export const createEquipmentCategory = (data) => request({
  url: '/equipment/categories',
  method: 'post',
  data
})

export const updateEquipmentCategory = (categoryId, data) => request({
  url: `/equipment/categories/${categoryId}`,
  method: 'patch',
  data
})

export const disableEquipmentCategory = (categoryId, data = {}) => request({
  url: `/equipment/categories/${categoryId}`,
  method: 'delete',
  data
})

export const getEquipmentHistory = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}/history`,
  method: 'get',
  params
})

export const generateEquipmentQrCode = (equipmentId) => request({
  url: `/equipment/${equipmentId}/qrcode`,
  method: 'post'
})

export const exportEquipment = (params) => request({
  url: '/equipment/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const createEquipmentImportPreview = (file, { onUploadProgress } = {}) => {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/equipment/imports',
    method: 'post',
    data,
    timeout: 15 * 60 * 1000,
    onUploadProgress
  })
}

export const getEquipmentImportJob = (importJobId, params) => request({
  url: `/equipment/imports/${importJobId}`,
  method: 'get',
  params
})

export const getEquipmentImportExceptions = (importJobId, params) => request({
  url: `/equipment/imports/${importJobId}/exceptions`,
  method: 'get',
  params
})

export const confirmEquipmentImport = (importJobId, data) => request({
  url: `/equipment/imports/${importJobId}/confirm`,
  method: 'post',
  data
})

export const cancelEquipmentImport = (importJobId, data) => request({
  url: `/equipment/imports/${importJobId}/cancel`,
  method: 'post',
  data,
  timeout: 2 * 60 * 1000
})

export const getEquipmentRoutineRules = (params) => request({
  url: '/equipment/routine-rules',
  method: 'get',
  params
})

export const getEquipmentRoutineRule = (ruleId, params) => request({
  url: `/equipment/routine-rules/${ruleId}`,
  method: 'get',
  params
})

export const createEquipmentRoutineRule = (data) => request({
  url: '/equipment/routine-rules',
  method: 'post',
  data
})

export const updateEquipmentRoutineRule = (ruleId, data) => request({
  url: `/equipment/routine-rules/${ruleId}`,
  method: 'patch',
  data
})

export const disableEquipmentRoutineRule = (ruleId, data = {}) => request({
  url: `/equipment/routine-rules/${ruleId}`,
  method: 'delete',
  data
})

export const getEquipmentRoutineSchedule = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}/routine-schedule`,
  method: 'get',
  params
})

export const getEquipmentRoutineRecords = (params) => request({
  url: '/equipment/routine-records',
  method: 'get',
  params
})

export const exportEquipmentRoutineRecords = (params) => request({
  url: '/equipment/routine-records/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const getEquipmentRoutinePlans = (params) => request({
  url: '/equipment/routine-plans',
  method: 'get',
  params
})

export const getEquipmentRoutinePlan = (planId, params) => request({
  url: `/equipment/routine-plans/${planId}`,
  method: 'get',
  params
})

export const getEquipmentRoutineExceptions = (params) => request({
  url: '/equipment/routine-exceptions',
  method: 'get',
  params
})

export const getEquipmentRoutineException = (exceptionId, params) => request({
  url: `/equipment/routine-exceptions/${exceptionId}`,
  method: 'get',
  params
})

export const transitionEquipmentRoutineException = (exceptionId, data) => request({
  url: `/equipment/routine-exceptions/${exceptionId}/actions`,
  method: 'post',
  data
})

export const runEquipmentRoutineWorker = (data = {}) => request({
  url: '/equipment/routine-worker/run',
  method: 'post',
  data
})

export const createEquipmentRoutineRecord = (equipmentId, data) => request({
  url: `/equipment/${equipmentId}/routine-records`,
  method: 'post',
  data
})

export const getEquipmentRuntimeReadings = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}/runtime-readings`,
  method: 'get',
  params
})

export const createEquipmentRuntimeReading = (equipmentId, data) => request({
  url: `/equipment/${equipmentId}/runtime-readings`,
  method: 'post',
  data
})

export const getEquipmentInventoryOptions = (params) => request({
  url: '/equipment/inventories/options',
  method: 'get',
  params
})

export const getEquipmentInventorySessions = (params) => request({
  url: '/equipment/inventories',
  method: 'get',
  params
})

export const createEquipmentInventorySession = (data) => request({
  url: '/equipment/inventories',
  method: 'post',
  data
})

export const getEquipmentInventorySession = (inventorySessionId, params) => request({
  url: `/equipment/inventories/${inventorySessionId}`,
  method: 'get',
  params
})

export const updateEquipmentInventoryItem = (inventorySessionId, inventoryItemId, data) => request({
  url: `/equipment/inventories/${inventorySessionId}/items/${inventoryItemId}`,
  method: 'patch',
  data
})

export const scanEquipmentInventoryItem = (inventorySessionId, qrToken) => request({
  url: `/equipment/inventories/${inventorySessionId}/scan`,
  method: 'post',
  data: { qrToken }
})

export const submitEquipmentInventorySession = (inventorySessionId, data) => request({
  url: `/equipment/inventories/${inventorySessionId}/submit`,
  method: 'post',
  data
})

export const reviewEquipmentInventorySession = (inventorySessionId, data) => request({
  url: `/equipment/inventories/${inventorySessionId}/review`,
  method: 'post',
  data
})

export const exportEquipmentInventorySession = (inventorySessionId, params) => request({
  url: `/equipment/inventories/${inventorySessionId}/export`,
  method: 'get',
  params,
  responseType: 'blob'
})

export const getEquipmentRepairs = (params) => request({
  url: '/equipment/repairs',
  method: 'get',
  params
})

export const getEquipmentRepairLocations = (params) => request({
  url: '/equipment/repairs/locations',
  method: 'get',
  params
})

export const updateEquipmentRepairLocations = (data) => request({
  url: '/equipment/repairs/locations',
  method: 'put',
  data
})

export const getEquipmentRepair = (repairId, params) => request({
  url: `/equipment/repairs/${repairId}`,
  method: 'get',
  params
})

export const createEquipmentRepair = (data) => request({
  url: '/equipment/repairs',
  method: 'post',
  data
})

export const transitionEquipmentRepair = (repairId, data) => request({
  url: `/equipment/repairs/${repairId}/actions`,
  method: 'post',
  data
})

export const exportEquipmentRepairs = (params) => request({
  url: '/equipment/repairs/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const getEquipmentStatusApplications = (params) => request({
  url: '/equipment/status-applications',
  method: 'get',
  params
})

export const getEquipmentStatusApplication = (applicationId, params) => request({
  url: `/equipment/status-applications/${applicationId}`,
  method: 'get',
  params
})

export const createEquipmentStatusApplication = (data) => request({
  url: '/equipment/status-applications',
  method: 'post',
  data
})

export const transitionEquipmentStatusApplication = (applicationId, data) => request({
  url: `/equipment/status-applications/${applicationId}/actions`,
  method: 'post',
  data
})
