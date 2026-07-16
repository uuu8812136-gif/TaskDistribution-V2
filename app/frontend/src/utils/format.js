import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.locale('zh-cn')
dayjs.extend(relativeTime)

/**
 * 格式化日期
 * @param {Date|String} date - 日期
 * @param {String} format - 格式
 */
export function formatDate(date, format = 'YYYY-MM-DD HH:mm:ss') {
  if (!date) return '-'
  return dayjs(date).format(format)
}

/**
 * 相对时间
 * @param {Date|String} date - 日期
 */
export function fromNow(date) {
  if (!date) return '-'
  return dayjs(date).fromNow()
}

/**
 * 格式化文件大小
 * @param {Number} bytes - 字节数
 */
export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

/**
 * 任务状态文本
 */
export const taskStatusMap = {
  pending: '待开始',
  in_progress: '进行中',
  partial_completed: '部分完成',
  extension_pending: '待延期审批',
  extension_approved: '延期通过',
  // completed: '已完成',
  pending_review: '待审核',
  pending_confirm: '待确认',
  finished: '已完结'
}

/**
 * 任务状态类型（Element Plus tag type）
 */
export const taskStatusType = {
  pending: 'info',
  in_progress: 'primary',
  partial_completed: 'warning',
  extension_pending: 'warning',
  extension_approved: 'success',
  completed: 'success',
  pending_review: 'warning',
  pending_confirm: 'warning',
  finished: 'success'
}

/**
 * 优先级文本
 */
export const priorityMap = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急'
}

/**
 * 优先级类型
 */
export const priorityType = {
  low: 'info',
  normal: '',
  high: 'warning',
  urgent: 'danger'
}

/**
 * 消息类型文本
 */
export const messageTypeMap = {
  task_assigned: '任务分配',
  task_updated: '任务更新',
  task_completed: '任务完成',
  task_reviewed: '任务已审核',
  task_confirmed: '任务已确认',
  task_deleted: '任务删除',
  extension_applied: '延期申请',
  extension_approved: '延期通过',
  extension_rejected: '延期拒绝',
  system: '系统通知'
}

/**
 * 消息类型图标
 */
export const messageTypeIcon = {
  task_assigned: 'DocumentAdd',
  task_updated: 'Edit',
  task_completed: 'Check',
  task_reviewed: 'View',
  task_confirmed: 'CircleCheck',
  task_deleted: 'Delete',
  extension_applied: 'Clock',
  extension_approved: 'SuccessFilled',
  extension_rejected: 'CircleClose',
  system: 'Bell'
}

/**
 * 角色文本
 */
export const roleMap = {
  admin: '管理员',
  executor: '执行人',
  cc: '抄送人'
}

/**
 * 下载文件
 * @param {Blob} blob - 文件数据
 * @param {String} filename - 文件名
 */
export function downloadFile(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

