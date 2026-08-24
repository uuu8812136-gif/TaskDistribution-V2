import request from '@/utils/request'

export function getSuppliers(params) {
  return request({
    url: '/contracts/suppliers',
    method: 'get',
    params
  })
}

export function getSupplier(supplierId, params) {
  return request({
    url: `/contracts/suppliers/${supplierId}`,
    method: 'get',
    params
  })
}

export function updateSupplier(supplierId, data) {
  return request({
    url: `/contracts/suppliers/${supplierId}`,
    method: 'patch',
    data
  })
}

export function importSuppliers(file, params = {}, onUploadProgress) {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/contracts/suppliers/import',
    method: 'post',
    params,
    data,
    // A populated 60-column workbook can spend several minutes in the
    // transactional validation/write path; keep the global request timeout
    // unchanged for normal operations.
    timeout: 15 * 60 * 1000,
    onUploadProgress
  })
}

export function importSupplierContractPdfs(file, params = {}, onUploadProgress) {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/contracts/suppliers/contract-pdfs/import',
    method: 'post',
    params,
    data,
    suppressGlobalError: true,
    onUploadProgress
  })
}

export function importSupplierPaymentReceipts(file, params = {}, onUploadProgress) {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/contracts/suppliers/payment-receipts/import',
    method: 'post',
    params,
    data,
    suppressGlobalError: true,
    onUploadProgress
  })
}

export function exportSuppliers(params) {
  return request({
    url: '/contracts/suppliers/export',
    method: 'get',
    params,
    responseType: 'blob'
  })
}

export function getSupplierRecords(supplierId, params) {
  return request({
    url: `/contracts/suppliers/${supplierId}/records`,
    method: 'get',
    params
  })
}

export function createSupplierFirstRecord(data) {
  return request({
    url: '/contracts/records',
    method: 'post',
    data
  })
}

export function createSupplierRecord(supplierId, data) {
  return request({
    url: `/contracts/suppliers/${supplierId}/records`,
    method: 'post',
    data
  })
}

export function getSupplierRecord(recordId, params) {
  return request({
    url: `/contracts/records/${recordId}`,
    method: 'get',
    params
  })
}

export function updateSupplierRecord(recordId, data) {
  return request({
    url: `/contracts/records/${recordId}`,
    method: 'patch',
    data
  })
}

export function deleteSupplierRecord(recordId, data = {}) {
  return request({
    url: `/contracts/records/${recordId}`,
    method: 'delete',
    data
  })
}

export function getContractExpiryAlerts(params) {
  return request({
    url: '/contracts/expiry-alerts',
    method: 'get',
    params
  })
}

export function exportContractExpiryAlerts(params) {
  return request({
    url: '/contracts/expiry-alerts/export',
    method: 'get',
    params,
    responseType: 'blob'
  })
}

export function getSupplierSettlements(params) {
  return request({
    url: '/contracts/settlements',
    method: 'get',
    params
  })
}

export function createSupplierSettlement(data) {
  return request({
    url: '/contracts/settlements',
    method: 'post',
    data
  })
}

export function updateSupplierSettlement(settlementId, data) {
  return request({
    url: `/contracts/settlements/${settlementId}`,
    method: 'patch',
    data
  })
}

export function deleteSupplierSettlement(settlementId, data = {}) {
  return request({
    url: `/contracts/settlements/${settlementId}`,
    method: 'delete',
    data
  })
}

export function importSupplierSettlements(file, params = {}, onUploadProgress) {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/contracts/settlements/import',
    method: 'post',
    params,
    data,
    onUploadProgress
  })
}

export function exportSupplierSettlements(params) {
  return request({
    url: '/contracts/settlements/export',
    method: 'get',
    params,
    responseType: 'blob'
  })
}
