import request from '@/utils/request'

/**
 * 获取统计概览
 */
export function getStatisticsOverview() {
  return request({
    url: '/statistics/overview',
    method: 'get'
  })
}

/**
 * 导出任务统计
 */
export function exportTasks(params) {
  return request({
    url: '/statistics/export/tasks',
    method: 'get',
    params,
    responseType: 'blob'
  })
}

/**
 * 导出人员统计
 */
export function exportUsers(params) {
  return request({
    url: '/statistics/export/users',
    method: 'get',
    params,
    responseType: 'blob'
  })
}

