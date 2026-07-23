<template>
  <el-dialog
    v-model="visible"
    title="设备台账 Excel 导入"
    width="min(1180px, 97vw)"
    append-to-body
    :destroy-on-close="false"
    :before-close="requestClose"
  >
    <div class="import-content">
      <template v-if="!importJob">
        <section class="upload-band">
          <el-upload
            v-model:file-list="uploadList"
            :auto-upload="false"
            :limit="1"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            :on-change="handleFileChange"
            :on-exceed="handleFileExceed"
          >
            <el-button>
              <el-icon><FolderOpened /></el-icon>
              选择 Excel
            </el-button>
          </el-upload>
          <el-button
            type="primary"
            :loading="previewing"
            :disabled="!selectedFile"
            @click="createPreview"
          >
            <el-icon><View /></el-icon>
            生成导入预览
          </el-button>
        </section>
        <section v-if="previewing" class="processing-band" aria-live="polite">
          <el-progress :percentage="uploadPercentage" :status="uploadPercentage === 100 ? 'success' : ''" />
          <el-steps :active="processingStep" finish-status="success" align-center>
            <el-step title="上传" />
            <el-step title="解析" />
            <el-step title="写入" />
          </el-steps>
          <strong>{{ processingLabel }}</strong>
        </section>
      </template>

      <template v-else>
        <section class="job-heading">
          <div>
            <h3>{{ importJob.sourceFileName }}</h3>
            <p>{{ formatFileSize(importJob.sourceFileSize) }} · {{ scopeLabel }}</p>
          </div>
          <div class="job-actions">
            <el-tag :type="importJob.status === 'PUBLISHED' ? 'success' : 'warning'" effect="plain" size="large">
              {{ importJob.status === 'PUBLISHED' ? '已发布' : '待确认' }}
            </el-tag>
            <el-tooltip content="刷新任务状态" placement="top">
              <el-button circle :loading="refreshing" aria-label="刷新导入任务状态" @click="refreshJob">
                <el-icon><Refresh /></el-icon>
              </el-button>
            </el-tooltip>
            <el-button :loading="cancelling" @click="startNewImport">
              <el-icon><Plus /></el-icon>
              新建导入
            </el-button>
          </div>
        </section>

        <el-alert
          v-if="importJob.status === 'PREVIEW_READY'"
          title="预览已生成，设备台账尚未发布"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else
          :title="`发布完成：新增 ${importJob.publishedRows} 条，跳过 ${importJob.skippedRows} 条`"
          type="success"
          :closable="false"
          show-icon
        />

        <section class="summary-band">
          <div><span>工作表</span><strong>{{ importJob.sourceSheetNames.length }}</strong></div>
          <div><span>总行数</span><strong>{{ importJob.totalRows }}</strong></div>
          <div><span>有效行</span><strong class="success-text">{{ importJob.validRows }}</strong></div>
          <div><span>警告行</span><strong class="warning-text">{{ importJob.warningRows }}</strong></div>
          <div><span>错误行</span><strong class="danger-text">{{ importJob.errorRows }}</strong></div>
          <div><span>异常项</span><strong>{{ exceptionTotal }}</strong></div>
        </section>

        <section class="sheet-row">
          <span>Sheet</span>
          <el-tag v-for="sheet in importJob.sourceSheetNames" :key="sheet" effect="plain">{{ sheet }}</el-tag>
        </section>

        <el-tabs v-model="activeTab" class="import-tabs">
          <el-tab-pane label="预览数据" name="rows">
            <div class="table-shell preview-table-shell">
              <el-table
                v-loading="rowsLoading"
                :data="importJob.rows || []"
                class="preview-table"
                row-key="rowId"
                stripe
                empty-text="暂无预览行"
              >
                <el-table-column prop="sheetName" label="Sheet" min-width="120" fixed="left" show-overflow-tooltip />
                <el-table-column prop="rowNumber" label="行号" width="72" />
                <el-table-column label="校验" width="84">
                  <template #default="{ row }">
                    <el-tag :type="rowStatusOption(row.validationStatus).type" effect="plain" size="small">
                      {{ rowStatusOption(row.validationStatus).label }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column
                  v-for="column in IMPORT_PREVIEW_COLUMNS"
                  :key="column.key"
                  :label="column.label"
                  :width="column.width"
                  :min-width="column.minWidth"
                  :align="column.align || 'left'"
                  show-overflow-tooltip
                >
                  <template #default="{ row }">
                    <el-tag
                      v-if="column.key === 'issueCount' && previewFieldValue(row, column.key) > 0"
                      type="warning"
                      effect="plain"
                      size="small"
                    >
                      {{ previewFieldValue(row, column.key) }}
                    </el-tag>
                    <span v-else>{{ previewFieldValue(row, column.key) }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
            <el-pagination
              v-if="importJob.totalRows > rowPageSize"
              v-model:current-page="rowPage"
              :page-size="rowPageSize"
              :total="importJob.totalRows"
              layout="prev, pager, next"
              class="table-pagination"
              @current-change="loadRows"
            />
          </el-tab-pane>

          <el-tab-pane :label="`异常清单 (${exceptionTotal})`" name="exceptions">
            <div class="table-shell exception-table">
              <el-table v-loading="exceptionsLoading" :data="exceptions" row-key="_id" empty-text="暂无异常">
                <el-table-column prop="sheetName" label="Sheet" min-width="110" fixed="left" show-overflow-tooltip />
                <el-table-column prop="rowNumber" label="行号" width="68" />
                <el-table-column label="级别" width="78">
                  <template #default="{ row }">
                    <el-tag :type="row.severity === 'ERROR' ? 'danger' : 'warning'" effect="plain" size="small">
                      {{ row.severity === 'ERROR' ? '错误' : '警告' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="assetCode" label="资产编号" min-width="120" show-overflow-tooltip />
                <el-table-column label="异常字段" min-width="105">
                  <template #default="{ row }">{{ equipmentImportFieldLabel(row.field) }}</template>
                </el-table-column>
                <el-table-column label="异常类型" min-width="155" show-overflow-tooltip>
                  <template #default="{ row }">{{ equipmentImportExceptionLabel(row.exceptionType) }}</template>
                </el-table-column>
                <el-table-column label="原始值" min-width="130" show-overflow-tooltip>
                  <template #default="{ row }">{{ equipmentImportOriginalValue(row) }}</template>
                </el-table-column>
                <el-table-column label="建议处理" min-width="190" show-overflow-tooltip>
                  <template #default="{ row }">{{ equipmentImportSuggestedAction(row) }}</template>
                </el-table-column>
                <el-table-column v-if="importJob.status === 'PREVIEW_READY'" label="客户决定" min-width="190">
                  <template #default="{ row }">
                    <el-select
                      v-model="decisionState[row._id].action"
                      placeholder="请选择"
                      class="decision-select"
                      @change="handleDecisionChange(row)"
                    >
                      <el-option
                        v-for="item in equipmentImportDecisionOptions(row)"
                        :key="item.value"
                        :label="item.label"
                        :value="item.value"
                      />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column v-if="importJob.status === 'PREVIEW_READY'" label="修正值" min-width="210">
                  <template #default="{ row }">
                    <template v-if="decisionState[row._id].action === IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE">
                      <el-select
                        v-if="row.field === 'orgUnitId'"
                        v-model="decisionState[row._id].value"
                        filterable
                        class="resolved-editor"
                      >
                        <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
                      </el-select>
                      <el-select
                        v-else-if="row.field === 'categoryId'"
                        v-model="decisionState[row._id].value"
                        filterable
                        class="resolved-editor"
                      >
                        <el-option v-for="item in activeCategories" :key="item._id" :label="item.name" :value="item._id" />
                      </el-select>
                      <el-select
                        v-else-if="row.field === 'custodianUserId'"
                        v-model="decisionState[row._id].value"
                        clearable
                        filterable
                        class="resolved-editor"
                      >
                        <el-option v-for="item in scopedCustodians(row)" :key="item._id" :label="item.name" :value="item._id" />
                      </el-select>
                      <el-select
                        v-else-if="row.field === 'status'"
                        v-model="decisionState[row._id].value"
                        class="resolved-editor"
                      >
                        <el-option v-for="item in EQUIPMENT_STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
                      </el-select>
                      <el-date-picker
                        v-else-if="row.field === 'acquisitionDate'"
                        v-model="decisionState[row._id].value"
                        type="date"
                        value-format="YYYY-MM-DD"
                        class="resolved-editor"
                      />
                      <el-input-number
                        v-else-if="['quantity', 'originalValue'].includes(row.field)"
                        v-model="decisionState[row._id].value"
                        :min="0"
                        controls-position="right"
                        class="resolved-editor"
                      />
                      <el-input v-else v-model="decisionState[row._id].value" maxlength="500" />
                    </template>
                    <span v-else-if="decisionState[row._id].action === IMPORT_DECISION_ACTIONS.ACCEPT_SUGGESTION">
                      {{ formatEquipmentImportValue(row.suggestedValue) }}
                    </span>
                    <el-tag v-else-if="decisionState[row._id].action === IMPORT_DECISION_ACTIONS.SKIP_ROW" type="info" effect="plain">
                      整行跳过
                    </el-tag>
                    <span v-else>-</span>
                  </template>
                </el-table-column>
                <el-table-column v-else label="处理状态" min-width="110">
                  <template #default="{ row }">{{ exceptionStatusLabel(row.status) }}</template>
                </el-table-column>
              </el-table>
            </div>
            <el-pagination
              v-if="exceptionTotal > exceptionPageSize"
              v-model:current-page="exceptionPage"
              :page-size="exceptionPageSize"
              :total="exceptionTotal"
              layout="prev, pager, next"
              class="table-pagination"
              @current-change="loadExceptions"
            />
          </el-tab-pane>
        </el-tabs>

        <section v-if="importJob.status === 'PREVIEW_READY'" class="confirm-band">
          <div class="decision-progress">
            <span>异常决定</span>
            <strong :class="allExceptionsDecided ? 'success-text' : 'danger-text'">
              {{ completedDecisionCount }} / {{ exceptionTotal }}
            </strong>
          </div>
          <el-input
            v-model="confirmationReason"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
            placeholder="发布说明"
          />
          <el-checkbox v-model="reviewConfirmed">已核对预览数据和全部异常决定</el-checkbox>
          <el-button
            type="primary"
            :loading="publishing"
            :disabled="!canPublish"
            @click="publishImport"
          >
            <el-icon><CircleCheck /></el-icon>
            确认发布
          </el-button>
        </section>
      </template>
    </div>

    <template #footer>
      <el-button :loading="cancelling" @click="closeDialog">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  cancelEquipmentImport,
  confirmEquipmentImport,
  createEquipmentImportPreview,
  getEquipmentImportExceptions,
  getEquipmentImportJob
} from '@/api/equipment'
import {
  EQUIPMENT_STATUS_OPTIONS,
  IMPORT_DECISION_ACTIONS,
  buildEquipmentImportConfirmation,
  equipmentImportDecisionOptions,
  equipmentImportExceptionLabel,
  equipmentImportFieldLabel,
  equipmentImportOriginalValue,
  equipmentImportSuggestedAction,
  formatEquipmentImportValue,
  isEquipmentImportDecisionComplete,
  optionForValue
} from '@/utils/equipment'
import {
  equipmentFieldValue,
  equipmentImportCandidate
} from '@/utils/equipmentAssetDisplay'

const IMPORT_PREVIEW_COLUMNS = Object.freeze([
  { key: 'sourceSequence', label: '序号', width: 72, align: 'center' },
  { key: 'assetType', label: '资产类型', minWidth: 125 },
  { key: 'assetCode', label: '资产编码', minWidth: 135 },
  { key: 'sourceAssetCode', label: '原资产编码', minWidth: 135 },
  { key: 'name', label: '名称', minWidth: 150 },
  { key: 'productCode', label: '产品编码/SN/PN', minWidth: 160 },
  { key: 'plateNumber', label: '车牌号', minWidth: 115 },
  { key: 'serialNumber', label: '序列号', minWidth: 130 },
  { key: 'brand', label: '品牌', minWidth: 105 },
  { key: 'brandSerialNumber', label: '品牌编号', minWidth: 125 },
  { key: 'specification', label: '型号规格', minWidth: 145 },
  { key: 'manufacturer', label: '生产厂家', minWidth: 140 },
  { key: 'bookQuantity', label: '账存数量', width: 96, align: 'right' },
  { key: 'physicalQuantity', label: '实盘数量', width: 96, align: 'right' },
  { key: 'unit', label: '单位', width: 72 },
  { key: 'activationDate', label: '启用日期', minWidth: 120 },
  { key: 'custodianDisplayName', label: '使用人', minWidth: 105 },
  { key: 'orgUnitNameSnapshot', label: '所在部室', minWidth: 125 },
  { key: 'location', label: '存放地点', minWidth: 125 },
  { key: 'conditionText', label: '状态', minWidth: 90 },
  { key: 'photoCount', label: '照片', width: 72, align: 'center' },
  { key: 'issueCount', label: '异常', width: 72, align: 'center' }
])
const IMPORT_JOB_STORAGE_KEY = 'equipmentImportPreviewJobId'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  orgUnits: { type: Array, default: () => [] },
  categories: { type: Array, default: () => [] },
  custodians: { type: Array, default: () => [] }
})
const emit = defineEmits(['update:modelValue', 'published'])

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})
const activeCategories = computed(() => props.categories.filter((item) => item.status === 'ACTIVE'))
const uploadList = ref([])
const selectedFile = ref(null)
const importJob = ref(null)
const previewing = ref(false)
const refreshing = ref(false)
const rowsLoading = ref(false)
const exceptionsLoading = ref(false)
const publishing = ref(false)
const cancelling = ref(false)
const restoring = ref(false)
const processingStage = ref('IDLE')
const uploadPercentage = ref(0)
const activeTab = ref('rows')
const rowPage = ref(1)
const rowPageSize = 20
const exceptionPage = ref(1)
const exceptionPageSize = 20
const exceptions = ref([])
const exceptionTotal = ref(0)
const decisionState = reactive({})
const confirmationReason = ref('')
const reviewConfirmed = ref(false)

const completedDecisionCount = computed(() => Object.values(decisionState)
  .filter(isEquipmentImportDecisionComplete).length)
const allExceptionsDecided = computed(() => completedDecisionCount.value === exceptionTotal.value)
const canPublish = computed(() => (
  importJob.value?.status === 'PREVIEW_READY' &&
  allExceptionsDecided.value &&
  confirmationReason.value.trim().length > 0 &&
  reviewConfirmed.value
))
const scopeLabel = computed(() => importJob.value?.dataScope === 'ORG_UNIT' ? '组织范围' : '团队范围')
const processingStep = computed(() => ({ UPLOADING: 0, PARSING: 1, WRITING: 2 }[processingStage.value] ?? 0))
const processingLabel = computed(() => ({
  UPLOADING: `上传 Excel ${uploadPercentage.value}%`,
  PARSING: '上传完成，服务端正在解析工作簿和图片',
  WRITING: '解析完成，正在写入并加载预览数据'
}[processingStage.value] || ''))

const rowStatusOption = (value) => optionForValue([
  { value: 'VALID', label: '有效', type: 'success' },
  { value: 'WARNING', label: '警告', type: 'warning' },
  { value: 'ERROR', label: '错误', type: 'danger' },
  { value: 'SKIPPED', label: '已跳过', type: 'info' },
  { value: 'PUBLISHED', label: '已发布', type: 'success' }
], value)
const exceptionStatusLabel = (value) => ({ PENDING: '待决定', RESOLVED: '已处理', SKIPPED: '已跳过' }[value] || value)
const formatFileSize = (size) => {
  const value = Number(size) || 0
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function previewFieldValue(row, key) {
  return equipmentFieldValue(equipmentImportCandidate(row), key)
}

function handleFileChange(file, fileList) {
  const raw = file.raw
  if (!raw || !/\.xlsx$/i.test(raw.name || '') || raw.size > 128 * 1024 * 1024) {
    ElMessage.warning('请选择不超过128 MB的 .xlsx 文件')
    uploadList.value = fileList.filter((item) => item.uid !== file.uid)
    selectedFile.value = null
    return
  }
  selectedFile.value = raw
}

function handleFileExceed() {
  ElMessage.warning('每次只能选择一个 Excel 文件')
}

async function createPreview() {
  if (!selectedFile.value) return
  previewing.value = true
  uploadPercentage.value = 0
  processingStage.value = 'UPLOADING'
  try {
    const result = await createEquipmentImportPreview(selectedFile.value, {
      onUploadProgress(event) {
        if (!event.total) return
        uploadPercentage.value = Math.min(100, Math.round((event.loaded / event.total) * 100))
        if (event.loaded >= event.total) processingStage.value = 'PARSING'
      }
    })
    processingStage.value = 'WRITING'
    importJob.value = result.importJob
    localStorage.setItem(IMPORT_JOB_STORAGE_KEY, importJob.value._id)
    rowPage.value = 1
    exceptionPage.value = 1
    await Promise.all([loadRows(), loadExceptions()])
    activeTab.value = result.exceptionCount > 0 ? 'exceptions' : 'rows'
    ElMessage.success('导入预览已生成')
  } finally {
    previewing.value = false
    processingStage.value = 'IDLE'
  }
}

async function loadRows() {
  if (!importJob.value?._id) return
  rowsLoading.value = true
  try {
    importJob.value = (await getEquipmentImportJob(importJob.value._id, {
      page: rowPage.value,
      pageSize: rowPageSize
    })).importJob
  } finally {
    rowsLoading.value = false
  }
}

function ensureDecision(exception) {
  if (decisionState[exception._id]) return
  decisionState[exception._id] = {
    exceptionId: exception._id,
    action: '',
    value: exception.hasSuggestedValue ? exception.suggestedValue : ''
  }
}

async function loadExceptions() {
  if (!importJob.value?._id) return
  exceptionsLoading.value = true
  try {
    const result = await getEquipmentImportExceptions(importJob.value._id, {
      page: exceptionPage.value,
      pageSize: exceptionPageSize
    })
    exceptions.value = result.exceptions || []
    exceptionTotal.value = result.total || 0
    exceptions.value.forEach(ensureDecision)
  } finally {
    exceptionsLoading.value = false
  }
}

function handleDecisionChange(exception) {
  const state = decisionState[exception._id]
  if (state.action === IMPORT_DECISION_ACTIONS.USE_RESOLVED_VALUE) {
    state.value = exception.hasSuggestedValue ? exception.suggestedValue : ''
  }
  if (state.action === IMPORT_DECISION_ACTIONS.SKIP_ROW) {
    exceptions.value
      .filter((item) => item.importRowId === exception.importRowId)
      .forEach((item) => { decisionState[item._id].action = IMPORT_DECISION_ACTIONS.SKIP_ROW })
  }
}

function scopedCustodians(exception) {
  return props.custodians.filter((item) => !exception.orgUnitId || item.orgUnitId === exception.orgUnitId)
}

async function refreshJob() {
  if (!importJob.value?._id) return
  refreshing.value = true
  try {
    await Promise.all([loadRows(), loadExceptions()])
    if (importJob.value.status === 'PUBLISHED') emit('published', importJob.value)
    ElMessage.success('导入任务状态已刷新')
  } finally {
    refreshing.value = false
  }
}

async function publishImport() {
  if (!canPublish.value) return
  const payload = buildEquipmentImportConfirmation(
    importJob.value,
    decisionState,
    confirmationReason.value
  )
  try {
    await ElMessageBox.confirm(
      `确认发布 ${importJob.value.totalRows} 行预览数据？异常决定提交后不能撤销。`,
      '确认发布设备台账',
      { confirmButtonText: '确认发布', cancelButtonText: '取消', type: 'warning' }
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    throw error
  }

  publishing.value = true
  try {
    const result = await confirmEquipmentImport(importJob.value._id, payload)
    importJob.value = result.importJob
    localStorage.removeItem(IMPORT_JOB_STORAGE_KEY)
    reviewConfirmed.value = false
    await loadExceptions()
    emit('published', importJob.value)
    ElMessage.success(`设备台账已发布 ${importJob.value.publishedRows} 条`)
  } finally {
    publishing.value = false
  }
}

function resetWorkflow() {
  uploadList.value = []
  selectedFile.value = null
  importJob.value = null
  exceptions.value = []
  exceptionTotal.value = 0
  Object.keys(decisionState).forEach((key) => delete decisionState[key])
  confirmationReason.value = ''
  reviewConfirmed.value = false
  activeTab.value = 'rows'
  rowPage.value = 1
  exceptionPage.value = 1
}

async function cancelCurrentPreview(reason) {
  if (importJob.value?.status !== 'PREVIEW_READY') return
  cancelling.value = true
  try {
    await cancelEquipmentImport(importJob.value._id, {
      expectedVersion: importJob.value.version,
      reason
    })
    localStorage.removeItem(IMPORT_JOB_STORAGE_KEY)
    resetWorkflow()
    ElMessage.success('导入预览已取消，暂存文件已进入清理流程')
  } finally {
    cancelling.value = false
  }
}

async function confirmAndCancel(reason) {
  if (previewing.value) {
    ElMessage.warning('Excel 正在上传或解析，请等待预览任务返回后再关闭')
    return false
  }
  if (importJob.value?.status !== 'PREVIEW_READY') return true
  try {
    await ElMessageBox.confirm(
      '当前预览尚未发布。继续将取消任务并删除暂存的 Excel 和图片，且无法恢复。',
      '取消当前导入预览',
      { confirmButtonText: '取消预览', cancelButtonText: '继续处理', type: 'warning' }
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') return false
    throw error
  }
  await cancelCurrentPreview(reason)
  return true
}

async function startNewImport() {
  if (!await confirmAndCancel('User started a new equipment import')) return
  resetWorkflow()
}

async function closeDialog() {
  if (!await confirmAndCancel('User closed the equipment import preview')) return
  visible.value = false
}

function requestClose(done) {
  confirmAndCancel('User closed the equipment import preview')
    .then((allowed) => { if (allowed) done() })
    .catch(() => {})
}

async function restorePreview() {
  if (restoring.value || importJob.value) return
  const jobId = localStorage.getItem(IMPORT_JOB_STORAGE_KEY)
  if (!jobId) return
  restoring.value = true
  try {
    const result = await getEquipmentImportJob(jobId, { page: 1, pageSize: rowPageSize })
    if (result.importJob?.status !== 'PREVIEW_READY') {
      localStorage.removeItem(IMPORT_JOB_STORAGE_KEY)
      return
    }
    importJob.value = result.importJob
    await loadExceptions()
    activeTab.value = exceptionTotal.value > 0 ? 'exceptions' : 'rows'
    ElMessage.info('已恢复上次未发布的设备导入预览')
  } catch (error) {
    if (error?.response?.status === 404 || error?.response?.status === 409) {
      localStorage.removeItem(IMPORT_JOB_STORAGE_KEY)
      return
    }
    throw error
  } finally {
    restoring.value = false
  }
}

watch(() => props.modelValue, (value) => {
  if (value) restorePreview()
}, { immediate: true })
</script>

<style scoped lang="scss">
.import-content { max-height: 72vh; overflow-y: auto; padding-right: 4px; }
.upload-band, .job-heading, .job-actions, .sheet-row, .confirm-band { display: flex; align-items: center; }
.upload-band { min-height: 160px; justify-content: center; gap: 18px; border-block: 1px solid #e4e7ed; }
.processing-band { max-width: 680px; margin: 18px auto; text-align: center; }
.processing-band .el-progress { margin-bottom: 18px; }
.processing-band strong { display: block; margin-top: 12px; color: #606266; font-size: 14px; }
.job-heading { justify-content: space-between; gap: 18px; margin-bottom: 14px; }
.job-heading h3 { margin: 0 0 5px; font-size: 18px; letter-spacing: 0; overflow-wrap: anywhere; }
.job-heading p { margin: 0; color: #909399; }
.job-actions { flex-wrap: wrap; gap: 10px; }
.summary-band { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin-top: 16px; border-block: 1px solid #e4e7ed; }
.summary-band > div { min-width: 0; padding: 14px 16px; border-right: 1px solid #ebeef5; }
.summary-band > div:last-child { border-right: 0; }
.summary-band span { display: block; margin-bottom: 6px; color: #909399; font-size: 12px; }
.summary-band strong { font-size: 20px; }
.success-text { color: #529b2e; }
.warning-text { color: #b88230; }
.danger-text { color: #c45656; }
.sheet-row { flex-wrap: wrap; gap: 8px; padding: 12px 0 4px; }
.sheet-row > span { margin-right: 4px; color: #606266; font-size: 13px; }
.import-tabs { margin-top: 8px; }
.table-shell { overflow: hidden; border: 1px solid #e4e7ed; border-radius: 6px; }
.preview-table-shell { overflow-x: auto; }
.preview-table { min-width: 3000px; }
.exception-table { overflow-x: auto; }
.table-pagination { justify-content: flex-end; margin-top: 12px; }
.decision-select, .resolved-editor { width: 100%; }
.confirm-band { align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #e4e7ed; }
.confirm-band .el-textarea { flex: 1 1 420px; }
.decision-progress { flex: 0 0 110px; }
.decision-progress span { display: block; margin-bottom: 5px; color: #909399; font-size: 12px; }
.decision-progress strong { font-size: 17px; }
@media (max-width: 760px) {
  .upload-band, .job-heading { align-items: stretch; flex-direction: column; }
  .upload-band { padding: 28px 0; }
  .summary-band { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .summary-band > div:nth-child(3n) { border-right: 0; }
  .confirm-band { align-items: stretch; flex-direction: column; }
  .confirm-band .el-textarea { flex-basis: auto; }
}
</style>
