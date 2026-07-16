import request from '@/utils/request'

/**
 * 获取任务列表
 */
export function getTaskList(params) {
  return request({
    url: '/tasks',
    method: 'get',
    params
  })
}

/**
 * 获取我的任务
 */
export function getMyTasks(params) {
  return request({
    url: '/tasks/my-tasks',
    method: 'get',
    params
  })
}

/**
 * 获取任务详情
 */
export function getTaskDetail(id) {
  return request({
    url: `/tasks/${id}`,
    method: 'get'
  })
}

/**
 * 创建任务
 */
export function createTask(data) {
  return request({
    url: '/tasks',
    method: 'post',
    data
  })
}

/**
 * 更新任务
 */
export function updateTask(id, data) {
  return request({
    url: `/tasks/${id}`,
    method: 'put',
    data
  })
}

/**
 * 删除任务
 */
export function deleteTask(id) {
  return request({
    url: `/tasks/${id}`,
    method: 'delete'
  })
}

/**
 * 完成任务
 */
export function completeTask(id, data) {
  return request({
    url: `/tasks/${id}/complete`,
    method: 'post',
    data
  })
}

/**
 * 审核任务
 */
export function reviewTask(id, data) {
  return request({
    url: `/tasks/${id}/review`,
    method: 'post',
    data
  })
}

/**
 * 确认任务
 */
export function confirmTask(id, data = {}) {
  return request({
    url: `/tasks/${id}/confirm`,
    method: 'post',
    data
  })
}

/**
 * 获取任务审核记录
 */
export function getTaskReviews(id) {
  return request({
    url: `/tasks/${id}/reviews`,
    method: 'get'
  })
}

/**
 * 批量导出任务为Excel
 */
export function batchExportTasks(params) {
  return request({
    url: '/tasks/export',
    method: 'get',
    params,
    responseType: 'blob'
  })
}

