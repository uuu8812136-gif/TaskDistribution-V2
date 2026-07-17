<template>
  <div class="repair-page">
    <header class="page-heading">
      <div>
        <h1>设备维修</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
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
      <el-select v-model="filters.status" clearable placeholder="流程状态">
        <el-option v-for="(label, value) in REPAIR_STATUS_LABELS" :key="value" :label="label" :value="value" />
      </el-select>
      <el-checkbox v-if="session.isTeamMode" v-model="filters.todo">只看我的待办</el-checkbox>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button circle aria-label="刷新维修单" :loading="loading" @click="loadRepairs">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell">
      <el-table v-loading="loading" :data="repairs" row-key="_id" stripe empty-text="暂无维修记录">
        <el-table-column label="设备" min-width="190" fixed="left">
          <template #default="{ row }">
            <div class="asset-cell">
              <strong>{{ row.equipmentSnapshot?.name || '-' }}</strong>
              <span>{{ row.equipmentSnapshot?.assetCode || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" min-width="150">
          <template #default="{ row }">{{ repairTypeLabel(row.type) }}</template>
        </el-table-column>
        <el-table-column label="所属分部" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.equipmentSnapshot?.orgUnitName || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="190">
          <template #default="{ row }">
            <el-tag :type="repairStatusTone(row.status)" effect="light">
              {{ repairStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报修/维修日期" width="150">
          <template #default="{ row }">{{ displayDate(row.reportTime || row.repairDate) }}</template>
        </el-table-column>
        <el-table-column label="金额" width="110" align="right">
          <template #default="{ row }">{{ row.type === 'PARTS_REPAIR' ? `¥${row.totalAmount.toFixed(2)}` : '-' }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="172">
          <template #default="{ row }">{{ displayTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right" align="center">
          <template #default="{ row }">
            <el-button text type="primary" @click="openDetail(row)">
              {{ row.availableActions?.length ? '处理' : '详情' }}
            </el-button>
          </template>
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
      title="新建设备维修单"
      width="min(940px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="resetCreateForm"
    >
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <div class="form-grid">
          <el-form-item label="维修类型" prop="type" class="wide-field">
            <el-segmented v-model="createForm.type" :options="repairTypeSegments" block />
          </el-form-item>
          <el-form-item label="设备" prop="equipmentId" class="wide-field">
            <el-select v-model="createForm.equipmentId" filterable class="full-width" placeholder="输入设备编码或名称搜索">
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
              <el-input v-model="createForm.reportLocation" maxlength="500" />
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
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import {
  createEquipmentRepair,
  exportEquipmentRepairs,
  getEquipmentList,
  getEquipmentRepairs
} from '@/api/equipment'
import { deleteFile, getFileMetadata, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import { prepareAttachmentReferences } from '@/utils/attachments'
import {
  REPAIR_STATUS_LABELS,
  REPAIR_TYPE_OPTIONS,
  emptyRepairPart,
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel,
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
const createFormRef = ref(null)
const photoFileList = ref([])
const selectedTeamId = ref(String(route.query.teamId || ''))

const filters = reactive({ keyword: '', type: '', status: '', todo: false, page: 1, pageSize: 20 })
const createForm = reactive(emptyCreateForm())
const canCreate = computed(() => session.can('equipment.repair', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('equipment.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const repairTypeSegments = REPAIR_TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value }))

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

function listParams(extra = {}) {
  return {
    ...requestTeamParams.value,
    keyword: filters.keyword.trim() || undefined,
    type: filters.type || undefined,
    status: filters.status || undefined,
    todo: filters.todo || undefined,
    page: filters.page,
    pageSize: filters.pageSize,
    ...extra
  }
}

async function loadRepairs() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    repairs.value = []
    total.value = 0
    return
  }
  loading.value = true
  try {
    const result = await getEquipmentRepairs(listParams())
    repairs.value = result.repairs || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

async function loadEquipmentOptions() {
  if (!session.isTeamMode) return
  const result = await getEquipmentList({ page: 1, pageSize: 200 })
  equipmentOptions.value = result.equipment || []
}

function applyFilters() {
  filters.page = 1
  loadRepairs()
}

function resetFilters() {
  Object.assign(filters, { keyword: '', type: '', status: '', todo: false, page: 1 })
  loadRepairs()
}

function handleTeamChange() {
  filters.page = 1
  router.replace({ query: selectedTeamId.value ? { teamId: selectedTeamId.value } : {} })
  loadRepairs()
}

function openCreate() {
  const requestedEquipmentId = String(route.query.equipmentId || '')
  if (requestedEquipmentId && equipmentOptions.value.some((item) => item._id === requestedEquipmentId)) {
    createForm.equipmentId = requestedEquipmentId
  }
  createVisible.value = true
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
    ElMessage.error(error.message || '维修单提交失败')
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
  exporting.value = true
  try {
    const blob = await exportEquipmentRepairs(listParams({ page: undefined, pageSize: undefined, todo: undefined }))
    saveRepairWorkbook(blob)
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadRepairs(), loadEquipmentOptions()])
  if (route.query.create === '1' && canCreate.value) openCreate()
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
.toolbar-spacer { flex: 1; }
.table-shell { overflow: hidden; border: 1px solid #dce4ee; border-radius: 6px; background: #fff; }
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
  .toolbar-spacer { display: none; }
  .form-grid { grid-template-columns: 1fr; }
  .wide-field { grid-column: auto; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
}
</style>
