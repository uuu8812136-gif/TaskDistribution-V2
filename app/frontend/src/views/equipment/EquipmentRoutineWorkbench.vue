<template>
  <div class="routine-workbench-page">
    <header class="page-heading">
      <div>
        <h1>点检与保养工作台</h1>
        <p>查看待执行计划、执行记录和待处理异常 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button
          v-if="canRunRoutineWorker"
          type="primary"
          plain
          :loading="workerRunning"
          :disabled="loading"
          @click="runRoutineWorkerNow"
        >
          <el-icon><VideoPlay /></el-icon>
          立即补跑计划
        </el-button>
        <el-button
          v-if="activeTab === 'plans' && canMarkRestDay"
          type="warning"
          plain
          :loading="restDaySubmitting"
          :disabled="selectedRestDayPlanIds.length === 0"
          @click="markSelectedPlansRestDay"
        >
          所选计划设为休班
        </el-button>
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

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="load-error-alert"
    >
      <template #default>
        <el-button type="primary" plain :loading="loading" @click="loadActiveTab">重新加载</el-button>
      </template>
    </el-alert>

    <section v-if="activeTab === 'plans'" class="table-shell">
      <el-table
        ref="planTableRef"
        v-loading="loading"
        :data="plans"
        :row-class-name="planRowClass"
        row-key="_id"
        stripe
        empty-text="暂无执行计划"
        @selection-change="handlePlanSelectionChange"
      >
        <el-table-column
          v-if="canMarkRestDay"
          type="selection"
          width="48"
          fixed="left"
          :selectable="canSelectRestDayPlan"
        />
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
        <el-table-column label="计划状态" min-width="230">
          <template #default="{ row }">
            <div class="plan-status-cell">
              <el-tag :type="planStatus(row.status).type" effect="plain">{{ planStatus(row.status).label }}</el-tag>
              <span v-if="planCancellationReason(row)" :title="planCancellationReason(row)">
                {{ planCancellationReason(row) }}
              </span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-else-if="activeTab === 'records'" class="table-shell">
      <el-table
        v-loading="loading"
        :data="records"
        class="record-table-view"
        row-key="_id"
        stripe
        empty-text="暂无执行记录"
      >
        <el-table-column label="设备" min-width="160">
          <template #default="{ row }">
            <div class="record-cell-stack">
              <strong>{{ row.equipment?.name || '-' }}</strong>
              <span>{{ row.equipment?.assetCode || '-' }}</span>
              <span>车牌号：{{ recordPlateNumber(row) || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="组织" min-width="100">
          <template #default="{ row }">{{ row.orgUnit?.name || '-' }}</template>
        </el-table-column>
        <el-table-column label="规则" min-width="145">
          <template #default="{ row }">
            <div class="record-cell-stack">
              <strong>{{ recordRuleLabel(row) }}</strong>
              <span>{{ routineLabel(row.routineType) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="对应计划" min-width="220">
          <template #default="{ row }">
            <div class="record-cell-stack record-plan-cell">
              <strong>{{ recordPlanReference(row) }}</strong>
              <span v-if="recordPlanSecondary(row)" :title="recordPlanSecondary(row)">{{ recordPlanSecondary(row) }}</span>
              <span>计划开始：{{ displayTime(recordPlanWindow(row).scheduledFor) }}</span>
              <span>计划截止：{{ displayTime(recordPlanWindow(row).dueAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="执行情况" min-width="155">
          <template #default="{ row }">
            <div class="record-cell-stack">
              <strong>{{ displayTime(row.performedAt) }}</strong>
              <span>执行人：{{ recordPerformerName(row) }}</span>
              <span>运行小时：{{ row.performedRuntimeHours ?? '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="结果与证据" min-width="220">
          <template #default="{ row }">
            <div class="record-evidence-cell">
              <el-tag :type="resultTagType(row.overallResult)" effect="plain">{{ resultLabel(row.overallResult) }}</el-tag>
              <span :title="row.abnormalSummary || '无异常说明'">异常：{{ row.abnormalSummary || '无' }}</span>
              <span :title="recordPhotoEvidenceText(row)">照片：{{ recordPhotoSummary(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="88" align="center">
          <template #default="{ row }"><el-button text type="primary" @click="openRecordDetail(row)">查看详情</el-button></template>
        </el-table-column>
      </el-table>

      <div v-loading="loading" class="record-compact-view">
        <el-empty v-if="!records.length && !loading" description="暂无执行记录" :image-size="72" />
        <div v-for="row in records" :key="row._id" class="record-compact-row">
          <div class="record-compact-heading">
            <div class="record-cell-stack">
              <strong>{{ row.equipment?.name || '-' }}</strong>
              <span>{{ row.equipment?.assetCode || '-' }} · 车牌号：{{ recordPlateNumber(row) || '-' }} · {{ row.orgUnit?.name || '-' }}</span>
            </div>
            <el-tag :type="resultTagType(row.overallResult)" effect="plain">{{ resultLabel(row.overallResult) }}</el-tag>
            <el-button text type="primary" @click="openRecordDetail(row)">查看详情</el-button>
          </div>
          <div class="record-compact-grid">
            <div>
              <span>规则</span>
              <strong>{{ recordRuleLabel(row) }}</strong>
              <small>{{ routineLabel(row.routineType) }}</small>
            </div>
            <div>
              <span>对应计划</span>
              <strong>{{ recordPlanReference(row) }}</strong>
              <small v-if="recordPlanSecondary(row)">{{ recordPlanSecondary(row) }}</small>
              <small>计划开始：{{ displayTime(recordPlanWindow(row).scheduledFor) }}</small>
              <small>计划截止：{{ displayTime(recordPlanWindow(row).dueAt) }}</small>
            </div>
            <div>
              <span>执行情况</span>
              <strong>{{ displayTime(row.performedAt) }}</strong>
              <small>执行人：{{ recordPerformerName(row) }}</small>
              <small>运行小时：{{ row.performedRuntimeHours ?? '-' }}</small>
            </div>
            <div>
              <span>结果与证据</span>
              <strong>异常：{{ row.abnormalSummary || '无' }}</strong>
              <small :title="recordPhotoEvidenceText(row)">照片：{{ recordPhotoSummary(row) }}</small>
            </div>
          </div>
        </div>
      </div>
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

    <el-dialog
      v-model="recordDetailVisible"
      title="点检/保养执行详情"
      class="routine-record-detail-dialog"
      width="min(980px, 96vw)"
      append-to-body
      @close="closeRecordDetail"
    >
      <template v-if="selectedRecord">
        <el-descriptions :column="2" border class="record-detail-summary">
          <el-descriptions-item label="设备">
            {{ selectedRecord.equipment?.name || '-' }}（{{ selectedRecord.equipment?.assetCode || '-' }}）
          </el-descriptions-item>
          <el-descriptions-item label="车牌号">{{ recordPlateNumber(selectedRecord) || '-' }}</el-descriptions-item>
          <el-descriptions-item label="规则">{{ recordRuleLabel(selectedRecord) }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ routineLabel(selectedRecord.routineType) }}</el-descriptions-item>
          <el-descriptions-item label="关联计划">{{ recordPlanReference(selectedRecord, true) }}</el-descriptions-item>
          <el-descriptions-item label="计划窗口">{{ recordPlanWindowLabel(selectedRecord) }}</el-descriptions-item>
          <el-descriptions-item label="执行时间">{{ displayTime(selectedRecord.performedAt) }}</el-descriptions-item>
          <el-descriptions-item label="执行人">{{ recordPerformerName(selectedRecord) }}</el-descriptions-item>
          <el-descriptions-item label="总体结果">
            <el-tag :type="resultTagType(selectedRecord.overallResult)" effect="plain">
              {{ resultLabel(selectedRecord.overallResult) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="异常说明" :span="2">{{ selectedRecord.abnormalSummary || '无' }}</el-descriptions-item>
          <el-descriptions-item label="照片信息" :span="2">
            <span v-if="!selectedRecordPhotos.length">无现场照片</span>
            <div v-else class="record-photo-list">
              <div v-for="(photo, index) in selectedRecordPhotos" :key="photo.fileId">
                <div class="record-photo-copy">
                  <strong>照片 {{ index + 1 }}</strong>
                  <span>{{ displayWatermark(selectedRecord, photo) }}</span>
                </div>
                <el-button
                  text
                  type="primary"
                  :loading="recordPhotoLoadingId === photo.fileId"
                  :aria-label="`预览照片 ${index + 1}`"
                  @click="previewRecordPhoto(photo, index)"
                >
                  <el-icon><View /></el-icon>
                  预览
                </el-button>
              </div>
            </div>
          </el-descriptions-item>
        </el-descriptions>

        <section class="record-detail-section">
          <h3>逐项执行结果</h3>
          <div v-if="selectedRecordItems.length" class="record-result-list">
            <div v-for="(item, index) in selectedRecordItems" :key="item.itemKey || index" class="record-result-row">
              <div class="record-result-copy">
                <strong>{{ index + 1 }}. {{ item.name }}</strong>
                <span>{{ item.description || (item.required ? '必检项目' : '选检项目') }}</span>
              </div>
              <el-tag :type="resultTagType(item.result)" effect="plain">{{ itemResultLabel(item.result) }}</el-tag>
              <span class="record-result-note">{{ item.note || '无备注' }}</span>
            </div>
          </div>
          <el-empty v-else description="该历史记录没有逐项结果" :image-size="72" />
        </section>
      </template>
      <template #footer><el-button @click="closeRecordDetail">关闭</el-button></template>
    </el-dialog>

    <el-dialog
      v-model="recordPhotoPreviewVisible"
      :title="recordPhotoPreviewName || '现场照片'"
      width="min(760px, 94vw)"
      append-to-body
      @closed="clearRecordPhotoPreview"
    >
      <img
        v-if="recordPhotoPreviewUrl"
        :src="recordPhotoPreviewUrl"
        :alt="recordPhotoPreviewName || '现场照片'"
        class="record-photo-preview"
      />
    </el-dialog>

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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  exportEquipmentRoutineRecords,
  getEquipmentList,
  getEquipmentOptions,
  getEquipmentRoutineException,
  getEquipmentRoutineExceptions,
  getEquipmentRoutinePlan,
  getEquipmentRoutinePlans,
  getEquipmentRoutineRecords,
  markEquipmentRoutinePlansRestDay,
  runEquipmentRoutineWorker,
  transitionEquipmentRoutineException
} from '@/api/equipment'
import { downloadFileBlob } from '@/api/file'
import {
  createRoutineRecordPhotoRequestGuard,
  isRoutinePlanRestDaySelectable,
  loadRoutineRecordPhotoPreview,
  routinePlanCancellationReasonLabel,
  routineRecordChecklistItems,
  routineRecordPerformerName,
  routineRecordPlanWindow,
  routineRecordPlateNumber,
  routineScheduleLabel,
  saveBlob
} from '@/utils/equipment'
import { requestErrorMessage } from '@/utils/request'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const ROUTINE_TABS = new Set(['plans', 'records', 'exceptions'])
const requestedTab = String(route.query.tab || '')
const loading = ref(false)
const loadError = ref('')
const exporting = ref(false)
const submitting = ref(false)
const restDaySubmitting = ref(false)
const workerRunning = ref(false)
const activeTab = ref(ROUTINE_TABS.has(requestedTab) ? requestedTab : 'plans')
const selectedTeamId = ref(String(route.query.teamId || ''))
const focusedExceptionId = ref(String(route.query.exceptionId || ''))
const focusedPlanId = ref(String(route.query.planId || ''))
const plans = ref([])
const planTableRef = ref(null)
const selectedRestDayPlanIds = ref([])
const records = ref([])
const exceptions = ref([])
const equipmentOptions = ref([])
const orgUnitOptions = ref([])
const total = ref(0)
let referenceRequestId = 0
let activeTabRequestId = 0
const handleVisible = ref(false)
const selectedException = ref(null)
const recordDetailVisible = ref(false)
const selectedRecord = ref(null)
const recordPhotoPreviewVisible = ref(false)
const recordPhotoPreviewUrl = ref('')
const recordPhotoPreviewName = ref('')
const recordPhotoLoadingId = ref('')
const recordPhotoRequestGuard = createRoutineRecordPhotoRequestGuard()
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
  SUB_DEPARTMENT_MANAGER: '分部负责人处理',
  ASSET_ADMIN: '设备管理员处理',
  RESOLVED: '已解决'
}
const requestTeam = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const canExport = computed(() => session.hasPermission('equipment.export'))
const canMarkRestDay = computed(() => (
  session.isTeamMode && session.hasPermission('equipment.inspect')
))
const canRunRoutineWorker = computed(() => {
  const membership = session.context.membership || {}
  const managerIdentityAllowed = (
    session.isSuperAdmin ||
    membership.positionKey === 'DEPARTMENT_MANAGER' ||
    membership.functionalRoleKeys?.includes('ASSET_ADMIN')
  )
  return managerIdentityAllowed &&
    session.isTeamMode &&
    session.moduleDataScopes.equipment === 'TEAM' &&
    session.can('equipment.edit', { write: true, teamRequired: true })
})
const handleActions = computed(() => (
  selectedException.value?.currentStage === 'ASSET_ADMIN'
    ? [{ label: '解决异常', value: 'RESOLVE' }]
    : [{ label: '本级解决', value: 'RESOLVE' }, { label: '无法解决，升级', value: 'ESCALATE' }]
))
const selectedRecordItems = computed(() => routineRecordChecklistItems(selectedRecord.value || {}))
const selectedRecordPhotos = computed(() => recordPhotos(selectedRecord.value || {}))

const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const routineLabel = (value) => value === 'MAINTENANCE' ? '保养' : '点检'
const resultLabel = (value) => ({ NORMAL: '正常', COMPLETED: '完成', ABNORMAL: '异常' }[value] || value || '-')
const itemResultLabel = (value) => ({
  NORMAL: '正常',
  COMPLETED: '完成',
  ABNORMAL: '异常',
  SKIPPED: '跳过'
}[value] || (value ? String(value) : '未记录'))
const resultTagType = (value) => ({ ABNORMAL: 'danger', SKIPPED: 'info' }[value] || (value ? 'success' : 'info'))
const planStatus = (value) => planStatuses[value] || { label: value || '-', type: 'info' }
const planCancellationReason = (row) => routinePlanCancellationReasonLabel(row)
const recordPlanWindow = (row) => routineRecordPlanWindow(row)
const recordPlateNumber = (row) => routineRecordPlateNumber(row)
const recordPerformerName = (row) => routineRecordPerformerName(row)
const stageLabel = (value) => stages[value] || value || '-'
const canSelectRestDayPlan = (row) => (
  canMarkRestDay.value && isRoutinePlanRestDaySelectable(row)
)
const displayWatermark = (row, photo) => {
  const existing = String(photo?.watermarkText || '').trim()
  const location = String(photo?.address || row?.equipment?.location || '').trim()
  const hasCoordinates = (
    photo?.locationStatus === 'GRANTED' &&
    Number.isFinite(Number(photo?.latitude)) &&
    Number.isFinite(Number(photo?.longitude))
  )
  const coordinateText = hasCoordinates
    ? `${Number(photo.latitude).toFixed(6)}, ${Number(photo.longitude).toFixed(6)}`
    : ''
  const parts = existing ? [existing] : [displayTime(photo?.capturedAt)]
  if (location && !existing.includes(location)) parts.push(`设备地点：${location}`)
  if (coordinateText && !existing.includes(coordinateText)) parts.push(`GPS：${coordinateText}`)
  return parts.filter(Boolean).join(' | ')
}

function recordPhotoEvidenceText(row = {}) {
  const photos = recordPhotos(row)
  if (!photos.length) return '无现场照片'
  return photos
    .map((photo, index) => `照片 ${index + 1}：${displayWatermark(row, photo)}`)
    .join('；')
}

function recordPhotoSummary(row = {}) {
  const photos = recordPhotos(row)
  if (!photos.length) return '无'
  const first = displayWatermark(row, photos[0])
  const firstSummary = first && first !== '-' ? ` · ${first}` : ''
  const remainingSummary = photos.length > 1 ? ` · 其余 ${photos.length - 1} 张见详情` : ''
  return `${photos.length} 张${firstSummary}${remainingSummary}`
}

function recordPhotos(row = {}) {
  const photos = []
  const seen = new Set()
  for (const evidence of Array.isArray(row.photoEvidence) ? row.photoEvidence : []) {
    const fileId = String(evidence?.fileId || '').trim()
    if (!fileId || seen.has(fileId)) continue
    seen.add(fileId)
    photos.push({ ...evidence, fileId })
  }
  for (const value of Array.isArray(row.photoFileIds) ? row.photoFileIds : []) {
    const fileId = String(value || '').trim()
    if (!fileId || seen.has(fileId)) continue
    seen.add(fileId)
    photos.push({ fileId })
  }
  return photos
}

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

function recordRule(row = {}) {
  return row.ruleSnapshot || row.rule || row.routineRule || {}
}

function recordRuleLabel(row = {}) {
  const name = recordRule(row).name || row.ruleName || '-'
  return row.ruleVersion ? `${name} v${row.ruleVersion}` : name
}

function recordPlanReference(row = {}, full = false) {
  const { planId } = recordPlanWindow(row)
  if (!planId) return '未关联计划（历史/手动记录）'
  return full ? `计划编号 ${planId}` : `计划 ${planId.slice(-8)}`
}

function recordPlanSecondary(row = {}) {
  const { windowName, cycleKey } = recordPlanWindow(row)
  const visibleCycleKey = cycleKey.length > 14 ? `…${cycleKey.slice(-12)}` : cycleKey
  return [windowName, visibleCycleKey ? `周期：${visibleCycleKey}` : ''].filter(Boolean).join(' · ')
}

function recordPlanWindowLabel(row = {}) {
  const { scheduledFor, dueAt } = recordPlanWindow(row)
  if (!scheduledFor && !dueAt) return '未记录计划时间'
  return `${displayTime(scheduledFor)} 至 ${displayTime(dueAt)}`
}

function queryParams() {
  const [from, to] = filters.dateRange || []
  const params = {
    ...requestTeam.value,
    routineType: filters.routineType || undefined,
    equipmentId: filters.equipmentId || undefined,
    orgUnitId: filters.orgUnitId || undefined,
    from: from ? `${from}T00:00:00+08:00` : undefined,
    to: to ? `${to}T23:59:59.999+08:00` : undefined,
    page: filters.page,
    pageSize: filters.pageSize
  }
  if (activeTab.value === 'plans') params.status = filters.planStatus || undefined
  if (activeTab.value === 'records') {
    params.overallResult = filters.overallResult || undefined
    params.dateBasis = 'PLAN'
  }
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
  const requestedTeamId = String(teamParams.teamId || '')
  const [equipmentResult, optionResult] = await Promise.all([
    getEquipmentList({ ...teamParams, page: 1, pageSize: 200 }),
    getEquipmentOptions(teamParams)
  ])
  if (
    requestId !== referenceRequestId ||
    requestedTeamId !== String(requestTeam.value.teamId || '')
  ) return
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
  const requestedTeamId = String(teamParams.teamId || '')
  const requestedPlanId = focusedPlanId.value
  const requestedExceptionId = focusedExceptionId.value
  loading.value = true
  loadError.value = ''
  try {
    const result = tab === 'plans'
      ? await getEquipmentRoutinePlans(params)
      : tab === 'records'
        ? await getEquipmentRoutineRecords(params)
        : await getEquipmentRoutineExceptions(params)
    if (
      requestId !== activeTabRequestId ||
      requestedTeamId !== String(requestTeam.value.teamId || '')
    ) return
    const listedPlans = result.plans || []
    plans.value = listedPlans
    selectedRestDayPlanIds.value = []
    await nextTick()
    planTableRef.value?.clearSelection?.()
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
  } catch (error) {
    if (
      requestId !== activeTabRequestId ||
      requestedTeamId !== String(requestTeam.value.teamId || '')
    ) return
    if (tab === 'plans') plans.value = []
    if (tab === 'records') records.value = []
    if (tab === 'exceptions') exceptions.value = []
    total.value = 0
    loadError.value = requestErrorMessage(error, '工作台数据加载失败，请重试')
  } finally {
    if (requestId === activeTabRequestId) loading.value = false
  }
}

function handlePlanSelectionChange(rows) {
  selectedRestDayPlanIds.value = (rows || [])
    .filter(canSelectRestDayPlan)
    .map(({ _id }) => String(_id))
}

async function markSelectedPlansRestDay() {
  if (!selectedRestDayPlanIds.value.length || restDaySubmitting.value) return
  try {
    await ElMessageBox.confirm(
      `确认将选中的 ${selectedRestDayPlanIds.value.length} 条点检计划按各自计划日期设为“休班”吗？`,
      '所选计划设为休班',
      {
        confirmButtonText: '确认休班',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }
  restDaySubmitting.value = true
  try {
    const result = await markEquipmentRoutinePlansRestDay({
      planIds: [...selectedRestDayPlanIds.value]
    })
    const count = Number(result.cancelledCount || 0)
    ElMessage.success(count > 0 ? `已将 ${count} 条点检计划设为休班` : '所选计划已是休班状态')
    selectedRestDayPlanIds.value = []
    await loadActiveTab()
  } finally {
    restDaySubmitting.value = false
  }
}

async function runRoutineWorkerNow() {
  if (!canRunRoutineWorker.value || workerRunning.value) return
  workerRunning.value = true
  let workerCompleted = false
  try {
    const response = await runEquipmentRoutineWorker()
    workerCompleted = true
    const result = response?.result || response || {}
    const rulesProcessed = Number(result.rulesProcessed || 0)
    const plansProcessed = Number(result.plansProcessed || 0)
    ElMessage.success(`补跑完成：扫描 ${rulesProcessed} 条规则，处理 ${plansProcessed} 条计划`)
    filters.page = 1
    if (activeTab.value !== 'plans') {
      activeTab.value = 'plans'
      await changeTab()
    } else {
      await loadActiveTab()
    }
  } catch (error) {
    ElMessage.error(requestErrorMessage(
      error,
      workerCompleted ? '补跑已完成，但计划列表刷新失败，请手动刷新' : '计划补跑失败，请稍后重试'
    ))
  } finally {
    workerRunning.value = false
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
  ++activeTabRequestId
  loading.value = false
  plans.value = []
  records.value = []
  exceptions.value = []
  total.value = 0
  loadError.value = ''
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

watch(() => route.query.tab, async (requestedRouteTab) => {
  const routedTab = String(requestedRouteTab || '')
  const nextTab = ROUTINE_TABS.has(routedTab) ? routedTab : 'plans'
  if (nextTab === activeTab.value) return
  closeRecordDetail()
  ++activeTabRequestId
  loading.value = false
  activeTab.value = nextTab
  plans.value = []
  records.value = []
  exceptions.value = []
  total.value = 0
  loadError.value = ''
  filters.page = 1
  focusedExceptionId.value = nextTab === 'exceptions' ? String(route.query.exceptionId || '') : ''
  focusedPlanId.value = nextTab === 'plans' ? String(route.query.planId || '') : ''
  await loadActiveTab()
})

async function changeTeam() {
  closeRecordDetail()
  ++activeTabRequestId
  ++referenceRequestId
  loading.value = false
  plans.value = []
  records.value = []
  exceptions.value = []
  equipmentOptions.value = []
  orgUnitOptions.value = []
  total.value = 0
  loadError.value = ''
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
  return session.isTeamMode && row.status === 'OPEN' && row.accessPolicy?.canHandle === true
}

function openRecordDetail(row) {
  invalidateRecordPhotoRequest()
  recordPhotoPreviewVisible.value = false
  clearRecordPhotoPreview()
  selectedRecord.value = row
  recordDetailVisible.value = true
}

function recordPhotoRequestContext() {
  return {
    recordId: String(selectedRecord.value?._id || selectedRecord.value?.id || ''),
    teamId: String(requestTeam.value.teamId || session.activeTeamId || ''),
    userId: String(session.user?._id || session.user?.id || '')
  }
}

function invalidateRecordPhotoRequest() {
  recordPhotoRequestGuard.invalidate()
  recordPhotoLoadingId.value = ''
}

function clearRecordPhotoPreview() {
  if (recordPhotoPreviewUrl.value) URL.revokeObjectURL(recordPhotoPreviewUrl.value)
  recordPhotoPreviewUrl.value = ''
  recordPhotoPreviewName.value = ''
}

function closeRecordDetail() {
  invalidateRecordPhotoRequest()
  recordDetailVisible.value = false
  recordPhotoPreviewVisible.value = false
  clearRecordPhotoPreview()
  selectedRecord.value = null
}

async function previewRecordPhoto(photo, index) {
  const fileId = String(photo?.fileId || '').trim()
  const context = recordPhotoRequestContext()
  if (!fileId || !context.recordId || recordPhotoLoadingId.value) return
  const requestedTeamId = requestTeam.value.teamId
  const request = recordPhotoRequestGuard.begin(context)
  recordPhotoLoadingId.value = fileId
  try {
    const preview = await loadRoutineRecordPhotoPreview({
      guard: recordPhotoRequestGuard,
      request,
      currentContext: recordPhotoRequestContext,
      loadBlob: () => downloadFileBlob(fileId, requestedTeamId),
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url)
    })
    if (preview.stale) return
    clearRecordPhotoPreview()
    recordPhotoPreviewUrl.value = preview.url
    recordPhotoPreviewName.value = `现场照片 ${index + 1}`
    recordPhotoPreviewVisible.value = true
  } catch (error) {
    if (recordPhotoRequestGuard.isCurrent(request, recordPhotoRequestContext())) {
      ElMessage.error(requestErrorMessage(error, '现场照片加载失败，请稍后重试'))
    }
  } finally {
    if (recordPhotoRequestGuard.isCurrent(request, recordPhotoRequestContext())) {
      recordPhotoLoadingId.value = ''
    }
  }
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
onBeforeUnmount(() => {
  recordPhotoRequestGuard.destroy()
  recordPhotoLoadingId.value = ''
  clearRecordPhotoPreview()
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
.plan-status-cell { display: grid; justify-items: start; gap: 6px; }
.plan-status-cell span { color: var(--zl-muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.record-cell-stack, .record-evidence-cell { min-width: 0; display: grid; align-content: start; gap: 4px; line-height: 1.4; }
.record-cell-stack strong, .record-cell-stack span, .record-evidence-cell span { min-width: 0; overflow-wrap: anywhere; }
.record-cell-stack span, .record-evidence-cell span { color: var(--zl-muted); font-size: 12px; }
.record-plan-cell span, .record-evidence-cell span { white-space: normal; }
.record-evidence-cell { justify-items: start; }
.record-compact-view { display: none; }
.record-compact-row { padding: 14px 12px; border-bottom: 1px solid var(--zl-border-soft); }
.record-compact-row:last-child { border-bottom: 0; }
.record-compact-heading { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; gap: 10px; }
.record-compact-heading > .el-button { margin-left: 0; }
.record-compact-grid { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(220px, 1.4fr) minmax(145px, 0.8fr) minmax(190px, 1.2fr); gap: 12px; margin-top: 10px; }
.record-compact-grid > div { min-width: 0; display: grid; align-content: start; gap: 4px; padding-top: 9px; border-top: 1px solid var(--zl-border-soft); }
.record-compact-grid span, .record-compact-grid small, .record-compact-grid strong { min-width: 0; overflow-wrap: anywhere; }
.record-compact-grid span { color: var(--zl-muted); font-size: 12px; }
.record-compact-grid small { color: var(--zl-muted); line-height: 1.4; }
.record-detail-section { margin-top: 20px; }
.record-detail-section h3 { margin: 0 0 10px; font-size: 16px; letter-spacing: 0; }
.record-photo-list, .record-result-list { display: grid; }
.record-photo-list > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 5px 0; }
.record-photo-copy { min-width: 0; display: grid; gap: 4px; }
.record-photo-copy span { min-width: 0; overflow-wrap: anywhere; }
.record-photo-preview { display: block; max-width: 100%; max-height: 72vh; margin: 0 auto; object-fit: contain; }
.record-result-row { display: grid; grid-template-columns: minmax(220px, 1.2fr) 84px minmax(180px, 1fr); align-items: center; gap: 14px; min-height: 58px; padding: 10px 4px; border-top: 1px solid var(--zl-border-soft); }
.record-result-row:last-child { border-bottom: 1px solid var(--zl-border-soft); }
.record-result-copy { min-width: 0; display: grid; gap: 4px; }
.record-result-copy span, .record-result-note { color: var(--zl-muted); font-size: 13px; overflow-wrap: anywhere; }
:deep(.focused-message-row > td.el-table__cell) { background: var(--el-color-primary-light-9) !important; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.handle-form { margin-top: 18px; }
@media (max-width: 1180px) {
  .record-table-view { display: none; }
  .record-compact-view { display: block; }
}
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .heading-actions, .toolbar > *, .team-select { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .record-compact-heading { grid-template-columns: minmax(0, 1fr) auto; }
  .record-compact-heading > .el-button { grid-column: 1 / -1; justify-self: start; }
  .record-compact-grid { grid-template-columns: minmax(0, 1fr); }
  .record-result-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; }
  .record-result-note { grid-column: 1 / -1; }
}
</style>
