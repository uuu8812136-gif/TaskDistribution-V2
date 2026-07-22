<template>
  <div class="routine-workbench-page">
    <header class="page-heading">
      <div>
        <h1>点检与保养工作台</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button
          v-if="activeTab === 'records' && canExport"
          :loading="exporting"
          @click="exportRows"
        >
          <el-icon><Download /></el-icon>
          导出 Excel
        </el-button>
        <el-button :loading="loading" circle title="刷新" aria-label="刷新" @click="loadActiveTab">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
    </header>

    <section class="toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="changeTeam"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-segmented v-model="filters.routineType" :options="routineTypeOptions" @change="applyFilters" />
      <el-date-picker
        v-model="filters.dateRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        @change="applyFilters"
      />
      <el-select v-model="filters.equipmentId" clearable filterable placeholder="设备" @change="applyFilters">
        <el-option
          v-for="item in equipmentOptions"
          :key="item._id"
          :label="`${item.assetCode || '-'} · ${item.name || '-'}`"
          :value="item._id"
        />
      </el-select>
      <el-select v-model="filters.orgUnitId" clearable filterable placeholder="组织" @change="applyFilters">
        <el-option v-for="item in orgUnitOptions" :key="item._id" :label="item.name" :value="item._id" />
      </el-select>
      <el-select
        v-if="activeTab === 'plans'"
        v-model="filters.planStatus"
        clearable
        placeholder="计划状态"
        @change="applyFilters"
      >
        <el-option v-for="item in planStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select
        v-else-if="activeTab === 'records'"
        v-model="filters.overallResult"
        clearable
        placeholder="执行结果"
        @change="applyFilters"
      >
        <el-option v-for="item in resultOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select
        v-else
        v-model="filters.exceptionStatus"
        clearable
        placeholder="异常状态"
        @change="applyFilters"
      >
        <el-option v-for="item in exceptionStatusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-button @click="resetFilters">重置</el-button>
    </section>

    <el-tabs v-model="activeTab" class="workbench-tabs" @tab-change="changeTab">
      <el-tab-pane label="执行计划与提醒" name="plans" />
      <el-tab-pane label="执行记录" name="records" />
      <el-tab-pane label="异常处理" name="exceptions" />
    </el-tabs>

    <section v-if="activeTab === 'plans'" class="table-shell">
      <el-table
        v-loading="loading"
        :data="plans"
        :row-class-name="planRowClass"
        row-key="_id"
        stripe
        empty-text="暂无执行计划"
      >
        <el-table-column label="设备" min-width="190" fixed="left">
          <template #default="{ row }">
            <div class="primary-cell"><strong>{{ row.equipment?.name || '-' }}</strong><span>{{ row.equipment?.assetCode || '-' }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="组织" min-width="130"><template #default="{ row }">{{ row.orgUnit?.name || '-' }}</template></el-table-column>
        <el-table-column label="类型" width="90"><template #default="{ row }">{{ routineLabel(row.routineType) }}</template></el-table-column>
        <el-table-column label="规则" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.ruleSnapshot?.name || '-' }}</template>
        </el-table-column>
        <el-table-column label="周期" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ routineScheduleLabel(row.ruleSnapshot?.schedule) }}</template>
        </el-table-column>
        <el-table-column label="窗口" min-width="120" prop="windowName" />
        <el-table-column label="开始时间" width="170"><template #default="{ row }">{{ displayTime(row.scheduledFor) }}</template></el-table-column>
        <el-table-column label="截止时间" width="170"><template #default="{ row }">{{ displayTime(row.dueAt) }}</template></el-table-column>
        <el-table-column label="计划状态" width="110" align="center">
          <template #default="{ row }"><el-tag :type="planStatus(row.status).type" effect="plain">{{ planStatus(row.status).label }}</el-tag></template>
        </el-table-column>
      </el-table>
    </section>

    <section v-else-if="activeTab === 'records'" class="table-shell">
      <el-table v-loading="loading" :data="records" row-key="_id" stripe empty-text="暂无执行记录">
        <el-table-column label="设备" min-width="190" fixed="left">
          <template #default="{ row }">
            <div class="primary-cell"><strong>{{ row.equipment?.name || '-' }}</strong><span>{{ row.equipment?.assetCode || '-' }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="组织" min-width="130"><template #default="{ row }">{{ row.orgUnit?.name || '-' }}</template></el-table-column>
        <el-table-column label="规则" min-width="180"><template #default="{ row }">{{ row.ruleSnapshot?.name || '-' }} v{{ row.ruleVersion }}</template></el-table-column>
        <el-table-column label="类型" width="90"><template #default="{ row }">{{ routineLabel(row.routineType) }}</template></el-table-column>
        <el-table-column label="运行小时" width="110" align="right">
          <template #default="{ row }">{{ row.performedRuntimeHours ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="结果" width="100" align="center">
          <template #default="{ row }"><el-tag :type="row.overallResult === 'ABNORMAL' ? 'danger' : 'success'" effect="plain">{{ resultLabel(row.overallResult) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="执行时间" width="170"><template #default="{ row }">{{ displayTime(row.performedAt) }}</template></el-table-column>
        <el-table-column label="异常说明" min-width="220" show-overflow-tooltip prop="abnormalSummary" />
        <el-table-column label="照片/水印" min-width="240">
          <template #default="{ row }">
            <span v-if="!row.photoEvidence?.length">无</span>
            <div v-else class="watermark-list">
              <span v-for="photo in row.photoEvidence" :key="photo.fileId">{{ photo.watermarkText }}</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-else class="table-shell">
      <el-table
        v-loading="loading"
        :data="exceptions"
        :row-class-name="exceptionRowClass"
        row-key="_id"
        stripe
        empty-text="暂无异常处理单"
      >
        <el-table-column label="设备" min-width="190" fixed="left">
          <template #default="{ row }">
            <div class="primary-cell"><strong>{{ row.equipment?.name || '-' }}</strong><span>{{ row.equipment?.assetCode || '-' }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="组织" min-width="130"><template #default="{ row }">{{ row.orgUnit?.name || '-' }}</template></el-table-column>
        <el-table-column label="异常说明" min-width="260" show-overflow-tooltip prop="summary" />
        <el-table-column label="当前阶段" min-width="150"><template #default="{ row }">{{ stageLabel(row.currentStage) }}</template></el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }"><el-tag :type="row.status === 'RESOLVED' ? 'success' : 'danger'" effect="plain">{{ row.status === 'RESOLVED' ? '已解决' : '处理中' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="更新时间" width="170"><template #default="{ row }">{{ displayTime(row.updatedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right" align="center">
          <template #default="{ row }"><el-button v-if="canHandle(row)" text type="primary" @click="openHandle(row)">处理</el-button></template>
        </el-table-column>
      </el-table>
    </section>

    <footer class="pagination-row">
      <span>共 {{ total }} 条</span>
      <el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        :page-sizes="[20, 50, 100]"
        :total="total"
        layout="sizes, prev, pager, next"
        @change="changePage"
      />
    </footer>

    <el-dialog v-model="handleVisible" title="处理设备异常" width="min(560px, 94vw)" append-to-body>
      <el-alert :title="selectedException?.summary || ''" type="warning" :closable="false" />
      <el-form label-position="top" class="handle-form">
        <el-form-item label="处理结论">
          <el-segmented v-model="handleForm.action" :options="handleActions" block />
        </el-form-item>
        <el-form-item label="处理意见">
          <el-input v-model="handleForm.opinion" type="textarea" :rows="4" maxlength="3000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="handleVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitHandle">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import {
  exportEquipmentRoutineRecords,
  getEquipmentList,
  getEquipmentOptions,
  getEquipmentRoutineException,
  getEquipmentRoutineExceptions,
  getEquipmentRoutinePlan,
  getEquipmentRoutinePlans,
  getEquipmentRoutineRecords,
  transitionEquipmentRoutineException
} from '@/api/equipment'
import { routineScheduleLabel, saveBlob } from '@/utils/equipment'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const ROUTINE_TABS = new Set(['plans', 'records', 'exceptions'])
const requestedTab = String(route.query.tab || '')
const loading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const activeTab = ref(ROUTINE_TABS.has(requestedTab) ? requestedTab : 'plans')
const selectedTeamId = ref(String(route.query.teamId || ''))
const focusedExceptionId = ref(String(route.query.exceptionId || ''))
const focusedPlanId = ref(String(route.query.planId || ''))
const plans = ref([])
const records = ref([])
const exceptions = ref([])
const equipmentOptions = ref([])
const orgUnitOptions = ref([])
const total = ref(0)
let referenceRequestId = 0
let activeTabRequestId = 0
const handleVisible = ref(false)
const selectedException = ref(null)
const filters = reactive({
  routineType: '',
  dateRange: [],
  equipmentId: String(route.query.equipmentId || ''),
  orgUnitId: '',
  planStatus: '',
  overallResult: '',
  exceptionStatus: '',
  page: 1,
  pageSize: 20
})
const handleForm = reactive({ action: 'RESOLVE', opinion: '' })
const routineTypeOptions = [
  { label: '全部', value: '' },
  { label: '点检', value: 'INSPECTION' },
  { label: '保养', value: 'MAINTENANCE' }
]
const planStatuses = {
  PLANNED: { label: '待开始', type: 'info' },
  IN_WINDOW: { label: '执行中', type: 'primary' },
  OVERDUE: { label: '已逾期', type: 'danger' },
  COMPLETED: { label: '已完成', type: 'success' },
  CANCELLED: { label: '已取消', type: 'info' }
}
const planStatusOptions = Object.entries(planStatuses).map(([value, item]) => ({ value, label: item.label }))
const resultOptions = [
  { value: 'NORMAL', label: '正常' },
  { value: 'COMPLETED', label: '完成' },
  { value: 'ABNORMAL', label: '异常' }
]
const exceptionStatusOptions = [
  { value: 'OPEN', label: '处理中' },
  { value: 'RESOLVED', label: '已解决' }
]
const stages = {
  TEAM_LEADER: '班组长处理',
  SUB_DEPARTMENT_MANAGER: '分部经理处理',
  ASSET_ADMIN: '设备管理员处理',
  RESOLVED: '已解决'
}
const requestTeam = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const canExport = computed(() => session.hasPermission('equipment.export'))
const handleActions = computed(() => (
  selectedException.value?.currentStage === 'ASSET_ADMIN'
    ? [{ label: '解决异常', value: 'RESOLVE' }]
    : [{ label: '本级解决', value: 'RESOLVE' }, { label: '无法解决，升级', value: 'ESCALATE' }]
))

const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const routineLabel = (value) => value === 'MAINTENANCE' ? '保养' : '点检'
const resultLabel = (value) => ({ NORMAL: '正常', COMPLETED: '完成', ABNORMAL: '异常' }[value] || value || '-')
const planStatus = (value) => planStatuses[value] || { label: value || '-', type: 'info' }
const stageLabel = (value) => stages[value] || value || '-'
const planRowClass = ({ row }) => (
  focusedPlanId.value && String(row?._id || '') === focusedPlanId.value
    ? 'focused-message-row'
    : ''
)
const exceptionRowClass = ({ row }) => (
  focusedExceptionId.value && String(row?._id || '') === focusedExceptionId.value
    ? 'focused-message-row'
    : ''
)

function queryParams() {
  const [from, to] = filters.dateRange || []
  const params = {
    ...requestTeam.value,
    routineType: filters.routineType || undefined,
    equipmentId: filters.equipmentId || undefined,
    orgUnitId: filters.orgUnitId || undefined,
    from: from ? `${from}T00:00:00+08:00` : undefined,
    to: to ? `${to}T23:59:59+08:00` : undefined,
    page: filters.page,
    pageSize: filters.pageSize
  }
  if (activeTab.value === 'plans') params.status = filters.planStatus || undefined
  if (activeTab.value === 'records') params.overallResult = filters.overallResult || undefined
  if (activeTab.value === 'exceptions') params.status = filters.exceptionStatus || undefined
  return params
}

async function loadReferenceData() {
  const requestId = ++referenceRequestId
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    equipmentOptions.value = []
    orgUnitOptions.value = []
    return
  }
  const teamParams = { ...requestTeam.value }
  const [equipmentResult, optionResult] = await Promise.all([
    getEquipmentList({ ...teamParams, page: 1, pageSize: 200 }),
    getEquipmentOptions(teamParams)
  ])
  if (requestId !== referenceRequestId) return
  equipmentOptions.value = equipmentResult.equipment || []
  orgUnitOptions.value = optionResult.orgUnits || []
}

async function loadActiveTab() {
  const requestId = ++activeTabRequestId
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    plans.value = []
    records.value = []
    exceptions.value = []
    total.value = 0
    loading.value = false
    return
  }
  const tab = activeTab.value
  const params = queryParams()
  const teamParams = { ...requestTeam.value }
  const requestedPlanId = focusedPlanId.value
  const requestedExceptionId = focusedExceptionId.value
  loading.value = true
  try {
    const result = tab === 'plans'
      ? await getEquipmentRoutinePlans(params)
      : tab === 'records'
        ? await getEquipmentRoutineRecords(params)
        : await getEquipmentRoutineExceptions(params)
    if (requestId !== activeTabRequestId) return
    const listedPlans = result.plans || []
    plans.value = listedPlans
    records.value = result.records || []
    const listedExceptions = result.exceptions || []
    exceptions.value = listedExceptions
    if (
      tab === 'plans' &&
      requestedPlanId &&
      !listedPlans.some((item) => String(item._id) === requestedPlanId)
    ) {
      try {
        const focusedResult = await getEquipmentRoutinePlan(
          requestedPlanId,
          teamParams
        )
        if (requestId !== activeTabRequestId) return
        if (focusedResult?.plan) {
          plans.value = [focusedResult.plan, ...listedPlans]
        }
      } catch {
        if (requestId === activeTabRequestId) {
          ElMessage.warning('消息对应的执行计划已不可用，已显示当前计划列表')
        }
      }
    }
    if (
      tab === 'exceptions' &&
      requestedExceptionId &&
      !listedExceptions.some((item) => String(item._id) === requestedExceptionId)
    ) {
      try {
        const focusedResult = await getEquipmentRoutineException(
          requestedExceptionId,
          teamParams
        )
        if (requestId !== activeTabRequestId) return
        if (focusedResult?.exception) {
          exceptions.value = [focusedResult.exception, ...listedExceptions]
        }
      } catch {
        if (requestId === activeTabRequestId) {
          ElMessage.warning('消息对应的异常记录已不可用，已显示当前异常列表')
        }
      }
    }
    if (requestId !== activeTabRequestId) return
    total.value = Number(result.total || 0)
  } finally {
    if (requestId === activeTabRequestId) loading.value = false
  }
}

async function clearMessageFocus() {
  if (!focusedPlanId.value && !focusedExceptionId.value) return
  focusedPlanId.value = ''
  focusedExceptionId.value = ''
  await router.replace({
    query: {
      ...route.query,
      planId: undefined,
      exceptionId: undefined
    }
  })
}

async function applyFilters() {
  filters.page = 1
  await clearMessageFocus()
  await loadActiveTab()
}

async function resetFilters() {
  Object.assign(filters, {
    routineType: '',
    dateRange: [],
    equipmentId: '',
    orgUnitId: '',
    planStatus: '',
    overallResult: '',
    exceptionStatus: '',
    page: 1
  })
  await clearMessageFocus()
  await loadActiveTab()
}

async function changePage() {
  await clearMessageFocus()
  await loadActiveTab()
}

async function changeTab() {
  filters.page = 1
  focusedExceptionId.value = activeTab.value === 'exceptions' ? focusedExceptionId.value : ''
  focusedPlanId.value = activeTab.value === 'plans' ? focusedPlanId.value : ''
  await router.replace({
    query: {
      ...route.query,
      tab: activeTab.value,
      exceptionId: focusedExceptionId.value || undefined,
      planId: focusedPlanId.value || undefined
    }
  })
  await loadActiveTab()
}

async function changeTeam() {
  filters.equipmentId = ''
  filters.orgUnitId = ''
  filters.page = 1
  await router.replace({
    query: {
      ...route.query,
      teamId: selectedTeamId.value || undefined,
      equipmentId: undefined,
      exceptionId: undefined,
      planId: undefined
    }
  })
  focusedExceptionId.value = ''
  focusedPlanId.value = ''
  await Promise.all([loadReferenceData(), loadActiveTab()])
}

function canHandle(row) {
  if (!session.isTeamMode || row.status !== 'OPEN') return false
  const membership = session.context.membership || {}
  if (row.currentStage === 'TEAM_LEADER') return membership.positionKey === 'TEAM_LEADER'
  if (row.currentStage === 'SUB_DEPARTMENT_MANAGER') {
    return membership.positionKey === 'SUB_DEPARTMENT_MANAGER'
  }
  return row.currentStage === 'ASSET_ADMIN' && membership.functionalRoleKeys?.includes('ASSET_ADMIN')
}

function openHandle(row) {
  selectedException.value = row
  handleForm.action = 'RESOLVE'
  handleForm.opinion = ''
  handleVisible.value = true
}

async function submitHandle() {
  if (!handleForm.opinion.trim()) return ElMessage.warning('请填写处理意见')
  submitting.value = true
  try {
    await transitionEquipmentRoutineException(selectedException.value._id, {
      action: handleForm.action,
      opinion: handleForm.opinion.trim(),
      expectedRevision: selectedException.value.revision
    })
    ElMessage.success(handleForm.action === 'RESOLVE' ? '异常已解决' : '异常已升级')
    handleVisible.value = false
    await loadActiveTab()
  } finally {
    submitting.value = false
  }
}

async function exportRows() {
  if (exporting.value) return
  exporting.value = true
  try {
    const params = queryParams()
    delete params.page
    delete params.pageSize
    const blob = await exportEquipmentRoutineRecords(params)
    saveBlob(blob, `点检保养记录-${dayjs().format('YYYYMMDD')}.xlsx`)
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  await Promise.all([loadReferenceData(), loadActiveTab()])
})
</script>

<style scoped lang="scss">
.routine-workbench-page { min-width: 0; }
.page-heading, .heading-actions, .toolbar, .pagination-row { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 18px; margin-bottom: 12px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: var(--zl-muted); }
.heading-actions { gap: 8px; }
.toolbar { flex-wrap: wrap; gap: 10px; padding: 12px 0; border-block: 1px solid var(--zl-border-soft); }
.team-select { width: 200px; }
.toolbar > .el-select:not(.team-select) { width: 190px; }
.workbench-tabs { margin-top: 10px; }
.table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 8px; }
.primary-cell, .watermark-list { display: grid; gap: 3px; }
.primary-cell span, .watermark-list { color: var(--zl-muted); font-size: 12px; }
.watermark-list span { overflow-wrap: anywhere; }
:deep(.focused-message-row > td.el-table__cell) { background: var(--el-color-primary-light-9) !important; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.handle-form { margin-top: 18px; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .heading-actions, .toolbar > *, .team-select { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
}
</style>
