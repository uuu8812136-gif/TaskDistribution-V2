const FILE_ID_PATTERN = /^[0-9a-fA-F]{24}$/

export function managedFileId(attachment) {
  const fileId = attachment?.fileId
  return typeof fileId === 'string' && FILE_ID_PATTERN.test(fileId)
    ? fileId.toLowerCase()
    : null
}

export function taskTemporaryUploadUrl({ taskId = '', orgUnitId = '' } = {}) {
  const normalizedTaskId = taskId === null || taskId === undefined ? '' : String(taskId).trim()
  const normalizedOrgUnitId = orgUnitId === null || orgUnitId === undefined
    ? ''
    : String(orgUnitId).trim()
  if (Boolean(normalizedTaskId) === Boolean(normalizedOrgUnitId)) {
    throw new TypeError('任务附件必须且只能指定 taskId 或 orgUnitId')
  }
  return normalizedTaskId
    ? `/files/task-temporary?taskId=${encodeURIComponent(normalizedTaskId)}`
    : `/files/task-temporary?orgUnitId=${encodeURIComponent(normalizedOrgUnitId)}`
}

export function attachmentName(attachment) {
  return attachment?.originalName || attachment?.filename || '附件'
}

export function attachmentMimeType(attachment) {
  return attachment?.mimeType || attachment?.mimetype || ''
}

export function isImageAttachment(attachment) {
  const mimeType = attachmentMimeType(attachment).toLowerCase()
  if (mimeType) return mimeType.startsWith('image/')
  return /\.(?:jpe?g|png|gif)$/i.test(attachmentName(attachment))
}

export function canOpenDocument(attachment) {
  return /\.(?:pdf|docx?|xlsx?|pptx?)$/i.test(attachmentName(attachment))
}
