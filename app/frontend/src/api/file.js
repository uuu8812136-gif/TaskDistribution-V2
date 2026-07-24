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

export function uploadTaskTemporaryFile(file, { taskId = '', orgUnitId = '' } = {}) {
  const normalizedTaskId = String(taskId || '').trim()
  const normalizedOrgUnitId = String(orgUnitId || '').trim()
  if (Boolean(normalizedTaskId) === Boolean(normalizedOrgUnitId)) {
    throw new TypeError('任务附件必须且只能指定 taskId 或 orgUnitId')
  }
  const data = new FormData()
  data.append('file', file)
  return request({
    url: '/files/task-temporary',
    method: 'post',
    params: normalizedTaskId
      ? { taskId: normalizedTaskId }
      : { orgUnitId: normalizedOrgUnitId },
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
