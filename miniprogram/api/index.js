/**
 * API 接口统一管理
 */
import { get, post, put, del } from '@/utils/request.js'
import config from '@/config/index.js'

// ==================== 认证模块 ====================

/**
 * 用户登录
 */
export const login = (data) => {
  return post('/auth/login', data)
}

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
 * 上传单个文件
 */
const uploadFile = (url, filePath) => {
  return new Promise((resolve, reject) => {
    const token = uni.getStorageSync('token')
    
    uni.uploadFile({
      url: config.baseURL + url,
      filePath: filePath,
      name: 'file',
      header: {
        Authorization: token ? `Bearer ${token}` : ''
      },
      success: (res) => {
        try {
          const result = JSON.parse(res.data)
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve(result)
          } else {
            reject(new Error(result.message || '上传失败'))
          }
        } catch (e) {
          reject(e)
        }
      },
      fail: (err) => {
        reject(err)
      }
    })
  })
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

// ==================== 统计模块 ====================

/**
 * 获取统计概览
 */
export const getStatistics = () => {
  return get('/statistics/overview')
}

