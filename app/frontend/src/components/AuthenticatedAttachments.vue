<template>
  <div class="authenticated-attachments">
    <div
      v-for="(attachment, index) in attachments"
      :key="attachment.fileId || attachment._id || index"
      class="attachment-row"
    >
      <el-icon class="attachment-icon">
        <Picture v-if="isImageAttachment(attachment)" />
        <Document v-else />
      </el-icon>
      <span class="attachment-name">{{ attachmentName(attachment) }}</span>
      <span class="attachment-size">{{ formatSize(attachment.size) }}</span>
      <template v-if="managedFileId(attachment)">
        <el-tooltip v-if="isImageAttachment(attachment)" content="预览" placement="top">
          <el-button
            text
            :icon="View"
            :loading="loadingId === managedFileId(attachment)"
            aria-label="预览附件"
            @click="preview(attachment)"
          />
        </el-tooltip>
        <el-tooltip content="下载" placement="top">
          <el-button
            text
            :icon="Download"
            :loading="loadingId === managedFileId(attachment)"
            aria-label="下载附件"
            @click="download(attachment)"
          />
        </el-tooltip>
      </template>
      <el-tag v-else size="small" type="info">历史附件</el-tag>
    </div>

    <el-dialog v-model="previewVisible" title="附件预览" width="min(760px, 92vw)" @closed="clearPreview">
      <img v-if="previewUrl" :src="previewUrl" :alt="previewName" class="preview-image" />
    </el-dialog>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref } from 'vue'
import { Document, Download, Picture, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { downloadFileBlob } from '@/api/file'
import {
  attachmentName,
  isImageAttachment,
  managedFileId
} from '@/utils/attachments'

const props = defineProps({
  attachments: {
    type: Array,
    default: () => []
  },
  teamId: {
    type: String,
    default: ''
  }
})

const loadingId = ref('')
const previewVisible = ref(false)
const previewUrl = ref('')
const previewName = ref('')

function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewName.value = ''
}

async function loadBlob(attachment) {
  const fileId = managedFileId(attachment)
  if (!fileId) throw new Error('该历史附件尚未迁移到私有文件服务')
  loadingId.value = fileId
  try {
    return await downloadFileBlob(fileId, props.teamId)
  } finally {
    loadingId.value = ''
  }
}

async function preview(attachment) {
  try {
    const blob = await loadBlob(attachment)
    clearPreview()
    previewUrl.value = URL.createObjectURL(blob)
    previewName.value = attachmentName(attachment)
    previewVisible.value = true
  } catch (error) {
    ElMessage.error(error.message || '附件预览失败')
  }
}

async function download(attachment) {
  try {
    const blob = await loadBlob(attachment)
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = attachmentName(attachment)
    link.click()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) {
    ElMessage.error(error.message || '附件下载失败')
  }
}

onBeforeUnmount(clearPreview)
</script>

<style scoped>
.authenticated-attachments {
  display: grid;
  gap: 8px;
}

.attachment-row {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto auto auto;
  align-items: center;
  min-height: 40px;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.attachment-icon {
  color: var(--el-color-primary);
}

.attachment-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.attachment-size {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.preview-image {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  margin: 0 auto;
  object-fit: contain;
}
</style>
