<template>
  <el-dialog
    :model-value="modelValue"
    title="录入设备运行小时"
    class="runtime-reading-dialog"
    width="min(520px, 94vw)"
    destroy-on-close
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetForm"
  >
    <el-alert
      :title="currentLabel"
      type="info"
      :closable="false"
      show-icon
      class="current-reading"
    />
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
      <el-form-item label="累计运行小时" prop="hours">
        <el-input-number
          v-model="form.hours"
          :min="minimumHours"
          :max="1000000000"
          :precision="1"
          controls-position="right"
          class="full-width"
        />
      </el-form-item>
      <el-form-item label="录入说明" prop="reason">
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          maxlength="2000"
          show-word-limit
          placeholder="例如：交班抄表、维修后复核"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submitForm">保存读数</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { requestErrorMessage } from '@/utils/request'
import { buildRuntimeReadingPayload, normalizeRuntimeHours } from '@/utils/equipment'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  currentRuntimeHours: { type: [Number, String], default: null },
  submitting: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref(null)
const form = reactive({ hours: null, reason: '' })
const numericCurrentHours = computed(() => normalizeRuntimeHours(props.currentRuntimeHours))
const minimumHours = computed(() => numericCurrentHours.value ?? 0)
const currentLabel = computed(() => numericCurrentHours.value === null
  ? '当前尚无运行小时读数，请录入设备累计值。'
  : `当前累计运行 ${numericCurrentHours.value} 小时，新读数不能小于当前值。`)
const rules = {
  hours: [{ required: true, message: '请输入累计运行小时', trigger: 'change' }],
  reason: [{ required: true, message: '请输入录入说明', trigger: 'blur' }]
}

function resetForm() {
  Object.assign(form, {
    hours: numericCurrentHours.value,
    reason: ''
  })
  formRef.value?.clearValidate()
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (numericCurrentHours.value !== null && Number(form.hours) < numericCurrentHours.value) {
    ElMessage.warning('累计运行小时不能小于当前读数')
    return
  }
  try {
    emit('submit', buildRuntimeReadingPayload(form))
  } catch (error) {
    console.error('运行小时读数校验失败:', error)
    ElMessage.warning(requestErrorMessage(error, '请完善运行小时读数'))
  }
}

watch(() => props.modelValue, (visible) => {
  if (visible) resetForm()
})
</script>

<style lang="scss">
.runtime-reading-dialog.el-dialog { border-radius: 8px; }
</style>

<style scoped>
.current-reading { margin-bottom: 18px; }
.full-width { width: 100%; }
</style>
