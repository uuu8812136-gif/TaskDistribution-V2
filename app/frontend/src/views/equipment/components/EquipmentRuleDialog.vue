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
    <template #header="{ titleId, titleClass }">
      <div class="routine-rule-dialog__header">
        <span
          :id="titleId"
          :class="[titleClass, 'routine-rule-dialog__title']"
          role="heading"
          aria-level="2"
        >
          {{ dialogTitle }}
        </span>
        <el-tooltip content="功能说明" placement="bottom">
          <el-button
            text
            circle
            class="routine-rule-help-button"
            aria-label="查看规则功能说明"
            aria-haspopup="dialog"
            :aria-expanded="helpVisible"
            @click="helpVisible = true"
          >
            <el-icon :size="18"><QuestionFilled /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </template>

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
        <el-alert
          title="本周期适用于上方全部检查项；执行频率不同的项目请单独建立一条规则。"
          type="info"
          :closable="false"
          show-icon
          class="schedule-scope-alert"
        />
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

  <el-drawer
    v-model="helpVisible"
    title="点检/保养规则功能说明"
    size="min(560px, 94vw)"
    append-to-body
    destroy-on-close
    class="routine-rule-help-drawer"
  >
    <div class="routine-rule-help-content">
      <p class="routine-rule-help-intro">
        本页用于为一个具体设备类型建立点检或保养规则，统一设置适用设备、现场项目、执行周期、计划窗口和提交证据。
      </p>

      <section class="routine-rule-help-section">
        <h3>1. 权限与作用范围</h3>
        <ul>
          <li>维护规则时必须先进入具体团队，并具备设备编辑及对应的点检或保养权限。</li>
          <li>部门经理、设备管理员，以及切入具体团队后的超级管理员，可按实际授权新增、编辑、复制、停用或删除规则。</li>
          <li>全局只读状态或查看模式只允许查看内容，不能保存修改。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>2. 基本信息、设备类型与二维码</h3>
        <ul>
          <li><strong>业务类型：</strong>点检用于确认设备状态，保养用于记录维护工作；规则创建后不能直接更换业务类型。</li>
          <li><strong>设备类型：</strong>规则只与所选分类精确匹配，规则创建后不能直接更换设备类型。</li>
          <li><strong>规则名称和说明：</strong>用于在规则列表、计划、消息和现场执行页中识别规则及查看注意事项。</li>
          <li><strong>二维码关系：</strong>每台设备的二维码通过隐藏令牌定位唯一设备记录，标签同时显示固定资产编号；扫码后，系统再按该设备的类型查询适用规则，规则内容不会写入二维码。</li>
        </ul>
        <div class="routine-rule-help-callout" role="note">
          当前设备类型按所选分类精确匹配。选择父级分类不会自动覆盖其下级设备；不同下级分类需要分别建立规则。
        </div>
      </section>

      <section class="routine-rule-help-section">
        <h3>3. 执行窗口与提醒</h3>
        <ul>
          <li>窗口用于设置允许执行的班次和时间，结束时间早于或等于开始时间时按跨天窗口处理。</li>
          <li>停用的窗口不生成对应计划，但整条规则至少要保留一个启用窗口。</li>
          <li>日历点检会使用全部启用窗口，日历保养只使用第一个启用窗口；运行小时达到阈值后会立即生成到期计划，并使用第一个启用窗口的名称作为任务标识。</li>
          <li>日历计划在窗口开始前为“计划中”，进入窗口后为“执行中”，超过结束时间未完成则为“已逾期”。</li>
          <li>“二次升级等待”只用于点检异常，超过设置时间仍未处理时继续通知上一级负责人。</li>
          <li>国内团队时区保持 <code>Asia/Shanghai</code>，否则执行窗口和到期时间可能发生偏移。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>4. 点检或保养项目</h3>
        <ul>
          <li>每一行代表现场要完成的一项工作，可填写项目名称、执行标准或注意事项，并调整顺序。</li>
          <li>所有项目都必须选择结果；必检项目不能跳过，非必检项目可按实际情况选择跳过。</li>
          <li>同一规则内的全部项目共用同一个执行周期。项目频率不同，例如每日检查和每月检查，应拆成两条规则。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>5. 执行周期</h3>
        <dl class="routine-rule-help-definitions">
          <div>
            <dt>手动发起</dt>
            <dd>系统不自动生成周期计划，由有权限的人员按需发起。</dd>
          </div>
          <div>
            <dt>按日历周期</dt>
            <dd>按每 N 天、每 N 周或每 N 月执行。首次未执行前以“首次到期时间”为基准，完成后按最近一次实际执行时间继续计算下一周期。</dd>
          </div>
          <div>
            <dt>按运行小时</dt>
            <dd>设备累计运行小时达到阈值后到期；没有有效运行小时读数时不会虚构到期时间。</dd>
          </div>
          <div>
            <dt>日历与运行小时组合</dt>
            <dd>“任一条件到期”表示日期或运行小时任意一项先到即可执行；“全部条件到期”表示两项都满足后才可执行。未来的日历计划仍可能提前以“计划中”状态建立。</dd>
          </div>
        </dl>
      </section>

      <section class="routine-rule-help-section">
        <h3>6. 计划生成逻辑</h3>
        <ul>
          <li>只有状态为“启用”的规则，才会为同一团队、设备类型精确匹配且状态为“在用”的设备生成计划。</li>
          <li>后台计划生成服务启用后，服务启动时先扫描一次，之后默认每 5 分钟扫描一次；它不是为每条规则在某个秒点单独注册的定时任务，计划会在下一次扫描时生成。</li>
          <li>日历点检通常预生成当前周期和下一周期；保养只生成下一到期周期。运行小时计划在累计读数达到条件后生成。</li>
          <li>自动周期模式下，同一计划或同一周期完成后不能重复提交；下一周期到来后才会再次允许执行。手动发起模式仍允许按需多次执行。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>7. 提交要求与现场证据</h3>
        <ul>
          <li><strong>照片要求：</strong>可设置为不要求、异常时必填或始终必填，现场提交时按当前规则校验。</li>
          <li><strong>异常说明：</strong>设置为必填后，只要存在异常项目，就必须填写项目说明或统一异常说明。</li>
          <li><strong>可选定位：</strong>允许已上传的现场照片不带定位；“必须取得定位”会校验已上传照片的定位，并可限制最大误差。若规则不要求照片且本次没有上传照片，当前不会单独因无定位拦截提交。</li>
          <li><strong>待客户确认：</strong>当前会记录授权状态、定位信息和水印文本，但定位被拒绝或失败时暂不阻止提交。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>8. 编辑、停用与删除的影响</h3>
        <ul>
          <li>保存编辑会生成新的规则版本，并取消旧版本尚未完成的开放计划；已完成记录和历史审计继续保留。</li>
          <li>停用规则后不再生成新计划，并取消该规则当前尚未完成的开放计划；以后可以重新启用。</li>
          <li>永久删除前必须先停用规则；已有执行记录或已完成计划的规则不能删除，只能继续保留为停用状态。</li>
          <li>业务类型或设备类型需要改变时，应复制或新建正确规则，再停用旧规则。</li>
        </ul>
      </section>

      <section class="routine-rule-help-section">
        <h3>9. 配置示例</h3>
        <ol>
          <li>叉车每日点检：选择具体叉车分类，使用“按日历周期 / 每 1 天”，再启用白班和夜班窗口。</li>
          <li>车辆每 500 小时保养：选择车辆的具体分类，使用“按运行小时 / 500 小时”，并持续录入累计运行小时。</li>
          <li>同一设备既要每日检查又要每月检查：分别建立两条规则，不能把不同频率的项目放在同一条规则中。</li>
        </ol>
      </section>
    </div>
  </el-drawer>
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
const helpVisible = ref(false)
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
  helpVisible.value = false
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
  else helpVisible.value = false
})
</script>

<style lang="scss">
.routine-rule-dialog.el-dialog {
  border-radius: 8px;
}

.routine-rule-help-drawer .el-drawer__header {
  margin-bottom: 0;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--zl-border-soft);
}

.routine-rule-help-drawer .el-drawer__body {
  padding: 0 24px 28px;
}
</style>

<style scoped lang="scss">
.routine-rule-dialog__header { display: flex; align-items: center; gap: 12px; width: 100%; padding-right: 38px; }
.routine-rule-dialog__title { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 18px; font-weight: 600; line-height: 32px; }
.routine-rule-help-button { flex: 0 0 32px; width: 32px; height: 32px; margin-right: 4px; margin-left: auto; color: var(--el-color-primary); }
.routine-rule-help-button:hover,
.routine-rule-help-button:focus-visible { background: var(--el-color-primary-light-9); }
.routine-rule-help-content { color: var(--zl-text, #1f2937); font-size: 14px; line-height: 1.75; }
.routine-rule-help-intro { margin: 0 -24px; padding: 18px 24px; color: #334155; background: #f5f8fc; }
.routine-rule-help-section { padding: 20px 0; border-bottom: 1px solid var(--zl-border-soft); }
.routine-rule-help-section:last-child { border-bottom: 0; }
.routine-rule-help-section h3 { margin: 0 0 10px; color: #172033; font-size: 16px; line-height: 1.5; }
.routine-rule-help-section ul,
.routine-rule-help-section ol { display: grid; gap: 7px; margin: 0; padding-left: 22px; }
.routine-rule-help-section li { padding-left: 2px; }
.routine-rule-help-section strong,
.routine-rule-help-definitions dt { color: #172033; font-weight: 600; }
.routine-rule-help-section code { padding: 1px 5px; border-radius: 4px; color: #0f4c81; background: #edf5ff; font-family: inherit; }
.routine-rule-help-callout { margin-top: 14px; padding: 11px 12px; border-left: 3px solid #e6a23c; color: #7c4a03; background: #fff8e8; }
.routine-rule-help-definitions { display: grid; gap: 12px; margin: 0; }
.routine-rule-help-definitions > div { display: grid; grid-template-columns: 118px minmax(0, 1fr); gap: 14px; }
.routine-rule-help-definitions dt,
.routine-rule-help-definitions dd { margin: 0; }
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
.schedule-scope-alert { margin-bottom: 16px; }
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
  .routine-rule-dialog__header { align-items: flex-start; gap: 8px; padding-right: 34px; }
  .routine-rule-dialog__title { font-size: 16px; line-height: 24px; }
  .routine-rule-help-button { margin-top: -4px; }
  .routine-rule-help-definitions > div { grid-template-columns: 1fr; gap: 2px; }
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
