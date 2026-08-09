/**
 * API 接口统一管理
 */
import { get, post, put, patch, del, upload, download } from '@/utils/request.js'
import { managedFileId, taskTemporaryUploadUrl } from '@/utils/attachments.js'

// ==================== 认证模块 ====================

/**
 * 用户登录
 */
export const login = (data) => {
  return post('/auth/login', data, { auth: false, contextScoped: false })
}

export const getLoginTeams = () => get('/auth/login-teams', {}, {
  auth: false,
  contextScoped: false,
  showLoading: false,
  silentError: true
})

export const getAccessibleTeams = () => get('/auth/teams')

export const switchTeam = (teamId) => post('/auth/switch-team', { teamId })

export const enterGlobalReadOnly = () => post('/auth/global-readonly')

export const logout = () => post('/auth/logout', {}, {
  showLoading: false,
  silentError: true
})

/**
 * 获取当前用户信息
 */
export const getCurrentUser = () => {
  return get('/auth/me')
}

/**
 * 修改密码
 */
export const changePassword = (data) => {
  return post('/auth/change-password', data)
}

export const uploadTaskAttachment = async (file) => {
  const response = await upload('/files', file.path, {
    originalName: file.name
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return { fileId }
}

export const uploadTaskScopedAttachment = async (file, { taskId = '', orgUnitId = '' } = {}) => {
  const response = await upload(taskTemporaryUploadUrl({ taskId, orgUnitId }), file.path, {
    originalName: file.name
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return { fileId }
}

export const downloadTaskAttachment = (file, params = {}) => {
  const fileId = managedFileId(file)
  if (!fileId) throw new TypeError('附件文件编号无效')
  const teamId = typeof params.teamId === 'string' ? params.teamId : ''
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  return download(`/files/${fileId}/download${query}`)
}

// ==================== 任务模块 ====================

/**
 * 获取我的任务
 * @param {Object} params - { type: 'executor|cc|created', status: '', page, limit }
 */
export const getMyTasks = (params) => {
  return get('/tasks/my-tasks', params)
}

/**
 * 获取所有任务（管理员）
 * @param {Object} params - { page, limit, status, priority, keyword, startDate, endDate }
 */
export const getAllTasks = (params) => {
  return get('/tasks', params)
}

export const getTaskAssignableUsers = (params = {}) => {
  return get('/tasks/assignable-users', params)
}

/**
 * 获取任务详情
 */
export const getTaskDetail = (id, params = {}) => {
  return get(`/tasks/${id}`, params)
}

/**
 * 创建任务（管理员）
 */
/**
 * 创建任务
 */
export const createTask = (data) => {
  return post('/tasks', data)
}

/**
 * 更新任务（管理员）
 */
export const updateTask = (id, data) => {
  return put(`/tasks/${id}`, data)
}

/**
 * 删除任务（管理员）
 */
export const deleteTask = (id) => {
  return del(`/tasks/${id}`)
}

/**
 * 完成任务（执行人）
 */
/**
 * 完成任务 - 附件已在组件中上传
 */
export const completeTask = (id, data) => {
  return post(`/tasks/${id}/complete`, {
    completionNote: data.completionNote,
    attachments: data.attachments || []
  })
}

/**
 * 审核任务（抄送人）- 支持附件上传
 */
export const reviewTask = async (id, data) => {
  try {
    // 直接使用传入的数据，不再重新处理
    // review.vue 已经处理好了附件上传
    const requestData = {
      content: data.content,      // 已经是正确的字段名
      result: data.result,        // 已经是正确的字段名
      rating: data.rating,
      attachments: data.attachments || []  // 直接使用传入的 attachments
    }
    
    return post(`/tasks/${id}/review`, requestData)
    
  } catch (error) {
    console.error('reviewTask API 错误:', error)
    throw error
  }
}

/**
 * 确认任务（管理员）
 */
export const confirmTask = (id, data = {}) => {
  return post(`/tasks/${id}/confirm`, data)
}

/**
 * 获取任务审核记录
 */
export const getTaskReviews = (id, params = {}) => {
  return get(`/tasks/${id}/reviews`, params)
}

// ==================== 延期申请模块 ====================

/**
 * 申请延期
 */
export const applyExtension = (id, data) => {
  return post(`/extensions/apply/${id}`, data)
}

/**
 * 审批延期申请（管理员）
 */
export const approveExtension = (id, data) => {
  return post(`/extensions/approve/${id}`, data)
}

/**
 * 获取延期申请列表
 */
export const getExtensions = (params) => {
  return get('/extensions', params)
}

export const getExtensionRequest = (id) => {
  return get(`/extensions/${id}`)
}

/**
 * 获取任务延期历史
 */
export const getExtensionHistory = (taskId, params = {}) => {
  return get(`/extensions/history/${taskId}`, params)
}

// ==================== 消息模块 ====================

/**
 * 获取消息列表
 */
export const getMessages = (params) => {
  return get('/messages', params)
}

/**
 * 获取未读消息数量
 */
export const getUnreadCount = () => {
  return get('/messages/unread-count')
}

/**
 * 标记消息为已读
 */
export const markMessageRead = (id) => {
  return put(`/messages/${id}/read`)
}

/**
 * 全部标记为已读
 */
export const markAllRead = () => {
  return put('/messages/read-all')
}

/**
 * 删除消息
 */
export const deleteMessage = (id) => {
  return del(`/messages/${id}`)
}

/**
 * 清空已读消息
 */
export const clearReadMessages = () => {
  return del('/messages/clear-read')
}

// ==================== 用户模块 ====================

/**
 * 获取用户列表（用于选择执行人、抄送人）
 */
export const getUsers = (params) => {
  return get('/users', params)
}

export const getOrgUnits = (params = {}) => {
  return get('/org-units', params)
}

// ==================== 设备现场模块 ====================

export const getEquipmentList = (params = {}) => {
  return get('/equipment', params)
}

export const getEquipmentDetail = (equipmentId, params = {}) => {
  return get(`/equipment/${equipmentId}`, params)
}

export const getEquipmentByQrToken = (qrToken, params = {}, options = {}) => {
  return get(`/equipment/qr/${encodeURIComponent(qrToken)}`, params, options)
}

export const getEquipmentRoutineSchedule = (equipmentId, params = {}, options = {}) => {
  return get(`/equipment/${equipmentId}/routine-schedule`, params, options)
}

export const createEquipmentRoutineRecord = (equipmentId, data) => {
  return post(`/equipment/${equipmentId}/routine-records`, data)
}

export const getEquipmentRoutineRecords = (params = {}) => {
  return get('/equipment/routine-records', params)
}

export const getEquipmentRoutinePlans = (params = {}) => {
  return get('/equipment/routine-plans', params)
}

export const getEquipmentRoutinePlan = (planId, params = {}) => {
  return get(`/equipment/routine-plans/${encodeURIComponent(planId)}`, params)
}

export const markEquipmentRoutinePlansRestDay = (data) => {
  return post('/equipment/routine-plans/rest-day', data)
}

export const getEquipmentRoutineExceptions = (params = {}) => {
  return get('/equipment/routine-exceptions', params)
}

export const getEquipmentRoutineException = (exceptionId, params = {}) => {
  return get(`/equipment/routine-exceptions/${exceptionId}`, params)
}

export const transitionEquipmentRoutineException = (exceptionId, data) => {
  return post(`/equipment/routine-exceptions/${exceptionId}/actions`, data)
}

export const getEquipmentRuntimeReadings = (equipmentId, params = {}) => {
  return get(`/equipment/${equipmentId}/runtime-readings`, params)
}

export const createEquipmentRuntimeReading = (equipmentId, data) => {
  return post(`/equipment/${equipmentId}/runtime-readings`, data)
}

export const uploadEquipmentRoutinePhoto = async (file) => {
  const response = await upload('/files', file.path, {
    originalName: file.name || `equipment-${Date.now()}.jpg`
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return fileId
}

export const getEquipmentRepairs = (params = {}) => {
  return get('/equipment/repairs', params)
}

export const getEquipmentRepairLocations = (params = {}) => {
  return get('/equipment/repairs/locations', params)
}

export const getEquipmentRepair = (repairId, params = {}) => {
  return get(`/equipment/repairs/${repairId}`, params)
}

export const createEquipmentRepair = (data) => {
  return post('/equipment/repairs', data)
}

export const transitionEquipmentRepair = (repairId, data) => {
  return post(`/equipment/repairs/${repairId}/actions`, data)
}

export const uploadEquipmentRepairPhoto = async (file) => {
  const response = await upload('/files', file.path || file.tempFilePath, {
    originalName: file.name || `repair-${Date.now()}.jpg`
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return fileId
}

export const getEquipmentInventorySessions = (params = {}) => {
  return get('/equipment/inventories', params)
}

export const getEquipmentInventorySession = (inventorySessionId, params = {}) => {
  return get(`/equipment/inventories/${inventorySessionId}`, params)
}

export const scanEquipmentInventoryItem = (inventorySessionId, qrToken) => {
  return post(`/equipment/inventories/${inventorySessionId}/scan`, { qrToken })
}

export const updateEquipmentInventoryItem = (inventorySessionId, inventoryItemId, data) => {
  return patch(`/equipment/inventories/${inventorySessionId}/items/${inventoryItemId}`, data)
}

export const submitEquipmentInventorySession = (inventorySessionId, data) => {
  return post(`/equipment/inventories/${inventorySessionId}/submit`, data)
}

export const reviewEquipmentInventorySession = (inventorySessionId, data) => {
  return post(`/equipment/inventories/${inventorySessionId}/review`, data)
}

export const uploadEquipmentInventoryPhoto = async (file) => {
  const response = await upload('/files', file.path || file.tempFilePath, {
    originalName: file.name || `inventory-${Date.now()}.jpg`
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return fileId
}

export const getEquipmentStatusApplications = (params = {}) => {
  return get('/equipment/status-applications', params)
}

export const getEquipmentStatusApplication = (applicationId, params = {}) => {
  return get(`/equipment/status-applications/${applicationId}`, params)
}

export const createEquipmentStatusApplication = (data) => {
  return post('/equipment/status-applications', data)
}

export const transitionEquipmentStatusApplication = (applicationId, data) => {
  return post(`/equipment/status-applications/${applicationId}/actions`, data)
}

export const uploadEquipmentStatusAttachment = async (file) => {
  const response = await upload('/files', file.path || file.tempFilePath, {
    originalName: file.name || `equipment-status-${Date.now()}.jpg`
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return fileId
}

// ==================== 数据提报模块 ====================

export const getTransportRecords = (params = {}) => {
  return get('/transport-records', params)
}

export const getTransportMasterData = (params = {}) => {
  return get('/transport-records/master-data', params)
}

export const getTransportRecord = (transportRecordId, params = {}) => {
  return get(`/transport-records/${transportRecordId}`, params)
}

export const createTransportRecord = (data) => {
  return post('/transport-records', data)
}

export const uploadTransportPhoto = async (file) => {
  const response = await upload('/files', file.path, {
    originalName: file.name
  })
  const fileId = managedFileId({ fileId: response.file?._id })
  if (!fileId) throw new Error('上传响应缺少有效文件ID')
  return fileId
}

export const getPrivateFileMetadata = (fileId, params = {}) => {
  const normalized = managedFileId({ fileId })
  if (!normalized) throw new TypeError('文件编号无效')
  return get(`/files/${normalized}`, params)
}

export const getPrivateFileMetadataSilently = (fileId) => {
  const normalized = managedFileId({ fileId })
  if (!normalized) throw new TypeError('文件编号无效')
  return get(`/files/${normalized}`, {}, { showLoading: false, silentError: true })
}

export const deleteTemporaryPrivateFile = (fileId, reason = 'Client upload cleanup') => {
  const normalized = managedFileId({ fileId })
  if (!normalized) throw new TypeError('文件编号无效')
  return del(`/files/${normalized}`, { reason }, { showLoading: false, silentError: true })
}

export const downloadPrivateFile = (fileId, params = {}) => {
  const normalized = managedFileId({ fileId })
  if (!normalized) throw new TypeError('文件编号无效')
  const teamId = typeof params.teamId === 'string' ? params.teamId : ''
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  return download(`/files/${normalized}/download${query}`)
}

export const getDailyProductionSchedules = (slot, params = {}) => {
  if (slot !== 'previous' && slot !== 'current') {
    throw new TypeError('日排产查询范围仅支持上月或当月')
  }
  return get(`/production-schedules/daily/${slot}`, params)
}

export const getMonthlyProductionSchedules = (params = {}) => {
  return get('/production-schedules/monthly', params)
}

export const getAttendanceOptions = (params = {}) => {
  return get('/attendance-submissions/options', params)
}

export const getAttendanceSubmissions = (params = {}) => {
  return get('/attendance-submissions', params)
}

export const getAttendanceSubmission = (attendanceSubmissionId, params = {}) => {
  return get(`/attendance-submissions/${attendanceSubmissionId}`, params)
}

export const createAttendanceSubmission = (data) => {
  return post('/attendance-submissions', data)
}

export const updateAttendanceSubmission = (attendanceSubmissionId, data) => {
  return patch(`/attendance-submissions/${attendanceSubmissionId}`, data)
}

export const getAttendanceDailySummary = (params = {}) => {
  return get('/attendance-submissions/summary/daily', params)
}

export const getAttendanceMonthlySummary = (params = {}) => {
  return get('/attendance-submissions/summary/monthly', params)
}

export const reviewAttendanceDailySummary = (date, data = {}) => {
  return post(`/attendance-submissions/summary/daily/${date}/review`, data)
}

export const getGeneratedDailyReports = (params = {}) => {
  return get('/generated-daily-reports', params)
}

export const getGeneratedDailyReport = (date, params = {}) => {
  return get(`/generated-daily-reports/${date}`, params)
}

export const generateDailyReport = (date) => {
  return post(`/generated-daily-reports/${date}/generate`, {})
}

// ==================== 统计模块 ====================

/**
 * 获取统计概览
 */
export const getStatistics = () => {
  return get('/statistics/overview')
}

