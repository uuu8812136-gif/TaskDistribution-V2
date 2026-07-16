import request from '@/utils/request'

export function uploadTemporaryFile(file) {
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/files',
    method: 'post',
    data
  })
}

export function downloadFileBlob(fileId, teamId) {
  return request({
    url: `/files/${fileId}/download`,
    method: 'get',
    params: teamId ? { teamId } : undefined,
    responseType: 'blob'
  })
}

export function getFileMetadata(fileId, teamId) {
  return request({
    url: `/files/${fileId}`,
    method: 'get',
    params: teamId ? { teamId } : undefined
  })
}

export function deleteFile(fileId) {
  return request({
    url: `/files/${fileId}`,
    method: 'delete'
  })
}
