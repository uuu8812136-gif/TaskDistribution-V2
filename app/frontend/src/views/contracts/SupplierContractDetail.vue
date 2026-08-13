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
          <el-tag effect="plain">托管属性：{{ optionLabel(SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS, supplier?.trusteeAttribute) }}</el-tag>
          <el-tag :type="supplier?.hasSignedContract ? 'success' : 'info'" effect="plain">
            是否签订合同：{{ supplier?.hasSignedContract ? '是' : '否' }}（系统派生）
          </el-tag>
          <el-tag :type="supplier?.contractValid ? 'success' : 'danger'" effect="plain">
            合同是否有效：{{ supplier?.contractValid ? '有效' : '到期' }}（系统派生）
          </el-tag>
        </div>
      </div>
      <div class="heading-actions">
        <el-button v-if="canManage" :disabled="!supplier" @click="openSupplierIdentity">
          <el-icon><Edit /></el-icon>
          维护供应商信息
        </el-button>
        <el-button v-if="canImport" @click="openImport">
          <el-icon><Upload /></el-icon>
          导入三级细表
        </el-button>
        <el-button v-if="canExport" :loading="exportingScope === 'supplier'" @click="handleExport()">
          <el-icon><Download /></el-icon>
          导出二级汇总
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
          <p>本区域为二级只读汇总；新增、修改和删除均进入三级细表完成。</p>
        </div>
        <div class="heading-actions">
          <el-button
            v-if="canExport"
            :loading="exportingScope === activeCategory"
            @click="handleExport(activeCategory)"
          >
            <el-icon><Download /></el-icon>
            导出三级明细
          </el-button>
          <el-button v-if="canManage" type="primary" @click="openCreateRecord">
            <el-icon><Plus /></el-icon>
            新增三级明细
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
            <el-button text type="primary" :icon="View" @click="openViewRecord(record)">查看明细</el-button>
            <el-button v-if="canManage" text :icon="Edit" @click="openEditRecord(record)">维护明细</el-button>
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

    <el-dialog
      v-model="supplierIdentityVisible"
      title="三级页面 · 维护供应商信息"
      width="min(620px, 94vw)"
      append-to-body
      :close-on-click-modal="!savingSupplierIdentity"
      :close-on-press-escape="!savingSupplierIdentity"
      :show-close="!savingSupplierIdentity"
    >
      <el-alert
        title="此处是供应商名称、编码和托管属性的唯一人工维护入口，保存后主表与二级汇总自动刷新"
        type="info"
        :closable="false"
        show-icon
        class="derived-alert"
      />
      <el-form ref="supplierIdentityFormRef" :model="supplierIdentityForm" :rules="supplierIdentityRules" label-width="112px">
        <el-form-item label="供应商名称" prop="name">
          <el-input v-model="supplierIdentityForm.name" maxlength="200" />
        </el-form-item>
        <el-form-item label="供应商编码" prop="code">
          <el-input v-model="supplierIdentityForm.code" maxlength="100" placeholder="按文本保存，可保留前导零" />
        </el-form-item>
        <el-form-item label="托管属性" prop="trusteeAttribute">
          <el-segmented v-model="supplierIdentityForm.trusteeAttribute" :options="SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="savingSupplierIdentity" @click="supplierIdentityVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingSupplierIdentity" @click="saveSupplierIdentity">保存供应商信息</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="viewVisible" :title="`三级细表 · ${activeConfig.label}详情`" width="min(860px, 95vw)" append-to-body>
      <dl v-if="viewRecord" class="record-context-view">
        <div><dt>供应商名称</dt><dd>{{ supplier?.name || '-' }}</dd></div>
        <div><dt>供应商编码</dt><dd>{{ supplier?.code || '-' }}</dd></div>
        <div><dt>托管属性</dt><dd>{{ optionLabel(SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS, viewRecord.trusteeAttribute || supplier?.trusteeAttribute) }}</dd></div>
      </dl>
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
      :title="editingRecordId ? `三级细表 · 维护${activeConfig.label}` : `三级细表 · 新增${activeConfig.label}`"
      width="min(940px, 96vw)"
      append-to-body
      :close-on-click-modal="!formBusy"
      :close-on-press-escape="!formBusy"
      :show-close="!formBusy"
    >
      <el-form
        ref="recordFormRef"
        :model="recordForm"
        :rules="recordRules"
        :disabled="formBusy"
        label-position="top"
        class="record-form"
      >
        <section class="record-context-grid">
          <el-form-item label="供应商名称">
            <el-input :model-value="supplier?.name || '-'" disabled />
          </el-form-item>
          <el-form-item label="供应商编码">
            <el-input :model-value="supplier?.code || '-'" disabled />
          </el-form-item>
          <el-form-item label="托管属性" prop="trusteeAttribute">
            <el-segmented v-model="recordForm.trusteeAttribute" :options="SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS" />
          </el-form-item>
        </section>
        <el-alert
          title="保存三级明细后，供应商主表和二级汇总会自动重新关联"
          type="info"
          :closable="false"
          show-icon
          class="derived-alert"
        />
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
            <el-input
              v-else
              v-model="recordForm[item.key]"
              :maxlength="item.maxlength || 500"
              :placeholder="item.placeholder || ''"
            />
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
        <div class="dialog-footer-row">
          <el-button
            v-if="editingRecordId && canManage"
            type="danger"
            plain
            :loading="deletingId === editingRecordId"
            :disabled="submitting || (Boolean(deletingId) && deletingId !== editingRecordId)"
            @click="deleteEditingRecord"
          >删除本条三级明细</el-button>
          <span v-else />
          <div class="dialog-footer-actions">
            <el-button :disabled="formBusy" @click="formVisible = false">取消</el-button>
            <el-button type="primary" :loading="submitting" :disabled="Boolean(deletingId)" @click="submitRecord">保存三级明细</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="importVisible" title="导入供应商合同" width="min(620px, 94vw)" append-to-body :show-close="!importing">
      <el-alert
        :title="`请使用57列三级细表模板（D列为托管属性），系统将按供应商编码更新只读汇总；当前供应商：${supplier?.name || '-'}`"
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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
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
  updateSupplier,
  updateSupplierRecord
} from '@/api/contract'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import {
  createPageConfirmationGuard,
  isSamePageRequestContext,
  pageRequestContextSnapshot
} from '@/utils/pageRequestContext'
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
const supplierIdentityVisible = ref(false)
const supplierIdentityFormRef = ref(null)
const supplierIdentityForm = reactive({ name: '', code: '', trusteeAttribute: 'NON_HOSTED' })
const supplierIdentityRules = {
  name: [{ required: true, message: '请输入供应商名称', trigger: 'blur' }],
  code: [{ required: true, message: '请输入供应商编码', trigger: 'blur' }],
  trusteeAttribute: [{ required: true, message: '请选择托管属性', trigger: 'change' }]
}
const savingSupplierIdentity = ref(false)
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
const recordRules = {
  trusteeAttribute: [{ required: true, message: '请选择托管属性', trigger: 'change' }]
}
const attachmentFiles = reactive({})
const editingRecordId = ref('')
const submitting = ref(false)
const deletingId = ref('')
const formBusy = computed(() => submitting.value || Boolean(deletingId.value))
const exportingScope = ref('')
const importVisible = ref(false)
const importFiles = ref([])
const importFile = ref(null)
const importing = ref(false)
let pageActive = true
let supplierRequestId = 0
let detailRequestId = 0
let mutationRequestId = 0
let exportRequestId = 0
let importRequestId = 0

const canManage = computed(() => session.can('contract.supplier.manage', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('contract.supplier.import', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('contract.supplier.export'))

function currentPageContext() {
  return pageRequestContextSnapshot({
    route,
    session,
    teamId: selectedTeamId.value,
    pageActive
  })
}

function isCurrentPageContext(context) {
  return isSamePageRequestContext(context, currentPageContext())
}

const confirmationGuard = createPageConfirmationGuard(currentPageContext)

function invalidateDetailPage() {
  pageActive = false
  confirmationGuard.invalidate()
  supplierRequestId += 1
  detailRequestId += 1
  mutationRequestId += 1
  exportRequestId += 1
  importRequestId += 1
  supplierLoading.value = false
  savingSupplierIdentity.value = false
  submitting.value = false
  deletingId.value = ''
  exportingScope.value = ''
  importing.value = false
  supplierIdentityVisible.value = false
  viewVisible.value = false
  formVisible.value = false
  importVisible.value = false
  for (const state of Object.values(recordState)) {
    state.requestId += 1
    state.loading = false
  }
}

function goBack() {
  router.push({ name: 'SupplierContracts', query: requestTeamParams.value })
}

function openSupplierIdentity() {
  Object.assign(supplierIdentityForm, {
    name: supplier.value?.name || '',
    code: String(supplier.value?.code || ''),
    trusteeAttribute: supplier.value?.trusteeAttribute || 'NON_HOSTED'
  })
  supplierIdentityFormRef.value?.clearValidate()
  supplierIdentityVisible.value = true
}

async function saveSupplierIdentity() {
  const valid = await supplierIdentityFormRef.value?.validate().catch(() => false)
  if (!valid) return
  const name = supplierIdentityForm.name.trim()
  const code = String(supplierIdentityForm.code).trim()
  if (!name || !code) {
    ElMessage.warning('供应商名称和供应商编码不能只填写空格')
    return
  }
  savingSupplierIdentity.value = true
  const requestId = ++mutationRequestId
  const context = currentPageContext()
  try {
    await updateSupplier(supplierId.value, {
      name,
      code,
      trusteeAttribute: supplierIdentityForm.trusteeAttribute
    })
    if (requestId !== mutationRequestId || !isCurrentPageContext(context)) return
    supplierIdentityVisible.value = false
    await loadSupplier()
    if (requestId !== mutationRequestId || !isCurrentPageContext(context)) return
    ElMessage.success('供应商信息已更新，主表与二级汇总已自动刷新')
  } finally {
    if (requestId === mutationRequestId) savingSupplierIdentity.value = false
  }
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
  const requestId = ++supplierRequestId
  const context = currentPageContext()
  supplierLoading.value = true
  supplierError.value = ''
  try {
    const result = await getSupplier(supplierId.value, requestTeamParams.value)
    if (requestId !== supplierRequestId || !isCurrentPageContext(context)) return false
    supplier.value = result.supplier || result
    return true
  } catch (error) {
    if (requestId === supplierRequestId && isCurrentPageContext(context)) {
      supplier.value = null
      supplierError.value = error?.message || '供应商资料加载失败，请稍后重试'
    }
    return false
  } finally {
    if (requestId === supplierRequestId) supplierLoading.value = false
  }
}

async function loadRecords(category, { force = false } = {}) {
  const state = recordState[category]
  if (!state || state.loading || state.loaded && !force) return
  const requestId = ++state.requestId
  const context = currentPageContext()
  state.loading = true
  state.error = ''
  try {
    const result = await getSupplierRecords(supplierId.value, {
      ...requestTeamParams.value,
      category,
      page: state.page,
      pageSize: state.pageSize
    })
    if (requestId !== state.requestId || !isCurrentPageContext(context)) return false
    state.items = (result.records || []).map(normalizeRecord)
    state.total = Number(result.total) || 0
    state.loaded = true
    return true
  } catch (error) {
    if (requestId === state.requestId && isCurrentPageContext(context)) {
      state.error = error?.message || '合同记录加载失败，请稍后重试'
    }
    return false
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
  recordForm.trusteeAttribute = source.trusteeAttribute || supplier.value?.trusteeAttribute || 'NON_HOSTED'
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
  const requestId = ++detailRequestId
  const context = currentPageContext()
  const result = await getSupplierRecord(record._id, requestTeamParams.value)
  if (requestId !== detailRequestId || !isCurrentPageContext(context)) return null
  return normalizeRecord(result.record || result)
}

async function openViewRecord(record) {
  viewRecord.value = await loadFullRecord(record)
  if (!viewRecord.value) return
  viewVisible.value = true
}

async function openEditRecord(record) {
  const fullRecord = await loadFullRecord(record)
  if (!fullRecord) return
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
  if (submitting.value || deletingId.value) return
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
  const requestId = ++mutationRequestId
  const context = currentPageContext()
  const uploadedFileIds = []
  try {
    const attachments = []
    for (const group of activeConfig.value.attachmentGroups) {
      const prepared = await prepareAttachmentReferences(attachmentFiles[group.purpose] || [], uploadTemporaryFile)
      uploadedFileIds.push(...prepared.uploadedFileIds)
      if (requestId !== mutationRequestId || !isCurrentPageContext(context)) {
        await cleanupTemporaryFiles(uploadedFileIds, deleteFile)
        return
      }
      attachments.push(...prepared.references.map(({ fileId }) => ({ fileId, purpose: group.purpose })))
    }
    const payload = buildRecordPayload(activeConfig.value, recordForm, attachments)
    if (editingRecordId.value) await updateSupplierRecord(editingRecordId.value, payload)
    else await createSupplierRecord(supplierId.value, payload)
    uploadedFileIds.length = 0
    if (requestId !== mutationRequestId || !isCurrentPageContext(context)) return
    ElMessage.success(editingRecordId.value ? '三级明细已更新，汇总已自动刷新' : '三级明细已新增，汇总已自动刷新')
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
    if (requestId === mutationRequestId) submitting.value = false
  }
}

async function handleDeleteRecord(record) {
  if (submitting.value || deletingId.value) return
  const confirmation = confirmationGuard.capture()
  try {
    await ElMessageBox.confirm('确定删除这条三级明细吗？删除后主表和二级汇总会自动更新。', '删除三级明细', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  if (!confirmationGuard.isCurrent(confirmation)) return
  deletingId.value = record._id
  const requestId = ++mutationRequestId
  const context = currentPageContext()
  try {
    const result = await deleteSupplierRecord(record._id, { reason: '后台供应商合同管理删除记录' })
    if (
      requestId !== mutationRequestId ||
      !isCurrentPageContext(context) ||
      !confirmationGuard.isCurrent(confirmation)
    ) return
    const supplierDeleted = Boolean(result?.record?.supplierDeleted)
    ElMessage.success(supplierDeleted
      ? '最后一条三级明细及其派生供应商已删除'
      : '三级明细已删除，主表和二级汇总已自动更新')
    if (record._id === editingRecordId.value) {
      formVisible.value = false
      editingRecordId.value = ''
    }
    if (supplierDeleted) {
      await router.replace({ name: 'SupplierContracts', query: requestTeamParams.value })
      return
    }
    if (activeState.value.items.length === 1 && activeState.value.page > 1) activeState.value.page -= 1
    activeState.value.loaded = false
    await Promise.all([loadSupplier(), loadActiveRecords()])
  } finally {
    if (requestId === mutationRequestId) deletingId.value = ''
  }
}

function deleteEditingRecord() {
  if (!editingRecordId.value) return
  return handleDeleteRecord({ _id: editingRecordId.value })
}

async function handleExport(category = '') {
  const scope = category || 'supplier'
  const requestId = ++exportRequestId
  const context = currentPageContext()
  exportingScope.value = scope
  try {
    const blob = await exportSuppliers({
      ...requestTeamParams.value,
      scope: category ? 'detail' : 'secondary',
      supplierId: supplierId.value,
      category: category || undefined
    })
    if (requestId !== exportRequestId || !isCurrentPageContext(context)) return
    const suffix = category ? activeConfig.value.shortLabel : '二级汇总'
    saveContractBlob(blob, `${supplier.value.code}-${supplier.value.name}-${suffix}.xlsx`)
    ElMessage.success('合同资料已导出')
  } finally {
    if (requestId === exportRequestId) exportingScope.value = ''
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
  const requestId = ++importRequestId
  const context = currentPageContext()
  const file = importFile.value
  importing.value = true
  try {
    await importSuppliers(file, { ...requestTeamParams.value, supplierId: supplierId.value })
    if (requestId !== importRequestId || !isCurrentPageContext(context)) return
    ElMessage.success('供应商合同导入完成')
    importVisible.value = false
    for (const state of Object.values(recordState)) state.loaded = false
    await Promise.all([
      loadSupplier(),
      ...CONTRACT_CATEGORY_CONFIGS.map((config) => loadRecords(config.value, { force: true }))
    ])
  } finally {
    if (requestId === importRequestId) importing.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    loadSupplier(),
    ...CONTRACT_CATEGORY_CONFIGS.map((config) => loadRecords(config.value))
  ])
})
onBeforeUnmount(invalidateDetailPage)
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
.record-context-view, .record-context-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; }
.record-context-view { margin-bottom: 16px; border-top: 1px solid var(--zl-border-soft); border-left: 1px solid var(--zl-border-soft); }
.record-context-view > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--zl-border-soft); border-bottom: 1px solid var(--zl-border-soft); }
.record-context-view dt { color: var(--el-text-color-secondary); font-size: 12px; }
.record-context-view dd { margin-top: 4px; overflow-wrap: anywhere; }
.derived-alert { margin-bottom: 16px; }
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
.dialog-footer-row, .dialog-footer-actions { display: flex; align-items: center; gap: 10px; }
.dialog-footer-row { justify-content: space-between; }
@media (max-width: 1024px) {
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
  .detail-grid, .record-context-view, .record-context-grid, .record-form-grid, .attachment-editor { grid-template-columns: 1fr; }
  .detail-field--wide, .form-field--wide { grid-column: auto; }
  .contact-row { grid-template-columns: 1fr auto; }
  .contact-row .el-input:first-child { grid-column: 1 / -1; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
  .dialog-footer-row { align-items: stretch; flex-direction: column; }
  .dialog-footer-actions, .dialog-footer-actions .el-button { width: 100%; }
}
</style>
