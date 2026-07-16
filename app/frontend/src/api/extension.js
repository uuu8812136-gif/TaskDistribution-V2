import request from '@/utils/request'

/**
 * 申请延期
 */
export function applyExtension(id, data) {
  return request({
    url: `/extensions/apply/${id}`,
    method: 'post',
    data
  })
}

/**
 * 审批延期
 */
export function approveExtension(id, data) {
  return request({
    url: `/extensions/approve/${id}`,
    method: 'post',
    data
  })
}

/**
 * 获取延期申请列表
 */
export function getExtensionList(params) {
  return request({
    url: '/extensions',
    method: 'get',
    params
  })
}

/**
 * 获取延期申请详情
 */
export function getExtensionDetail(id) {
  return request({
    url: `/extensions/${id}`,
    method: 'get'
  })
}

/**
 * 获取任务延期历史
 */
export function getTaskExtensionHistory(taskId) {
  return request({
    url: `/extensions/history/${taskId}`,
    method: 'get'
  })
}

