<template>
  <div class="report-page">
    <header class="page-heading">
      <div>
        <h1>运输提报</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button @click="openSummary">
          <el-icon><DataAnalysis /></el-icon>
          司机月汇总
        </el-button>
        <el-button v-if="canSubmit" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建提报
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
      <el-date-picker
        v-model="filters.dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        range-separator="至"
        class="date-range"
      />
      <el-input
        v-model="filters.keyword"
        clearable
        class="keyword-input"
        placeholder="搜索司机、路线、车牌或趟次"
        @keyup.enter="applyFilters"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.orgUnitId" clearable filterable placeholder="所属组织">
        <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
      </el-select>
      <el-select v-model="filters.shift" clearable placeholder="班次">
        <el-option v-for="item in TRANSPORT_SHIFT_OPTIONS" :key="item" :label="item" :value="item" />
      </el-select>
      <el-select v-model="filters.dispatchType" clearable placeholder="出车类型">
        <el-option v-for="item in TRANSPORT_DISPATCH_OPTIONS" :key="item" :label="item" :value="item" />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button :loading="loading" circle aria-label="刷新运输提报" @click="loadRecords">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell">
      <el-table v-loading="loading" :data="records" row-key="_id" stripe empty-text="暂无运输提报">
        <el-table-column prop="reportDate" label="日期" width="112" fixed="left" />
        <el-table-column prop="driverName" label="司机" min-width="110" />
        <el-table-column prop="vehiclePlate" label="车牌号" min-width="120" />
        <el-table-column prop="route" label="路线" min-width="160" show-overflow-tooltip />
        <el-table-column prop="tripLabel" label="趟次" min-width="90" />
        <el-table-column prop="shift" label="班次" width="82" />
        <el-table-column prop="dispatchType" label="类型" width="82" />
        <el-table-column label="所属组织" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ orgName(row.orgUnitId) }}</template>
        </el-table-column>
        <el-table-column prop="loadTotal" label="装载合计" width="100" align="right" />
        <el-table-column label="照片" width="74" align="center">
          <template #default="{ row }">{{ row.photoFileIds?.length || 0 }}</template>
        </el-table-column>
        <el-table-column label="操作" width="142" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button text type="primary" @click="goDetail(row)">详情</el-button>
              <el-button v-if="canSubmit" text type="primary" @click="openEdit(row._id)">编辑</el-button>
            </div>
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
        @change="loadRecords"
      />
    </footer>

    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑运输提报' : '新建运输提报'"
      width="min(920px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
        <div class="form-grid">
          <el-form-item label="所属组织" prop="orgUnitId">
            <el-select v-model="form.orgUnitId" filterable class="full-width">
              <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item label="提报日期" prop="reportDate">
            <el-date-picker v-model="form.reportDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
          </el-form-item>
          <el-form-item label="班次" prop="shift">
            <el-select v-model="form.shift" class="full-width">
              <el-option v-for="item in TRANSPORT_SHIFT_OPTIONS" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item label="趟次" prop="tripLabel">
            <el-input v-model="form.tripLabel" maxlength="50" placeholder="例如：第1趟" />
          </el-form-item>
          <el-form-item label="路线" prop="route">
            <el-input v-model="form.route" maxlength="200" />
          </el-form-item>
          <el-form-item label="出车类型" prop="dispatchType">
            <el-segmented v-model="form.dispatchType" :options="TRANSPORT_DISPATCH_OPTIONS" block />
          </el-form-item>
          <el-form-item label="车牌号" prop="vehiclePlate">
            <el-input v-model="form.vehiclePlate" maxlength="50" />
          </el-form-item>
          <el-form-item label="车型">
            <el-input v-model="form.vehicleType" maxlength="100" />
          </el-form-item>
          <el-form-item label="司机姓名" prop="driverName">
            <el-input v-model="form.driverName" maxlength="100" />
          </el-form-item>
        </div>

        <div class="form-section-heading">
          <h3>装载明细</h3>
          <span>合计 {{ formLoadTotal }}</span>
        </div>
        <div class="quantity-grid">
          <el-form-item v-for="item in TRANSPORT_LOAD_FIELDS" :key="item.key" :label="item.label">
            <el-input-number
              v-model="form.loadDetails[item.key]"
              :min="0"
              :max="2147483647"
              :precision="0"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
        </div>

        <el-form-item label="现场照片（2-10张）" required>
          <el-upload
            v-model:file-list="photoFileList"
            :auto-upload="false"
            :limit="10"
            accept="image/*"
            list-type="text"
            :on-change="handlePhotoChange"
            :on-preview="previewPhoto"
            :on-exceed="handlePhotoExceed"
          >
            <el-button>
              <el-icon><Upload /></el-icon>
              选择照片
            </el-button>
          </el-upload>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="2000" show-word-limit />
        </el-form-item>
        <el-form-item v-if="editingId" label="修改说明">
          <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="summaryVisible" title="司机月汇总" width="min(1040px, 96vw)" append-to-body>
      <div class="summary-toolbar">
        <el-date-picker v-model="summaryMonth" type="month" value-format="YYYY-MM" placeholder="选择月份" />
        <el-button type="primary" :loading="summaryLoading" @click="loadSummary">生成汇总</el-button>
        <el-button v-if="canExport" :loading="exporting" @click="handleSummaryExport">
          <el-icon><Download /></el-icon>
          导出 Excel
        </el-button>
      </div>
      <div class="table-shell summary-table">
        <el-table v-loading="summaryLoading" :data="summaryRows" row-key="key" empty-text="该月暂无运输数据">
          <el-table-column prop="driverName" label="司机" min-width="100" fixed="left" />
          <el-table-column prop="route" label="路线" min-width="150" show-overflow-tooltip />
          <el-table-column prop="vehiclePlate" label="车牌号" min-width="110" />
          <el-table-column prop="vehicleType" label="车型" min-width="100" />
          <el-table-column prop="dispatchType" label="类型" width="80" />
          <el-table-column label="每日趟次" min-width="260" show-overflow-tooltip>
            <template #default="{ row }">{{ dailyCountText(row) }}</template>
          </el-table-column>
          <el-table-column prop="totalTrips" label="趟数合计" width="100" align="right" />
          <el-table-column label="备注" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.remarks.join('；') || '-' }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="照片预览" width="min(760px, 94vw)" append-to-body @closed="clearPreview">
      <img v-if="previewUrl" :src="previewUrl" :alt="previewName" class="preview-image" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import {
  createTransportRecord,
  exportTransportSummary,
  getTransportOptions,
  getTransportRecord,
  getTransportRecords,
  updateTransportRecord
} from '@/api/reporting'
import {
  deleteFile,
  downloadFileBlob,
  getFileMetadata,
  uploadTemporaryFile
} from '@/api/file'
import { useSessionStore } from '@/stores/session'
import {
  cleanupTemporaryFiles,
  managedFileId,
  prepareAttachmentReferences
} from '@/utils/attachments'
import {
  TRANSPORT_DISPATCH_OPTIONS,
  TRANSPORT_LOAD_FIELDS,
  TRANSPORT_SHIFT_OPTIONS,
  aggregateDriverMonthly,
  buildTransportPayload,
  dailyCountText,
  emptyTransportLoadDetails,
  entityName,
  naturalMonthRange,
  saveBlob
} from '@/utils/reporting'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const records = ref([])
const orgUnits = ref([])
const total = ref(0)
const loading = ref(false)
const submitting = ref(false)
const exporting = ref(false)
const formVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const photoFileList = ref([])
const selectedTeamId = ref(String(route.query.teamId || ''))
const summaryVisible = ref(false)
const summaryMonth = ref(dayjs().format('YYYY-MM'))
const summaryRows = ref([])
const summaryLoading = ref(false)
const previewVisible = ref(false)
const previewUrl = ref('')
const previewName = ref('')

const filters = reactive({
  dateRange: [],
  keyword: '',
  orgUnitId: '',
  shift: '',
  dispatchType: '',
  page: 1,
  pageSize: 20
})
const form = reactive(emptyForm())

const canSubmit = computed(() => session.can('report.submit', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('report.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const formLoadTotal = computed(() => TRANSPORT_LOAD_FIELDS.reduce(
  (sum, { key }) => sum + (Number(form.loadDetails[key]) || 0),
  0
))

const rules = {
  orgUnitId: [{ required: true, message: '请选择所属组织', trigger: 'change' }],
  reportDate: [{ required: true, message: '请选择提报日期', trigger: 'change' }],
  shift: [{ required: true, message: '请选择班次', trigger: 'change' }],
  tripLabel: [{ required: true, message: '请输入趟次', trigger: 'blur' }],
  route: [{ required: true, message: '请输入路线', trigger: 'blur' }],
  dispatchType: [{ required: true, message: '请选择出车类型', trigger: 'change' }],
  vehiclePlate: [{ required: true, message: '请输入车牌号', trigger: 'blur' }],
  driverName: [{ required: true, message: '请输入司机姓名', trigger: 'blur' }]
}

function emptyForm() {
  return {
    orgUnitId: '',
    reportDate: dayjs().format('YYYY-MM-DD'),
    shift: '白班',
    tripLabel: '',
    route: '',
    dispatchType: '配送',
    vehiclePlate: '',
    vehicleType: '',
    driverName: '',
    loadDetails: emptyTransportLoadDetails(),
    remark: '',
    reason: ''
  }
}

const orgName = (id) => entityName(orgUnits.value, id, id ? `组织 ${id.slice(-6)}` : '-')

function recordParams(extra = {}) {
  return {
    ...requestTeamParams.value,
    dateFrom: filters.dateRange?.[0] || undefined,
    dateTo: filters.dateRange?.[1] || undefined,
    keyword: filters.keyword.trim() || undefined,
    orgUnitId: filters.orgUnitId || undefined,
    shift: filters.shift || undefined,
    dispatchType: filters.dispatchType || undefined,
    ...extra
  }
}

async function loadOptions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getTransportOptions(requestTeamParams.value)
  orgUnits.value = result.orgUnits || []
}

async function loadRecords() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  loading.value = true
  try {
    const result = await getTransportRecords(recordParams({
      page: filters.page,
      pageSize: filters.pageSize
    }))
    records.value = result.transportRecords || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await Promise.all([loadOptions(), loadRecords()])
  if (route.query.edit && canSubmit.value) await openEdit(String(route.query.edit))
}

function applyFilters() {
  filters.page = 1
  loadRecords()
}

function resetFilters() {
  Object.assign(filters, {
    dateRange: [], keyword: '', orgUnitId: '', shift: '', dispatchType: '', page: 1
  })
  loadRecords()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: { teamId } })
  Object.assign(filters, {
    dateRange: [], keyword: '', orgUnitId: '', shift: '', dispatchType: '', page: 1
  })
  await Promise.all([loadOptions(), loadRecords()])
}

function resetForm() {
  editingId.value = ''
  Object.assign(form, emptyForm())
  photoFileList.value = []
  formRef.value?.clearValidate()
}

function openCreate() {
  resetForm()
  if (orgUnits.value.length === 1) form.orgUnitId = orgUnits.value[0]._id
  formVisible.value = true
}

async function openEdit(transportRecordId) {
  const result = await getTransportRecord(transportRecordId, requestTeamParams.value)
  const record = result.transportRecord
  const metadata = await Promise.all(record.photoFileIds.map(async (fileId) => {
    const response = await getFileMetadata(fileId, requestTeamParams.value.teamId)
    return response.file
  }))
  editingId.value = record._id
  Object.assign(form, {
    ...emptyForm(),
    ...record,
    loadDetails: { ...emptyTransportLoadDetails(), ...record.loadDetails },
    reason: ''
  })
  photoFileList.value = metadata.map((file) => ({
    uid: file._id,
    fileId: file._id,
    name: file.originalName,
    size: file.size,
    mimeType: file.mimeType,
    status: 'success'
  }))
  formVisible.value = true
}

function handlePhotoChange(file, fileList) {
  if (!file.raw) return
  const isImage = file.raw.type?.startsWith('image/')
  if (!isImage) {
    ElMessage.warning('现场照片只能选择图片文件')
    photoFileList.value = fileList.filter((item) => item.uid !== file.uid)
  }
}

function handlePhotoExceed() {
  ElMessage.warning('现场照片最多上传10张')
}

function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewName.value = ''
}

async function previewPhoto(file) {
  clearPreview()
  previewName.value = file.name || '现场照片'
  if (file.raw) previewUrl.value = URL.createObjectURL(file.raw)
  else {
    const fileId = managedFileId(file)
    if (!fileId) return
    const blob = await downloadFileBlob(fileId, requestTeamParams.value.teamId)
    previewUrl.value = URL.createObjectURL(blob)
  }
  previewVisible.value = true
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (photoFileList.value.length < 2 || photoFileList.value.length > 10) {
    ElMessage.warning('请上传2至10张现场照片')
    return
  }
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(photoFileList.value, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    const payload = buildTransportPayload(
      form,
      prepared.references.map(({ fileId }) => fileId)
    )
    if (editingId.value) await updateTransportRecord(editingId.value, payload)
    else await createTransportRecord(payload)
    uploadedFileIds = []
    ElMessage.success(editingId.value ? '运输提报已更新' : '运输提报已创建')
    formVisible.value = false
    await loadRecords()
  } catch (error) {
    await cleanupTemporaryFiles(
      [...uploadedFileIds, ...(error.uploadedFileIds || [])],
      deleteFile
    )
    throw error
  } finally {
    submitting.value = false
  }
}

function goDetail(record) {
  router.push({
    name: 'TransportRecordDetail',
    params: { id: record._id },
    query: requestTeamParams.value
  })
}

async function openSummary() {
  summaryVisible.value = true
  await loadSummary()
}

async function loadSummary() {
  if (!summaryMonth.value) return
  summaryLoading.value = true
  try {
    const range = naturalMonthRange(summaryMonth.value)
    const base = recordParams({ ...range, dateFrom: range.dateFrom, dateTo: range.dateTo })
    const first = await getTransportRecords({ ...base, page: 1, pageSize: 200 })
    const all = [...(first.transportRecords || [])]
    const pages = Math.ceil((first.total || 0) / 200)
    for (let page = 2; page <= pages; page += 1) {
      const result = await getTransportRecords({ ...base, page, pageSize: 200 })
      all.push(...(result.transportRecords || []))
    }
    summaryRows.value = aggregateDriverMonthly(all)
  } finally {
    summaryLoading.value = false
  }
}

async function handleSummaryExport() {
  if (!summaryMonth.value) return
  exporting.value = true
  try {
    const blob = await exportTransportSummary(recordParams({ month: summaryMonth.value }))
    saveBlob(blob, `运输司机月汇总-${summaryMonth.value}.xlsx`)
  } finally {
    exporting.value = false
  }
}

onMounted(initialize)
onBeforeUnmount(clearPreview)
</script>

<style scoped lang="scss">
.report-page { min-width: 0; }
.page-heading, .heading-actions, .toolbar, .pagination-row, .summary-toolbar, .form-section-heading { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #909399; }
.heading-actions, .summary-toolbar { gap: 8px; }
.toolbar { flex-wrap: wrap; gap: 8px; padding: 14px 0; border-block: 1px solid var(--zl-border-soft); }
.toolbar .el-select { width: 140px; }
.toolbar .team-select { width: 190px; }
.date-range { width: 250px; }
.keyword-input { width: min(280px, 100%); }
.toolbar-spacer { flex: 1; }
.table-shell { margin-top: 16px; overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.table-actions { justify-content: center; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; }
.quantity-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; }
.full-width { width: 100%; }
.form-section-heading { justify-content: space-between; margin: 8px 0 2px; }
.form-section-heading h3 { font-size: 16px; letter-spacing: 0; }
.form-section-heading span { color: #606266; }
.summary-toolbar { flex-wrap: wrap; margin-bottom: 14px; }
.summary-table { margin-top: 0; }
.preview-image { display: block; max-width: 100%; max-height: 72vh; margin: 0 auto; object-fit: contain; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-actions { flex-wrap: wrap; justify-content: flex-start; }
  .toolbar > *, .toolbar .el-select, .toolbar .team-select, .date-range, .keyword-input { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .form-grid, .quantity-grid { grid-template-columns: 1fr; }
  .summary-toolbar > * { width: 100%; }
}
</style>
