const MANAGED_ID_PATTERN = /^[0-9a-fA-F]{24}$/

export function managedFileId(value) {
  const candidate = value?.fileId || value?.response?.file?._id || value?.file?._id
  return typeof candidate === 'string' && MANAGED_ID_PATTERN.test(candidate)
    ? candidate.toLowerCase()
    : null
}

export function attachmentName(attachment) {
  return attachment?.originalName || attachment?.name || attachment?.filename || '附件'
}

export function attachmentMimeType(attachment) {
  return attachment?.mimeType || attachment?.mimetype || attachment?.type || ''
}

export function isImageAttachment(attachment) {
  const mimeType = attachmentMimeType(attachment).toLowerCase()
  if (mimeType) return mimeType.startsWith('image/')
  return /\.(?:jpe?g|png|gif)$/i.test(attachmentName(attachment))
}

export function existingAttachmentFileList(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => {
      const fileId = managedFileId(attachment)
      if (!fileId) return null
      return {
        uid: fileId,
        fileId,
        name: attachmentName(attachment),
        size: Number(attachment.size) || 0,
        status: 'success'
      }
    })
    .filter(Boolean)
}

export async function prepareAttachmentReferences(fileList, uploadFile) {
  if (!Array.isArray(fileList)) throw new TypeError('附件列表格式不正确')
  if (typeof uploadFile !== 'function') throw new TypeError('附件上传方法不可用')

  const references = []
  const uploadedFileIds = []
  try {
    for (const item of fileList) {
      const existingId = managedFileId(item)
      if (existingId) {
        references.push({ fileId: existingId })
        continue
      }
      if (!item?.raw) throw new TypeError('所选附件缺少文件数据，请重新选择')
      const response = await uploadFile(item.raw)
      const uploadedId = managedFileId(response)
      if (!uploadedId) throw new TypeError('附件上传结果缺少有效文件编号')
      references.push({ fileId: uploadedId })
      uploadedFileIds.push(uploadedId)
    }
  } catch (error) {
    error.uploadedFileIds = [...uploadedFileIds]
    throw error
  }
  return { references, uploadedFileIds }
}

export async function cleanupTemporaryFiles(fileIds, deleteManagedFile) {
  if (typeof deleteManagedFile !== 'function') return
  await Promise.allSettled(
    [...new Set(fileIds || [])].map((fileId) => deleteManagedFile(fileId))
  )
}
