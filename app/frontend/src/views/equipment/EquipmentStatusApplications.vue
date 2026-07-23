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

    <div class="filter-band">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-select v-model="filters.applicationType" clearable placeholder="申请类型" @change="load">
        <el-option v-for="item in STATUS_APPLICATION_TYPES" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.workflowStatus" clearable placeholder="流程状态" @change="load">
        <el-option v-for="item in workflowOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-checkbox v-model="filters.todo" border @change="load">只看我的待办</el-checkbox>
      <el-button circle :loading="loading" aria-label="刷新" @click="load">
        <el-icon><Refresh /></el-icon>
      </el-button>
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
      </el-table>
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        :pager-count="5"
        layout="prev, pager, next, total"
        @current-change="load"
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
          <el-segmented v-model="createForm.applicationType" :options="STATUS_APPLICATION_TYPES" />
        </el-form-item>
        <el-form-item label="申请原因" required>
          <el-input v-model="createForm.reason" type="textarea" :rows="5" maxlength="5000" show-word-limit />
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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { createEquipmentStatusApplication, getEquipmentList, getEquipmentDetail, getEquipmentStatusApplications } from '@/api/equipment'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { cleanupTemporaryFiles, prepareAttachmentReferences } from '@/utils/attachments'
import { requestErrorMessage } from '@/utils/request'
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
const page = ref(1)
const pageSize = 20
const total = ref(0)
const createVisible = ref(false)
const submitting = ref(false)
const equipmentLoading = ref(false)
const equipmentOptions = ref([])
const selectedTeamId = ref(String(route.query.teamId || ''))
const filters = reactive({ applicationType: '', workflowStatus: '', todo: false })
const createForm = reactive(emptyCreateForm())
let listRequestId = 0
let equipmentRequestId = 0
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

function emptyCreateForm() {
  return { equipmentId: '', applicationType: 'IDLE', reason: '', files: [] }
}

const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

async function load() {
  const requestId = ++listRequestId
  loading.value = true
  try {
    const result = await getEquipmentStatusApplications({
      page: page.value,
      pageSize,
      ...(session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}),
      ...(filters.applicationType ? { applicationType: filters.applicationType } : {}),
      ...(filters.workflowStatus ? { workflowStatus: filters.workflowStatus } : {}),
      ...(filters.todo ? { todo: true } : {})
    })
    if (requestId !== listRequestId) return
    rows.value = result.applications || []
    total.value = Number(result.total || 0)
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
  Object.assign(createForm, emptyCreateForm(), { equipmentId })
  equipmentOptions.value = []
  if (equipmentId) {
    const result = await getEquipmentDetail(equipmentId)
    equipmentOptions.value = [result.equipment]
  } else {
    await loadEquipmentOptions()
  }
  createVisible.value = true
}

async function submitCreate() {
  if (!createForm.equipmentId || !createForm.reason.trim()) {
    return ElMessage.warning('请选择设备并填写申请原因')
  }
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(createForm.files, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    const result = await createEquipmentStatusApplication({
      equipmentId: createForm.equipmentId,
      applicationType: createForm.applicationType,
      reason: createForm.reason,
      attachments: prepared.references,
      idempotencyKey: globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random()}`
    })
    uploadedFileIds = []
    createVisible.value = false
    ElMessage.success('状态申请已提交')
    await router.push({ name: 'EquipmentStatusApplicationDetail', params: { applicationId: result.application._id } })
  } catch (error) {
    await cleanupTemporaryFiles(uploadedFileIds, deleteFile)
    console.error('设备状态申请提交失败:', error)
    ElMessage.error(requestErrorMessage(error, '设备状态申请提交失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

const openDetail = (row) => router.push({
  name: 'EquipmentStatusApplicationDetail',
  params: { applicationId: row._id },
  query: session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
})

async function handleTeamChange(teamId) {
  page.value = 1
  await router.replace({ query: { ...route.query, teamId: teamId || undefined } })
  await load()
}

watch(() => route.query.create, async (value) => {
  if (value === '1' && canCreate.value) await openCreate(String(route.query.equipmentId || ''))
})

onMounted(async () => {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await load()
  if (route.query.create === '1' && canCreate.value) await openCreate(String(route.query.equipmentId || ''))
})
</script>

<style scoped>
.status-applications-page { display: grid; gap: 18px; }
.page-heading, .filter-band { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-heading h1 { margin: 0; color: #1f2733; font-size: 25px; letter-spacing: 0; }
.page-heading p { margin: 6px 0 0; color: #667085; }
.filter-band { justify-content: flex-start; flex-wrap: wrap; padding-block: 14px; border-block: 1px solid #dce4ee; }
.filter-band .el-select { width: 220px; }
.table-shell { min-width: 0; }
.equipment-name, .equipment-code { display: block; overflow-wrap: anywhere; }
.equipment-code { margin-top: 4px; color: #667085; font-size: 12px; }
.pagination { justify-content: flex-end; margin-top: 16px; }
.full-width { width: 100%; }
@media (max-width: 720px) {
  .page-heading { align-items: flex-start; }
  .filter-band .el-select { width: 100%; }
  .pagination { width: 100%; justify-content: flex-start; overflow-x: auto; padding-bottom: 4px; }
}
</style>
