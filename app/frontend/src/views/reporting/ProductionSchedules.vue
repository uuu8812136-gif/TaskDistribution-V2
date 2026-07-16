<template>
  <div class="schedule-page">
    <header class="page-heading">
      <div>
        <h1>生产排产</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
    </header>

    <section v-if="session.isGlobalReadOnly" class="team-band">
      <el-select v-model="selectedTeamId" placeholder="选择项目团队" @change="handleTeamChange">
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
    </section>

    <el-tabs v-model="activeTab" class="schedule-tabs" @tab-change="handleTabChange">
      <el-tab-pane label="日排产" name="daily">
        <section class="toolbar">
          <el-segmented
            v-model="dailySlot"
            :options="dailySlotOptions"
            :disabled="dailyEditing"
            @change="loadDaily"
          />
          <el-select
            v-model="selectedOrgUnitId"
            filterable
            :disabled="dailyEditing"
            placeholder="选择所属组织"
            class="org-select"
            @change="loadDaily"
          >
            <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
          </el-select>
          <el-tag v-if="dailyMonth" effect="plain" size="large">{{ dailyMonth }}</el-tag>
          <span class="toolbar-spacer" />
          <el-button v-if="canExport" :disabled="!selectedOrgUnitId" :loading="dailyExporting" @click="exportDaily">
            <el-icon><Download /></el-icon>
            导出
          </el-button>
          <el-button
            :disabled="dailyEditing"
            :loading="dailyLoading"
            circle
            aria-label="刷新日排产"
            @click="loadDaily"
          >
            <el-icon><Refresh /></el-icon>
          </el-button>
          <el-button v-if="canManage && !dailyEditing" type="primary" :disabled="!selectedOrgUnitId" @click="dailyEditing = true">
            <el-icon><Edit /></el-icon>
            维护排产
          </el-button>
        </section>

        <el-empty v-if="!selectedOrgUnitId && !dailyLoading" description="暂无可用组织" />
        <template v-else>
          <section class="daily-summary">
            <div>
              <span>所属组织</span>
              <strong>{{ entityName(orgUnits, selectedOrgUnitId) }}</strong>
            </div>
            <div>
              <span>排产月份</span>
              <strong>{{ dailyMonth || '-' }}</strong>
            </div>
            <div>
              <span>月度排产合计</span>
              <strong>{{ dailyGrandTotal }}</strong>
            </div>
            <div>
              <span>生产计划（预测）</span>
              <el-input-number
                v-if="dailyEditing"
                v-model="dailySchedule.productionPlanForecast"
                :min="0"
                :precision="0"
                controls-position="right"
              />
              <strong v-else>{{ displayQuantity(dailySchedule.productionPlanForecast) }}</strong>
            </div>
          </section>

          <section class="table-shell daily-table">
            <el-table v-loading="dailyLoading" :data="dailySchedule.dailyEntries" row-key="date" stripe empty-text="暂无日排产">
              <el-table-column label="日期" width="118" fixed="left">
                <template #default="{ row }">{{ dayLabel(row.date) }}</template>
              </el-table-column>
              <el-table-column
                v-for="item in DAILY_SCHEDULE_FIELDS"
                :key="item.key"
                :label="item.label"
                :min-width="item.key === 'transferCaseLine' ? 150 : 125"
                align="right"
              >
                <template #default="{ row }">
                  <el-input-number
                    v-if="dailyEditing"
                    v-model="row[item.key]"
                    :min="0"
                    :max="2147483647"
                    :precision="0"
                    :controls="false"
                    class="table-number"
                  />
                  <span v-else>{{ displayQuantity(row[item.key]) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="合计" width="100" align="right" fixed="right">
                <template #default="{ row }">
                  <strong>{{ rowQuantityTotal(row, DAILY_SCHEDULE_FIELDS) }}</strong>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <section v-if="dailyEditing" class="edit-actions">
            <el-input
              v-model="dailyReason"
              maxlength="2000"
              placeholder="维护说明"
              class="reason-input"
            />
            <el-button @click="cancelDailyEdit">取消</el-button>
            <el-button type="primary" :loading="dailySaving" @click="saveDaily">保存日排产</el-button>
          </section>
        </template>
      </el-tab-pane>

      <el-tab-pane label="月排产" name="monthly">
        <section class="toolbar monthly-toolbar">
          <el-select v-model="monthlyFilters.orgUnitId" clearable filterable placeholder="所属组织">
            <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
          </el-select>
          <el-date-picker v-model="monthlyFilters.fromMonth" type="month" value-format="YYYY-MM" placeholder="开始月份" />
          <el-date-picker v-model="monthlyFilters.toMonth" type="month" value-format="YYYY-MM" placeholder="结束月份" />
          <el-button type="primary" @click="applyMonthlyFilters">查询</el-button>
          <el-button @click="resetMonthlyFilters">重置</el-button>
          <span class="toolbar-spacer" />
          <el-button v-if="canExport" :loading="monthlyExporting" @click="exportMonthly">
            <el-icon><Download /></el-icon>
            导出
          </el-button>
          <el-button v-if="canManage" type="primary" @click="openMonthlyCreate">
            <el-icon><Plus /></el-icon>
            维护月排产
          </el-button>
          <el-button :loading="monthlyLoading" circle aria-label="刷新月排产" @click="loadMonthly">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </section>

        <section class="table-shell">
          <el-table v-loading="monthlyLoading" :data="monthlySchedules" row-key="_id" stripe empty-text="暂无月排产">
            <el-table-column prop="month" label="月份" width="110" fixed="left" />
            <el-table-column label="所属组织" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ entityName(orgUnits, row.orgUnitId, `组织 ${row.orgUnitId.slice(-6)}`) }}</template>
            </el-table-column>
            <el-table-column
              v-for="item in MONTHLY_SCHEDULE_FIELDS"
              :key="item.key"
              :label="item.label"
              :min-width="item.key === 'transferCaseLine' ? 150 : 120"
              align="right"
            >
              <template #default="{ row }">{{ displayQuantity(row.monthlyTotals[item.key]) }}</template>
            </el-table-column>
            <el-table-column label="合计" width="100" align="right">
              <template #default="{ row }"><strong>{{ row.monthlyTotals.total }}</strong></template>
            </el-table-column>
            <el-table-column v-if="canManage" label="操作" width="86" fixed="right">
              <template #default="{ row }">
                <el-button text type="primary" @click="openMonthlyEdit(row)">编辑</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <footer class="pagination-row">
          <span>共 {{ monthlyTotal }} 条</span>
          <el-pagination
            v-model:current-page="monthlyFilters.page"
            v-model:page-size="monthlyFilters.pageSize"
            :total="monthlyTotal"
            :page-sizes="[20, 50, 100]"
            layout="sizes, prev, pager, next"
            @change="loadMonthly"
          />
        </footer>
      </el-tab-pane>
    </el-tabs>

    <el-dialog
      v-model="monthlyFormVisible"
      :title="monthlyEditing ? '编辑月排产' : '维护月排产'"
      width="min(720px, 95vw)"
      destroy-on-close
      append-to-body
      @closed="resetMonthlyForm"
    >
      <el-form ref="monthlyFormRef" :model="monthlyForm" :rules="monthlyRules" label-position="top">
        <div class="monthly-form-grid">
          <el-form-item label="月份" prop="month">
            <el-date-picker
              v-model="monthlyForm.month"
              type="month"
              value-format="YYYY-MM"
              :disabled="monthlyEditing"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="所属组织" prop="orgUnitId">
            <el-select v-model="monthlyForm.orgUnitId" filterable :disabled="monthlyEditing" class="full-width">
              <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item v-for="item in MONTHLY_SCHEDULE_FIELDS" :key="item.key" :label="item.label">
            <el-input-number
              v-model="monthlyForm.monthlyTotals[item.key]"
              :min="0"
              :max="2147483647"
              :precision="0"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
        </div>
        <el-form-item label="维护说明">
          <el-input v-model="monthlyForm.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
        <div class="monthly-form-total">合计：{{ rowQuantityTotal(monthlyForm.monthlyTotals, MONTHLY_SCHEDULE_FIELDS) }}</div>
      </el-form>
      <template #footer>
        <el-button @click="monthlyFormVisible = false">取消</el-button>
        <el-button type="primary" :loading="monthlySaving" @click="saveMonthly">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  exportDailyProductionSchedule,
  exportMonthlyProductionSchedules,
  getDailyProductionSchedule,
  getMonthlyProductionSchedules,
  getProductionOptions,
  maintainDailyProductionSchedule,
  maintainMonthlyProductionSchedule
} from '@/api/reporting'
import { useSessionStore } from '@/stores/session'
import {
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  buildDailySchedulePayload,
  buildMonthlySchedulePayload,
  createDailyTemplate,
  entityName,
  rowQuantityTotal,
  saveBlob
} from '@/utils/reporting'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const activeTab = ref('daily')
const selectedTeamId = ref(String(route.query.teamId || ''))
const orgUnits = ref([])
const selectedOrgUnitId = ref('')
const dailySlot = ref('current')
const dailyMonth = ref('')
const dailySchedule = reactive(emptyDailySchedule())
const dailyOriginal = ref(null)
const dailyLoading = ref(false)
const dailyEditing = ref(false)
const dailySaving = ref(false)
const dailyExporting = ref(false)
const dailyReason = ref('')
const monthlySchedules = ref([])
const monthlyTotal = ref(0)
const monthlyLoading = ref(false)
const monthlyExporting = ref(false)
const monthlyFormVisible = ref(false)
const monthlyEditing = ref(false)
const monthlySaving = ref(false)
const monthlyFormRef = ref(null)
const monthlyForm = reactive(emptyMonthlyForm())

const dailySlotOptions = [
  { label: '上月', value: 'previous' },
  { label: '当月', value: 'current' }
]
const monthlyFilters = reactive({
  orgUnitId: '',
  fromMonth: '',
  toMonth: '',
  page: 1,
  pageSize: 20
})
const monthlyRules = {
  month: [{ required: true, message: '请选择月份', trigger: 'change' }],
  orgUnitId: [{ required: true, message: '请选择所属组织', trigger: 'change' }]
}

const canManage = computed(() => session.can('report.schedule.manage', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('report.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const dailyGrandTotal = computed(() => (dailySchedule.dailyEntries || []).reduce(
  (sum, row) => sum + rowQuantityTotal(row, DAILY_SCHEDULE_FIELDS),
  0
))

function emptyDailySchedule() {
  return { orgUnitId: '', month: '', dailyEntries: [], productionPlanForecast: null }
}

function emptyMonthlyTotals() {
  return Object.fromEntries(MONTHLY_SCHEDULE_FIELDS.map(({ key }) => [key, null]))
}

function emptyMonthlyForm() {
  return {
    month: dayjs().format('YYYY-MM'),
    orgUnitId: '',
    monthlyTotals: emptyMonthlyTotals(),
    reason: ''
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function applyDailySchedule(value) {
  Object.assign(dailySchedule, emptyDailySchedule(), clone(value))
  dailyOriginal.value = clone(dailySchedule)
}

const displayQuantity = (value) => value === null || value === undefined ? '-' : value
const dayLabel = (date) => {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][dayjs(date).day()]
  return `${dayjs(date).format('MM-DD')} 周${weekday}`
}

async function loadOptions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getProductionOptions(requestTeamParams.value)
  orgUnits.value = result.orgUnits || []
  if (!orgUnits.value.some((item) => item._id === selectedOrgUnitId.value)) {
    selectedOrgUnitId.value = orgUnits.value[0]?._id || ''
  }
}

async function loadDaily() {
  if (!selectedOrgUnitId.value) {
    applyDailySchedule(emptyDailySchedule())
    return
  }
  dailyLoading.value = true
  dailyEditing.value = false
  dailyReason.value = ''
  try {
    const result = await getDailyProductionSchedule(dailySlot.value, {
      ...requestTeamParams.value,
      orgUnitId: selectedOrgUnitId.value
    })
    dailyMonth.value = result.month
    const found = (result.schedules || [])[0]
    applyDailySchedule(found || {
      orgUnitId: selectedOrgUnitId.value,
      month: result.month,
      dailyEntries: createDailyTemplate(result.month),
      productionPlanForecast: null
    })
  } finally {
    dailyLoading.value = false
  }
}

async function saveDaily() {
  dailySaving.value = true
  try {
    const result = await maintainDailyProductionSchedule(
      dailySlot.value,
      buildDailySchedulePayload(dailySchedule, dailyReason.value)
    )
    applyDailySchedule(result.schedule)
    dailyEditing.value = false
    dailyReason.value = ''
    ElMessage.success('日排产已保存')
  } finally {
    dailySaving.value = false
  }
}

function cancelDailyEdit() {
  if (dailyOriginal.value) applyDailySchedule(dailyOriginal.value)
  dailyEditing.value = false
  dailyReason.value = ''
}

async function exportDaily() {
  dailyExporting.value = true
  try {
    const blob = await exportDailyProductionSchedule(dailySlot.value, {
      ...requestTeamParams.value,
      orgUnitId: selectedOrgUnitId.value
    })
    saveBlob(blob, `日排产-${dailySlot.value === 'previous' ? '上月' : '当月'}-${dailyMonth.value}.xlsx`)
  } finally {
    dailyExporting.value = false
  }
}

function monthlyParams(extra = {}) {
  return {
    ...requestTeamParams.value,
    orgUnitId: monthlyFilters.orgUnitId || undefined,
    fromMonth: monthlyFilters.fromMonth || undefined,
    toMonth: monthlyFilters.toMonth || undefined,
    ...extra
  }
}

async function loadMonthly() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  monthlyLoading.value = true
  try {
    const result = await getMonthlyProductionSchedules(monthlyParams({
      page: monthlyFilters.page,
      pageSize: monthlyFilters.pageSize
    }))
    monthlySchedules.value = result.productionSchedules || []
    monthlyTotal.value = result.total || 0
  } finally {
    monthlyLoading.value = false
  }
}

function applyMonthlyFilters() {
  monthlyFilters.page = 1
  loadMonthly()
}

function resetMonthlyFilters() {
  Object.assign(monthlyFilters, { orgUnitId: '', fromMonth: '', toMonth: '', page: 1 })
  loadMonthly()
}

function resetMonthlyForm() {
  monthlyEditing.value = false
  Object.assign(monthlyForm, emptyMonthlyForm())
  monthlyFormRef.value?.clearValidate()
}

function openMonthlyCreate() {
  resetMonthlyForm()
  monthlyForm.orgUnitId = selectedOrgUnitId.value || orgUnits.value[0]?._id || ''
  monthlyFormVisible.value = true
}

function openMonthlyEdit(schedule) {
  monthlyEditing.value = true
  Object.assign(monthlyForm, {
    month: schedule.month,
    orgUnitId: schedule.orgUnitId,
    monthlyTotals: {
      ...emptyMonthlyTotals(),
      ...schedule.monthlyTotals
    },
    reason: ''
  })
  monthlyFormVisible.value = true
}

async function saveMonthly() {
  const valid = await monthlyFormRef.value?.validate().catch(() => false)
  if (!valid) return
  monthlySaving.value = true
  try {
    await maintainMonthlyProductionSchedule(
      monthlyForm.month,
      buildMonthlySchedulePayload(monthlyForm)
    )
    ElMessage.success('月排产已保存')
    monthlyFormVisible.value = false
    await loadMonthly()
  } finally {
    monthlySaving.value = false
  }
}

async function exportMonthly() {
  monthlyExporting.value = true
  try {
    const blob = await exportMonthlyProductionSchedules(monthlyParams())
    saveBlob(blob, `月排产-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
  } finally {
    monthlyExporting.value = false
  }
}

async function handleTeamChange(teamId) {
  await router.replace({ query: { teamId } })
  Object.assign(monthlyFilters, { orgUnitId: '', fromMonth: '', toMonth: '', page: 1 })
  selectedOrgUnitId.value = ''
  await loadOptions()
  await Promise.all([loadDaily(), loadMonthly()])
}

function handleTabChange(name) {
  if (name === 'monthly' && monthlySchedules.value.length === 0) loadMonthly()
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await loadOptions()
  await Promise.all([loadDaily(), loadMonthly()])
}

onBeforeRouteLeave(async () => {
  if (!dailyEditing.value) return true

  try {
    await ElMessageBox.confirm(
      '日排产存在未保存修改，确定离开并放弃修改吗？',
      '未保存修改',
      {
        confirmButtonText: '放弃并离开',
        cancelButtonText: '继续编辑',
        type: 'warning'
      }
    )
    return true
  } catch {
    return false
  }
})

onMounted(initialize)
</script>

<style scoped lang="scss">
.schedule-page { min-width: 0; }
.page-heading, .toolbar, .pagination-row, .edit-actions { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #909399; }
.team-band { padding: 12px 0; border-block: 1px solid #e4e7ed; }
.team-band .el-select { width: min(260px, 100%); }
.schedule-tabs { margin-top: 12px; }
.toolbar { flex-wrap: wrap; gap: 8px; padding: 10px 0 14px; }
.toolbar .org-select { width: 210px; }
.monthly-toolbar .el-select, .monthly-toolbar .el-date-editor { width: 165px; }
.toolbar-spacer { flex: 1; }
.daily-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--zl-surface); border-block: 1px solid var(--zl-border-soft); }
.daily-summary > div { min-width: 0; padding: 14px 16px; border-right: 1px solid #ebeef5; }
.daily-summary > div:last-child { border-right: 0; }
.daily-summary span { display: block; margin-bottom: 7px; color: #909399; font-size: 12px; }
.daily-summary strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.daily-table { margin-top: 16px; }
.table-number { width: 100%; min-width: 90px; }
.edit-actions { justify-content: flex-end; gap: 8px; padding-top: 14px; }
.reason-input { width: min(420px, 100%); margin-right: auto; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.monthly-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.full-width { width: 100%; }
.monthly-form-total { padding: 12px 0; text-align: right; color: #303133; font-size: 16px; font-weight: 600; }
@media (max-width: 760px) {
  .toolbar > *, .toolbar .org-select, .monthly-toolbar .el-select, .monthly-toolbar .el-date-editor { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .daily-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .daily-summary :deep(.el-input-number) { width: 100%; min-width: 0; }
  .daily-summary > div:nth-child(2) { border-right: 0; }
  .edit-actions { align-items: stretch; flex-direction: column; }
  .reason-input { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .monthly-form-grid { grid-template-columns: 1fr; }
}
</style>
