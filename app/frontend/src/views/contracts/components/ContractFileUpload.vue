<template>
  <div class="contract-file-upload">
    <el-upload
      v-model:file-list="fileList"
      :auto-upload="false"
      :disabled="disabled"
      :multiple="true"
      :limit="limit"
      :accept="accept"
      :on-change="validateFile"
      :on-preview="previewFile"
    >
      <el-button :disabled="disabled">
        <el-icon><Paperclip /></el-icon>
        选择附件
      </el-button>
      <template #tip>
        <div class="el-upload__tip">{{ acceptTip }}，单个文件不超过 20 MB</div>
      </template>
    </el-upload>

    <el-dialog v-model="previewVisible" title="附件预览" width="min(760px, 92vw)" append-to-body @closed="clearPreview">
      <img v-if="previewKind === 'image'" :src="previewUrl" :alt="previewName" class="preview-image" />
      <iframe v-else-if="previewKind === 'pdf'" :src="previewUrl" :title="previewName" class="preview-pdf" />
      <el-empty v-else description="该格式请下载后查看" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { downloadFileBlob } from '@/api/file'
import { managedFileId } from '@/utils/attachments'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  teamId: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  limit: { type: Number, default: 10 },
  accept: {
    type: String,
    default: '.jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx'
  }
})
const emit = defineEmits(['update:modelValue'])

const fileList = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})
const acceptTip = computed(() => {
  if (props.accept === '.pdf') return '仅支持 PDF'
  if (!/doc|xls/i.test(props.accept)) return '支持图片和 PDF'
  return '支持图片、PDF 和常用文档'
})
const previewVisible = ref(false)
const previewUrl = ref('')
const previewName = ref('')
const previewKind = ref('')

function validateFile(file, files) {
  if (!file.raw) return
  const allowedExtensions = props.accept
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.startsWith('.'))
  const fileName = String(file.raw.name || '').toLowerCase()
  if (allowedExtensions.length && !allowedExtensions.some((extension) => fileName.endsWith(extension))) {
    ElMessage.warning(`附件“${file.raw.name}”格式不符合当前资料要求`)
    emit('update:modelValue', files.filter((item) => item.uid !== file.uid))
    return
  }
  if (file.raw.size > 20 * 1024 * 1024) {
    ElMessage.warning('单个附件不能超过 20 MB')
    emit('update:modelValue', files.filter((item) => item.uid !== file.uid))
  }
}

function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewName.value = ''
  previewKind.value = ''
}

async function previewFile(file) {
  clearPreview()
  previewName.value = file.name || '附件'
  const mimeType = file.raw?.type || file.mimeType || ''
  previewKind.value = mimeType.startsWith('image/') || /\.(?:jpe?g|png)$/i.test(previewName.value)
    ? 'image'
    : mimeType === 'application/pdf' || /\.pdf$/i.test(previewName.value) ? 'pdf' : 'other'
  if (previewKind.value === 'other') {
    ElMessage.info('该附件格式请保存后在记录中下载查看')
    return
  }
  if (file.raw) previewUrl.value = URL.createObjectURL(file.raw)
  else {
    const fileId = managedFileId(file)
    if (!fileId) return
    previewUrl.value = URL.createObjectURL(await downloadFileBlob(fileId, props.teamId || undefined))
  }
  previewVisible.value = true
}

onBeforeUnmount(clearPreview)
</script>

<style scoped>
.preview-image { display: block; max-width: 100%; max-height: 68vh; margin: 0 auto; object-fit: contain; }
.preview-pdf { width: 100%; height: 68vh; border: 0; }
</style>
