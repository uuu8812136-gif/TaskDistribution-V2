/**
 * 工具函数 - 格式化、状态转换等
 */

export const parseDate = (value) => {
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value === 'number') return new Date(value)
  if (typeof value !== 'string') return new Date(value)

  const trimmed = value.trim()
  if (!trimmed) return new Date(NaN)
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const normalized = !hasExplicitTimezone && /^\d{4}-\d{1,2}-\d{1,2}/.test(trimmed)
    ? trimmed.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})/, '$1/$2/$3').replace('T', ' ')
    : trimmed
  return new Date(normalized)
}

/**
 * 格式化日期时间
 * @param {String|Date} date - 日期
 * @param {String} format - 格式 (默认: 'YYYY-MM-DD HH:mm:ss')
 */
export const formatDate = (date, format = 'YYYY-MM-DD HH:mm:ss') => {
  if (!date) return ''
  
  const d = parseDate(date)
  if (isNaN(d.getTime())) return ''
  
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  const second = String(d.getSeconds()).padStart(2, '0')
  
  return format
    .replace('YYYY', year)
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hour)
    .replace('mm', minute)
    .replace('ss', second)
}

/**
 * 格式化相对时间（刚刚、几分钟前、几小时前等）
 */
export const formatRelativeTime = (date) => {
  if (!date) return ''
  
  const d = parseDate(date)
  if (isNaN(d.getTime())) return ''
  
  const now = new Date()
  const diff = now - d
  
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  
  if (diff < minute) {
    return '刚刚'
  } else if (diff < hour) {
    return `${Math.floor(diff / minute)}分钟前`
  } else if (diff < day) {
    return `${Math.floor(diff / hour)}小时前`
  } else if (diff < 7 * day) {
    return `${Math.floor(diff / day)}天前`
  } else {
    return formatDate(date, 'YYYY-MM-DD')
  }
}

/**
 * 格式化文件大小
 */
export const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B'
  
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
}

/**
 * 任务状态文本映射
 */
export const taskStatusMap = {
  'pending_review': '待审核',
  'in_progress': '进行中',
  'extension_pending': '延期待审批',
  'pending_confirm': '待确认',
  'finished': '已完成',
  'rejected': '已拒绝',
  'overdue': '已逾期'
}

/**
 * 获取任务状态文本
 */
export const getTaskStatusText = (status) => {
  return taskStatusMap[status] || status
}

/**
 * 获取任务状态颜色
 */
export const getTaskStatusColor = (status) => {
  const colorMap = {
    'pending_review': '#E6A23C',     // 橙色
    'in_progress': '#409EFF',        // 蓝色
    'extension_pending': '#E6A23C',  // 橙色
    'pending_confirm': '#67C23A',    // 绿色
    'finished': '#67C23A',           // 绿色
    'rejected': '#F56C6C',           // 红色
    'overdue': '#F56C6C'             // 红色
  }
  return colorMap[status] || '#909399'
}

/**
 * 判断任务是否已过期
 * @param {String|Date} plannedCompletionTime - 计划完成时间
 * @param {String} status - 任务状态
 * @returns {Boolean} 是否过期
 */
export const isTaskOverdue = (plannedCompletionTime, status) => {
  // 已完成或待确认的任务不算过期
  if (status === 'finished' || status === 'pending_confirm') {
    return false
  }
  
  if (!plannedCompletionTime) return false
  
  const plannedTime = parseDate(plannedCompletionTime)
  const now = new Date()
  
  // 精确到毫秒比较
  return now.getTime() > plannedTime.getTime()
}

/**
 * 优先级文本映射
 */
export const priorityMap = {
  'low': '低',
  'normal': '普通',
  'high': '高',
  'urgent': '紧急'
}

/**
 * 获取优先级文本
 */
export const getPriorityText = (priority) => {
  return priorityMap[priority] || priority
}

/**
 * 获取优先级颜色
 */
export const getPriorityColor = (priority) => {
  const colorMap = {
    'low': '#909399',      // 灰色
    'normal': '#409EFF',   // 蓝色
    'high': '#E6A23C',     // 橙色
    'urgent': '#F56C6C'    // 红色
  }
  return colorMap[priority] || '#909399'
}

/**
 * 审核状态文本映射
 */
export const reviewStatusMap = {
  'approved': '通过',
  'rejected': '拒绝'
}

/**
 * 获取审核状态文本
 */
export const getReviewStatusText = (status) => {
  return reviewStatusMap[status] || status
}

/**
 * 延期状态文本映射
 */
export const extensionStatusMap = {
  'pending': '待审批',
  'approved': '已通过',
  'rejected': '已拒绝'
}

/**
 * 获取延期状态文本
 */
export const getExtensionStatusText = (status) => {
  return extensionStatusMap[status] || status
}

/**
 * 获取延期状态颜色
 */
export const getExtensionStatusColor = (status) => {
  const colorMap = {
    'pending': '#E6A23C',   // 橙色
    'approved': '#67C23A',  // 绿色
    'rejected': '#F56C6C'   // 红色
  }
  return colorMap[status] || '#909399'
}

/**
 * 消息类型文本映射
 */
export const messageTypeMap = {
  'task_assigned': '任务分配',
  'task_updated': '任务更新',
  'task_deleted': '任务删除',
  'task_completed': '任务完成',
  'task_reviewed': '任务审核',
  'task_confirmed': '任务确认',
  'extension_applied': '延期申请',
  'extension_approved': '延期审批',
  'extension_rejected': '延期拒绝',
  'system': '系统提醒',
  'repair': '设备维修',
  'equipment_status': '设备状态审批',
  'task_overdue': '任务逾期'
}

/**
 * 获取消息类型文本
 */
export const getMessageTypeText = (type) => {
  return messageTypeMap[type] || type
}

/**
 * 防抖函数
 */
export const debounce = (func, wait = 500) => {
  let timeout
  return function(...args) {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      func.apply(this, args)
    }, wait)
  }
}

/**
 * 节流函数
 */
export const throttle = (func, wait = 500) => {
  let timeout
  return function(...args) {
    if (!timeout) {
      timeout = setTimeout(() => {
        timeout = null
        func.apply(this, args)
      }, wait)
    }
  }
}

