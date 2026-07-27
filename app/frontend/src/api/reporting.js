import request from '@/utils/request'

export const getTransportOptions = (params) => request({
  url: '/transport-records/options',
  method: 'get',
  params
})

export const getTransportMasterData = (params) => request({
  url: '/transport-records/master-data',
  method: 'get',
  params
})

export const createTransportMasterData = (data) => request({
  url: '/transport-records/master-data',
  method: 'post',
  data
})

export const updateTransportMasterData = (masterDataId, data) => request({
  url: `/transport-records/master-data/${masterDataId}`,
  method: 'patch',
  data
})

export const setTransportMasterDataStatus = (masterDataId, status) => request({
  url: `/transport-records/master-data/${masterDataId}/status`,
  method: 'patch',
  data: { status }
})

export const deleteTransportMasterData = (masterDataId) => request({
  url: `/transport-records/master-data/${masterDataId}`,
  method: 'delete'
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

export const getAttendanceOptions = (params) => request({
  url: '/attendance-submissions/options',
  method: 'get',
  params
})

export const getAttendanceSubmissions = (params) => request({
  url: '/attendance-submissions',
  method: 'get',
  params
})

export const getAttendanceSubmission = (attendanceSubmissionId, params) => request({
  url: `/attendance-submissions/${attendanceSubmissionId}`,
  method: 'get',
  params
})

export const createAttendanceSubmission = (data) => request({
  url: '/attendance-submissions',
  method: 'post',
  data
})

export const updateAttendanceSubmission = (attendanceSubmissionId, data) => request({
  url: `/attendance-submissions/${attendanceSubmissionId}`,
  method: 'patch',
  data
})

export const getAttendanceDailySummary = (params) => request({
  url: '/attendance-submissions/summary/daily',
  method: 'get',
  params
})

export const getAttendanceMonthlySummary = (params) => request({
  url: '/attendance-submissions/summary/monthly',
  method: 'get',
  params
})

export const exportAttendanceMonthlySummary = (params) => request({
  url: '/attendance-submissions/summary/monthly/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const reviewAttendanceDailySummary = (date, data = {}) => request({
  url: `/attendance-submissions/summary/daily/${date}/review`,
  method: 'post',
  data
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

export const getGeneratedDailyReports = (params) => request({
  url: '/generated-daily-reports',
  method: 'get',
  params
})

export const getGeneratedDailyReport = (date, params) => request({
  url: `/generated-daily-reports/${date}`,
  method: 'get',
  params
})

export const generateDailyReport = (date) => request({
  url: `/generated-daily-reports/${date}/generate`,
  method: 'post',
  data: {}
})
