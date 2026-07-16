import request from '@/utils/request'

export const getEquipmentList = (params) => request({
  url: '/equipment',
  method: 'get',
  params
})

export const getEquipmentDetail = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}`,
  method: 'get',
  params
})

export const createEquipment = (data) => request({
  url: '/equipment',
  method: 'post',
  data
})

export const updateEquipment = (equipmentId, data) => request({
  url: `/equipment/${equipmentId}`,
  method: 'patch',
  data
})

export const getEquipmentOptions = (params) => request({
  url: '/equipment/options',
  method: 'get',
  params
})

export const getEquipmentCategories = (params) => request({
  url: '/equipment/categories',
  method: 'get',
  params
})

export const createEquipmentCategory = (data) => request({
  url: '/equipment/categories',
  method: 'post',
  data
})

export const updateEquipmentCategory = (categoryId, data) => request({
  url: `/equipment/categories/${categoryId}`,
  method: 'patch',
  data
})

export const disableEquipmentCategory = (categoryId, data = {}) => request({
  url: `/equipment/categories/${categoryId}`,
  method: 'delete',
  data
})

export const getEquipmentHistory = (equipmentId, params) => request({
  url: `/equipment/${equipmentId}/history`,
  method: 'get',
  params
})

export const generateEquipmentQrCode = (equipmentId) => request({
  url: `/equipment/${equipmentId}/qrcode`,
  method: 'post'
})

export const exportEquipment = (params) => request({
  url: '/equipment/export',
  method: 'get',
  params,
  responseType: 'blob'
})

export const createEquipmentImportPreview = (file) => {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/equipment/imports',
    method: 'post',
    data
  })
}

export const getEquipmentImportJob = (importJobId, params) => request({
  url: `/equipment/imports/${importJobId}`,
  method: 'get',
  params
})

export const getEquipmentImportExceptions = (importJobId, params) => request({
  url: `/equipment/imports/${importJobId}/exceptions`,
  method: 'get',
  params
})

export const confirmEquipmentImport = (importJobId, data) => request({
  url: `/equipment/imports/${importJobId}/confirm`,
  method: 'post',
  data
})
