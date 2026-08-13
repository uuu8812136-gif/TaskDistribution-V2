<template>
  <div class="status-applications-page">
    <header class="page-heading">
      <div>
        <h1>设备状态申请</h1>
        <p>闲置、停用和报废使用同一条固定审批链。</p>
      </div>
      <el-button v-if="canCreate" type="primary" @click="openCreate()">
        <el-icon><Plus /></el-icon>
        发起申请
      </el-button>
    </header>

    <div class="status-guidance">
      <el-alert :title="accessNotice" type="info" :closable="false" show-icon />
      <el-alert
        title="申请不支持删除；填写有误时，由原发起设备管理员在详情中选择“作废申请”。"
        type="info"
        :closable="false"
        show-icon
      />
    </div>

    <div class="filter-band">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-select v-model="filters.applicationType" clearable placeholder="申请类型" @change="handleFilterChange">
        <el-option v-for="item in STATUS_APPLICATION_TYPES" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.workflowStatus" clearable placeholder="流程状态" @change="handleFilterChange">
        <el-option v-for="item in workflowOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-checkbox v-model="filters.todo" border @change="handleFilterChange">只看我的待办</el-checkbox>
      <el-button circle :loading="loading" aria-label="刷新" @click="load">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>

    <div v-if="loadError" class="load-error" role="alert">
      <el-alert :title="loadError" type="error" :closable="false" show-icon />
      <el-button :loading="loading" @click="retryLoad">重新加载</el-button>
    </div>

    <div class="table-shell">
      <el-table v-loading="loading" :data="rows" row-key="_id" stripe empty-text="暂无状态申请">
        <el-table-column label="设备" min-width="230">
          <template #default="{ row }">
            <strong class="equipment-name">{{ row.equipmentSnapshot?.name || '-' }}</strong>
            <span class="equipment-code">{{ row.equipmentSnapshot?.assetCode || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">{{ statusApplicationTypeLabel(row.applicationType) }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="190">
          <template #default="{ row }">
            <el-tag :type="statusApplicationWorkflowTone(row.workflowStatus)">
              {{ statusApplicationWorkflowLabel(row.workflowStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="申请原因" min-width="260" show-overflow-tooltip />
        <el-table-column label="发起时间" width="170">
          <template #default="{ row }">{{ displayTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right" align="center">
          <template #default="{ row }">
            <el-button text type="primary" @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :description="emptyDescription" :image-size="72">
            <el-button v-if="canCreate && !filters.todo" type="primary" @click="openCreate()">发起申请</el-button>
          </el-empty>
        </template>
      </el-table>
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        :pager-count="5"
        layout="prev, pager, next, total"
        @current-change="handlePageChange"
        class="pagination"
      />
    </div>

    <el-dialog v-model="createVisible" title="发起设备状态申请" width="min(720px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="设备" required>
          <el-select
            v-model="createForm.equipmentId"
            filterable
            remote
            :remote-method="loadEquipmentOptions"
            :loading="equipmentLoading"
            placeholder="输入设备名称或编号检索"
            class="full-width"
            @change="handleEquipmentChange"
          >
            <el-option
              v-for="item in equipmentOptions"
              :key="item._id"
              :label="`${item.assetCode} · ${item.name}`"
              :value="item._id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="申请类型" required>
          <el-segmented v-model="createForm.applicationType" :options="createStatusOptions" />
          <p v-if="selectedSourceStatus" class="field-help">
            当前状态为“{{ equipmentStatusLabel(selectedSourceStatus) }}”，请选择其他目标状态。
          </p>
        </el-form-item>
        <el-form-item label="申请原因" required>
          <el-input
            v-model="createForm.reason"
            type="textarea"
            :rows="5"
            maxlength="5000"
            show-word-limit
            placeholder="请说明恢复在用、闲置、停用或报废原因"
          />
        </el-form-item>
        <el-form-item label="附件（最多10个，支持 JPG、PNG、PDF）">
          <el-upload v-model:file-list="createForm.files" :auto-upload="false" multiple :limit="10">
            <el-button>选择附件</el-button>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">提交申请</el-button>
      </template>
    </el-dialog>
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
import { ElMessage } from 'element-plus'
import { createEquipmentStatusApplication, getEquipmentList, getEquipmentDetail, getEquipmentStatusApplications } from '@/api/equipment'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { cleanupTemporaryFiles, prepareAttachmentReferences } from '@/utils/attachments'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { requestErrorMessage } from '@/utils/request'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import {
  STATUS_APPLICATION_TYPES,
  statusApplicationTypeLabel,
  statusApplicationWorkflowLabel,
  statusApplicationWorkflowTone
} from '@/utils/equipmentStatusApplication'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const rows = ref([])
const loading = ref(false)
const loadError = ref('')
const page = ref(1)
const lastLoadedPage = ref(1)
const failedPage = ref(null)
const pageSize = 20
const total = ref(0)
const createVisible = ref(false)
const submitting = ref(false)
const equipmentLoading = ref(false)
const equipmentOptions = ref([])
const selectedSourceStatus = ref('')
const selectedTeamId = ref(String(route.query.teamId || ''))
const filters = reactive({ applicationType: '', workflowStatus: '', todo: false })
const createForm = reactive(emptyCreateForm())
let listRequestId = 0
let equipmentRequestId = 0
let createRequestId = 0
let submitRequestId = 0
let pageActive = true
let wasDeactivated = false
let routeCreateToken = ''
let resumeListLoad = false
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.EQUIPMENT_STATUS_APPLICATIONS
})
const workflowOptions = [
  { value: 'DEPUTY_REVIEW_PENDING', label: '待副经理/经理助理审核' },
  { value: 'MANAGER_REVIEW_PENDING', label: '待部门经理终审' },
  { value: 'RETURNED_TO_CREATOR', label: '已退回发起人' },
  { value: 'APPROVED', label: '已通过' },
  { value: 'REJECTED', label: '已驳回' },
  { value: 'VOIDED', label: '已作废' }
]
const canCreate = computed(() => (
  session.can('equipment.status.apply', { write: true, teamRequired: true }) &&
  session.context.membership?.functionalRoleKeys?.includes('ASSET_ADMIN')
))
const accessNotice = computed(() => {
  const requirement = '发起条件：进入具体团队，并同时配置“设备管理员”和“状态申请”权限。'
  if (canCreate.value) return `当前账号可以发起申请。${requirement}`
  if (session.isGlobalReadOnly) return `当前为跨团队只读查看。${requirement}`
  if (session.hasPermission('equipment.status.approve')) {
    return `当前账号不能发起申请，可在“我的待办”处理分配给您的审核。${requirement}`
  }
  return `当前账号仅可查看。${requirement}`
})
const emptyDescription = computed(() => {
  if (loadError.value) return '状态申请加载失败，请重新加载'
  if (filters.todo) return '暂无需要您处理的状态申请'
  if (!canCreate.value) return '暂无状态申请，当前账号仅可查看'
  return '暂无状态申请，可发起一条新申请'
})
const createStatusOptions = computed(() => STATUS_APPLICATION_TYPES.map((item) => ({
  ...item,
  disabled: item.value === selectedSourceStatus.value
})))

function emptyCreateForm() {
  return { equipmentId: '', applicationType: 'IDLE', reason: '', files: [] }
}

const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const equipmentStatusLabel = (value) => ({
  IN_USE: '在用',
  IDLE: '闲置',
  STOPPED: '停用',
  SCRAPPED: '报废'
}[value] || value || '-')

function syncTargetStatus() {
  if (createForm.applicationType !== selectedSourceStatus.value) return
  createForm.applicationType = STATUS_APPLICATION_TYPES.find(
    (item) => item.value !== selectedSourceStatus.value
  )?.value || ''
}

function handleEquipmentChange(equipmentId) {
  selectedSourceStatus.value = equipmentOptions.value.find(
    (item) => String(item._id) === String(equipmentId || '')
  )?.status || ''
  syncTargetStatus()
}

const currentTeamContextId = () => String(
  session.isGlobalReadOnly ? selectedTeamId.value : session.activeTeamId || ''
)

function currentPageContext() {
  return {
    routeName: String(route.name || ''),
    routeTeamId: String(route.query.teamId || ''),
    contextEpoch: session.contextEpoch,
    teamId: currentTeamContextId()
  }
}

function isCurrentPageContext(context) {
  const current = currentPageContext()
  return pageActive &&
    current.routeName === 'EquipmentStatusApplications' &&
    current.routeName === context.routeName &&
    current.routeTeamId === context.routeTeamId &&
    current.contextEpoch === context.contextEpoch &&
    current.teamId === context.teamId
}

async function load() {
  const requestId = ++listRequestId
  const requestedPage = page.value
  const requestedTeamId = session.isGlobalReadOnly ? String(selectedTeamId.value || '') : ''
  const requestedContextTeamId = currentTeamContextId()
  const loadStartRevision = mutationRefresh.currentRevision()
  loadError.value = ''
  loading.value = true
  try {
    const result = await getEquipmentStatusApplications({
      page: page.value,
      pageSize,
      ...(requestedTeamId ? { teamId: requestedTeamId } : {}),
      ...(filters.applicationType ? { applicationType: filters.applicationType } : {}),
      ...(filters.workflowStatus ? { workflowStatus: filters.workflowStatus } : {}),
      ...(filters.todo ? { todo: true } : {})
    })
    if (
      !pageActive ||
      requestId !== listRequestId ||
      requestedTeamId !== (session.isGlobalReadOnly ? String(selectedTeamId.value || '') : '') ||
      requestedContextTeamId !== currentTeamContextId()
    ) return false
    rows.value = result.applications || []
    total.value = Number(result.total || 0)
    lastLoadedPage.value = requestedPage
    failedPage.value = null
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } catch (error) {
    if (
      !pageActive ||
      requestId !== listRequestId ||
      requestedContextTeamId !== currentTeamContextId()
    ) return false
    failedPage.value = requestedPage
    page.value = lastLoadedPage.value
    loadError.value = requestErrorMessage(error, '状态申请加载失败，请稍后重试')
    return false
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

async function loadEquipmentOptions(keyword = '') {
  const requestId = ++equipmentRequestId
  equipmentLoading.value = true
  try {
    const result = await getEquipmentList({ page: 1, pageSize: 100, keyword: keyword.trim() })
    if (requestId !== equipmentRequestId) return
    equipmentOptions.value = (result.equipment || []).filter((item) => item.status !== 'SCRAPPED')
  } finally {
    if (requestId === equipmentRequestId) equipmentLoading.value = false
  }
}

async function openCreate(equipmentId = '') {
  const requestId = ++createRequestId
  Object.assign(createForm, emptyCreateForm(), { equipmentId })
  equipmentOptions.value = []
  selectedSourceStatus.value = ''
  if (equipmentId) {
    const result = await getEquipmentDetail(equipmentId)
    if (!pageActive || requestId !== createRequestId) return
    equipmentOptions.value = [result.equipment]
    selectedSourceStatus.value = result.equipment?.status || ''
    syncTargetStatus()
  } else {
    await loadEquipmentOptions()
    if (!pageActive || requestId !== createRequestId) return
  }
  createVisible.value = true
}

function currentCreateToken() {
  if (route.name !== 'EquipmentStatusApplications' || route.query.create !== '1') return ''
  return `${String(route.query.create)}:${String(route.query.equipmentId || '')}`
}

async function syncRouteCreateAction() {
  if (!pageActive || route.name !== 'EquipmentStatusApplications') return
  const routedTeamId = session.isGlobalReadOnly ? String(route.query.teamId || '') : ''
  if (routedTeamId && routedTeamId !== selectedTeamId.value) {
    selectedTeamId.value = routedTeamId
    listRequestId += 1
    equipmentRequestId += 1
    createRequestId += 1
    submitRequestId += 1
    rows.value = []
    total.value = 0
    equipmentOptions.value = []
    selectedSourceStatus.value = ''
    equipmentLoading.value = false
    submitting.value = false
    createVisible.value = false
    await load()
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
  await openCreate(String(route.query.equipmentId || ''))
  if (!pageActive || currentCreateToken() !== token) return
  await router.replace({ query: { ...route.query, create: undefined, equipmentId: undefined } })
}

async function submitCreate() {
  if (submitting.value) return
  if (!createForm.equipmentId || !createForm.reason.trim()) {
    return ElMessage.warning('请选择设备并填写申请原因')
  }
  if (createForm.applicationType === selectedSourceStatus.value) {
    return ElMessage.warning('目标状态不能与设备当前状态相同')
  }
  const requestId = ++submitRequestId
  const context = currentPageContext()
  const detailQuery = session.isGlobalReadOnly && selectedTeamId.value
    ? { teamId: selectedTeamId.value }
    : {}
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(createForm.files, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    if (requestId !== submitRequestId || !isCurrentPageContext(context)) {
      await cleanupTemporaryFiles(uploadedFileIds, deleteFile)
      uploadedFileIds = []
      return
    }
    const result = await createEquipmentStatusApplication({
      equipmentId: createForm.equipmentId,
      applicationType: createForm.applicationType,
      reason: createForm.reason,
      attachments: prepared.references,
      idempotencyKey: globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random()}`
    })
    uploadedFileIds = []
    if (requestId !== submitRequestId || !isCurrentPageContext(context)) return
    createVisible.value = false
    ElMessage.success('状态申请已提交')
    await router.push({
      name: 'EquipmentStatusApplicationDetail',
      params: { applicationId: result.application._id },
      query: detailQuery
    })
  } catch (error) {
    await cleanupTemporaryFiles(
      [...uploadedFileIds, ...(error.uploadedFileIds || [])],
      deleteFile
    )
    if (requestId === submitRequestId && isCurrentPageContext(context)) {
      console.error('设备状态申请提交失败:', error)
      ElMessage.error(requestErrorMessage(error, '设备状态申请提交失败，请稍后重试'))
    }
  } finally {
    if (requestId === submitRequestId) submitting.value = false
  }
}

const openDetail = (row) => router.push({
  name: 'EquipmentStatusApplicationDetail',
  params: { applicationId: row._id },
  query: session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
})

async function handleFilterChange() {
  page.value = 1
  lastLoadedPage.value = 1
  failedPage.value = null
  rows.value = []
  total.value = 0
  await load()
}

async function handlePageChange() {
  await load()
}

async function retryLoad() {
  page.value = failedPage.value || page.value
  await load()
}

async function handleTeamChange(teamId) {
  ++listRequestId
  ++equipmentRequestId
  ++createRequestId
  ++submitRequestId
  loading.value = false
  equipmentLoading.value = false
  submitting.value = false
  createVisible.value = false
  page.value = 1
  lastLoadedPage.value = 1
  failedPage.value = null
  rows.value = []
  total.value = 0
  loadError.value = ''
  await router.replace({ query: { ...route.query, teamId: teamId || undefined } })
  if (String(teamId || '') !== String(selectedTeamId.value || '')) return
  await load()
}

watch(() => [route.name, route.query.teamId, route.query.create, route.query.equipmentId], () => {
  if (pageActive) void syncRouteCreateAction()
})
watch(() => session.contextEpoch, () => {
  listRequestId += 1
  equipmentRequestId += 1
  createRequestId += 1
  submitRequestId += 1
  rows.value = []
  total.value = 0
  loading.value = false
  equipmentLoading.value = false
  submitting.value = false
  createVisible.value = false
  if (pageActive) void load()
})

onMounted(async () => {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await load()
  await syncRouteCreateAction()
})

onActivated(() => {
  pageActive = true
  if (!wasDeactivated) return
  wasDeactivated = false
  routeCreateToken = ''
  const reloadList = resumeListLoad
  resumeListLoad = false
  void syncRouteCreateAction().then(() => (
    reloadList ? load() : Promise.resolve()
  )).then(() => mutationRefresh.refreshIfNeeded(load)).catch(() => {})
})
function deactivateStatusApplications() {
  resumeListLoad = resumeListLoad || loading.value
  pageActive = false
  wasDeactivated = true
  listRequestId += 1
  equipmentRequestId += 1
  createRequestId += 1
  submitRequestId += 1
  loading.value = false
  equipmentLoading.value = false
  submitting.value = false
  createVisible.value = false
}

onDeactivated(deactivateStatusApplications)
onBeforeUnmount(deactivateStatusApplications)
</script>

<style scoped>
.status-applications-page { display: grid; gap: 18px; }
.page-heading, .filter-band { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-heading h1 { margin: 0; color: #1f2733; font-size: 25px; letter-spacing: 0; }
.page-heading p { margin: 6px 0 0; color: #667085; }
.status-guidance { display: grid; gap: 8px; }
.filter-band { justify-content: flex-start; flex-wrap: wrap; padding-block: 14px; border-block: 1px solid #dce4ee; }
.filter-band .el-select { width: 220px; }
.load-error { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.table-shell { min-width: 0; }
.equipment-name, .equipment-code { display: block; overflow-wrap: anywhere; }
.equipment-code { margin-top: 4px; color: #667085; font-size: 12px; }
.pagination { justify-content: flex-end; margin-top: 16px; }
.full-width { width: 100%; }
.field-help { margin: 8px 0 0; color: #667085; font-size: 12px; line-height: 1.5; }
@media (max-width: 720px) {
  .page-heading { align-items: flex-start; }
  .filter-band .el-select { width: 100%; }
  .load-error { grid-template-columns: minmax(0, 1fr); }
  .load-error .el-button { justify-self: start; }
  .pagination { width: 100%; justify-content: flex-start; overflow-x: auto; padding-bottom: 4px; }
}
</style>
