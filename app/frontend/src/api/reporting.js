import request from '@/utils/request'

export const getTransportOptions = (params) => request({
  url: '/transport-records/options',
  method: 'get',
  params
})

export const getTransportRecords = (params) => request({
  url: '/transport-records',
  method: 'get',
  params
})

export const getTransportRecord = (transportRecordId, params) => request({
  url: `/transport-records/${transportRecordId}`,
  method: 'get',
  params
})

export const getTransportHistory = (transportRecordId, params) => request({
  url: `/transport-records/${transportRecordId}/history`,
  method: 'get',
  params
})

export const createTransportRecord = (data) => request({
  url: '/transport-records',
  method: 'post',
  data
})

export const updateTransportRecord = (transportRecordId, data) => request({
  url: `/transport-records/${transportRecordId}`,
  method: 'patch',
  data
})

export const exportTransportSummary = (params) => request({
  url: '/transport-records/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const getProductionOptions = (params) => request({
  url: '/production-schedules/options',
  method: 'get',
  params
})

export const getDailyProductionSchedule = (slot, params) => request({
  url: `/production-schedules/daily/${slot}`,
  method: 'get',
  params
})

export const maintainDailyProductionSchedule = (slot, data) => request({
  url: `/production-schedules/daily/${slot}`,
  method: 'put',
  data
})

export const exportDailyProductionSchedule = (slot, params) => request({
  url: `/production-schedules/daily/${slot}/export`,
  method: 'get',
  params,
  responseType: 'blob'
})

export const getMonthlyProductionSchedules = (params) => request({
  url: '/production-schedules/monthly',
  method: 'get',
  params
})

export const maintainMonthlyProductionSchedule = (month, data) => request({
  url: `/production-schedules/monthly/${month}`,
  method: 'put',
  data
})

export const exportMonthlyProductionSchedules = (params) => request({
  url: '/production-schedules/monthly/export',
  method: 'get',
  params,
  responseType: 'blob'
})
