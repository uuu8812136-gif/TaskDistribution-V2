import request from '@/utils/request'

/**
 * 获取消息列表
 */
export function getMessageList(params) {
  return request({
    url: '/messages',
    method: 'get',
    params
  })
}

/**
 * 获取未读消息数量
 */
export function getUnreadCount() {
  return request({
    url: '/messages/unread-count',
    method: 'get'
  })
}

/**
 * 获取消息详情
 */
export function getMessageDetail(id) {
  return request({
    url: `/messages/${id}`,
    method: 'get'
  })
}

/**
 * 标记消息为已读
 */
export function markMessageAsRead(id) {
  return request({
    url: `/messages/${id}/read`,
    method: 'put'
  })
}

/**
 * 批量标记消息为已读
 */
export function markMultipleAsRead(messageIds) {
  return request({
    url: '/messages/read-multiple',
    method: 'put',
    data: { messageIds }
  })
}

/**
 * 全部标记为已读
 */
export function markAllAsRead() {
  return request({
    url: '/messages/read-all',
    method: 'put'
  })
}

/**
 * 删除消息
 */
export function deleteMessage(id) {
  return request({
    url: `/messages/${id}`,
    method: 'delete'
  })
}

/**
 * 批量删除消息
 */
export function deleteMultipleMessages(messageIds) {
  return request({
    url: '/messages/delete-multiple',
    method: 'delete',
    data: { messageIds }
  })
}

/**
 * 清空已读消息
 */
export function clearReadMessages() {
  return request({
    url: '/messages/clear-read',
    method: 'delete'
  })
}

