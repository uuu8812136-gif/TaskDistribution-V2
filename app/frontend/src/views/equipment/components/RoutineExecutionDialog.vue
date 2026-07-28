<template>
  <el-dialog
    :model-value="modelValue"
    title="提交点检/保养记录"
    class="routine-execution-dialog"
    width="min(840px, 96vw)"
    destroy-on-close
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetForm"
  >
    <template v-if="rule">
      <section class="execution-summary">
        <div>
          <span>规则</span>
          <strong>{{ rule.name }}</strong>
        </div>
        <div>
          <span>类型</span>
          <strong>{{ optionForValue(ROUTINE_TYPE_OPTIONS, rule.routineType).label }}</strong>
        </div>
        <div>
          <span>周期</span>
          <strong>{{ routineScheduleLabel(rule.schedule) }}</strong>
        </div>
      </section>

      <el-alert
        v-if="rule.photoPolicy !== 'NONE'"
        title="当前 Web 表单不上传现场照片；规则要求照片时，请使用小程序完成现场提交。"
        type="info"
        :closable="false"
        show-icon
        class="photo-alert"
      />

      <el-form ref="formRef" :model="form" label-position="top">
        <div class="result-editor">
          <div class="result-header" aria-hidden="true">
            <span>项目</span>
            <span>结果</span>
            <span>说明</span>
          </div>
          <div v-for="item in form.itemResults" :key="item.itemKey" class="result-row">
            <div class="item-copy">
              <strong>{{ item.name }}</strong>
              <span>{{ item.description || '无补充要求' }}</span>
            </div>
            <el-radio-group v-model="item.result" class="result-radio">
              <el-radio-button
                v-for="option in resultOptions(item)"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </el-radio-button>
            </el-radio-group>
            <el-input
              v-model="item.note"
              maxlength="2000"
              :placeholder="item.result === 'ABNORMAL' && rule.abnormalNoteRequired !== false ? '填写说明，或在下方统一汇总' : '结果说明（选填）'"
            />
          </div>
        </div>

        <div class="execution-form-grid">
          <el-form-item v-if="usesRuntime" label="本次累计运行小时">
            <el-input-number
              v-model="form.runtimeHours"
              :min="0"
              :max="1000000000"
              :precision="1"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="异常汇总" :class="{ 'span-full': !usesRuntime }">
            <el-input v-model="form.abnormalSummary" maxlength="2000" placeholder="可填写异常处理或交接信息" />
          </el-form-item>
        </div>
      </el-form>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submitForm">提交记录</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { requestErrorMessage } from '@/utils/request'
import {
  ROUTINE_TYPE_OPTIONS,
  buildRoutineRecordPayload,
  optionForValue,
  routineAbnormalNotesComplete,
  routineItemResultOptions,
  routineScheduleLabel,
  selectExecutableRoutinePlan
} from '@/utils/equipment'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  scheduleEntry: { type: Object, default: null },
  currentRuntimeHours: { type: [Number, String], default: null },
  submitting: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref(null)
const form = reactive(emptyForm())

const rule = computed(() => props.scheduleEntry?.rule || null)
const usesRuntime = computed(() => ['RUNTIME_HOURS', 'COMBINED'].includes(rule.value?.schedule?.mode))

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyForm() {
  return {
    ruleId: '',
    runtimeHours: null,
    itemResults: [],
    abnormalSummary: '',
    photoFileIds: [],
    planId: '',
    idempotencyKey: createIdempotencyKey()
  }
}

function resetForm() {
  const sourceRule = rule.value
  Object.assign(form, emptyForm(), {
    ruleId: sourceRule?._id || '',
    planId: selectExecutableRoutinePlan(props.scheduleEntry?.plans)?._id || '',
    runtimeHours: props.currentRuntimeHours ?? null,
    itemResults: (sourceRule?.checklistItems || []).map((item, index) => ({
      itemKey: item.key || `item-${index + 1}`,
      name: item.name,
      description: item.description,
      required: item.required !== false,
      result: '',
      note: ''
    }))
  })
}

function submitForm() {
  if (form.itemResults.some((item) => !item.result)) {
    ElMessage.warning('请逐项选择正常或异常')
    return
  }
  if (!routineAbnormalNotesComplete(
    form.itemResults,
    form.abnormalSummary,
    rule.value?.abnormalNoteRequired !== false
  )) {
    ElMessage.warning('请填写异常项目说明或异常汇总')
    return
  }
  if (usesRuntime.value && (form.runtimeHours === null || form.runtimeHours === '')) {
    ElMessage.warning('运行小时周期必须填写本次累计运行小时')
    return
  }
  const hasAbnormal = form.itemResults.some((item) => item.result === 'ABNORMAL')
  if (rule.value?.photoPolicy === 'ALWAYS' || (rule.value?.photoPolicy === 'ON_ABNORMAL' && hasAbnormal)) {
    ElMessage.warning('该结果需要现场照片，请使用小程序完成提交')
    return
  }
  try {
    emit('submit', buildRoutineRecordPayload(form))
  } catch (error) {
    console.error('点检或保养执行结果校验失败:', error)
    ElMessage.warning(requestErrorMessage(error, '请完善执行结果'))
  }
}

function resultOptions(item) {
  return routineItemResultOptions(rule.value?.routineType, item.required)
}

watch(() => props.modelValue, (visible) => {
  if (visible) resetForm()
})
</script>

<style lang="scss">
.routine-execution-dialog.el-dialog { border-radius: 8px; }
</style>

<style scoped lang="scss">
.execution-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid var(--zl-border-soft); }
.execution-summary > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--zl-border-soft); }
.execution-summary > div:last-child { border-right: 0; }
.execution-summary span { display: block; margin-bottom: 5px; color: var(--zl-muted); font-size: 12px; }
.execution-summary strong { display: block; overflow-wrap: anywhere; }
.photo-alert { margin-top: 16px; }
.result-editor { margin-top: 18px; overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 8px; }
.result-header,
.result-row { display: grid; grid-template-columns: minmax(190px, 1fr) 166px minmax(210px, 1fr); align-items: center; gap: 10px; min-width: 650px; padding: 9px 12px; }
.result-header { color: #475569; background: #eef4ff; font-size: 13px; font-weight: 600; }
.result-row + .result-row { border-top: 1px solid var(--zl-border-soft); }
.item-copy { min-width: 0; display: grid; gap: 3px; }
.item-copy strong,
.item-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-copy span { color: var(--zl-muted); font-size: 12px; }
.result-radio { display: grid; grid-template-columns: repeat(2, 1fr); }
.result-radio :deep(.el-radio-button__inner) { width: 100%; }
.execution-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; margin-top: 18px; }
.span-full { grid-column: 1 / -1; }
.full-width { width: 100%; }
@media (max-width: 720px) {
  .execution-summary { grid-template-columns: 1fr; }
  .execution-summary > div { border-right: 0; border-bottom: 1px solid var(--zl-border-soft); }
  .execution-summary > div:last-child { border-bottom: 0; }
  .result-editor { overflow-x: auto; }
  .execution-form-grid { grid-template-columns: 1fr; }
  .span-full { grid-column: auto; }
}
</style>
