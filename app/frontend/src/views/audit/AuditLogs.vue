<template>
  <div class="audit-page">
    <header class="page-heading">
      <div>
        <h1>审计日志</h1>
        <p>查看登录、操作和业务数据变更记录 · {{ scopeLabel }}</p>
      </div>
      <el-tooltip content="刷新审计日志" placement="bottom">
        <el-button circle aria-label="刷新审计日志" :loading="loading" @click="loadAuditLogs">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </el-tooltip>
    </header>

    <section class="filter-band" aria-label="审计日志筛选">
      <el-date-picker
        v-model="filters.timeRange"
        type="datetimerange"
        range-separator="至"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        :shortcuts="dateShortcuts"
        class="time-range"
      />
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="filters.targetTeamId"
        clearable
        filterable
        placeholder="全部团队"
        class="team-filter"
      >
        <el-option label="系统级" value="SYSTEM" />
        <el-option
          v-for="team in session.teams"
          :key="team._id"
          :label="team.name"
          :value="team._id"
        />
      </el-select>
      <el-select v-model="filters.action" clearable filterable placeholder="操作类型">
        <el-option
          v-for="item in AUDIT_ACTION_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select v-model="filters.resourceType" clearable filterable placeholder="资源类型">
        <el-option
          v-for="item in AUDIT_RESOURCE_TYPE_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-input v-model="filters.actorUserId" clearable placeholder="操作人 ID" />
      <el-input v-model="filters.resourceId" clearable placeholder="资源 ID" />
      <el-input v-model="filters.requestId" clearable placeholder="请求 ID" @keyup.enter="applyFilters" />
      <div class="filter-actions">
        <el-button type="primary" @click="applyFilters">
          <el-icon><Search /></el-icon>
          查询
        </el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>
    </section>

    <section class="table-shell">
      <el-table
        v-loading="loading"
        :data="auditLogs"
        row-key="_id"
        stripe
        empty-text="暂无审计日志"
        @row-dblclick="openDetail"
      >
        <el-table-column label="时间" width="172" fixed="left">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="团队" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ 'system-scope': !row.targetTeamId }">
              {{ row.targetTeam?.name || '系统级' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作人" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.actor?.name || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作类型" width="134">
          <template #default="{ row }">
            <el-tag effect="plain" :type="actionTone(row.action)">
              {{ auditActionLabel(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="资源" min-width="160">
          <template #default="{ row }">{{ auditResourceLabel(row.resourceType) }}</template>
        </el-table-column>
        <el-table-column prop="resourceId" label="资源 ID" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.resourceId || '-' }}</template>
        </el-table-column>
        <el-table-column prop="requestId" label="请求 ID" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ row.requestId || '-' }}</template>
        </el-table-column>
        <el-table-column label="详情" width="86" fixed="right" align="center">
          <template #default="{ row }">
            <el-button text type="primary" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <footer class="pagination-row">
      <span>共 {{ total }} 条</span>
      <el-pagination
        :current-page="filters.page"
        :page-size="filters.pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :pager-count="5"
        layout="sizes, prev, pager, next"
        class="audit-pagination"
        @size-change="handlePageSizeChange"
        @current-change="handlePageChange"
      />
    </footer>

    <el-drawer
      v-model="detailVisible"
      title="审计详情"
      size="min(780px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="closeDetail"
    >
      <div v-loading="detailLoading" class="detail-body">
        <template v-if="selectedLog">
          <el-descriptions :column="detailColumns" border size="small" class="detail-grid">
            <el-descriptions-item label="时间">{{ formatDateTime(selectedLog.createdAt) }}</el-descriptions-item>
            <el-descriptions-item label="目标团队">{{ selectedLog.targetTeam?.name || '系统级' }}</el-descriptions-item>
            <el-descriptions-item label="操作人">{{ selectedLog.actor?.name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="身份">{{ actorRoleLabel(selectedLog.actorRole) }}</el-descriptions-item>
            <el-descriptions-item label="操作">{{ auditActionLabel(selectedLog.action) }}</el-descriptions-item>
            <el-descriptions-item label="资源">{{ auditResourceLabel(selectedLog.resourceType) }}</el-descriptions-item>
            <el-descriptions-item label="资源 ID">{{ selectedLog.resourceId || '-' }}</el-descriptions-item>
            <el-descriptions-item label="请求 ID">{{ selectedLog.requestId || '-' }}</el-descriptions-item>
            <el-descriptions-item label="请求" :span="detailColumns">
              {{ [selectedLog.requestMethod, selectedLog.requestPath].filter(Boolean).join(' ') || '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="原因" :span="detailColumns">{{ selectedLog.reason || '-' }}</el-descriptions-item>
          </el-descriptions>

          <section class="snapshot-section">
            <h2>变更快照</h2>
            <div class="snapshot-grid">
              <div class="snapshot-pane">
                <h3>变更前</h3>
                <pre>{{ formatAuditSnapshot(selectedLog.before) }}</pre>
              </div>
              <div class="snapshot-pane">
                <h3>变更后</h3>
                <pre>{{ formatAuditSnapshot(selectedLog.after) }}</pre>
              </div>
            </div>
          </section>
        </template>
      </div>
    </el-drawer>
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
  ref
} from 'vue'
import dayjs from 'dayjs'
import { getAuditLog, getAuditLogs } from '@/api/auditLog'
import { useSessionStore } from '@/stores/session'
import {
  AUDIT_ACTION_OPTIONS,
  AUDIT_RESOURCE_TYPE_OPTIONS,
  auditActionLabel,
  auditResourceLabel,
  buildAuditQuery,
  formatAuditSnapshot
} from '@/utils/auditLog'

const session = useSessionStore()
const auditLogs = ref([])
const total = ref(0)
const loading = ref(false)
const detailLoading = ref(false)
const detailVisible = ref(false)
const selectedLog = ref(null)
const compactDetail = ref(false)

let listRequestId = 0
let detailRequestId = 0
let detailMediaQuery = null
let detailMediaListenerAttached = false
let resumeListLoad = false

const filters = reactive({
  timeRange: [],
  targetTeamId: '',
  action: '',
  resourceType: '',
  actorUserId: '',
  resourceId: '',
  requestId: '',
  page: 1,
  pageSize: 20
})

const dateShortcuts = [
  { text: '今天', value: () => [dayjs().startOf('day').toDate(), dayjs().endOf('day').toDate()] },
  { text: '最近 7 天', value: () => [dayjs().subtract(6, 'day').startOf('day').toDate(), dayjs().endOf('day').toDate()] },
  { text: '最近 30 天', value: () => [dayjs().subtract(29, 'day').startOf('day').toDate(), dayjs().endOf('day').toDate()] }
]

const scopeLabel = computed(() => (
  session.isGlobalReadOnly
    ? '全部团队与系统级日志'
    : session.activeTeam?.name || '当前项目团队'
))
const detailColumns = computed(() => compactDetail.value ? 1 : 2)

function formatDateTime(value) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'
}

function actorRoleLabel(value) {
  return ({
    SUPER_ADMIN: '超级管理员',
    PROJECT_ADMIN: '项目管理员',
    MEMBER: '普通成员',
    SYSTEM: '系统'
  })[value] || value || '-'
}

function actionTone(action) {
  if (['DELETE', 'DISABLE', 'REJECT', 'LOGIN_FAILURE'].includes(action)) return 'danger'
  if (['CREATE', 'ENABLE', 'APPROVE', 'PUBLISH'].includes(action)) return 'success'
  if (['UPDATE', 'STATUS_CHANGE', 'CORRECT', 'PERMISSION_UPDATE', 'ROLE_UPDATE'].includes(action)) return 'warning'
  return 'info'
}

async function loadAuditLogs() {
  const requestId = ++listRequestId
  const query = buildAuditQuery(filters, { global: session.isGlobalReadOnly })
  auditLogs.value = []
  total.value = 0
  loading.value = true
  try {
    const result = await getAuditLogs(query)
    if (requestId !== listRequestId) return
    auditLogs.value = result.auditLogs || []
    total.value = result.total || 0
    filters.page = result.page || filters.page
    filters.pageSize = result.pageSize || filters.pageSize
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

function applyFilters() {
  filters.page = 1
  loadAuditLogs()
}

function resetFilters() {
  Object.assign(filters, {
    timeRange: [],
    targetTeamId: '',
    action: '',
    resourceType: '',
    actorUserId: '',
    resourceId: '',
    requestId: '',
    page: 1
  })
  loadAuditLogs()
}

function handlePageSizeChange(pageSize) {
  filters.pageSize = pageSize
  filters.page = 1
  loadAuditLogs()
}

function handlePageChange(page) {
  filters.page = page
  loadAuditLogs()
}

async function openDetail(row) {
  const requestId = ++detailRequestId
  detailVisible.value = true
  detailLoading.value = true
  selectedLog.value = null
  try {
    const result = await getAuditLog(row._id)
    if (requestId !== detailRequestId) return
    selectedLog.value = result.auditLog || null
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false
  }
}

function closeDetail() {
  detailRequestId += 1
  detailLoading.value = false
  selectedLog.value = null
}

function syncDetailLayout(event) {
  compactDetail.value = event.matches
}

function attachDetailMediaListener() {
  if (!detailMediaQuery) detailMediaQuery = window.matchMedia('(max-width: 680px)')
  syncDetailLayout(detailMediaQuery)
  if (detailMediaListenerAttached) return
  detailMediaQuery.addEventListener('change', syncDetailLayout)
  detailMediaListenerAttached = true
}

function deactivateAuditPage() {
  resumeListLoad = resumeListLoad || loading.value
  if (detailMediaListenerAttached) {
    detailMediaQuery?.removeEventListener('change', syncDetailLayout)
    detailMediaListenerAttached = false
  }
  listRequestId += 1
  detailRequestId += 1
  loading.value = false
  detailLoading.value = false
  detailVisible.value = false
  selectedLog.value = null
}

onMounted(() => {
  attachDetailMediaListener()
  loadAuditLogs()
})

onActivated(() => {
  attachDetailMediaListener()
  if (!resumeListLoad) return
  resumeListLoad = false
  void loadAuditLogs()
})
onDeactivated(deactivateAuditPage)
onBeforeUnmount(deactivateAuditPage)
</script>

<style scoped lang="scss">
.audit-page {
  min-width: 0;
}

.page-heading p {
  margin-top: 4px;
  color: var(--zl-muted);
  font-size: 13px;
}

.filter-band {
  display: grid;
  grid-template-columns: minmax(300px, 1.7fr) repeat(3, minmax(150px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
  padding: 14px;
  background: rgb(255 255 255 / 76%);
  border: 1px solid var(--zl-border-soft);
  border-radius: 6px;
}

.filter-band :deep(.el-select),
.filter-band :deep(.el-input),
.time-range {
  width: 100%;
}

.filter-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-shell {
  overflow: hidden;
  border: 1px solid var(--zl-border-soft);
  border-radius: 6px;
}

.system-scope {
  color: var(--el-color-warning-dark-2);
}

.pagination-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 2px 0;
  color: var(--zl-muted);
  font-size: 13px;
}

.detail-body {
  min-height: 240px;
}

.detail-grid {
  margin-bottom: 22px;
}

.snapshot-section h2 {
  margin-bottom: 12px;
  font-size: 16px;
  letter-spacing: 0;
}

.snapshot-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.snapshot-pane {
  min-width: 0;
  border: 1px solid var(--zl-border-soft);
  border-radius: 6px;
  overflow: hidden;
}

.snapshot-pane h3 {
  padding: 9px 12px;
  background: #f4f7fb;
  border-bottom: 1px solid var(--zl-border-soft);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

.snapshot-pane pre {
  min-height: 180px;
  max-height: 440px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  color: #334155;
  background: #fff;
  font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 1100px) {
  .filter-band {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .filter-band,
  .snapshot-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .pagination-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .audit-pagination {
    width: 100%;
    justify-content: flex-start;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .audit-pagination :deep(.el-pagination__sizes) {
    display: none;
  }
}
</style>
