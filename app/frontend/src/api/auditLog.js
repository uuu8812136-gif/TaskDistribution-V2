import request from '@/utils/request'

export function getAuditLogs(params) {
  return request({
    url: '/audit-logs',
    method: 'get',
    params
  })
}

export function getAuditLog(id) {
  return request({
    url: `/audit-logs/${id}`,
    method: 'get'
  })
}
