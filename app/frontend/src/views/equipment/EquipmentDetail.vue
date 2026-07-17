<template>
  <div class="detail-page">
    <header class="page-heading">
      <div class="heading-main">
        <el-button circle aria-label="返回" @click="router.back()">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ equipment?.name || '设备详情' }}</h1>
          <p>{{ equipment?.assetCode || '' }}</p>
        </div>
      </div>
      <div class="heading-actions">
        <el-button v-if="canQr && equipment" @click="showQrCode">
          <el-icon><FullScreen /></el-icon>
          二维码
        </el-button>
        <el-button v-if="canEdit && equipment" type="primary" @click="editEquipment">
          <el-icon><Edit /></el-icon>
          编辑
        </el-button>
      </div>
    </header>

    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="equipment">
      <section class="summary-band">
        <div>
          <span>设备状态</span>
          <el-tag :type="statusOption.type" effect="plain">{{ statusOption.label }}</el-tag>
        </div>
        <div><span>所属组织</span><strong>{{ orgUnitName }}</strong></div>
        <div><span>设备分类</span><strong>{{ categoryName }}</strong></div>
        <div><span>保管人</span><strong>{{ custodianName }}</strong></div>
      </section>

      <section class="detail-section">
        <h2>台账信息</h2>
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="资产编号">{{ equipment.assetCode }}</el-descriptions-item>
          <el-descriptions-item label="设备名称">{{ equipment.name }}</el-descriptions-item>
          <el-descriptions-item label="规格型号">{{ equipment.specification || '-' }}</el-descriptions-item>
          <el-descriptions-item label="生产厂家">{{ equipment.manufacturer || '-' }}</el-descriptions-item>
          <el-descriptions-item label="数量">{{ equipment.quantity }} {{ equipment.unit }}</el-descriptions-item>
          <el-descriptions-item label="购置日期">{{ displayDate(equipment.acquisitionDate) }}</el-descriptions-item>
          <el-descriptions-item label="原值">{{ displayMoney(equipment.originalValue) }}</el-descriptions-item>
          <el-descriptions-item label="存放地点">{{ equipment.location || '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="descriptionColumns">{{ equipment.remark || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ displayTime(equipment.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ displayTime(equipment.updatedAt) }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section v-if="canViewRoutine" class="detail-section routine-section">
        <div class="section-heading routine-heading">
          <div>
            <h2>点检与保养</h2>
            <p>按设备类型匹配当前启用规则和到期状态</p>
          </div>
          <div class="section-actions">
            <el-button @click="openRoutineRecords">
              <el-icon><Document /></el-icon>
              查看记录
            </el-button>
            <el-button v-if="canRecordRuntime" type="primary" plain @click="runtimeDialogVisible = true">
              <el-icon><Timer /></el-icon>
              录入运行小时
            </el-button>
            <el-button :loading="routineLoading" circle aria-label="刷新点检与保养计划" @click="loadRoutineSchedule">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <section class="runtime-band">
          <span>当前累计运行小时</span>
          <strong>{{ currentRuntimeLabel }}</strong>
          <small v-if="currentRuntimeHours === null">运行小时规则将在录入首条读数后计算到期阈值</small>
        </section>

        <div class="table-shell routine-table">
          <el-table v-loading="routineLoading" :data="routineSchedules" row-key="rule._id" empty-text="当前设备类型暂无启用规则">
            <el-table-column label="类型" width="82" align="center">
              <template #default="{ row }">
                <el-tag :type="optionForValue(ROUTINE_TYPE_OPTIONS, row.rule?.routineType).type" effect="plain" size="small">
                  {{ optionForValue(ROUTINE_TYPE_OPTIONS, row.rule?.routineType).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="规则" min-width="190" show-overflow-tooltip>
              <template #default="{ row }">{{ row.rule?.name || '-' }}</template>
            </el-table-column>
            <el-table-column label="周期" min-width="210">
              <template #default="{ row }">{{ routineScheduleLabel(row.rule?.schedule) }}</template>
            </el-table-column>
            <el-table-column label="到期状态" width="120" align="center">
              <template #default="{ row }">
                <el-tag :type="dueStateOption(row).type" effect="plain" size="small">
                  {{ dueStateOption(row).label }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="下次到期" min-width="190">
              <template #default="{ row }">{{ nextDueLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="最近执行" width="168">
              <template #default="{ row }">{{ row.lastRecord ? displayTime(row.lastRecord.performedAt) : (row.latestRecordId ? '已有记录' : '-') }}</template>
            </el-table-column>
            <el-table-column label="操作" width="96" fixed="right" align="center">
              <template #default="{ row }">
                <el-button
                  v-if="canExecuteRoutine(row.rule?.routineType)"
                  text
                  type="primary"
                  @click="openRoutineExecution(row)"
                >
                  执行
                </el-button>
                <span v-else>-</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <section class="detail-section">
        <div class="section-heading">
          <h2>变更记录</h2>
          <el-button :loading="historyLoading" circle aria-label="刷新变更记录" @click="loadHistory">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
        <div class="table-shell">
          <el-table :data="changes" row-key="_id" empty-text="暂无变更记录">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ displayTime(row.occurredAt) }}</template>
            </el-table-column>
            <el-table-column label="类型" width="110">
              <template #default="{ row }">{{ changeTypeLabel(row.changeType) }}</template>
            </el-table-column>
            <el-table-column label="操作人" min-width="120">
              <template #default="{ row }">{{ operatorName(row.operatorId) }}</template>
            </el-table-column>
            <el-table-column prop="reason" label="说明" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason || '-' }}</template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination
          v-if="historyTotal > historyPageSize"
          v-model:current-page="historyPage"
          :page-size="historyPageSize"
          :total="historyTotal"
          layout="prev, pager, next"
          class="history-pagination"
          @current-change="loadHistory"
        />
      </section>
    </template>

    <RuntimeReadingDialog
      v-model="runtimeDialogVisible"
      :current-runtime-hours="currentRuntimeHours"
      :submitting="runtimeSubmitting"
      @submit="submitRuntimeReading"
    />

    <RoutineExecutionDialog
      v-model="executionDialogVisible"
      :schedule-entry="selectedScheduleEntry"
      :current-runtime-hours="currentRuntimeHours"
      :submitting="executionSubmitting"
      @submit="submitRoutineRecord"
    />

    <el-dialog
      v-model="recordsDialogVisible"
      title="点检与保养记录"
      class="routine-records-dialog"
      width="min(940px, 96vw)"
      append-to-body
    >
      <div class="records-toolbar">
        <el-segmented v-model="recordFilters.routineType" :options="recordTypeOptions" @change="applyRecordFilters" />
        <span class="toolbar-spacer" />
        <el-button :loading="recordsLoading" circle aria-label="刷新执行记录" @click="loadRoutineRecords">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
      <div class="table-shell records-table">
        <el-table v-loading="recordsLoading" :data="routineRecords" row-key="_id" stripe empty-text="暂无执行记录">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="record-result-list">
                <div v-for="(item, index) in row.itemResults || []" :key="item.itemKey || index">
                  <strong>{{ routineRecordItemName(row, item, index) }}</strong>
                  <el-tag :type="optionForValue(ROUTINE_ITEM_RESULT_OPTIONS, item.result).type" effect="plain" size="small">
                    {{ optionForValue(ROUTINE_ITEM_RESULT_OPTIONS, item.result).label }}
                  </el-tag>
                  <span>{{ item.note || '-' }}</span>
                </div>
                <p v-if="!(row.itemResults || []).length">该历史记录没有逐项明细</p>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="执行时间" width="170">
            <template #default="{ row }">{{ displayTime(row.performedAt || row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="类型" width="86">
            <template #default="{ row }">{{ routineRecordTypeLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="规则" min-width="190" show-overflow-tooltip>
            <template #default="{ row }">{{ routineRecordRuleName(row) }}</template>
          </el-table-column>
          <el-table-column label="异常项" width="90" align="right">
            <template #default="{ row }">{{ abnormalResultCount(row) }}</template>
          </el-table-column>
          <el-table-column label="运行小时" width="110" align="right">
            <template #default="{ row }">{{ row.performedRuntimeHours ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="执行人" min-width="120">
            <template #default="{ row }">{{ routineRecordOperator(row) }}</template>
          </el-table-column>
          <el-table-column prop="abnormalSummary" label="异常汇总" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.abnormalSummary || '-' }}</template>
          </el-table-column>
        </el-table>
      </div>
      <footer class="records-pagination">
        <span>共 {{ recordTotal }} 条</span>
        <el-pagination
          v-model:current-page="recordFilters.page"
          :page-size="recordFilters.pageSize"
          :total="recordTotal"
          layout="prev, pager, next"
          @current-change="loadRoutineRecords"
        />
      </footer>
    </el-dialog>

    <el-dialog v-model="qrVisible" title="设备二维码" width="min(430px, 92vw)" append-to-body>
      <div class="qr-sheet">
        <strong>{{ equipment?.name }}</strong>
        <span>{{ equipment?.assetCode }}</span>
        <img v-if="qrImage" :src="qrImage" alt="设备二维码" />
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!qrImage" @click="printQr">
          <el-icon><Printer /></el-icon>
          打印
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import QRCode from 'qrcode'
import { ElMessage } from 'element-plus'
import RoutineExecutionDialog from './components/RoutineExecutionDialog.vue'
import RuntimeReadingDialog from './components/RuntimeReadingDialog.vue'
import {
  createEquipmentRoutineRecord,
  createEquipmentRuntimeReading,
  generateEquipmentQrCode,
  getEquipmentCategories,
  getEquipmentDetail,
  getEquipmentHistory,
  getEquipmentOptions,
  getEquipmentRoutineRecords,
  getEquipmentRoutineSchedule
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  EQUIPMENT_STATUS_OPTIONS,
  ROUTINE_DUE_STATE_OPTIONS,
  ROUTINE_ITEM_RESULT_OPTIONS,
  ROUTINE_TYPE_OPTIONS,
  entityName,
  optionForValue,
  routineScheduleLabel
} from '@/utils/equipment'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const equipment = ref(null)
const categories = ref([])
const options = ref({ orgUnits: [], custodians: [] })
const changes = ref([])
const loading = ref(true)
const historyLoading = ref(false)
const historyPage = ref(1)
const historyPageSize = 20
const historyTotal = ref(0)
const qrVisible = ref(false)
const qrImage = ref('')
const routineLoading = ref(false)
const routineSchedules = ref([])
const currentRuntimeHours = ref(null)
const runtimeDialogVisible = ref(false)
const runtimeSubmitting = ref(false)
const executionDialogVisible = ref(false)
const executionSubmitting = ref(false)
const selectedScheduleEntry = ref(null)
const recordsDialogVisible = ref(false)
const recordsLoading = ref(false)
const routineRecords = ref([])
const recordTotal = ref(0)
const recordFilters = ref({ routineType: '', page: 1, pageSize: 20 })
const recordTypeOptions = [
  { label: '全部', value: '' },
  { label: '点检', value: 'INSPECTION' },
  { label: '保养', value: 'MAINTENANCE' }
]

const requestParams = computed(() => (
  session.isGlobalReadOnly && route.query.teamId ? { teamId: String(route.query.teamId) } : {}
))
const canEdit = computed(() => session.can('equipment.edit', { write: true, teamRequired: true }))
const canQr = computed(() => session.can('equipment.qrcode', { write: true, teamRequired: true }))
const canViewRoutine = computed(() => session.hasPermission('equipment.view'))
const canRecordRuntime = computed(() => (
  session.can('equipment.edit', { write: true, teamRequired: true })
))
const statusOption = computed(() => optionForValue(EQUIPMENT_STATUS_OPTIONS, equipment.value?.status))
const orgUnitName = computed(() => entityName(options.value.orgUnits, equipment.value?.orgUnitId))
const categoryName = computed(() => entityName(categories.value, equipment.value?.categoryId))
const custodianName = computed(() => (
  equipment.value?.custodianUserId
    ? entityName(options.value.custodians, equipment.value.custodianUserId)
    : '-'
))
const descriptionColumns = computed(() => window.innerWidth < 720 ? 1 : 2)
const currentRuntimeLabel = computed(() => (
  currentRuntimeHours.value === null || currentRuntimeHours.value === undefined
    ? '待录入'
    : `${currentRuntimeHours.value} 小时`
))

const displayDate = (value) => value ? dayjs(value).format('YYYY-MM-DD') : '-'
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const displayMoney = (value) => value === null || value === undefined
  ? '-'
  : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value)
const changeTypeLabel = (value) => ({ CREATE: '创建', UPDATE: '编辑', STATUS_CHANGE: '状态变更' }[value] || value)
const operatorName = (id) => entityName(options.value.custodians, id, id ? `用户 ${id.slice(-6)}` : '-')

function canExecuteRoutine(routineType) {
  const permission = routineType === 'MAINTENANCE' ? 'equipment.maintain' : 'equipment.inspect'
  return session.can(permission, { write: true, teamRequired: true })
}

function dueStateOption(entry) {
  const value = String(entry?.dueState || 'NOT_DUE').toUpperCase()
  const known = optionForValue(ROUTINE_DUE_STATE_OPTIONS, value)
  if (known.label !== value) return known
  return { value, label: entry?.dueStateLabel || value, type: 'info' }
}

function nextDueLabel(entry) {
  const parts = []
  if (entry?.nextDueAt) parts.push(dayjs(entry.nextDueAt).format('YYYY-MM-DD HH:mm'))
  if (entry?.runtimeStatus === 'WAITING_FOR_READING') parts.push('运行小时：待录入')
  if (entry?.nextDueRuntimeHours !== null && entry?.nextDueRuntimeHours !== undefined) {
    parts.push(`累计 ${entry.nextDueRuntimeHours} 小时`)
  }
  if (parts.length) return parts.join(' / ')
  if (entry?.rule?.schedule?.mode === 'MANUAL') return '手动发起'
  if (['RUNTIME_HOURS', 'COMBINED'].includes(entry?.rule?.schedule?.mode) && currentRuntimeHours.value === null) {
    return '待录入运行小时'
  }
  return '-'
}

function routineRecordRule(row) {
  return row.rule || row.ruleSnapshot || row.routineRule || {}
}

function routineRecordTypeLabel(row) {
  const type = row.routineType || routineRecordRule(row).routineType
  return optionForValue(ROUTINE_TYPE_OPTIONS, type).label
}

function routineRecordRuleName(row) {
  return routineRecordRule(row).name || row.ruleName || '-'
}

function abnormalResultCount(row) {
  return (row.itemResults || []).filter((item) => item.result === 'ABNORMAL').length
}

function routineRecordItemName(row, item, index) {
  const configured = routineRecordRule(row).checklistItems?.find((entry) => entry.key === item.itemKey)
  return configured?.name || `项目 ${index + 1}`
}

function routineRecordOperator(row) {
  const operator = row.executor || row.operator || row.performedBy || row.createdBy
  if (operator?.name) return operator.name
  const operatorId = operator?._id || row.executorId || row.operatorId || row.performedBy || operator
  return operatorId ? operatorName(String(operatorId)) : '-'
}

async function loadHistory() {
  historyLoading.value = true
  try {
    const result = await getEquipmentHistory(route.params.id, {
      ...requestParams.value,
      page: historyPage.value,
      pageSize: historyPageSize
    })
    changes.value = result.changes || []
    historyTotal.value = result.total || 0
  } finally {
    historyLoading.value = false
  }
}

async function loadRoutineSchedule() {
  if (!canViewRoutine.value || !equipment.value) return
  routineLoading.value = true
  try {
    const result = await getEquipmentRoutineSchedule(route.params.id, requestParams.value)
    routineSchedules.value = (result.schedules || []).map((entry) => ({
      ...entry,
      dueState: entry.dueState || entry.status,
      lastRecord: entry.lastRecord || entry.latestRecord || null
    }))
    const runtimeHours = result.equipment?.currentRuntimeHours ??
      result.currentRuntimeHours ??
      result.latestRuntimeReading?.hours ??
      null
    currentRuntimeHours.value = runtimeHours === null || runtimeHours === undefined
      ? null
      : Number(runtimeHours)
  } finally {
    routineLoading.value = false
  }
}

async function loadRoutineRecords() {
  if (!canViewRoutine.value) return
  recordsLoading.value = true
  try {
    const result = await getEquipmentRoutineRecords({
      ...requestParams.value,
      equipmentId: route.params.id,
      routineType: recordFilters.value.routineType || undefined,
      page: recordFilters.value.page,
      pageSize: recordFilters.value.pageSize
    })
    routineRecords.value = result.records || result.routineRecords || []
    recordTotal.value = result.total ?? routineRecords.value.length
  } finally {
    recordsLoading.value = false
  }
}

function applyRecordFilters() {
  recordFilters.value.page = 1
  loadRoutineRecords()
}

async function openRoutineRecords() {
  recordsDialogVisible.value = true
  await loadRoutineRecords()
}

function openRoutineExecution(entry) {
  selectedScheduleEntry.value = entry
  executionDialogVisible.value = true
}

async function submitRuntimeReading(payload) {
  runtimeSubmitting.value = true
  try {
    await createEquipmentRuntimeReading(route.params.id, payload)
    ElMessage.success('运行小时已记录')
    runtimeDialogVisible.value = false
    await loadRoutineSchedule()
  } finally {
    runtimeSubmitting.value = false
  }
}

async function submitRoutineRecord(payload) {
  executionSubmitting.value = true
  try {
    await createEquipmentRoutineRecord(route.params.id, payload)
    ElMessage.success('点检/保养记录已提交')
    executionDialogVisible.value = false
    await loadRoutineSchedule()
    if (recordsDialogVisible.value) await loadRoutineRecords()
  } finally {
    executionSubmitting.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !route.query.teamId) {
    await router.replace({ name: 'Equipment' })
    return
  }
  loading.value = true
  try {
    const [detailResult, categoryResult, optionResult] = await Promise.all([
      getEquipmentDetail(route.params.id, requestParams.value),
      getEquipmentCategories({ ...requestParams.value, pageSize: 200 }),
      getEquipmentOptions(requestParams.value)
    ])
    equipment.value = detailResult.equipment
    categories.value = categoryResult.categories || []
    options.value = optionResult
    await Promise.all([
      loadHistory(),
      canViewRoutine.value ? loadRoutineSchedule() : Promise.resolve()
    ])
  } finally {
    loading.value = false
  }
}

function editEquipment() {
  router.push({
    name: 'Equipment',
    query: { ...requestParams.value, edit: equipment.value._id }
  })
}

async function showQrCode() {
  const result = await generateEquipmentQrCode(equipment.value._id)
  qrImage.value = await QRCode.toDataURL(result.qrCode.payload, {
    width: 360,
    margin: 2,
    errorCorrectionLevel: 'M'
  })
  qrVisible.value = true
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]))
}

function printQr() {
  const printWindow = window.open('', '_blank', 'width=520,height=640')
  if (!printWindow) return
  printWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(equipment.value.assetCode)}</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:32px}h1{font-size:22px;margin:0 0 8px}p{font-size:16px;margin:0 0 18px}img{width:360px;height:360px}</style></head><body><h1>${escapeHtml(equipment.value.name)}</h1><p>${escapeHtml(equipment.value.assetCode)}</p><img src="${qrImage.value}" onload="window.print();window.close()"></body></html>`)
  printWindow.document.close()
}

onMounted(initialize)
</script>

<style lang="scss">
.routine-records-dialog.el-dialog { border-radius: 8px; }
</style>

<style scoped lang="scss">
.detail-page { min-width: 0; }
.page-heading, .heading-main, .heading-actions, .section-heading, .section-actions, .records-toolbar, .records-pagination { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.heading-main { min-width: 0; gap: 12px; }
.heading-main h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.heading-main p { margin: 0; color: #909399; }
.heading-actions { gap: 8px; }
.summary-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--zl-surface); border-block: 1px solid var(--zl-border-soft); }
.summary-band > div { min-width: 0; padding: 16px 18px; border-right: 1px solid #ebeef5; }
.summary-band > div:last-child { border-right: 0; }
.summary-band span { display: block; margin-bottom: 7px; color: #909399; font-size: 12px; }
.summary-band strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-section { margin-top: 24px; }
.detail-section h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
.section-heading { justify-content: space-between; }
.routine-heading { gap: 16px; }
.routine-heading h2 { margin-bottom: 3px; }
.routine-heading p { margin: 0; color: var(--zl-muted); font-size: 13px; }
.section-actions { flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.section-actions .el-button { margin: 0; }
.runtime-band { min-height: 58px; margin-top: 12px; padding: 10px 14px; display: grid; grid-template-columns: auto auto minmax(180px, 1fr); align-items: center; gap: 12px; background: rgb(238 244 255 / 68%); border-block: 1px solid var(--zl-border-soft); }
.runtime-band span { color: var(--zl-muted); font-size: 13px; }
.runtime-band strong { font-size: 18px; }
.runtime-band small { color: var(--zl-muted); text-align: right; }
.routine-table { margin-top: 12px; border-radius: 8px; }
.table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.history-pagination { justify-content: flex-end; margin-top: 14px; }
.records-toolbar { gap: 8px; margin-bottom: 14px; }
.records-toolbar .toolbar-spacer { flex: 1; }
.records-table { border-radius: 8px; }
.records-pagination { justify-content: space-between; gap: 16px; margin-top: 14px; color: #606266; }
.record-result-list { padding: 8px 18px 14px 58px; display: grid; gap: 8px; }
.record-result-list > div { min-height: 34px; display: grid; grid-template-columns: minmax(140px, 0.7fr) 68px minmax(180px, 1fr); align-items: center; gap: 10px; border-bottom: 1px solid var(--zl-border-soft); }
.record-result-list p { margin: 0; color: var(--zl-muted); }
.qr-sheet { display: flex; flex-direction: column; align-items: center; }
.qr-sheet strong { font-size: 18px; }
.qr-sheet span { margin-top: 4px; color: #606266; }
.qr-sheet img { width: min(360px, 100%); aspect-ratio: 1; margin-top: 14px; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-main { width: 100%; }
  .heading-actions { flex-direction: row; align-items: center; }
  .summary-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-band > div:nth-child(2) { border-right: 0; }
  .summary-band > div:nth-child(-n+2) { border-bottom: 1px solid #ebeef5; }
  .routine-heading { align-items: flex-start; flex-direction: column; }
  .section-actions { width: 100%; justify-content: flex-start; }
  .runtime-band { grid-template-columns: 1fr 1fr; }
  .runtime-band small { grid-column: 1 / -1; text-align: left; }
  .records-toolbar { align-items: stretch; }
  .records-toolbar :deep(.el-segmented) { min-width: 0; flex: 1; }
  .records-pagination { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .record-result-list { padding-left: 18px; }
}
</style>
