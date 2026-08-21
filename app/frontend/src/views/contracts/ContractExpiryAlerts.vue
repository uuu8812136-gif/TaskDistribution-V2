<template>
  <div class="contract-page">
    <header class="page-heading">
      <div>
        <h1>供应商合同到期预警</h1>
        <p>按合同记录查看剩余有效天数，自动顺延合同不进入黄红预警。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canExport" :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出当前结果
        </el-button>
      </div>
    </header>

    <section class="toolbar alert-toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-input v-model="filters.supplierCode" clearable placeholder="供应商编码（精确）" @keyup.enter="applyFilters" />
      <el-input v-model="filters.supplierName" clearable placeholder="供应商名称" @keyup.enter="applyFilters">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-input-number
        v-model="filters.remainingDaysGt"
        :controls="false"
        placeholder="剩余天数大于"
      />
      <el-input-number
        v-model="filters.remainingDaysLt"
        :controls="false"
        placeholder="剩余天数小于"
      />
      <el-select v-model="filters.autoRenew" clearable placeholder="是否自动顺延">
        <el-option v-for="item in AUTO_RENEW_FILTER_OPTIONS" :key="String(item.value)" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <el-tooltip content="刷新" placement="top">
        <el-button circle :loading="loading" aria-label="刷新合同到期预警" @click="loadAlerts">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </el-tooltip>
    </section>

    <div class="legend" aria-label="预警颜色说明">
      <span><i class="legend-dot legend-dot--warning" />剩余 0 至 30 天</span>
      <span><i class="legend-dot legend-dot--expired" />已过期</span>
      <span><i class="legend-dot legend-dot--normal" />正常或自动顺延</span>
    </div>

    <el-alert
      v-if="session.isGlobalReadOnly && !selectedTeamId"
      title="请选择一个项目团队后查看合同预警"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
    >
      <template #default><el-button text type="primary" @click="loadAlerts">重新加载</el-button></template>
    </el-alert>

    <template v-else>
      <section class="table-shell desktop-alert-table">
        <el-table
          v-loading="loading"
          :data="alerts"
          row-key="recordId"
          stripe
          :empty-text="loadError ? '加载失败，请重新加载' : '暂无符合条件的合同预警'"
          :row-class-name="expiryAlertRowClass"
        >
          <el-table-column prop="supplierCode" label="供应商编码" min-width="125" />
          <el-table-column prop="supplierName" label="供应商名称" min-width="190" />
          <el-table-column label="合同类型" min-width="130">
            <template #default="{ row }">{{ categoryLabel(row.category) }}</template>
          </el-table-column>
          <el-table-column prop="contractNumber" label="合同编号" min-width="145">
            <template #default="{ row }">{{ row.contractNumber || '-' }}</template>
          </el-table-column>
          <el-table-column label="生效日期" min-width="110">
            <template #default="{ row }">{{ formatDate(row.effectiveDate) }}</template>
          </el-table-column>
          <el-table-column label="截止日期" min-width="110">
            <template #default="{ row }">{{ formatDate(row.expiryDate) }}</template>
          </el-table-column>
          <el-table-column label="剩余有效天数" min-width="120" align="center">
            <template #default="{ row }">
              <strong :class="daysClass(row)">{{ Number.isFinite(Number(row.remainingDays)) ? row.remainingDays : '-' }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="自动顺延" min-width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="row.autoRenew === null || row.autoRenew === undefined ? 'warning' : row.autoRenew ? 'success' : 'info'" effect="plain">{{ autoRenewLabel(row.autoRenew) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="90" align="right">
            <template #default="{ row }">
              <el-button text type="primary" :icon="View" @click="openContract(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-loading="loading" class="mobile-alert-list">
        <el-empty v-if="!loading && !loadError && !alerts.length" description="暂无符合条件的合同预警" />
        <article v-for="row in alerts" :key="row.recordId" class="mobile-info-item" :class="mobileAlertClass(row)">
          <div class="mobile-item-heading">
            <strong>{{ row.supplierName }}</strong>
            <el-tag :type="row.autoRenew === null || row.autoRenew === undefined ? 'warning' : row.autoRenew ? 'success' : alertTagType(row)" effect="plain" size="small">
              {{ row.autoRenew === null || row.autoRenew === undefined ? '未设置' : row.autoRenew ? '自动顺延' : alertLabel(row) }}
            </el-tag>
          </div>
          <dl class="mobile-info-grid">
            <div><dt>供应商编码</dt><dd>{{ row.supplierCode }}</dd></div>
            <div><dt>合同类型</dt><dd>{{ categoryLabel(row.category) }}</dd></div>
            <div><dt>合同编号</dt><dd>{{ row.contractNumber || '-' }}</dd></div>
            <div><dt>截止日期</dt><dd>{{ formatDate(row.expiryDate) }}</dd></div>
            <div><dt>剩余天数</dt><dd>{{ row.remainingDays }}</dd></div>
          </dl>
          <el-button text type="primary" :icon="View" @click="openContract(row)">查看合同</el-button>
        </article>
      </section>

      <footer class="pagination-row">
        <span>共 {{ total }} 条合同记录</span>
        <el-pagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          :pager-count="5"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="loadAlerts"
          @size-change="applyFilters"
        />
      </footer>
    </template>
  </div>
</template>

<script setup>
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { exportContractExpiryAlerts, getContractExpiryAlerts } from '@/api/contract'
import { useSessionStore } from '@/stores/session'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import {
  CONTRACT_CATEGORY_CONFIGS,
  AUTO_RENEW_FILTER_OPTIONS,
  autoRenewLabel,
  expiryAlertRowClass,
  saveContractBlob
} from '@/utils/contract'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const alerts = ref([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const exporting = ref(false)
const selectedTeamId = ref(String(route.query.teamId || ''))
let requestId = 0
let exportRequestId = 0
let activationReady = false
let pageActive = true
let resumeListLoad = false
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.CONTRACT_EXPIRY_ALERTS
})
const filters = reactive({
  supplierCode: '',
  supplierName: '',
  remainingDaysGt: null,
  remainingDaysLt: null,
  autoRenew: '',
  page: 1,
  pageSize: 20
})

const canExport = computed(() => session.hasPermission('contract.expiry.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))

function currentPageContext() {
  return {
    routeName: String(route.name || ''),
    routeTeamId: String(route.query.teamId || ''),
    contextEpoch: session.contextEpoch,
    teamId: String(session.isGlobalReadOnly ? selectedTeamId.value : session.activeTeamId || '')
  }
}

function isCurrentPageContext(context) {
  const current = currentPageContext()
  return pageActive &&
    current.routeName === 'ContractExpiryAlerts' &&
    current.routeName === context.routeName &&
    current.routeTeamId === context.routeTeamId &&
    current.contextEpoch === context.contextEpoch &&
    current.teamId === context.teamId
}

function queryParams() {
  return {
    ...requestTeamParams.value,
    supplierCode: filters.supplierCode.trim() || undefined,
    supplierName: filters.supplierName.trim() || undefined,
    remainingDaysGt: filters.remainingDaysGt ?? undefined,
    remainingDaysLt: filters.remainingDaysLt ?? undefined,
    autoRenew: filters.autoRenew === '' ? undefined : filters.autoRenew,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

function categoryLabel(value) {
  return CONTRACT_CATEGORY_CONFIGS.find((item) => item.value === value)?.shortLabel || value || '-'
}

function formatDate(value) {
  return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : '-'
}

function alertLabel(row) {
  if (row.autoRenew) return '正常'
  if (row.alertLevel === 'EXPIRED' || Number(row.remainingDays) < 0) return '已过期'
  if (row.alertLevel === 'WARNING' || Number(row.remainingDays) <= 30) return '即将到期'
  return '正常'
}

function alertTagType(row) {
  if (row.autoRenew) return 'success'
  if (row.alertLevel === 'EXPIRED' || Number(row.remainingDays) < 0) return 'danger'
  if (row.alertLevel === 'WARNING' || Number(row.remainingDays) <= 30) return 'warning'
  return 'success'
}

function daysClass(row) {
  if (row.autoRenew) return 'days-normal'
  return row.alertLevel === 'EXPIRED' || Number(row.remainingDays) < 0
    ? 'days-expired'
    : row.alertLevel === 'WARNING' || Number(row.remainingDays) <= 30 ? 'days-warning' : 'days-normal'
}

function mobileAlertClass(row) {
  if (row.autoRenew) return ''
  return row.alertLevel === 'EXPIRED' || Number(row.remainingDays) < 0
    ? 'mobile-info-item--expired'
    : row.alertLevel === 'WARNING' || Number(row.remainingDays) <= 30 ? 'mobile-info-item--warning' : ''
}

async function loadAlerts() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    alerts.value = []
    total.value = 0
    return true
  }
  const loadStartRevision = mutationRefresh.currentRevision()
  const currentId = ++requestId
  const context = currentPageContext()
  loading.value = true
  loadError.value = ''
  try {
    const result = await getContractExpiryAlerts(queryParams())
    if (currentId !== requestId || !isCurrentPageContext(context)) return false
    alerts.value = result.alerts || []
    total.value = Number(result.total) || 0
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } catch (error) {
    if (currentId === requestId && isCurrentPageContext(context)) {
      loadError.value = error?.message || '合同到期预警加载失败，请稍后重试'
    }
    return false
  } finally {
    if (currentId === requestId) loading.value = false
  }
}

function invalidateAlertResults() {
  requestId += 1
  exportRequestId += 1
  alerts.value = []
  total.value = 0
  loading.value = false
  exporting.value = false
  loadError.value = ''
}

function applyFilters() {
  if (
    filters.remainingDaysGt !== null &&
    filters.remainingDaysLt !== null &&
    filters.remainingDaysGt >= filters.remainingDaysLt
  ) {
    ElMessage.warning('“剩余天数大于”必须小于“剩余天数小于”')
    return
  }
  filters.page = 1
  loadAlerts()
}

function resetFilterState() {
  Object.assign(filters, {
    supplierCode: '',
    supplierName: '',
    remainingDaysGt: null,
    remainingDaysLt: null,
    autoRenew: '',
    page: 1
  })
}

function resetFilters() {
  resetFilterState()
  return loadAlerts()
}

async function handleTeamChange(teamId) {
  invalidateAlertResults()
  resetFilterState()
  await router.replace({ query: teamId ? { teamId } : {} })
  if (
    String(route.query.teamId || '') !== String(teamId || '') ||
    String(selectedTeamId.value || '') !== String(teamId || '')
  ) return
  await loadAlerts()
}

function openContract(row) {
  router.push({
    name: 'SupplierContractDetail',
    params: { supplierId: row.supplierId },
    query: requestTeamParams.value
  })
}

async function handleExport() {
  if (exporting.value) return
  const currentId = ++exportRequestId
  const context = currentPageContext()
  exporting.value = true
  try {
    const blob = await exportContractExpiryAlerts({ ...queryParams(), page: undefined, pageSize: undefined })
    if (currentId !== exportRequestId || !isCurrentPageContext(context)) return
    saveContractBlob(blob, `供应商合同到期预警-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
    ElMessage.success('合同到期预警已导出')
  } finally {
    if (currentId === exportRequestId) exporting.value = false
  }
}

async function syncRouteTeamContext({ force = false } = {}) {
  if (!pageActive || route.name !== 'ContractExpiryAlerts') return false
  const routedTeamId = session.isGlobalReadOnly ? String(route.query.teamId || '') : ''
  const teamChanged = session.isGlobalReadOnly && routedTeamId !== selectedTeamId.value
  if (!force && !teamChanged) return false
  if (teamChanged) selectedTeamId.value = routedTeamId
  invalidateAlertResults()
  resetFilterState()
  if (session.isGlobalReadOnly && !selectedTeamId.value) return true
  await loadAlerts()
  return true
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
    if (selectedTeamId.value) await router.replace({ query: { teamId: selectedTeamId.value } })
  }
  await loadAlerts()
}

onMounted(async () => {
  try {
    await initialize()
  } finally {
    activationReady = true
  }
})
onActivated(() => {
  pageActive = true
  if (!activationReady) return
  const interrupted = resumeListLoad
  resumeListLoad = false
  void syncRouteTeamContext().then((changed) => {
    if (changed) return
    if (interrupted) return loadAlerts()
    return mutationRefresh.refreshIfNeeded(loadAlerts)
  }).catch(() => {})
})
watch(() => [route.name, route.query.teamId], () => {
  if (pageActive && activationReady) void syncRouteTeamContext()
})
watch(() => session.contextEpoch, () => {
  if (pageActive && activationReady) void syncRouteTeamContext({ force: true })
  else invalidateAlertResults()
})

function deactivateContractExpiryAlerts() {
  resumeListLoad = resumeListLoad || loading.value
  pageActive = false
  requestId += 1
  exportRequestId += 1
  loading.value = false
  exporting.value = false
}

onDeactivated(deactivateContractExpiryAlerts)
onBeforeUnmount(deactivateContractExpiryAlerts)
</script>

<style scoped lang="scss">
.page-heading p { margin-top: 6px; color: var(--el-text-color-secondary); }
.alert-toolbar { margin-bottom: 12px; }
.alert-toolbar .team-select { width: 190px; }
.alert-toolbar .el-input, .alert-toolbar .el-input-number { width: 180px; }
.alert-toolbar .el-select { width: 155px; }
.legend { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-bottom: 14px; color: var(--el-text-color-secondary); font-size: 13px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; background: #dfe7f0; }
.legend-dot--warning { background: #f5c451; }
.legend-dot--expired { background: #ef7777; }
.legend-dot--normal { background: #7fca9a; }
.desktop-alert-table { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 6px; }
.desktop-alert-table :deep(.contract-alert-row--warning > td.el-table__cell) { background: #fff9df !important; }
.desktop-alert-table :deep(.contract-alert-row--expired > td.el-table__cell) { background: #fff0f0 !important; }
.days-warning { color: #a66b00; }
.days-expired { color: var(--el-color-danger); }
.days-normal { color: var(--el-color-success); }
.mobile-alert-list { display: none; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--el-text-color-secondary); }
@media (max-width: 1180px) {
  .desktop-alert-table { display: none; }
  .mobile-alert-list { display: block; min-height: 150px; border-block: 1px solid var(--zl-border-soft); }
  .mobile-info-item { padding: 14px 2px; border-bottom: 1px solid var(--zl-border-soft); }
  .mobile-info-item--warning { background: #fff9df; }
  .mobile-info-item--expired { background: #fff0f0; }
  .mobile-item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .mobile-info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin: 12px 0 4px; }
  .mobile-info-grid dt { color: var(--el-text-color-secondary); font-size: 12px; }
  .mobile-info-grid dd { margin-top: 3px; overflow-wrap: anywhere; }
}
@media (max-width: 760px) {
  .alert-toolbar > *, .alert-toolbar .team-select, .alert-toolbar .el-input, .alert-toolbar .el-input-number, .alert-toolbar .el-select { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
  .pagination-row :deep(.el-pagination__sizes), .pagination-row :deep(.el-pagination__jump), .pagination-row :deep(.el-pagination__total) { display: none; }
}
</style>
