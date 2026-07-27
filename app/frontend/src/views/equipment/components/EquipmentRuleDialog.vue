<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    class="routine-rule-dialog"
    width="min(880px, 96vw)"
    destroy-on-close
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetForm"
  >
    <el-form ref="formRef" :model="form" :rules="rules" :disabled="readOnly" label-position="top" status-icon>
      <section class="form-section first-section">
        <h3>基本信息</h3>
        <div class="form-grid">
          <el-form-item label="业务类型" prop="routineType">
            <el-segmented
              v-model="form.routineType"
              :options="routineTypeOptions"
              :disabled="isEditing"
              block
            />
            <p class="field-hint">点检用于检查设备状态，保养用于记录维护工作。</p>
          </el-form-item>
          <el-form-item label="设备类型" prop="categoryId">
            <el-tree-select
              v-model="form.categoryId"
              :data="categoryOptions"
              node-key="value"
              check-strictly
              default-expand-all
              filterable
              :disabled="isEditing"
              class="full-width"
              placeholder="选择适用的设备类型"
            />
          </el-form-item>
          <el-form-item label="规则名称" prop="name" class="span-full">
            <el-input v-model="form.name" maxlength="200" show-word-limit placeholder="例如：电机皮带点检" />
          </el-form-item>
          <el-form-item label="规则说明" class="span-full">
            <el-input
              v-model="form.description"
              type="textarea"
              :rows="2"
              maxlength="2000"
              show-word-limit
              placeholder="填写适用范围或执行注意事项"
            />
          </el-form-item>
        </div>
      </section>

      <section class="form-section">
        <div class="section-heading">
          <div>
            <h3>执行窗口与提醒</h3>
            <p>设置允许执行的班次和时间，停用的窗口不会安排任务。</p>
          </div>
          <el-button v-if="!readOnly && form.executionConfig.windows.length < 8" @click="addExecutionWindow">
            <el-icon><Plus /></el-icon>
            添加窗口
          </el-button>
        </div>
        <div class="window-editor">
          <div
            v-for="(window, index) in form.executionConfig.windows"
            :key="window._localKey"
            class="window-row"
          >
            <el-switch v-model="window.enabled" class="window-enabled" aria-label="启用执行窗口" />
            <el-input v-model="window.name" maxlength="100" placeholder="窗口名称" class="window-name" />
            <el-time-picker
              v-model="window.startTime"
              format="HH:mm"
              value-format="HH:mm"
              placeholder="开始"
              class="window-time window-time--start"
            />
            <el-time-picker
              v-model="window.endTime"
              format="HH:mm"
              value-format="HH:mm"
              placeholder="结束"
              class="window-time window-time--end"
            />
            <el-button
              v-if="!readOnly"
              text
              circle
              type="danger"
              class="window-remove"
              :disabled="form.executionConfig.windows.length === 1"
              aria-label="删除执行窗口"
              @click="removeExecutionWindow(index)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
        <div class="form-grid execution-grid">
          <el-form-item v-if="form.routineType === 'INSPECTION'" label="二次升级等待（分钟）">
            <el-input-number
              v-model="form.executionConfig.inspectionEscalationMinutes"
              :min="1"
              :max="10080"
              :precision="0"
              class="full-width"
            />
            <p class="field-hint">异常超过该时间未处理，就继续通知上一级负责人。</p>
          </el-form-item>
          <el-form-item label="现场定位策略">
            <el-select v-model="form.executionConfig.locationPolicy" class="full-width">
              <el-option label="待客户确认（记录状态，不拦截）" value="PENDING_CONFIRMATION" />
              <el-option label="可选定位" value="OPTIONAL" />
              <el-option label="必须取得定位" value="REQUIRED" />
            </el-select>
            <p class="field-hint">决定手机定位失败时是否允许保存照片并提交记录。</p>
          </el-form-item>
          <el-form-item v-if="form.executionConfig.locationPolicy === 'REQUIRED'" label="最大定位误差（米）">
            <el-input-number
              v-model="form.executionConfig.locationPrecisionMeters"
              :min="1"
              :max="100000"
              :precision="0"
              clearable
              class="full-width"
            />
            <p class="field-hint">定位误差超过这个距离时，按定位失败处理。</p>
          </el-form-item>
          <el-form-item label="时区">
            <el-input v-model="form.executionConfig.timeZone" maxlength="64" />
            <p class="field-hint">用于判断执行窗口和到期时间，国内保持 Asia/Shanghai。</p>
          </el-form-item>
        </div>
        <el-alert
          v-if="form.executionConfig.locationPolicy === 'PENDING_CONFIRMATION'"
          title="地点精度、拒绝定位和无法定位时是否允许提交仍待客户确认；当前保存真实授权状态和水印文本，但不阻止提交。"
          type="warning"
          :closable="false"
          show-icon
        />
      </section>

      <section class="form-section">
        <div class="section-heading">
          <div>
            <h3>{{ routineProjectTitle }}</h3>
            <p>添加现场要做的项目，标为必检的项目必须填写结果。</p>
          </div>
          <el-button
            v-if="!readOnly"
            type="primary"
            class="add-checklist-button"
            @click="addChecklistItem"
          >
            <el-icon><Plus /></el-icon>
            添加检查项
          </el-button>
        </div>

        <div class="checklist-editor">
          <div class="checklist-header" :class="{ 'is-readonly': readOnly }" aria-hidden="true">
            <span>顺序</span>
            <span>项目名称</span>
            <span>执行要求</span>
            <span>必检</span>
            <span v-if="!readOnly">操作</span>
          </div>
          <div
            v-for="(item, index) in form.checklistItems"
            :key="item._localKey"
            class="checklist-row"
            :class="{ 'is-readonly': readOnly }"
          >
            <span class="item-order">{{ index + 1 }}</span>
            <el-input v-model="item.name" maxlength="200" placeholder="检查项目" />
            <el-input v-model="item.description" maxlength="2000" placeholder="标准、方法或注意事项" />
            <el-switch v-model="item.required" aria-label="是否必检" />
            <div v-if="!readOnly" class="item-actions">
              <el-tooltip content="上移" placement="top">
                <el-button text circle :disabled="index === 0" aria-label="上移" @click="moveItem(index, -1)">
                  <el-icon><Top /></el-icon>
                </el-button>
              </el-tooltip>
              <el-tooltip content="下移" placement="top">
                <el-button
                  text
                  circle
                  :disabled="index === form.checklistItems.length - 1"
                  aria-label="下移"
                  @click="moveItem(index, 1)"
                >
                  <el-icon><Bottom /></el-icon>
                </el-button>
              </el-tooltip>
              <el-tooltip content="删除" placement="top">
                <el-button
                  text
                  circle
                  type="danger"
                  :disabled="form.checklistItems.length === 1"
                  aria-label="删除检查项目"
                  @click="removeChecklistItem(index)"
                >
                  <el-icon><Delete /></el-icon>
                </el-button>
              </el-tooltip>
            </div>
          </div>
        </div>
      </section>

      <section class="form-section">
        <h3>执行周期</h3>
        <div class="form-grid schedule-grid">
          <el-form-item label="周期模式">
            <el-select v-model="form.schedule.mode" class="full-width" @change="handleScheduleModeChange">
              <el-option
                v-for="item in ROUTINE_SCHEDULE_MODE_OPTIONS"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
            <p class="field-hint">决定计划是手动发起，还是按日期或运行小时自动生成。</p>
          </el-form-item>

          <el-form-item v-if="usesCalendar" label="日历单位">
            <el-segmented v-model="form.schedule.calendar.unit" :options="calendarUnitOptions" block />
          </el-form-item>
          <el-form-item v-if="usesCalendar && form.schedule.calendar.unit === 'WEEK'" label="每周执行日">
            <el-select v-model="form.executionConfig.weeklyDay" class="full-width">
              <el-option v-for="day in weekDayOptions" :key="day.value" :label="day.label" :value="day.value" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="usesCalendar && form.schedule.calendar.unit === 'MONTH'" label="每月执行日">
            <el-input-number v-model="form.executionConfig.monthlyDay" :min="1" :max="31" :precision="0" class="full-width" />
          </el-form-item>
          <el-form-item v-if="usesCalendar" :label="calendarIntervalLabel">
            <el-input-number
              v-model="form.schedule.calendar.interval"
              :min="1"
              :max="10000"
              :precision="0"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
          <el-form-item v-if="usesCalendar" label="首次到期时间">
            <el-date-picker
              v-model="form.schedule.calendar.firstDueAt"
              type="datetime"
              class="full-width"
              placeholder="选择首次到期时间"
            />
            <p class="field-hint">系统从这个时间开始计算后续周期。</p>
          </el-form-item>

          <el-form-item v-if="usesRuntime" label="每运行多少小时">
            <el-input-number
              v-model="form.schedule.runtime.intervalHours"
              :min="0.1"
              :max="1000000"
              :step="0.1"
              :precision="1"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
          <el-form-item v-if="form.schedule.mode === 'COMBINED'" label="组合到期规则">
            <el-segmented v-model="form.schedule.duePolicy" :options="duePolicyOptions" block />
            <p class="field-hint">任一到期是满足一个就生成，全部到期是两个都满足才生成。</p>
          </el-form-item>
        </div>
        <el-alert
          v-if="usesRuntime"
          title="运行小时周期需要设备先录入累计运行小时；没有读数时不会生成虚假的到期时间。"
          type="info"
          :closable="false"
          show-icon
        />
      </section>

      <section class="form-section">
        <h3>提交要求</h3>
        <div class="form-grid">
          <el-form-item label="照片要求">
            <el-select v-model="form.photoPolicy" class="full-width">
              <el-option
                v-for="item in ROUTINE_PHOTO_POLICY_OPTIONS"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
            <p class="field-hint">决定提交时什么时候必须拍摄现场照片。</p>
          </el-form-item>
          <el-form-item label="异常说明">
            <el-switch
              v-model="form.abnormalNoteRequired"
              inline-prompt
              active-text="必填"
              inactive-text="选填"
            />
            <p class="field-hint">决定检查结果为异常时，是否必须填写原因。</p>
          </el-form-item>
        </div>
      </section>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ readOnly ? '关闭' : '取消' }}</el-button>
      <el-button v-if="!readOnly" type="primary" :loading="submitting" @click="submitForm">保存规则</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { requestErrorMessage } from '@/utils/request'
import {
  ROUTINE_CALENDAR_UNIT_OPTIONS,
  ROUTINE_DUE_POLICY_OPTIONS,
  ROUTINE_PHOTO_POLICY_OPTIONS,
  ROUTINE_SCHEDULE_MODE_OPTIONS,
  ROUTINE_TYPE_OPTIONS,
  appendChecklistItem as appendChecklistItemToList,
  buildCategoryTree,
  buildRoutineRulePayload,
  moveChecklistItem,
  removeChecklistItemAt
} from '@/utils/equipment'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  rule: { type: Object, default: null },
  copy: { type: Boolean, default: false },
  routineType: { type: String, default: 'INSPECTION' },
  allowedRoutineTypes: { type: Array, default: () => ['INSPECTION', 'MAINTENANCE'] },
  categories: { type: Array, default: () => [] },
  defaultCategoryId: { type: String, default: '' },
  schedulePreset: { type: String, default: '' },
  submitting: { type: Boolean, default: false },
  readOnly: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'submit'])
const formRef = ref(null)
let localKeySequence = 0
const form = reactive(emptyForm())

const isEditing = computed(() => Boolean(props.rule?._id) && !props.copy)
const dialogTitle = computed(() => {
  if (props.readOnly) return '查看点检/保养规则'
  if (props.copy) return '复制点检/保养规则'
  return isEditing.value ? '编辑点检/保养规则' : '新增点检/保养规则'
})
const routineProjectTitle = computed(() => (
  form.routineType === 'MAINTENANCE' ? '保养项目' : '点检项目'
))
const routineTypeOptions = computed(() => ROUTINE_TYPE_OPTIONS
  .filter((item) => props.allowedRoutineTypes.includes(item.value)))
const calendarUnitOptions = ROUTINE_CALENDAR_UNIT_OPTIONS.map((item) => ({
  label: item.label,
  value: item.value
}))
const duePolicyOptions = ROUTINE_DUE_POLICY_OPTIONS.map((item) => ({
  label: item.value === 'ANY' ? '任一到期' : '全部到期',
  value: item.value
}))
const weekDayOptions = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
]
const usesCalendar = computed(() => ['CALENDAR', 'COMBINED'].includes(form.schedule.mode))
const usesRuntime = computed(() => ['RUNTIME_HOURS', 'COMBINED'].includes(form.schedule.mode))
const calendarIntervalLabel = computed(() => ({
  DAY: '每隔多少天',
  WEEK: '每隔多少周',
  MONTH: '每隔多少月'
}[form.schedule.calendar.unit] || '周期间隔'))
const categoryOptions = computed(() => {
  const convert = (items) => items
    .filter((item) => item.status === 'ACTIVE' || item._id === form.categoryId)
    .map((item) => ({
      value: item._id,
      label: item.name,
      children: convert(item.children || [])
    }))
  return convert(buildCategoryTree(props.categories))
})

const rules = {
  routineType: [{ required: true, message: '请选择业务类型', trigger: 'change' }],
  categoryId: [{ required: true, message: '请选择设备类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }]
}

function createChecklistItem(source = {}) {
  localKeySequence += 1
  return {
    _localKey: `item-${localKeySequence}`,
    key: source.key || '',
    name: source.name || '',
    description: source.description || '',
    required: source.required !== false
  }
}

function defaultFirstDueAt() {
  const value = new Date()
  value.setDate(value.getDate() + 1)
  value.setHours(8, 0, 0, 0)
  return value
}

function defaultSchedule() {
  const calendarUnits = new Set(['DAY', 'WEEK', 'MONTH'])
  const preset = String(props.schedulePreset || '')
  const mode = preset === 'RUNTIME_HOURS'
    ? 'RUNTIME_HOURS'
    : preset === 'COMBINED' ? 'COMBINED' : 'CALENDAR'
  return {
    mode,
    duePolicy: 'ANY',
    calendar: {
      unit: calendarUnits.has(preset) ? preset : 'DAY',
      interval: 1,
      firstDueAt: defaultFirstDueAt()
    },
    runtime: { intervalHours: 200 }
  }
}

function createExecutionWindow(source = {}, index = 0) {
  localKeySequence += 1
  const defaults = index === 0
    ? { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00' }
    : { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00' }
  const key = source.key || defaults.key || `CUSTOM_${index + 1}`
  return {
    _localKey: `window-${localKeySequence}`,
    key,
    name: source.name || defaults.name || `窗口${index + 1}`,
    startTime: source.startTime || defaults.startTime || '07:00',
    endTime: source.endTime || defaults.endTime || '09:00',
    enabled: source.enabled !== false
  }
}

function emptyForm() {
  return {
    routineType: props?.routineType || 'INSPECTION',
    categoryId: props?.defaultCategoryId || '',
    name: '',
    description: '',
    checklistItems: [createChecklistItem()],
    schedule: defaultSchedule(),
    photoPolicy: 'ON_ABNORMAL',
    abnormalNoteRequired: true,
    executionConfig: {
      timeZone: 'Asia/Shanghai',
      windows: [createExecutionWindow({}, 0), createExecutionWindow({}, 1)],
      weeklyDay: 1,
      monthlyDay: 1,
      inspectionEscalationMinutes: 60,
      locationPolicy: 'PENDING_CONFIRMATION',
      locationPrecisionMeters: null
    },
    status: 'ACTIVE'
  }
}

function resetForm() {
  const source = props.rule
  if (!source) {
    Object.assign(form, emptyForm(), { routineType: props.routineType })
  } else {
    Object.assign(form, {
      routineType: source.routineType || props.routineType,
      categoryId: source.categoryId?._id || source.categoryId || '',
      name: props.copy ? `${source.name || ''}（副本）` : source.name || '',
      description: source.description || '',
      checklistItems: (source.checklistItems || []).map(createChecklistItem),
      schedule: {
        mode: source.schedule?.mode || 'MANUAL',
        duePolicy: source.schedule?.duePolicy || 'ANY',
        calendar: {
          unit: source.schedule?.calendar?.unit || 'DAY',
          interval: source.schedule?.calendar?.interval || 1,
          firstDueAt: source.schedule?.calendar?.firstDueAt
            ? new Date(source.schedule.calendar.firstDueAt)
            : defaultFirstDueAt()
        },
        runtime: {
          intervalHours: source.schedule?.runtime?.intervalHours || 200
        }
      },
      photoPolicy: source.photoPolicy || 'NONE',
      abnormalNoteRequired: source.abnormalNoteRequired !== false,
      executionConfig: {
        timeZone: source.executionConfig?.timeZone || 'Asia/Shanghai',
        windows: (source.executionConfig?.windows?.length
          ? source.executionConfig.windows
          : [
              { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00' },
              { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00' }
            ]).map(createExecutionWindow),
        weeklyDay: source.executionConfig?.weeklyDay || 1,
        monthlyDay: source.executionConfig?.monthlyDay || 1,
        inspectionEscalationMinutes: source.executionConfig?.inspectionEscalationMinutes || 60,
        locationPolicy: source.executionConfig?.locationPolicy || 'PENDING_CONFIRMATION',
        locationPrecisionMeters: source.executionConfig?.locationPrecisionMeters ?? null
      },
      status: props.copy ? 'ACTIVE' : source.status || 'ACTIVE'
    })
    if (!form.checklistItems.length) form.checklistItems.push(createChecklistItem())
  }
  formRef.value?.clearValidate()
}

function addChecklistItem() {
  appendChecklistItemToList(form.checklistItems, createChecklistItem())
}

function removeChecklistItem(index) {
  removeChecklistItemAt(form.checklistItems, index)
}

function moveItem(index, direction) {
  moveChecklistItem(form.checklistItems, index, direction)
}

function handleScheduleModeChange(mode) {
  if (mode === 'COMBINED' && !form.schedule.duePolicy) form.schedule.duePolicy = 'ANY'
}

function addExecutionWindow() {
  const index = form.executionConfig.windows.length
  form.executionConfig.windows.push(createExecutionWindow({
    key: `CUSTOM_${index + 1}`,
    name: `窗口${index + 1}`,
    startTime: '07:00',
    endTime: '09:00'
  }, index))
}

function removeExecutionWindow(index) {
  if (form.executionConfig.windows.length > 1) form.executionConfig.windows.splice(index, 1)
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (form.checklistItems.some((item) => !item.name.trim())) {
    ElMessage.warning('请填写所有检查项目名称')
    return
  }
  try {
    emit('submit', buildRoutineRulePayload(form))
  } catch (error) {
    console.error('规则配置校验失败:', error)
    ElMessage.warning(requestErrorMessage(error, '请完善规则配置'))
  }
}

watch(() => props.modelValue, (visible) => {
  if (visible) resetForm()
})
</script>

<style lang="scss">
.routine-rule-dialog.el-dialog {
  border-radius: 8px;
}
</style>

<style scoped lang="scss">
.form-section { padding-top: 20px; margin-top: 20px; border-top: 1px solid var(--zl-border-soft); }
.first-section { padding-top: 0; margin-top: 0; border-top: 0; }
.form-section h3 { margin: 0 0 14px; font-size: 16px; letter-spacing: 0; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.section-heading h3 { margin-bottom: 4px; }
.section-heading p { margin: 0 0 14px; color: var(--zl-muted); font-size: 13px; }
.add-checklist-button { flex: 0 0 auto; min-width: 126px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.span-full { grid-column: 1 / -1; }
.full-width { width: 100%; }
.field-hint { flex-basis: 100%; margin: 6px 0 0; color: var(--zl-muted); font-size: 12px; line-height: 1.5; }
.checklist-editor { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 8px; }
.checklist-header,
.checklist-row {
  display: grid;
  grid-template-columns: 46px minmax(150px, 0.8fr) minmax(220px, 1.2fr) 54px 116px;
  align-items: center;
  gap: 8px;
  min-width: 700px;
  padding: 8px 10px;
}
.checklist-header { color: #475569; background: #eef4ff; font-size: 13px; font-weight: 600; }
.checklist-header.is-readonly,
.checklist-row.is-readonly { grid-template-columns: 46px minmax(150px, 0.8fr) minmax(220px, 1.2fr) 54px; }
.checklist-row + .checklist-row { border-top: 1px solid var(--zl-border-soft); }
.item-order { color: var(--zl-muted); text-align: center; }
.item-actions { display: grid; grid-template-columns: repeat(3, 32px); justify-content: end; gap: 2px; }
.item-actions .el-button { width: 32px; height: 32px; margin: 0; }
.schedule-grid { align-items: end; }
.window-editor { display: grid; gap: 8px; margin-bottom: 16px; }
.window-row { display: grid; grid-template-columns: 44px minmax(120px, 1fr) 160px 160px 34px; align-items: center; gap: 8px; }
.window-row > * { min-width: 0; }
.window-row .window-time {
  --el-date-editor-width: 100%;
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100%;
}
.execution-grid { align-items: end; }
@media (max-width: 760px) {
  .form-grid { grid-template-columns: 1fr; }
  .span-full { grid-column: auto; }
  .section-heading { align-items: stretch; flex-direction: column; }
  .add-checklist-button { width: 100%; }
  .checklist-editor { overflow-x: auto; }
  .window-row { grid-template-columns: 40px repeat(4, minmax(0, 1fr)) 34px; }
  .window-enabled { grid-column: 1; grid-row: 1; }
  .window-name { grid-column: 2 / 6; grid-row: 1; }
  .window-remove { grid-column: 6; grid-row: 1; }
  .window-time--start { grid-column: 1 / 4; grid-row: 2; }
  .window-time--end { grid-column: 4 / 7; grid-row: 2; }
}
</style>
