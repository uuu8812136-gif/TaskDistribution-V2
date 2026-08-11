<template>
  <div class="contract-detail-page">
    <header class="detail-heading">
      <el-button circle aria-label="返回供应商合同列表" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <div class="supplier-heading">
        <h1>{{ supplier?.name || '供应商合同详情' }}</h1>
        <div class="supplier-meta">
          <span>供应商编码：<strong>{{ supplier?.code || '-' }}</strong></span>
          <el-tag effect="plain">{{ optionLabel(SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS, supplier?.trusteeAttribute) }}</el-tag>
          <el-tag :type="supplier?.hasSignedContract ? 'success' : 'info'" effect="plain">
            {{ supplier?.hasSignedContract ? '已签订主合同' : '未签订主合同' }}
          </el-tag>
          <el-tag :type="!supplier?.hasSignedContract ? 'info' : supplier?.contractValid ? 'success' : 'danger'" effect="plain">
            {{ supplier?.hasSignedContract ? (supplier?.contractValid ? '合同有效' : '合同无效') : '无有效性数据' }}
          </el-tag>
        </div>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImport" @click="openImport">
          <el-icon><Upload /></el-icon>
          导入更新
        </el-button>
        <el-button v-if="canExport" :loading="exportingScope === 'supplier'" @click="handleExport()">
          <el-icon><Download /></el-icon>
          导出供应商汇总
        </el-button>
      </div>
    </header>

    <el-skeleton v-if="supplierLoading" :rows="5" animated />
    <el-result
      v-else-if="!supplier"
      icon="error"
      title="供应商资料加载失败"
      :sub-title="supplierError || '该供应商可能已删除，或不属于当前团队'"
    >
      <template #extra>
        <div class="heading-actions">
          <el-button type="primary" :loading="supplierLoading" @click="reloadPage">重新加载</el-button>
          <el-button @click="goBack">返回列表</el-button>
        </div>
      </template>
    </el-result>

    <template v-else>
      <el-tabs v-model="activeCategory" class="contract-tabs" @tab-change="handleTabChange">
        <el-tab-pane
          v-for="config in CONTRACT_CATEGORY_CONFIGS"
          :key="config.value"
          :name="config.value"
          :label="`${config.label} (${recordState[config.value].total})`"
        />
      </el-tabs>
      <el-select v-model="activeCategory" class="mobile-category-select" @change="handleTabChange">
        <el-option
          v-for="config in CONTRACT_CATEGORY_CONFIGS"
          :key="config.value"
          :label="`${config.label} (${recordState[config.value].total})`"
          :value="config.value"
        />
      </el-select>

      <section class="records-toolbar">
        <div>
          <h2>{{ activeConfig.label }}</h2>
          <p>同一供应商可保留多条历史记录，最新数据不会覆盖旧记录。</p>
        </div>
        <div class="heading-actions">
          <el-button
            v-if="canExport"
            :loading="exportingScope === activeCategory"
            @click="handleExport(activeCategory)"
          >
            <el-icon><Download /></el-icon>
            导出本页签
          </el-button>
          <el-button v-if="canManage" type="primary" @click="openCreateRecord">
            <el-icon><Plus /></el-icon>
            新增记录
          </el-button>
        </div>
      </section>

      <section v-loading="activeState.loading" class="records-list" aria-live="polite">
        <el-alert
          v-if="activeState.error"
          :title="activeState.error"
          type="error"
          :closable="false"
          show-icon
        >
          <template #default><el-button text type="primary" @click="loadActiveRecords">重新加载</el-button></template>
        </el-alert>
        <el-empty v-if="!activeState.loading && !activeState.error && !activeState.items.length" :description="`暂无${activeConfig.label}记录`" />
        <article v-for="record in activeState.items" :key="record._id" class="record-item">
          <div class="record-main">
            <div class="record-title-row">
              <strong>{{ recordTitle(record, activeConfig) }}</strong>
              <el-tag v-if="record.signingStatus" :type="record.signingStatus === 'SIGNED' ? 'success' : 'info'" effect="plain" size="small">
                {{ optionLabel(SIGNING_STATUS_OPTIONS, record.signingStatus) }}
              </el-tag>
              <el-tag v-if="record.autoRenew" type="success" effect="plain" size="small">自动顺延</el-tag>
            </div>
            <dl class="record-summary">
              <div v-for="item in summaryFields(activeConfig)" :key="item.key">
                <dt>{{ item.label }}</dt>
                <dd>{{ formatContractField(record[item.key], item) }}</dd>
              </div>
              <div>
                <dt>附件</dt>
                <dd>{{ record.attachments?.length || 0 }} 个</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{{ formatDateTime(record.updatedAt || record.createdAt) }}</dd>
              </div>
            </dl>
          </div>
          <div class="record-actions">
            <el-button text type="primary" :icon="View" @click="openViewRecord(record)">查看</el-button>
            <el-button v-if="canManage" text :icon="Edit" @click="openEditRecord(record)">编辑</el-button>
            <el-button
              v-if="canManage"
              text
              type="danger"
              :icon="Delete"
              :loading="deletingId === record._id"
              @click="handleDeleteRecord(record)"
            >删除</el-button>
          </div>
        </article>
      </section>

      <footer v-if="activeState.total > activeState.pageSize" class="pagination-row">
        <span>共 {{ activeState.total }} 条记录</span>
        <el-pagination
          v-model:current-page="activeState.page"
          :page-size="activeState.pageSize"
          :total="activeState.total"
          :pager-count="5"
          layout="prev, pager, next"
          @current-change="loadActiveRecords"
        />
      </footer>
    </template>

    <el-dialog v-model="viewVisible" :title="`${activeConfig.label}详情`" width="min(860px, 95vw)">
      <dl v-if="viewRecord" class="detail-grid">
        <div v-for="item in activeConfig.fields" :key="item.key" :class="{ 'detail-field--wide': item.span === 2 }">
          <dt>{{ item.label }}</dt>
          <dd>{{ formatContractField(viewRecord[item.key], item) }}</dd>
        </div>
      </dl>
      <section v-for="group in activeConfig.attachmentGroups" :key="group.purpose" class="view-attachments">
        <h3>{{ group.label }}</h3>
        <AuthenticatedAttachments
          v-if="attachmentsForPurpose(viewRecord?.attachments, group.purpose).length"
          :attachments="attachmentsForPurpose(viewRecord?.attachments, group.purpose)"
          :team-id="requestTeamParams.teamId || ''"
        />
        <span v-else class="empty-value">暂无附件</span>
      </section>
      <template #footer><el-button @click="viewVisible = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog
      v-model="formVisible"
      :title="editingRecordId ? `编辑${activeConfig.label}` : `新增${activeConfig.label}`"
      width="min(940px, 96vw)"
      :close-on-click-modal="!submitting"
      :close-on-press-escape="!submitting"
      :show-close="!submitting"
    >
      <el-form ref="recordFormRef" :model="recordForm" label-position="top" class="record-form">
        <div class="record-form-grid">
          <el-form-item
            v-for="item in activeConfig.fields"
            :key="item.key"
            :label="item.label"
            :class="{ 'form-field--wide': item.span === 2 }"
          >
            <el-select v-if="item.type === 'signingStatus'" v-model="recordForm[item.key]" class="full-width">
              <el-option v-for="option in SIGNING_STATUS_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-segmented
              v-else-if="item.type === 'boolean'"
              v-model="recordForm[item.key]"
              :options="YES_NO_OPTIONS"
            />
            <el-date-picker
              v-else-if="item.type === 'date'"
              v-model="recordForm[item.key]"
              type="date"
              value-format="YYYY-MM-DD"
              class="full-width"
            />
            <el-select
              v-else-if="item.type === 'select'"
              v-model="recordForm[item.key]"
              clearable
              class="full-width"
            >
              <el-option v-for="option in item.options" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-select
              v-else-if="item.type === 'tags'"
              v-model="recordForm[item.key]"
              multiple
              filterable
              allow-create
              default-first-option
              :placeholder="item.placeholder"
              class="full-width"
            />
            <div v-else-if="item.type === 'contacts'" class="contacts-editor">
              <div v-for="(contact, index) in recordForm.contacts" :key="index" class="contact-row">
                <el-input v-model="contact.name" maxlength="100" placeholder="联系人姓名" />
                <el-input v-model="contact.phone" maxlength="100" placeholder="联系电话" />
                <el-tooltip content="删除联系人" placement="top">
                  <el-button circle :icon="Delete" aria-label="删除联系人" @click="removeContact(index)" />
                </el-tooltip>
              </div>
              <el-button :icon="Plus" @click="addContact">添加联系人</el-button>
            </div>
            <el-input
              v-else-if="item.type === 'textarea'"
              v-model="recordForm[item.key]"
              type="textarea"
              :rows="3"
              :maxlength="item.maxlength || 2000"
              show-word-limit
            />
            <el-input v-else v-model="recordForm[item.key]" maxlength="500" />
          </el-form-item>
        </div>

        <section class="attachment-editor">
          <div v-for="group in activeConfig.attachmentGroups" :key="group.purpose" class="attachment-field">
            <h3>{{ group.label }}</h3>
            <ContractFileUpload
              v-model="attachmentFiles[group.purpose]"
              :team-id="requestTeamParams.teamId || ''"
              :accept="group.accept"
            />
          </div>
        </section>
      </el-form>
      <template #footer>
        <el-button :disabled="submitting" @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRecord">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importVisible" title="导入供应商合同" width="min(620px, 94vw)" :show-close="!importing">
      <el-alert
        :title="`导入文件将按供应商编码更新五类合同资料；当前供应商：${supplier?.name || '-'}`"
        type="info"
        :closable="false"
        show-icon
      />
      <el-upload
        v-model:file-list="importFiles"
        drag
        :auto-upload="false"
        :limit="1"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        class="import-upload"
        :on-change="handleImportFileChange"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖入 Excel 文件，或<em>点击选择</em></div>
      </el-upload>
      <template #footer>
        <el-button :disabled="importing" @click="importVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" :disabled="!importFile" @click="submitImport">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { Delete, Edit, Plus, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import AuthenticatedAttachments from '@/components/AuthenticatedAttachments.vue'
import ContractFileUpload from './components/ContractFileUpload.vue'
import {
  createSupplierRecord,
  deleteSupplierRecord,
  exportSuppliers,
  getSupplier,
  getSupplierRecord,
  getSupplierRecords,
  importSuppliers,
  updateSupplierRecord
} from '@/api/contract'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import { cleanupTemporaryFiles, existingAttachmentFileList, prepareAttachmentReferences } from '@/utils/attachments'
import {
  CONTRACT_CATEGORY_CONFIGS,
  SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS,
  SIGNING_STATUS_OPTIONS,
  YES_NO_OPTIONS,
  buildRecordPayload,
  emptyRecordDetails,
  formatContractField,
  normalizeRecord,
  optionLabel,
  saveContractBlob
} from '@/utils/contract'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const supplierId = computed(() => String(route.params.supplierId || ''))
const selectedTeamId = computed(() => String(route.query.teamId || ''))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const supplier = ref(null)
const supplierLoading = ref(false)
const supplierError = ref('')
const activeCategory = ref(CONTRACT_CATEGORY_CONFIGS[0].value)
const recordState = reactive(Object.fromEntries(CONTRACT_CATEGORY_CONFIGS.map((config) => [
  config.value,
  { items: [], total: 0, page: 1, pageSize: 10, loading: false, loaded: false, error: '', requestId: 0 }
])))
const activeConfig = computed(() => CONTRACT_CATEGORY_CONFIGS.find((config) => config.value === activeCategory.value))
const activeState = computed(() => recordState[activeCategory.value])
const viewVisible = ref(false)
const viewRecord = ref(null)
const formVisible = ref(false)
const recordFormRef = ref(null)
const recordForm = reactive({})
const attachmentFiles = reactive({})
const editingRecordId = ref('')
const submitting = ref(false)
const deletingId = ref('')
const exportingScope = ref('')
const importVisible = ref(false)
const importFiles = ref([])
const importFile = ref(null)
const importing = ref(false)

const canManage = computed(() => session.can('contract.supplier.manage', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('contract.supplier.import', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('contract.supplier.export'))

function goBack() {
  router.push({ name: 'SupplierContracts', query: requestTeamParams.value })
}

function formatDateTime(value) {
  return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
}

function summaryFields(config) {
  return config.summaryKeys
    .map((key) => config.fields.find((item) => item.key === key))
    .filter(Boolean)
}

function recordTitle(record, config) {
  const effectiveDate = formatContractField(record.effectiveDate, { type: 'date' })
  if (record.contractNumber) return `${config.shortLabel} · ${record.contractNumber}`
  if (effectiveDate !== '-') return `${config.shortLabel} · ${effectiveDate}`
  return `${config.shortLabel}记录`
}

function attachmentsForPurpose(attachments, purpose) {
  const list = Array.isArray(attachments) ? attachments : []
  const matched = list.filter((item) => item.purpose === purpose)
  if (matched.length || activeConfig.value.attachmentGroups[0]?.purpose !== purpose) return matched
  return list.filter((item) => !item.purpose)
}

async function loadSupplier() {
  supplierLoading.value = true
  supplierError.value = ''
  try {
    const result = await getSupplier(supplierId.value, requestTeamParams.value)
    supplier.value = result.supplier || result
  } catch (error) {
    supplier.value = null
    supplierError.value = error?.message || '供应商资料加载失败，请稍后重试'
  } finally {
    supplierLoading.value = false
  }
}

async function loadRecords(category, { force = false } = {}) {
  const state = recordState[category]
  if (!state || state.loading || state.loaded && !force) return
  const requestId = ++state.requestId
  state.loading = true
  state.error = ''
  try {
    const result = await getSupplierRecords(supplierId.value, {
      ...requestTeamParams.value,
      category,
      page: state.page,
      pageSize: state.pageSize
    })
    if (requestId !== state.requestId) return
    state.items = (result.records || []).map(normalizeRecord)
    state.total = Number(result.total) || 0
    state.loaded = true
  } catch (error) {
    if (requestId === state.requestId) state.error = error?.message || '合同记录加载失败，请稍后重试'
  } finally {
    if (requestId === state.requestId) state.loading = false
  }
}

function loadActiveRecords() {
  return loadRecords(activeCategory.value, { force: true })
}

async function reloadPage() {
  for (const state of Object.values(recordState)) state.loaded = false
  await Promise.all([loadSupplier(), ...CONTRACT_CATEGORY_CONFIGS.map((config) => loadRecords(config.value, { force: true }))])
}

function handleTabChange(category) {
  loadRecords(category)
}

function resetRecordForm(source = {}) {
  for (const key of Object.keys(recordForm)) delete recordForm[key]
  Object.assign(recordForm, emptyRecordDetails(activeConfig.value), normalizeRecord(source))
  recordForm.signingStatus ||= 'UNSIGNED'
  if (activeCategory.value === 'SUPPLIER_INFO') recordForm.supplyStatus ||= 'NORMAL'
  if (activeConfig.value.fields.some((item) => item.key === 'contacts')) {
    recordForm.contacts = Array.isArray(recordForm.contacts) && recordForm.contacts.length
      ? recordForm.contacts.map((item) => ({ name: item.name || '', phone: item.phone || '' }))
      : [{ name: '', phone: '' }]
  }
  for (const key of Object.keys(attachmentFiles)) delete attachmentFiles[key]
  for (const group of activeConfig.value.attachmentGroups) {
    attachmentFiles[group.purpose] = existingAttachmentFileList(
      attachmentsForPurpose(source.attachments, group.purpose)
    )
  }
  recordFormRef.value?.clearValidate()
}

function openCreateRecord() {
  editingRecordId.value = ''
  resetRecordForm()
  formVisible.value = true
}

async function loadFullRecord(record) {
  const result = await getSupplierRecord(record._id, requestTeamParams.value)
  return normalizeRecord(result.record || result)
}

async function openViewRecord(record) {
  viewRecord.value = await loadFullRecord(record)
  viewVisible.value = true
}

async function openEditRecord(record) {
  const fullRecord = await loadFullRecord(record)
  editingRecordId.value = fullRecord._id
  resetRecordForm(fullRecord)
  formVisible.value = true
}

function addContact() {
  if (!Array.isArray(recordForm.contacts)) recordForm.contacts = []
  recordForm.contacts.push({ name: '', phone: '' })
}

function removeContact(index) {
  recordForm.contacts.splice(index, 1)
  if (!recordForm.contacts.length) addContact()
}

async function submitRecord() {
  const valid = await recordFormRef.value?.validate().catch(() => false)
  if (valid === false) return
  if (recordForm.effectiveDate && recordForm.expiryDate && dayjs(recordForm.expiryDate).isBefore(recordForm.effectiveDate, 'day')) {
    ElMessage.warning('截止日期不能早于生效日期')
    return
  }
  if (Array.isArray(recordForm.reconciliationEmails)) {
    const invalidEmail = recordForm.reconciliationEmails.find((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()))
    if (invalidEmail) {
      ElMessage.warning(`对账邮箱“${invalidEmail}”格式不正确`)
      return
    }
  }
  const totalAttachments = activeConfig.value.attachmentGroups.reduce(
    (sum, group) => sum + (attachmentFiles[group.purpose]?.length || 0),
    0
  )
  if (totalAttachments > 10) {
    ElMessage.warning('同一条记录最多上传 10 个附件，请删除多余附件后再保存')
    return
  }
  submitting.value = true
  const uploadedFileIds = []
  try {
    const attachments = []
    for (const group of activeConfig.value.attachmentGroups) {
      const prepared = await prepareAttachmentReferences(attachmentFiles[group.purpose] || [], uploadTemporaryFile)
      uploadedFileIds.push(...prepared.uploadedFileIds)
      attachments.push(...prepared.references.map(({ fileId }) => ({ fileId, purpose: group.purpose })))
    }
    const payload = buildRecordPayload(activeConfig.value, recordForm, attachments)
    if (editingRecordId.value) await updateSupplierRecord(editingRecordId.value, payload)
    else await createSupplierRecord(supplierId.value, payload)
    uploadedFileIds.length = 0
    ElMessage.success(editingRecordId.value ? '合同记录已更新' : '合同记录已新增')
    formVisible.value = false
    activeState.value.loaded = false
    await Promise.all([loadSupplier(), loadActiveRecords()])
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

async function handleDeleteRecord(record) {
  try {
    await ElMessageBox.confirm('确定删除这条合同记录吗？删除后不可恢复。', '删除合同记录', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  deletingId.value = record._id
  try {
    await deleteSupplierRecord(record._id, { reason: '后台供应商合同管理删除记录' })
    ElMessage.success('合同记录已删除')
    if (activeState.value.items.length === 1 && activeState.value.page > 1) activeState.value.page -= 1
    activeState.value.loaded = false
    await Promise.all([loadSupplier(), loadActiveRecords()])
  } finally {
    deletingId.value = ''
  }
}

async function handleExport(category = '') {
  const scope = category || 'supplier'
  exportingScope.value = scope
  try {
    const blob = await exportSuppliers({
      ...requestTeamParams.value,
      supplierId: supplierId.value,
      category: category || undefined
    })
    const suffix = category ? activeConfig.value.shortLabel : '全部合同'
    saveContractBlob(blob, `${supplier.value.code}-${supplier.value.name}-${suffix}.xlsx`)
    ElMessage.success('合同资料已导出')
  } finally {
    exportingScope.value = ''
  }
}

function openImport() {
  importFiles.value = []
  importFile.value = null
  importVisible.value = true
}

function handleImportFileChange(file, files) {
  if (!file.raw || !/\.xlsx$/i.test(file.raw.name || '')) {
    ElMessage.warning('请选择 .xlsx 格式的供应商合同文件')
    importFiles.value = files.filter((item) => item.uid !== file.uid)
    importFile.value = null
    return
  }
  importFile.value = file.raw
}

async function submitImport() {
  if (!importFile.value) return
  importing.value = true
  try {
    await importSuppliers(importFile.value, { ...requestTeamParams.value, supplierId: supplierId.value })
    ElMessage.success('供应商合同导入完成')
    importVisible.value = false
    for (const state of Object.values(recordState)) state.loaded = false
    await Promise.all([
      loadSupplier(),
      ...CONTRACT_CATEGORY_CONFIGS.map((config) => loadRecords(config.value, { force: true }))
    ])
  } finally {
    importing.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    loadSupplier(),
    ...CONTRACT_CATEGORY_CONFIGS.map((config) => loadRecords(config.value))
  ])
})
</script>

<style scoped lang="scss">
.contract-detail-page { min-width: 0; }
.detail-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 14px; margin-bottom: 18px; }
.supplier-heading h1 { margin: 0; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.supplier-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-top: 8px; color: var(--el-text-color-secondary); }
.contract-tabs { margin-top: 4px; }
.contract-tabs :deep(.el-tabs__header) { margin-bottom: 14px; }
.contract-tabs :deep(.el-tabs__nav-wrap) { overflow: visible; }
.mobile-category-select { display: none; width: 100%; margin-bottom: 14px; }
.records-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 0 14px; }
.records-toolbar h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
.records-toolbar p { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 13px; }
.records-list { min-height: 180px; border-block: 1px solid var(--zl-border-soft); }
.record-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 16px 4px; border-bottom: 1px solid var(--zl-border-soft); }
.record-item:last-child { border-bottom: 0; }
.record-title-row, .record-actions { display: flex; align-items: center; gap: 8px; }
.record-title-row strong { overflow-wrap: anywhere; }
.record-summary { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)); gap: 10px 18px; margin-top: 12px; }
.record-summary dt, .detail-grid dt { color: var(--el-text-color-secondary); font-size: 12px; }
.record-summary dd, .detail-grid dd { margin-top: 4px; overflow-wrap: anywhere; }
.record-actions { justify-content: flex-end; flex-wrap: wrap; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--el-text-color-secondary); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; border-top: 1px solid var(--zl-border-soft); border-left: 1px solid var(--zl-border-soft); }
.detail-grid > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--zl-border-soft); border-bottom: 1px solid var(--zl-border-soft); }
.detail-field--wide { grid-column: 1 / -1; }
.view-attachments { margin-top: 18px; }
.view-attachments h3, .attachment-field h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
.empty-value { color: var(--el-text-color-secondary); }
.record-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.form-field--wide { grid-column: 1 / -1; }
.full-width { width: 100%; }
.contacts-editor { display: grid; width: 100%; gap: 8px; }
.contact-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; }
.attachment-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; padding-top: 16px; border-top: 1px solid var(--zl-border-soft); }
.attachment-field { min-width: 0; }
.import-upload { margin-top: 18px; }
@media (max-width: 760px) {
  .detail-heading { grid-template-columns: auto minmax(0, 1fr); }
  .detail-heading > .heading-actions { grid-column: 1 / -1; width: 100%; }
  .detail-heading > .heading-actions .el-button { flex: 1 1 150px; }
  .supplier-heading h1 { font-size: 20px; }
  .contract-tabs { display: none; }
  .mobile-category-select { display: block; }
  .records-toolbar { align-items: stretch; flex-direction: column; }
  .records-toolbar .heading-actions, .records-toolbar .heading-actions .el-button { width: 100%; }
  .record-item { grid-template-columns: 1fr; gap: 10px; }
  .record-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .record-actions { justify-content: flex-start; }
  .detail-grid, .record-form-grid, .attachment-editor { grid-template-columns: 1fr; }
  .detail-field--wide, .form-field--wide { grid-column: auto; }
  .contact-row { grid-template-columns: 1fr auto; }
  .contact-row .el-input:first-child { grid-column: 1 / -1; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
}
</style>
