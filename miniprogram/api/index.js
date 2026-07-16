/**
 * API 接口统一管理
 */
import { get, post, put, del, upload, download } from '@/utils/request.js'
import { managedFileId } from '@/utils/attachments.js'

// ==================== 认证模块 ====================

/**
 * 用户登录
 */
export const login = (data) => {
  return post('/auth/login', data, { auth: false, contextScoped: false })
}

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

export const downloadTaskAttachment = (file) => {
  const fileId = managedFileId(file)
  if (!fileId) throw new TypeError('Managed attachment fileId is required')
  return download(`/files/${fileId}/download`)
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

/**
 * 获取任务详情
 */
export const getTaskDetail = (id) => {
  return get(`/tasks/${id}`)
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
    console.log('=== reviewTask API 调用 ===')
    console.log('id:', id)
    console.log('data:', data)
    
    // 直接使用传入的数据，不再重新处理
    // review.vue 已经处理好了附件上传
    const requestData = {
      content: data.content,      // 已经是正确的字段名
      result: data.result,        // 已经是正确的字段名
      rating: data.rating,
      attachments: data.attachments || []  // 直接使用传入的 attachments
    }
    
    console.log('=== 准备发送的请求数据 ===')
    console.log('requestData:', JSON.stringify(requestData, null, 2))
    
    return post(`/tasks/${id}/review`, requestData)
    
  } catch (error) {
    console.error('reviewTask API 错误:', error)
    throw error
  }
}

/**
 * 确认任务（管理员）
 */
export const confirmTask = (id) => {
  return post(`/tasks/${id}/confirm`)
}

/**
 * 获取任务审核记录
 */
export const getTaskReviews = (id) => {
  return get(`/tasks/${id}/reviews`)
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

/**
 * 获取任务延期历史
 */
export const getExtensionHistory = (taskId) => {
  return get(`/extensions/history/${taskId}`)
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

// ==================== 数据提报模块 ====================

export const getTransportRecords = (params = {}) => {
  return get('/transport-records', params)
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
  if (!normalized) throw new TypeError('Managed fileId is required')
  return get(`/files/${normalized}`, params)
}

export const downloadPrivateFile = (fileId, params = {}) => {
  const normalized = managedFileId({ fileId })
  if (!normalized) throw new TypeError('Managed fileId is required')
  const teamId = typeof params.teamId === 'string' ? params.teamId : ''
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
  return download(`/files/${normalized}/download${query}`)
}

export const getDailyProductionSchedules = (slot, params = {}) => {
  if (slot !== 'previous' && slot !== 'current') {
    throw new TypeError('Daily production slot must be previous or current')
  }
  return get(`/production-schedules/daily/${slot}`, params)
}

export const getMonthlyProductionSchedules = (params = {}) => {
  return get('/production-schedules/monthly', params)
}

// ==================== 统计模块 ====================

/**
 * 获取统计概览
 */
export const getStatistics = () => {
  return get('/statistics/overview')
}

