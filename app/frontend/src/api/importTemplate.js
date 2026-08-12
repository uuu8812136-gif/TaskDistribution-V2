import request from '@/utils/request'

export function getImportTemplates() {
  return request({
    url: '/import-templates',
    method: 'get'
  })
}

export function downloadImportTemplate(templateId) {
  return request({
    url: `/import-templates/${encodeURIComponent(templateId)}/download`,
    method: 'get',
    responseType: 'blob'
  })
}
