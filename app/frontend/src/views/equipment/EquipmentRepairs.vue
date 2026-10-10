<template>
  <div class="repair-page">
    <header class="page-heading">
      <div>
        <h1>设备维修</h1>
        <p>记录设备报修、维修、配件和审批 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canManageLocations" @click="openLocationManagement">
          <el-icon><Edit /></el-icon>
          报修地点
        </el-button>
        <el-button v-if="canExport" :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出
        </el-button>
        <el-button v-if="canCreate" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建维修单
        </el-button>
      </div>
    </header>

    <section class="toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-input
        v-model="filters.keyword"
        clearable
        class="keyword-input"
        placeholder="设备编码、名称、联系人或维修人"
        @keyup.enter="applyFilters"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.type" clearable placeholder="维修类型">
        <el-option v-for="item in REPAIR_TYPE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="流程状态（任一段命中）">
        <el-option v-for="(label, value) in REPAIR_STATUS_LABELS" :key="value" :label="label" :value="value" />
      </el-select>
      <el-select v-model="filters.followup" clearable placeholder="后续状态" class="followup-select">
        <el-option
          v-for="item in REPAIR_FOLLOWUP_FILTER_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-checkbox v-if="canViewRepairTodos" v-model="filters.todo">只看我的待办</el-checkbox>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button circle aria-label="刷新维修单" :loading="loading" @click="loadRepairs">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell">
      <el-table class="repair-table" v-loading="loading" :data="repairs" row-key="_id" stripe empty-text="暂无维修记录">
        <el-table-column label="设备信息" min-width="210" fixed="left">
          <template #default="{ row }">
            <div class="asset-cell">
              <strong>{{ row.equipmentSnapshot?.name || '-' }}</strong>
              <span>{{ row.equipmentSnapshot?.assetCode || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所属分部" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.equipmentSnapshot?.orgUnitName || '-' }}</template>
        </el-table-column>
        <el-table-column label="使用人" min-width="100" show-overflow-tooltip>
          <template #default="{ row }">{{ row.creatorName || '-' }}</template>
        </el-table-column>
        <el-table-column label="维修进度" min-width="420">
          <template #default="{ row }">
            <div class="repair-flow">
              <div v-if="row.type === 'FAULT_REPORT'" class="repair-flow-item fault-flow">
                <div class="repair-flow-head">
                  <strong class="repair-flow-label">故障报修</strong>
                  <el-tag :type="repairStatusTone(row.status)" effect="light">
                    {{ repairStatusLabel(row.status) }}
                  </el-tag>
                </div>
                <div class="repair-flow-content">
                  <span class="repair-flow-date">报修：{{ displayDate(row.reportTime) }}</span>
                  <el-button text type="primary" @click="openDetail(row)">
                    {{ row.availableActions?.length ? '处理' : '详情' }}
                  </el-button>
                </div>
              </div>

              <div v-if="followupRepairOfType(row, 'NO_PARTS_REPAIR')" class="repair-flow-item no-parts-flow">
                <div class="repair-flow-head">
                  <strong class="repair-flow-label">不需换件维修</strong>
                  <el-tag v-if="row.standaloneFollowup" type="warning" effect="light">
                    未关联故障报修
                  </el-tag>
                  <el-tag :type="repairStatusTone(followupRepairOfType(row, 'NO_PARTS_REPAIR').status)" effect="light">
                    {{ repairStatusLabel(followupRepairOfType(row, 'NO_PARTS_REPAIR').status) }}
                  </el-tag>
                </div>
                <div class="repair-flow-content">
                  <span class="repair-flow-date">维修：{{ displayDate(followupRepairOfType(row, 'NO_PARTS_REPAIR').repairDate) }}</span>
                  <el-button text type="primary" @click="openDetail(followupRepairOfType(row, 'NO_PARTS_REPAIR'))">
                    {{ followupRepairOfType(row, 'NO_PARTS_REPAIR').availableActions?.length ? '处理' : '详情' }}
                  </el-button>
                </div>
              </div>

              <div v-if="followupRepairOfType(row, 'PARTS_REPAIR')" class="repair-flow-item parts-flow">
                <div class="repair-flow-head">
                  <strong class="repair-flow-label">需要配件维修</strong>
                  <el-tag v-if="row.standaloneFollowup" type="warning" effect="light">
                    未关联故障报修
                  </el-tag>
                  <el-tag :type="repairStatusTone(followupRepairOfType(row, 'PARTS_REPAIR').status)" effect="light">
                    {{ repairStatusLabel(followupRepairOfType(row, 'PARTS_REPAIR').status) }}
                  </el-tag>
                </div>
                <div class="repair-flow-content">
                  <span class="repair-flow-date">维修：{{ displayDate(followupRepairOfType(row, 'PARTS_REPAIR').repairDate) }}</span>
                  <span class="repair-flow-amount">金额：￥{{ Number(followupRepairOfType(row, 'PARTS_REPAIR').totalAmount || 0).toFixed(2) }}</span>
                  <el-button text type="primary" @click="openDetail(followupRepairOfType(row, 'PARTS_REPAIR'))">
                    {{ followupRepairOfType(row, 'PARTS_REPAIR').availableActions?.length ? '处理' : '详情' }}
                  </el-button>
                </div>
              </div>

              <div v-if="row.needsFollowup && !followupRepair(row)" class="repair-flow-item pending-flow">
                <div class="repair-flow-head">
                  <strong class="repair-flow-label">待选择维修方式</strong>
                  <el-tag type="warning" effect="light">待补后续</el-tag>
                </div>
                <div class="repair-flow-content">
                  <span class="repair-flow-date">故障报修已完成，请选择后续维修方式</span>
                  <el-button v-if="canCreate && isRowCreator(row)" text type="warning" @click="openCreate(row)">
                    补后续
                  </el-button>
                </div>
              </div>

              <span v-if="!row.type && !followupRepair(row)" class="repair-flow-empty">-</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最后更新时间" width="165">
          <template #default="{ row }">{{ displayTime(latestUpdatedAt(row)) }}</template>
        </el-table-column>
      </el-table>
    </section>

    <footer class="pagination-row">
      <span>共 {{ total }} 条</span>
      <el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="sizes, prev, pager, next"
        @change="loadRepairs"
      />
    </footer>

    <el-dialog
      v-model="createVisible"
      :title="createForm.sourceRepairId ? '补录后续维修单' : '新建设备维修单'"
      width="min(940px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="resetCreateForm"
    >
      <el-alert
        v-if="createForm.sourceRepairId"
        type="info"
        :closable="false"
        show-icon
        title="该设备故障报修已完成，请选择后续维修方式：需更换配件维修 或 不需更换配件维修"
        class="followup-alert"
      />
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="维修类型" prop="type" class="wide-field">
            <el-segmented v-model="createForm.type" :options="activeRepairTypeSegments" block />
          </el-form-item>
          <el-form-item label="设备" prop="equipmentId" class="wide-field">
            <el-select
              v-model="createForm.equipmentId"
              filterable
              class="full-width"
              placeholder="输入设备编码或名称搜索"
              :disabled="Boolean(createForm.sourceRepairId)"
            >
              <el-option
                v-for="asset in equipmentOptions"
                :key="asset._id"
                :label="`${asset.assetCode} · ${asset.name}`"
                :value="asset._id"
              />
            </el-select>
          </el-form-item>
        </div>

        <template v-if="createForm.type === 'FAULT_REPORT'">
          <div class="form-grid">
            <el-form-item label="报修时间" prop="reportTime">
              <el-date-picker v-model="createForm.reportTime" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" class="full-width" />
            </el-form-item>
            <el-form-item label="报修地点" prop="reportLocation">
              <el-select
                v-model="createForm.reportLocation"
                filterable
                allow-create
                default-first-option
                class="full-width"
                placeholder="选择或输入报修地点"
              >
                <el-option v-for="location in repairLocations" :key="location" :label="location" :value="location" />
              </el-select>
            </el-form-item>
            <el-form-item label="车牌号">
              <el-input v-model="createForm.plateNumber" maxlength="100" />
            </el-form-item>
            <el-form-item label="联系人" prop="contactName">
              <el-input v-model="createForm.contactName" maxlength="100" />
            </el-form-item>
            <el-form-item label="联系电话" prop="contactPhone">
              <el-input v-model="createForm.contactPhone" maxlength="50" />
            </el-form-item>
          </div>
          <el-form-item label="故障描述" prop="faultDescription">
            <el-input v-model="createForm.faultDescription" type="textarea" :rows="4" maxlength="5000" show-word-limit />
          </el-form-item>
          <el-form-item label="现场照片（1-5张）" required>
            <el-upload
              v-model:file-list="photoFileList"
              :auto-upload="false"
              :limit="5"
              accept="image/jpeg,image/png"
              list-type="picture-card"
              :on-exceed="handlePhotoExceed"
            >
              <el-icon><Plus /></el-icon>
            </el-upload>
          </el-form-item>
        </template>

        <template v-else>
          <div class="form-grid">
            <el-form-item label="维修日期" prop="repairDate">
              <el-date-picker v-model="createForm.repairDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
            </el-form-item>
            <el-form-item label="维修人" prop="repairerName">
              <el-input v-model="createForm.repairerName" maxlength="200" />
            </el-form-item>
          </div>
          <el-form-item label="维修说明">
            <el-input v-model="createForm.repairDescription" type="textarea" :rows="3" maxlength="5000" show-word-limit />
          </el-form-item>
          <section v-if="createForm.type === 'PARTS_REPAIR'" class="parts-section">
            <div class="section-heading">
              <h3>配件明细</h3>
              <el-button type="primary" plain @click="addPart">
                <el-icon><Plus /></el-icon>
                添加配件
              </el-button>
            </div>
            <el-table :data="createForm.partItems" row-key="itemKey" border>
              <el-table-column label="配件名称" min-width="180">
                <template #default="{ row }"><el-input v-model="row.name" maxlength="200" /></template>
              </el-table-column>
              <el-table-column label="规格型号" min-width="160">
                <template #default="{ row }"><el-input v-model="row.specification" maxlength="300" /></template>
              </el-table-column>
              <el-table-column label="备注" min-width="180">
                <template #default="{ row }"><el-input v-model="row.remark" maxlength="1000" /></template>
              </el-table-column>
              <el-table-column label="操作" width="72" align="center">
                <template #default="{ $index }">
                  <el-button text type="danger" :disabled="createForm.partItems.length <= 1" aria-label="删除配件" @click="removePart($index)">
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">提交</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="locationVisible"
      title="维护报修地点"
      width="min(620px, 94vw)"
      destroy-on-close
      append-to-body
    >
      <el-select
        v-model="locationDraft"
        multiple
        filterable
        allow-create
        default-first-option
        class="full-width"
        placeholder="输入地点后按回车添加"
      >
        <el-option v-for="location in repairLocations" :key="location" :label="location" :value="location" />
      </el-select>
      <template #footer>
        <el-button @click="locationVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingLocations" @click="saveLocations">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onActivated, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import {
  createEquipmentRepair,
  exportEquipmentRepairs,
  getEquipmentList,
  getEquipmentRepairLocations,
  getEquipmentRepairs,
  updateEquipmentRepairLocations
} from '@/api/equipment'
import { deleteFile, getFileMetadata, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import { prepareAttachmentReferences } from '@/utils/attachments'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { requestErrorMessage } from '@/utils/request'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import {
  REPAIR_FOLLOWUP_FILTER_OPTIONS,
  REPAIR_STATUS_LABELS,
  REPAIR_TYPE_OPTIONS,
  emptyRepairPart,
  repairStatusLabel,
  repairStatusTone,
  saveRepairWorkbook
} from '@/utils/equipmentRepair'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const repairs = ref([])
const equipmentOptions = ref([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const exporting = ref(false)
const createVisible = ref(false)
const locationVisible = ref(false)
const savingLocations = ref(false)
const createFormRef = ref(null)
const photoFileList = ref([])
const repairLocations = ref([])
const locationDraft = ref([])
const selectedTeamId = ref(String(route.query.teamId || ''))
let repairsRequestId = 0
let equipmentOptionsRequestId = 0
let repairLocationsRequestId = 0
let exportRequestId = 0
let pageActive = true
let wasDeactivated = false
let routeCreateToken = ''
let equipmentOptionsRequestPending = false
let repairLocationsRequestPending = false
let resumeRepairsLoad = false
let resumeEquipmentOptionsLoad = false
let resumeRepairLocationsLoad = false
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.EQUIPMENT_REPAIRS
})

const filters = reactive({ keyword: '', type: '', status: '', followup: '', todo: false, page: 1, pageSize: 20 })
const createForm = reactive(emptyCreateForm())
const canCreate = computed(() => session.can('equipment.repair', { write: true, teamRequired: true }))
const canViewRepairTodos = computed(() => (
  session.isTeamMode && session.can('equipment.repair', { teamRequired: true })
))
const canExport = computed(() => session.hasPermission('equipment.export'))
const canManageLocations = computed(() => session.can('equipment.edit', { write: true, teamRequired: true }))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const repairTypeSegments = REPAIR_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value }))
const followupTypeSegments = REPAIR_TYPE_OPTIONS
  .filter((item) => item.value !== 'FAULT_REPORT')
  .map((item) => ({ label: item.label, value: item.value }))
const faultTypeSegments = REPAIR_TYPE_OPTIONS
  .filter((item) => item.value === 'FAULT_REPORT')
  .map((item) => ({ label: item.label, value: item.value }))
const activeRepairTypeSegments = computed(() => (
  createForm.sourceRepairId ? followupTypeSegments : faultTypeSegments
))

const createRules = {
  type: [{ required: true, message: '请选择维修类型', trigger: 'change' }],
  equipmentId: [{ required: true, message: '请选择设备', trigger: 'change' }],
  reportTime: [{ required: true, message: '请选择报修时间', trigger: 'change' }],
  reportLocation: [{ required: true, message: '请输入报修地点', trigger: 'blur' }],
  contactName: [{ required: true, message: '请输入联系人', trigger: 'blur' }],
  contactPhone: [{ required: true, message: '请输入联系电话', trigger: 'blur' }],
  faultDescription: [{ required: true, message: '请输入故障描述', trigger: 'blur' }],
  repairDate: [{ required: true, message: '请选择维修日期', trigger: 'change' }],
  repairerName: [{ required: true, message: '请输入维修人', trigger: 'blur' }]
}

function emptyCreateForm() {
  return {
    type: 'FAULT_REPORT',
    equipmentId: '',
    sourceRepairId: '',
    reportTime: dayjs().format('YYYY-MM-DDTHH:mm:ssZ'),
    reportLocation: '',
    plateNumber: '',
    contactName: '',
    contactPhone: '',
    faultDescription: '',
    repairDate: dayjs().format('YYYY-MM-DD'),
    repairerName: '',
    repairDescription: '',
    partItems: [emptyRepairPart(0)],
    idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

const displayDate = (value) => value ? dayjs(value).format('YYYY-MM-DD') : '-'
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const latestUpdatedAt = (row) => (
  row.followup?.updatedAt && row.updatedAt && new Date(row.followup.updatedAt) > new Date(row.updatedAt)
    ? row.followup.updatedAt
    : row.updatedAt
)
// Merged rows normally contain a fault report and one follow-up; standalone follow-ups remain valid detail rows.
const followupRepair = (row) => row.followup || (
  row.type && row.type !== 'FAULT_REPORT' ? row : null
)
const followupRepairOfType = (row, type) => {
  const repair = followupRepair(row)
  return repair?.type === type ? repair : null
}
const isRowCreator = (row) => Boolean(
  session.user?._id && row.createdBy && String(session.user._id) === String(row.createdBy)
)
const currentTeamContextId = () => String(
  session.isGlobalReadOnly ? selectedTeamId.value : session.activeTeamId || ''
)

function defaultTodoFilter() {
  return canViewRepairTodos.value
}

function listParams(extra = {}) {
  return {
    ...requestTeamParams.value,
    view: 'merged',
    keyword: filters.keyword.trim() || undefined,
    type: filters.type || undefined,
    status: filters.status || undefined,
    followup: filters.followup || undefined,
    todo: filters.todo || undefined,
    page: filters.page,
    pageSize: filters.pageSize,
    ...extra
  }
}

async function loadRepairs() {
  const requestId = ++repairsRequestId
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    repairs.value = []
    total.value = 0
    loading.value = false
    return false
  }
  const loadStartRevision = mutationRefresh.currentRevision()
  const requestedTeamId = currentTeamContextId()
  loading.value = true
  try {
    const result = await getEquipmentRepairs(listParams())
    if (requestId !== repairsRequestId) return false
    if (!pageActive || requestedTeamId !== currentTeamContextId()) return false
    repairs.value = result.repairs || []
    total.value = result.total || 0
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } finally {
    if (requestId === repairsRequestId) loading.value = false
  }
}

async function loadEquipmentOptions() {
  const requestId = ++equipmentOptionsRequestId
  if (!session.isTeamMode) return
  const requestedTeamId = currentTeamContextId()
  equipmentOptionsRequestPending = true
  try {
    const result = await getEquipmentList({ page: 1, pageSize: 200 })
    if (
      !pageActive ||
      requestId !== equipmentOptionsRequestId ||
      requestedTeamId !== currentTeamContextId()
    ) return
    equipmentOptions.value = result.equipment || []
  } finally {
    if (requestId === equipmentOptionsRequestId) equipmentOptionsRequestPending = false
  }
}

async function loadRepairLocations() {
  const requestId = ++repairLocationsRequestId
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    repairLocations.value = []
    return
  }
  const requestedTeamId = currentTeamContextId()
  repairLocationsRequestPending = true
  try {
    const result = await getEquipmentRepairLocations(requestTeamParams.value)
    if (
      !pageActive ||
      requestId !== repairLocationsRequestId ||
      requestedTeamId !== currentTeamContextId()
    ) return
    repairLocations.value = result.locations || []
  } finally {
    if (requestId === repairLocationsRequestId) repairLocationsRequestPending = false
  }
}

function applyFilters() {
  filters.page = 1
  loadRepairs()
}

function resetFilters() {
  Object.assign(filters, { keyword: '', type: '', status: '', followup: '', todo: defaultTodoFilter(), page: 1 })
  loadRepairs()
}

function invalidateRepairTeamContext() {
  repairsRequestId += 1
  equipmentOptionsRequestId += 1
  repairLocationsRequestId += 1
  exportRequestId += 1
  equipmentOptionsRequestPending = false
  repairLocationsRequestPending = false
  loading.value = false
  exporting.value = false
  repairs.value = []
  equipmentOptions.value = []
  repairLocations.value = []
  locationDraft.value = []
  total.value = 0
  createVisible.value = false
  locationVisible.value = false
  resetCreateForm()
}

async function handleTeamChange(teamId) {
  invalidateRepairTeamContext()
  Object.assign(filters, { keyword: '', type: '', status: '', followup: '', todo: defaultTodoFilter(), page: 1 })
  await router.replace({ query: teamId ? { teamId } : {} })
  await Promise.all([loadRepairs(), loadRepairLocations()])
}

function openLocationManagement() {
  locationDraft.value = [...repairLocations.value]
  locationVisible.value = true
}

async function saveLocations() {
  const locations = [...new Set(locationDraft.value.map((value) => value.trim()).filter(Boolean))]
  savingLocations.value = true
  try {
    const result = await updateEquipmentRepairLocations({ locations })
    repairLocations.value = result.locations || []
    locationVisible.value = false
    ElMessage.success('报修地点已更新')
  } finally {
    savingLocations.value = false
  }
}

function openCreate(sourceRow = null) {
  resetCreateForm()
  if (sourceRow) {
    // 从"待补后续"行进入：锁定源报修与设备，类型收窄为二选一
    createForm.sourceRepairId = String(sourceRow._id || '')
    createForm.equipmentId = String(sourceRow.equipmentId || '')
    createForm.type = 'NO_PARTS_REPAIR'
    createVisible.value = true
    return
  }
  const requestedEquipmentId = String(route.query.equipmentId || '')
  if (requestedEquipmentId && equipmentOptions.value.some((item) => item._id === requestedEquipmentId)) {
    createForm.equipmentId = requestedEquipmentId
  }
  createVisible.value = true
}

function currentCreateToken() {
  if (route.name !== 'EquipmentRepairs' || route.query.create !== '1') return ''
  return `${String(route.query.create)}:${String(route.query.equipmentId || '')}:${String(route.query.sourceRepairId || '')}`
}

async function syncRouteCreateAction() {
  if (!pageActive || route.name !== 'EquipmentRepairs') return
  const routedTeamId = session.isGlobalReadOnly ? String(route.query.teamId || '') : ''
  if (routedTeamId && routedTeamId !== selectedTeamId.value) {
    invalidateRepairTeamContext()
    selectedTeamId.value = routedTeamId
    Object.assign(filters, { keyword: '', type: '', status: '', todo: false, page: 1 })
    await Promise.all([loadRepairs(), loadRepairLocations()])
    if (!pageActive || routedTeamId !== selectedTeamId.value) return
  }
  if (!canCreate.value) return
  const token = currentCreateToken()
  if (!token) {
    routeCreateToken = ''
    return
  }
  if (token === routeCreateToken) return
  routeCreateToken = token
  if (!equipmentOptions.value.length) await loadEquipmentOptions()
  if (!pageActive || currentCreateToken() !== token) return
  const routedSourceRepairId = String(route.query.sourceRepairId || '')
  if (routedSourceRepairId) {
    // 从详情页/消息跳转补录：根据源报修构造上下文
    const sourceRow = repairs.value.find((item) => String(item._id) === routedSourceRepairId)
    openCreate(sourceRow || {
      _id: routedSourceRepairId,
      equipmentId: String(route.query.equipmentId || '')
    })
  } else {
    openCreate()
  }
  await router.replace({ query: { ...route.query, create: undefined, equipmentId: undefined, sourceRepairId: undefined } })
}

function openDetail(row) {
  router.push({ name: 'EquipmentRepairDetail', params: { repairId: row._id }, query: requestTeamParams.value })
}

function addPart() {
  if (createForm.partItems.length >= 100) return ElMessage.warning('最多添加100条配件明细')
  createForm.partItems.push(emptyRepairPart(createForm.partItems.length))
}

function removePart(index) {
  if (createForm.partItems.length > 1) createForm.partItems.splice(index, 1)
}

function handlePhotoExceed() {
  ElMessage.warning('故障报修最多上传5张照片')
}

function resetCreateForm() {
  Object.assign(createForm, emptyCreateForm())
  photoFileList.value = []
  createFormRef.value?.clearValidate()
}

async function submitCreate() {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) return
  if (createForm.type === 'FAULT_REPORT' && (photoFileList.value.length < 1 || photoFileList.value.length > 5)) {
    return ElMessage.warning('故障报修必须上传1-5张现场照片')
  }
  if (createForm.type === 'PARTS_REPAIR' && createForm.partItems.some((item) => !item.name.trim())) {
    return ElMessage.warning('请填写每条配件名称')
  }
  submitting.value = true
  let uploadedFileIds = []
  try {
    let photoAttachments = []
    if (createForm.type === 'FAULT_REPORT') {
      const prepared = await prepareAttachmentReferences(photoFileList.value, uploadTemporaryFile)
      photoAttachments = prepared.references
      uploadedFileIds = prepared.uploadedFileIds
    }
    await createEquipmentRepair({
      type: createForm.type,
      equipmentId: createForm.equipmentId,
      ...(createForm.sourceRepairId ? { sourceRepairId: createForm.sourceRepairId } : {}),
      idempotencyKey: createForm.idempotencyKey,
      ...(createForm.type === 'FAULT_REPORT'
        ? {
            reportTime: createForm.reportTime,
            reportLocation: createForm.reportLocation,
            plateNumber: createForm.plateNumber,
            contactName: createForm.contactName,
            contactPhone: createForm.contactPhone,
            faultDescription: createForm.faultDescription,
            photoAttachments
          }
        : {
            repairDate: createForm.repairDate,
            repairerName: createForm.repairerName,
            repairDescription: createForm.repairDescription,
            ...(createForm.type === 'PARTS_REPAIR'
              ? { partItems: createForm.partItems.map((item) => ({ ...item })) }
              : {})
          })
    })
    uploadedFileIds = []
    ElMessage.success('维修单已提交')
    createVisible.value = false
    await loadRepairs()
  } catch (error) {
    await cleanupUnboundTemporaryFiles([...uploadedFileIds, ...(error.uploadedFileIds || [])])
    console.error('维修单提交失败:', error)
    ElMessage.error(requestErrorMessage(error, '维修单提交失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

async function cleanupUnboundTemporaryFiles(fileIds) {
  await Promise.allSettled([...new Set(fileIds)].map(async (fileId) => {
    const metadata = await getFileMetadata(fileId)
    if (metadata.file?.status === 'TEMPORARY') await deleteFile(fileId)
  }))
}

async function handleExport() {
  const requestId = ++exportRequestId
  const requestedTeamId = currentTeamContextId()
  exporting.value = true
  try {
    const blob = await exportEquipmentRepairs(listParams({ page: undefined, pageSize: undefined, todo: undefined }))
    if (
      !pageActive ||
      requestId !== exportRequestId ||
      requestedTeamId !== currentTeamContextId()
    ) return
    saveRepairWorkbook(blob)
  } finally {
    if (requestId === exportRequestId) exporting.value = false
  }
}

onMounted(async () => {
  filters.todo = defaultTodoFilter()
  await Promise.all([loadRepairs(), loadEquipmentOptions(), loadRepairLocations()])
  await syncRouteCreateAction()
})

watch(
  () => [session.contextEpoch, session.mode, session.activeTeamId],
  () => {
    if (!pageActive) return
    filters.todo = defaultTodoFilter()
    filters.page = 1
    void loadRepairs()
  }
)

watch(() => [route.name, route.query.teamId, route.query.create, route.query.equipmentId, route.query.sourceRepairId], () => {
  if (pageActive) void syncRouteCreateAction()
})

onActivated(() => {
  pageActive = true
  if (!wasDeactivated) return
  wasDeactivated = false
  routeCreateToken = ''
  const reloadRepairs = resumeRepairsLoad
  const reloadEquipmentOptions = resumeEquipmentOptionsLoad
  const reloadRepairLocations = resumeRepairLocationsLoad
  resumeRepairsLoad = false
  resumeEquipmentOptionsLoad = false
  resumeRepairLocationsLoad = false
  void syncRouteCreateAction().then(() => Promise.all([
    reloadRepairs ? loadRepairs() : Promise.resolve(),
    reloadEquipmentOptions ? loadEquipmentOptions() : Promise.resolve(),
    reloadRepairLocations ? loadRepairLocations() : Promise.resolve()
  ])).then(() => mutationRefresh.refreshIfNeeded(loadRepairs)).catch(() => {})
})
onDeactivated(() => {
  resumeRepairsLoad = resumeRepairsLoad || loading.value
  resumeEquipmentOptionsLoad = resumeEquipmentOptionsLoad || equipmentOptionsRequestPending
  resumeRepairLocationsLoad = resumeRepairLocationsLoad || repairLocationsRequestPending
  pageActive = false
  wasDeactivated = true
  repairsRequestId += 1
  equipmentOptionsRequestId += 1
  repairLocationsRequestId += 1
  exportRequestId += 1
  loading.value = false
  exporting.value = false
  createVisible.value = false
  locationVisible.value = false
})
</script>

<style scoped>
.repair-page { display: grid; gap: 16px; }
.page-heading, .toolbar, .pagination-row, .section-heading { display: flex; align-items: center; gap: 12px; }
.page-heading { justify-content: space-between; }
.page-heading h1 { margin: 0; color: #1f2733; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 5px 0 0; color: #667085; }
.heading-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.toolbar { flex-wrap: wrap; padding: 12px 0; border-top: 1px solid #dce4ee; border-bottom: 1px solid #dce4ee; }
.toolbar .keyword-input { width: min(300px, 100%); }
.toolbar .team-select { width: 220px; }
.toolbar .followup-select { width: 150px; }
.followup-alert { margin-bottom: 14px; }
.toolbar-spacer { flex: 1; }
.table-shell { overflow: hidden; border: 1px solid #dce4ee; border-radius: 6px; background: #fff; }
.repair-table :deep(.el-table__header th) { padding: 7px 6px; color: #344054; font-size: 12px; }
.repair-table :deep(.el-table__body td) { padding: 7px 6px; }
.repair-table :deep(.el-table__header-wrapper .cell) { white-space: normal; line-height: 1.35; }
.repair-table :deep(.el-table__body-wrapper .cell) { line-height: 1.35; }
.repair-flow { display: grid; gap: 5px; min-width: 0; }
.repair-flow-item { display: grid; gap: 2px; min-width: 0; padding: 5px 8px; border: 1px solid transparent; border-radius: 6px; }
.repair-flow-item.fault-flow { background: #f1f8e9; border-color: #c6e0b4; }
.repair-flow-item.no-parts-flow { background: #eaf3ff; border-color: #b8d6f5; }
.repair-flow-item.parts-flow { background: #fff1f4; border-color: #f1c2cc; }
.repair-flow-item.pending-flow { background: #fff8e6; border-color: #f1d18a; }
.repair-flow-head, .repair-flow-content { display: flex; align-items: center; min-width: 0; gap: 7px; }
.repair-flow-head { flex-wrap: wrap; }
.repair-flow-content { justify-content: space-between; }
.repair-flow-label { flex: 0 0 auto; color: #344054; font-size: 12px; }
.repair-flow-date { min-width: 0; overflow: hidden; color: #475467; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.repair-flow-amount { flex: 0 0 auto; color: #b42318; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.repair-flow-item > .repair-flow-content > .el-button { flex: 0 0 auto; padding: 2px 4px; }
.repair-flow-empty { color: #98a2b3; }
.asset-cell { display: grid; gap: 4px; min-width: 0; }
.asset-cell strong, .asset-cell span { overflow-wrap: anywhere; }
.asset-cell span { color: #667085; font-size: 12px; }
.pagination-row { justify-content: space-between; color: #667085; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.wide-field { grid-column: 1 / -1; }
.full-width { width: 100%; }
.parts-section { margin-top: 10px; }
.section-heading { justify-content: space-between; margin-bottom: 10px; }
.section-heading h3 { margin: 0; font-size: 16px; letter-spacing: 0; }
@media (max-width: 768px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .toolbar > * { width: 100% !important; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height) !important; align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .form-grid { grid-template-columns: 1fr; }
  .wide-field { grid-column: auto; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .repair-flow-item { padding: 5px 6px; }
  .repair-flow-content { align-items: flex-start; }
  .repair-flow-date { white-space: normal; }
}
</style>
