<template>
  <div class="contract-page">
    <header class="page-heading">
      <div>
        <h1>供应商合同管理</h1>
        <p>主表只读汇总三级明细，签订状态和有效性由系统自动计算 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImport" @click="openImport">
          <el-icon><Upload /></el-icon>
          导入三级细表
        </el-button>
        <el-button v-if="canImport" @click="openPdfImport">
          <el-icon><FolderOpened /></el-icon>
          批量导入合同PDF
        </el-button>
        <el-button v-if="canImport" @click="openPaymentImport">
          <el-icon><FolderOpened /></el-icon>
          批量导入打款凭证
        </el-button>
        <el-button v-if="canExport" :loading="exportingScope === 'overview'" @click="handleExport('overview')">
          <el-icon><Download /></el-icon>
          导出主表汇总
        </el-button>
        <el-button v-if="canExport" :loading="exportingScope === 'detail'" @click="handleExport('detail')">
          <el-icon><Download /></el-icon>
          导出汇总
        </el-button>
        <el-button v-if="canManage" type="primary" @click="openFirstRecord">
          <el-icon><Plus /></el-icon>
          新增三级明细
        </el-button>
      </div>
    </header>

    <section class="toolbar contract-toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-input v-model="filters.code" clearable class="code-input" placeholder="供应商编码（精确）" @keyup.enter="applyFilters" />
      <el-input v-model="filters.name" clearable class="name-input" placeholder="供应商名称" @keyup.enter="applyFilters">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.trusteeAttribute" clearable placeholder="托管属性">
        <el-option v-for="item in SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.hasSignedContract" clearable placeholder="是否签订合同">
        <el-option v-for="item in YES_NO_OPTIONS" :key="String(item.value)" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.contractValid" clearable placeholder="合同是否有效">
        <el-option v-for="item in YES_NO_OPTIONS" :key="String(item.value)" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <el-tooltip content="刷新" placement="top">
        <el-button circle :loading="loading" aria-label="刷新供应商合同" @click="loadSuppliers">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </el-tooltip>
    </section>

    <el-alert
      v-if="session.isGlobalReadOnly && !selectedTeamId"
      title="请选择一个项目团队后查看供应商合同"
      type="info"
      :closable="false"
      show-icon
      class="scope-alert"
    />
    <el-alert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
      class="scope-alert"
    >
      <template #default><el-button text type="primary" @click="loadSuppliers">重新加载</el-button></template>
    </el-alert>

    <section v-if="selectedTeamId || !session.isGlobalReadOnly" class="table-shell supplier-table-shell desktop-supplier-table">
      <el-table v-loading="loading" :data="suppliers" row-key="_id" stripe :empty-text="loadError ? '加载失败，请重新加载' : '暂无供应商合同数据'">
        <el-table-column prop="code" label="供应商编码" min-width="130">
          <template #default="{ row }"><strong>{{ row.code || '-' }}</strong></template>
        </el-table-column>
        <el-table-column prop="name" label="供应商名称" min-width="220" />
        <el-table-column label="托管属性" min-width="100">
          <template #default="{ row }">{{ optionLabel(SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS, row.trusteeAttribute) }}</template>
        </el-table-column>
        <el-table-column label="是否签订合同" min-width="126" align="center">
          <template #default="{ row }">
            <el-tag :type="row.hasSignedContract ? 'success' : 'info'" effect="plain">
              {{ row.hasSignedContract ? '已签订' : '未签订' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="合同是否有效" min-width="118" align="center">
          <template #default="{ row }">
            <el-tag :type="contractValidityType(row)" effect="plain">
              {{ contractValidityLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latestContractNumber" label="最新合同编号" min-width="160" show-overflow-tooltip />
        <el-table-column prop="latestContractExpiryDate" label="最新截止日期" min-width="120">
          <template #default="{ row }">{{ formatDate(row.latestContractExpiryDate) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="150" align="right">
          <template #default="{ row }">
            <div class="table-actions table-actions--right">
              <el-button text type="primary" :icon="View" @click="openDetail(row)">进入三级细表</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="selectedTeamId || !session.isGlobalReadOnly" v-loading="loading" class="mobile-supplier-list">
      <el-empty v-if="!loading && !loadError && !suppliers.length" description="暂无供应商合同数据" />
      <article v-for="row in suppliers" :key="row._id" class="mobile-info-item">
        <div class="mobile-item-heading">
          <strong>{{ row.name }}</strong>
          <el-tag effect="plain" size="small">{{ optionLabel(SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS, row.trusteeAttribute) }}</el-tag>
        </div>
        <p class="supplier-code">{{ row.code }}</p>
        <dl class="mobile-info-grid">
          <div><dt>是否签订合同</dt><dd>{{ row.hasSignedContract ? '已签订' : '未签订' }}</dd></div>
          <div><dt>合同是否有效</dt><dd>{{ contractValidityLabel(row) }}</dd></div>
          <div><dt>最新合同编号</dt><dd>{{ row.latestContractNumber || '-' }}</dd></div>
          <div><dt>最新截止日期</dt><dd>{{ formatDate(row.latestContractExpiryDate) }}</dd></div>
        </dl>
        <div class="record-actions">
          <el-button text type="primary" :icon="View" @click="openDetail(row)">进入三级细表</el-button>
        </div>
      </article>
    </section>

    <footer v-if="selectedTeamId || !session.isGlobalReadOnly" class="pagination-row">
      <span>共 {{ total }} 家供应商</span>
      <el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :pager-count="5"
        layout="total, sizes, prev, pager, next, jumper"
        @current-change="loadSuppliers"
        @size-change="applyFilters"
      />
    </footer>

    <el-dialog
      v-model="firstRecordVisible"
      title="新增三级细表记录"
      width="min(940px, 96vw)"
      append-to-body
      :close-on-click-modal="!submittingFirstRecord"
      :close-on-press-escape="!submittingFirstRecord"
      :show-close="!submittingFirstRecord"
    >
      <el-form
        ref="firstRecordFormRef"
        :model="firstRecordForm"
        :rules="firstRecordRules"
        :disabled="submittingFirstRecord"
        label-position="top"
      >
        <section class="record-context-grid">
          <el-form-item label="供应商名称" prop="supplierName">
            <el-input v-model="firstRecordForm.supplierName" maxlength="200" />
          </el-form-item>
          <el-form-item label="供应商编码" prop="supplierCode">
            <el-input v-model="firstRecordForm.supplierCode" maxlength="100" placeholder="按文本保存，可保留前导零" />
          </el-form-item>
          <el-form-item label="托管属性" prop="trusteeAttribute">
            <el-segmented v-model="firstRecordForm.trusteeAttribute" :options="SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS" />
          </el-form-item>
          <el-form-item label="明细类别" prop="category">
            <el-select v-model="firstRecordForm.category" class="full-width" @change="resetFirstRecordFields">
              <el-option v-for="config in CONTRACT_CATEGORY_CONFIGS" :key="config.value" :label="config.label" :value="config.value" />
            </el-select>
          </el-form-item>
        </section>
        <el-alert
          title="供应商主表、二级汇总、是否签订合同和合同是否有效均由三级明细关联生成"
          type="info"
          :closable="false"
          show-icon
          class="derived-alert"
        />
        <div class="record-form-grid">
          <el-form-item
            v-for="item in firstRecordConfig.fields"
            :key="item.key"
            :label="item.label"
            :class="{ 'form-field--wide': item.span === 2 }"
          >
            <el-select v-if="item.type === 'signingStatus'" v-model="firstRecordForm[item.key]" class="full-width">
              <el-option v-for="option in SIGNING_STATUS_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-segmented v-else-if="item.type === 'boolean'" v-model="firstRecordForm[item.key]" :options="YES_NO_OPTIONS" />
            <el-date-picker v-else-if="item.type === 'date'" v-model="firstRecordForm[item.key]" type="date" value-format="YYYY-MM-DD" class="full-width" />
            <el-select v-else-if="item.type === 'select'" v-model="firstRecordForm[item.key]" clearable class="full-width">
              <el-option v-for="option in item.options" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-select
              v-else-if="item.type === 'tags'"
              v-model="firstRecordForm[item.key]"
              multiple
              filterable
              allow-create
              default-first-option
              :placeholder="item.placeholder"
              class="full-width"
            />
            <div v-else-if="item.type === 'contacts'" class="contacts-editor">
              <div v-for="(contact, index) in firstRecordForm.contacts" :key="index" class="contact-row">
                <el-input v-model="contact.name" maxlength="100" placeholder="联系人姓名" />
                <el-input v-model="contact.phone" maxlength="100" placeholder="联系电话" />
                <el-tooltip content="删除联系人" placement="top">
                  <el-button circle :icon="Delete" aria-label="删除联系人" @click="removeFirstRecordContact(index)" />
                </el-tooltip>
              </div>
              <el-button :icon="Plus" @click="addFirstRecordContact">添加联系人</el-button>
            </div>
            <el-input
              v-else-if="item.type === 'textarea'"
              v-model="firstRecordForm[item.key]"
              type="textarea"
              :rows="3"
              :maxlength="item.maxlength || 2000"
              show-word-limit
            />
            <el-input v-else v-model="firstRecordForm[item.key]" maxlength="500" />
          </el-form-item>
        </div>
        <section class="attachment-editor">
          <div v-for="group in firstRecordConfig.attachmentGroups" :key="group.purpose" class="attachment-field">
            <h3>{{ group.label }}</h3>
            <ContractFileUpload v-model="firstRecordAttachmentFiles[group.purpose]" :accept="group.accept" />
          </div>
        </section>
      </el-form>
      <template #footer>
        <el-button :disabled="submittingFirstRecord" @click="firstRecordVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingFirstRecord" @click="submitFirstRecord">保存三级明细</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="importVisible"
      title="导入供应商合同"
      width="min(620px, 94vw)"
      append-to-body
      :close-on-click-modal="!importing"
      :show-close="!importing"
    >
      <el-alert
        title="请使用57列三级细表模板（D列为托管属性）；W、BC、BD三列附件先留空，导入后再单独上传"
        type="info"
        :closable="false"
        show-icon
      />
      <el-alert
        class="import-attachment-note"
        title="W列/BC列合同PDF：用“批量导入合同PDF”上传；BD列打款凭证：进入对应器具租赁明细，在“打款凭证”栏上传。Excel里不要填写文件名、路径或URL。"
        type="warning"
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

    <el-dialog
      v-model="pdfImportVisible"
      title="批量导入合同PDF"
      width="min(680px, 94vw)"
      append-to-body
      :close-on-click-modal="!pdfImporting"
      :show-close="!pdfImporting"
    >
      <el-alert
        title="把PDF放进一个ZIP后上传，文件名按“供应商编码__合同编号.pdf”；同一供应商只有一条合同时可只写供应商编码"
        type="info"
        :closable="false"
        show-icon
      />
      <el-alert
        class="pdf-import-note"
        title="系统只会绑定已有的主合同或器具租赁合同，不会新建合同记录；匹配不完整时整包不写入"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-upload
        v-model:file-list="pdfImportFiles"
        drag
        :auto-upload="false"
        :limit="1"
        accept=".zip,application/zip,application/x-zip-compressed"
        class="import-upload"
        :on-change="handlePdfImportFileChange"
      >
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖入 ZIP 压缩包，或<em>点击选择</em></div>
        <template #tip><div class="el-upload__tip">仅支持 PDF，压缩包不超过 220 MB，单个 PDF 不超过 20 MB</div></template>
      </el-upload>
      <template #footer>
        <el-button :disabled="pdfImporting" @click="pdfImportVisible = false">取消</el-button>
        <el-button type="primary" :loading="pdfImporting" :disabled="!pdfImportFile" @click="submitPdfImport">开始匹配并导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="paymentImportVisible" title="批量导入打款凭证" width="min(680px, 94vw)" append-to-body :close-on-click-modal="!paymentImporting" :show-close="!paymentImporting">
      <el-alert title="把打款凭证放进一个ZIP后上传，支持 PDF、JPG、JPEG、PNG；文件名按“供应商编码__合同编号.扩展名”命名" type="info" :closable="false" show-icon />
      <el-alert class="pdf-import-note" title="系统只绑定已有的器具租赁记录；匹配不完整时整包不写入，单条记录最多10个附件" type="warning" :closable="false" show-icon />
      <el-upload v-model:file-list="paymentImportFiles" drag :auto-upload="false" :limit="1" accept=".zip,application/zip,application/x-zip-compressed" class="import-upload" :on-change="handlePaymentImportFileChange">
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖入 ZIP 压缩包，或<em>点击选择</em></div>
        <template #tip><div class="el-upload__tip">压缩包不超过220MB，单个凭证不超过20MB</div></template>
      </el-upload>
      <template #footer>
        <el-button :disabled="paymentImporting" @click="paymentImportVisible = false">取消</el-button>
        <el-button type="primary" :loading="paymentImporting" :disabled="!paymentImportFile" @click="submitPaymentImport">开始匹配并导入</el-button>
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
import { Delete, FolderOpened, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import ContractFileUpload from './components/ContractFileUpload.vue'
import {
  createSupplierFirstRecord,
  exportSuppliers,
  getSuppliers,
  importSupplierContractPdfs,
  importSupplierPaymentReceipts,
  importSuppliers
} from '@/api/contract'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import { cleanupTemporaryFiles, prepareAttachmentReferences } from '@/utils/attachments'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import {
  CONTRACT_CATEGORY_CONFIGS,
  SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS,
  SIGNING_STATUS_OPTIONS,
  YES_NO_OPTIONS,
  buildRecordPayload,
  emptyRecordDetails,
  optionLabel,
  saveContractBlob
} from '@/utils/contract'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const loadError = ref('')
const exportingScope = ref('')
const importing = ref(false)
const importVisible = ref(false)
const pdfImportVisible = ref(false)
const pdfImporting = ref(false)
const paymentImportVisible = ref(false)
const paymentImporting = ref(false)
const firstRecordVisible = ref(false)
const firstRecordFormRef = ref(null)
const submittingFirstRecord = ref(false)
const firstRecordAttachmentFiles = reactive({})
const importFiles = ref([])
const importFile = ref(null)
const pdfImportFiles = ref([])
const pdfImportFile = ref(null)
const paymentImportFiles = ref([])
const paymentImportFile = ref(null)
const suppliers = ref([])
const total = ref(0)
const selectedTeamId = ref(String(route.query.teamId || ''))
let listRequestId = 0
let exportRequestId = 0
let firstRecordSubmitRequestId = 0
let importRequestId = 0
let pdfImportRequestId = 0
let paymentImportRequestId = 0
let activationReady = false
let pageActive = true
let resumeListLoad = false
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.CONTRACT_SUPPLIERS
})

const filters = reactive({
  code: '',
  name: '',
  trusteeAttribute: '',
  hasSignedContract: '',
  contractValid: '',
  page: 1,
  pageSize: 20
})
const firstRecordForm = reactive({})
const firstRecordRules = {
  supplierName: [{ required: true, message: '请输入供应商名称', trigger: 'blur' }],
  supplierCode: [{ required: true, message: '请输入供应商编码', trigger: 'blur' }],
  trusteeAttribute: [{ required: true, message: '请选择托管属性', trigger: 'change' }],
  category: [{ required: true, message: '请选择明细类别', trigger: 'change' }]
}

const canManage = computed(() => session.can('contract.supplier.manage', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('contract.supplier.import', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('contract.supplier.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const firstRecordConfig = computed(() => (
  CONTRACT_CATEGORY_CONFIGS.find((config) => config.value === firstRecordForm.category)
  || CONTRACT_CATEGORY_CONFIGS[0]
))

function currentTeamContextId() {
  return String(session.isGlobalReadOnly ? selectedTeamId.value : session.activeTeamId || '')
}

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
    current.routeName === 'SupplierContracts' &&
    current.routeName === context.routeName &&
    current.routeTeamId === context.routeTeamId &&
    current.contextEpoch === context.contextEpoch &&
    current.teamId === context.teamId
}

function queryParams() {
  return {
    ...requestTeamParams.value,
    code: filters.code.trim() || undefined,
    name: filters.name.trim() || undefined,
    trusteeAttribute: filters.trusteeAttribute || undefined,
    hasSignedContract: filters.hasSignedContract === '' ? undefined : filters.hasSignedContract,
    contractValid: filters.contractValid === '' ? undefined : filters.contractValid,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

function formatDate(value) {
  return value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : '-'
}

function contractValidityLabel(row) {
  return row?.contractValid ? '有效' : '到期'
}

function contractValidityType(row) {
  return row?.contractValid ? 'success' : 'danger'
}

async function loadSuppliers() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    suppliers.value = []
    total.value = 0
    return true
  }
  const loadStartRevision = mutationRefresh.currentRevision()
  const requestId = ++listRequestId
  const context = currentPageContext()
  loading.value = true
  loadError.value = ''
  try {
    const result = await getSuppliers(queryParams())
    if (requestId !== listRequestId || !isCurrentPageContext(context)) return false
    suppliers.value = result.suppliers || []
    total.value = Number(result.total) || 0
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } catch (error) {
    if (requestId === listRequestId && isCurrentPageContext(context)) {
      loadError.value = error?.message || '供应商合同加载失败，请稍后重试'
    }
    return false
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

function invalidateSupplierResults() {
  listRequestId += 1
  exportRequestId += 1
  firstRecordSubmitRequestId += 1
  importRequestId += 1
  pdfImportRequestId += 1
  paymentImportRequestId += 1
  suppliers.value = []
  total.value = 0
  loading.value = false
  exportingScope.value = ''
  submittingFirstRecord.value = false
  importing.value = false
  pdfImporting.value = false
  paymentImporting.value = false
  loadError.value = ''
  firstRecordVisible.value = false
  importVisible.value = false
  pdfImportVisible.value = false
  paymentImportVisible.value = false
  importFiles.value = []
  importFile.value = null
  pdfImportFiles.value = []
  pdfImportFile.value = null
  paymentImportFiles.value = []
  paymentImportFile.value = null
}

function applyFilters() {
  filters.page = 1
  loadSuppliers()
}

function resetFilterState() {
  Object.assign(filters, {
    code: '',
    name: '',
    trusteeAttribute: '',
    hasSignedContract: '',
    contractValid: '',
    page: 1
  })
}

function resetFilters() {
  resetFilterState()
  return loadSuppliers()
}

async function handleTeamChange(teamId) {
  invalidateSupplierResults()
  resetFilterState()
  await router.replace({ query: teamId ? { teamId } : {} })
  if (
    String(route.query.teamId || '') !== String(teamId || '') ||
    String(selectedTeamId.value || '') !== String(teamId || '')
  ) return
  await loadSuppliers()
}

function resetFirstRecordFields() {
  const identity = {
    supplierName: firstRecordForm.supplierName || '',
    supplierCode: firstRecordForm.supplierCode || '',
    trusteeAttribute: firstRecordForm.trusteeAttribute || 'NON_HOSTED',
    category: firstRecordForm.category || CONTRACT_CATEGORY_CONFIGS[0].value
  }
  for (const key of Object.keys(firstRecordForm)) delete firstRecordForm[key]
  Object.assign(firstRecordForm, identity, emptyRecordDetails(firstRecordConfig.value))
  firstRecordForm.signingStatus ||= 'UNSIGNED'
  if (firstRecordForm.category === 'SUPPLIER_INFO') firstRecordForm.supplyStatus ||= 'NORMAL'
  if (firstRecordConfig.value.fields.some((item) => item.key === 'contacts')) {
    firstRecordForm.contacts = [{ name: '', phone: '' }]
  }
  for (const key of Object.keys(firstRecordAttachmentFiles)) delete firstRecordAttachmentFiles[key]
  for (const group of firstRecordConfig.value.attachmentGroups) firstRecordAttachmentFiles[group.purpose] = []
  firstRecordFormRef.value?.clearValidate()
}

function openFirstRecord() {
  for (const key of Object.keys(firstRecordForm)) delete firstRecordForm[key]
  Object.assign(firstRecordForm, {
    supplierName: '',
    supplierCode: '',
    trusteeAttribute: 'NON_HOSTED',
    category: CONTRACT_CATEGORY_CONFIGS[0].value
  })
  resetFirstRecordFields()
  firstRecordVisible.value = true
}

function addFirstRecordContact() {
  if (!Array.isArray(firstRecordForm.contacts)) firstRecordForm.contacts = []
  firstRecordForm.contacts.push({ name: '', phone: '' })
}

function removeFirstRecordContact(index) {
  firstRecordForm.contacts.splice(index, 1)
  if (!firstRecordForm.contacts.length) addFirstRecordContact()
}

async function submitFirstRecord() {
  if (submittingFirstRecord.value) return
  const valid = await firstRecordFormRef.value?.validate().catch(() => false)
  if (!valid) return
  const supplierName = String(firstRecordForm.supplierName || '').trim()
  const supplierCode = String(firstRecordForm.supplierCode || '').trim()
  if (!supplierName || !supplierCode) {
    ElMessage.warning('供应商名称和供应商编码不能只填写空格')
    return
  }
  if (firstRecordForm.effectiveDate && firstRecordForm.expiryDate && dayjs(firstRecordForm.expiryDate).isBefore(firstRecordForm.effectiveDate, 'day')) {
    ElMessage.warning('截止日期不能早于生效日期')
    return
  }
  if (Array.isArray(firstRecordForm.reconciliationEmails)) {
    const invalidEmail = firstRecordForm.reconciliationEmails.find((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()))
    if (invalidEmail) {
      ElMessage.warning(`对账邮箱“${invalidEmail}”格式不正确`)
      return
    }
  }
  const config = firstRecordConfig.value
  const attachmentFiles = new Map(config.attachmentGroups.map((group) => [
    group.purpose,
    [...(firstRecordAttachmentFiles[group.purpose] || [])]
  ]))
  const totalAttachments = config.attachmentGroups.reduce(
    (sum, group) => sum + (attachmentFiles.get(group.purpose)?.length || 0),
    0
  )
  if (totalAttachments > 10) {
    ElMessage.warning('同一条记录最多上传 10 个附件，请删除多余附件后再保存')
    return
  }

  submittingFirstRecord.value = true
  const submitRequestId = ++firstRecordSubmitRequestId
  const submitContext = currentPageContext()
  const submittedTeamParams = { ...requestTeamParams.value }
  const uploadedFileIds = []
  try {
    const attachments = []
    for (const group of config.attachmentGroups) {
      const prepared = await prepareAttachmentReferences(attachmentFiles.get(group.purpose) || [], uploadTemporaryFile)
      uploadedFileIds.push(...prepared.uploadedFileIds)
      attachments.push(...prepared.references.map(({ fileId }) => ({ fileId, purpose: group.purpose })))
      if (
        submitRequestId !== firstRecordSubmitRequestId ||
        !isCurrentPageContext(submitContext)
      ) {
        await cleanupTemporaryFiles(uploadedFileIds, deleteFile)
        uploadedFileIds.length = 0
        return
      }
    }
    const payload = {
      ...buildRecordPayload(config, firstRecordForm, attachments),
      supplierIdentity: { name: supplierName, code: supplierCode },
      trusteeAttribute: firstRecordForm.trusteeAttribute
    }
    const result = await createSupplierFirstRecord(payload)
    uploadedFileIds.length = 0
    if (
      submitRequestId !== firstRecordSubmitRequestId ||
      !isCurrentPageContext(submitContext)
    ) return
    firstRecordVisible.value = false
    ElMessage.success('三级明细已新增，主表和二级汇总已自动更新')
    await loadSuppliers()
    if (
      submitRequestId !== firstRecordSubmitRequestId ||
      !isCurrentPageContext(submitContext)
    ) return
    const createdSupplierId = result?.supplier?._id
    if (createdSupplierId) {
      router.push({
        name: 'SupplierContractDetail',
        params: { supplierId: createdSupplierId },
        query: submittedTeamParams
      })
    }
  } catch (error) {
    await cleanupTemporaryFiles(
      [...uploadedFileIds, ...(error.uploadedFileIds || [])],
      deleteFile
    )
    if (
      submitRequestId === firstRecordSubmitRequestId &&
      isCurrentPageContext(submitContext)
    ) throw error
  } finally {
    if (submitRequestId === firstRecordSubmitRequestId) submittingFirstRecord.value = false
  }
}

function openDetail(row) {
  router.push({
    name: 'SupplierContractDetail',
    params: { supplierId: row._id },
    query: requestTeamParams.value
  })
}

async function handleExport(scope) {
  if (exportingScope.value) return
  const requestId = ++exportRequestId
  const context = currentPageContext()
  exportingScope.value = scope
  try {
    const params = scope === 'overview'
      ? { ...queryParams(), scope: 'overview', page: undefined, pageSize: undefined }
      : { ...requestTeamParams.value, scope: 'detail' }
    const blob = await exportSuppliers(params)
    if (requestId !== exportRequestId || !isCurrentPageContext(context)) return
    const label = scope === 'overview' ? '主表汇总' : '三级汇总'
    saveContractBlob(blob, `供应商合同-${label}-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
    ElMessage.success(`${label}已导出`)
  } finally {
    if (requestId === exportRequestId) exportingScope.value = ''
  }
}

function openImport() {
  importFiles.value = []
  importFile.value = null
  importVisible.value = true
}

function openPdfImport() {
  pdfImportFiles.value = []
  pdfImportFile.value = null
  pdfImportVisible.value = true
}

function openPaymentImport() {
  paymentImportFiles.value = []
  paymentImportFile.value = null
  paymentImportVisible.value = true
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

function handlePdfImportFileChange(file, files) {
  if (!file.raw || !/\.zip$/i.test(file.raw.name || '')) {
    ElMessage.warning('请选择 .zip 格式的PDF压缩包')
    pdfImportFiles.value = files.filter((item) => item.uid !== file.uid)
    pdfImportFile.value = null
    return
  }
  pdfImportFile.value = file.raw
}

function handlePaymentImportFileChange(file, files) {
  if (!file.raw || !/\.zip$/i.test(file.raw.name || '')) {
    ElMessage.warning('请选择 .zip 格式的打款凭证压缩包')
    paymentImportFiles.value = files.filter((item) => item.uid !== file.uid)
    paymentImportFile.value = null
    return
  }
  paymentImportFile.value = file.raw
}

async function submitImport() {
  if (!importFile.value) return
  const requestId = ++importRequestId
  const context = currentPageContext()
  const file = importFile.value
  const teamParams = { ...requestTeamParams.value }
  importing.value = true
  try {
    const result = await importSuppliers(file, teamParams)
    if (requestId !== importRequestId || !isCurrentPageContext(context)) return
    const count = Number(result.importedCount ?? result.createdCount ?? result.totalImported)
    ElMessage.success(Number.isFinite(count) ? `已导入 ${count} 条三级明细数据` : '三级细表导入完成')
    importVisible.value = false
    filters.page = 1
    await loadSuppliers()
  } finally {
    if (requestId === importRequestId) importing.value = false
  }
}

async function submitPdfImport() {
  if (!pdfImportFile.value) return
  const requestId = ++pdfImportRequestId
  const context = currentPageContext()
  const file = pdfImportFile.value
  const teamParams = { ...requestTeamParams.value }
  pdfImporting.value = true
  try {
    const result = await importSupplierContractPdfs(file, teamParams)
    if (requestId !== pdfImportRequestId || !isCurrentPageContext(context)) return
    const imported = Number(result.importedCount) || 0
    const skipped = Number(result.skippedExisting) || 0
    ElMessage.success(`已匹配 ${result.matchedCount || 0} 个文件，导入 ${imported} 个，跳过重复 ${skipped} 个`)
    pdfImportVisible.value = false
    await loadSuppliers()
  } catch (error) {
    if (requestId === pdfImportRequestId && isCurrentPageContext(context)) {
      ElMessage.error(error?.message || '合同PDF批量导入失败，请稍后重试')
    }
  } finally {
    if (requestId === pdfImportRequestId) pdfImporting.value = false
  }
}

async function submitPaymentImport() {
  if (!paymentImportFile.value) return
  const requestId = ++paymentImportRequestId
  const context = currentPageContext()
  paymentImporting.value = true
  try {
    const result = await importSupplierPaymentReceipts(paymentImportFile.value, { ...requestTeamParams.value })
    if (requestId !== paymentImportRequestId || !isCurrentPageContext(context)) return
    ElMessage.success(`已匹配 ${result.matchedCount || 0} 个文件，导入 ${result.importedCount || 0} 个，跳过重复 ${result.skippedExisting || 0} 个`)
    paymentImportVisible.value = false
    await loadSuppliers()
  } catch (error) {
    if (requestId === paymentImportRequestId && isCurrentPageContext(context)) ElMessage.error(error?.message || '打款凭证批量导入失败，请稍后重试')
  } finally {
    if (requestId === paymentImportRequestId) paymentImporting.value = false
  }
}

async function syncRouteTeamContext({ force = false } = {}) {
  if (!pageActive || route.name !== 'SupplierContracts') return false
  const routedTeamId = session.isGlobalReadOnly ? String(route.query.teamId || '') : ''
  const teamChanged = session.isGlobalReadOnly && routedTeamId !== selectedTeamId.value
  if (!force && !teamChanged) return false
  if (teamChanged) selectedTeamId.value = routedTeamId
  invalidateSupplierResults()
  resetFilterState()
  if (session.isGlobalReadOnly && !selectedTeamId.value) return true
  await loadSuppliers()
  return true
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
    if (selectedTeamId.value) await router.replace({ query: { teamId: selectedTeamId.value } })
  }
  await loadSuppliers()
}

onMounted(async () => {
  try {
    await initialize()
  } finally {
    activationReady = true
  }
})
onActivated(() => {
  pageActive = true
  if (!activationReady) return
  const interrupted = resumeListLoad
  resumeListLoad = false
  void syncRouteTeamContext().then((changed) => {
    if (changed) return
    if (interrupted) return loadSuppliers()
    return mutationRefresh.refreshIfNeeded(loadSuppliers)
  }).catch(() => {})
})
watch(() => [route.name, route.query.teamId], () => {
  if (pageActive && activationReady) void syncRouteTeamContext()
})
watch(() => session.contextEpoch, () => {
  if (pageActive && activationReady) void syncRouteTeamContext({ force: true })
  else invalidateSupplierResults()
})

function deactivateSupplierContracts() {
  resumeListLoad = resumeListLoad || loading.value
  pageActive = false
  listRequestId += 1
  exportRequestId += 1
  firstRecordSubmitRequestId += 1
  importRequestId += 1
  pdfImportRequestId += 1
  paymentImportRequestId += 1
  loading.value = false
  exportingScope.value = ''
  submittingFirstRecord.value = false
  importing.value = false
  pdfImporting.value = false
  paymentImporting.value = false
  firstRecordVisible.value = false
  importVisible.value = false
  pdfImportVisible.value = false
  paymentImportVisible.value = false
  importFiles.value = []
  importFile.value = null
  pdfImportFiles.value = []
  pdfImportFile.value = null
  paymentImportFiles.value = []
  paymentImportFile.value = null
}

onDeactivated(deactivateSupplierContracts)
onBeforeUnmount(deactivateSupplierContracts)
</script>

<style scoped lang="scss">
.contract-page { min-width: 0; }
.page-heading p { margin-top: 6px; color: var(--el-text-color-secondary); }
.contract-toolbar { margin-bottom: 16px; }
.contract-toolbar .team-select { width: 190px; }
.contract-toolbar .code-input { width: 190px; }
.contract-toolbar .name-input { width: 230px; }
.contract-toolbar .el-select { width: 150px; }
.scope-alert { margin-bottom: 16px; }
.pdf-import-note { margin-top: 12px; }
.supplier-table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 6px; }
.mobile-supplier-list { display: none; }
.table-actions--right { justify-content: flex-end; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--el-text-color-secondary); }
.import-upload { margin-top: 18px; }
.import-attachment-note { margin-top: 12px; }
.record-context-grid, .record-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.derived-alert { margin-bottom: 16px; }
.form-field--wide { grid-column: 1 / -1; }
.full-width { width: 100%; }
.contacts-editor { display: grid; width: 100%; gap: 8px; }
.contact-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; }
.attachment-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; padding-top: 16px; border-top: 1px solid var(--zl-border-soft); }
.attachment-field { min-width: 0; }
.attachment-field h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
@media (max-width: 900px) {
  .contract-toolbar > *,
  .contract-toolbar .team-select,
  .contract-toolbar .code-input,
  .contract-toolbar .name-input,
  .contract-toolbar .el-select { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
  .pagination-row :deep(.el-pagination__sizes),
  .pagination-row :deep(.el-pagination__jump) { display: none; }
  .record-context-grid, .record-form-grid, .attachment-editor { grid-template-columns: 1fr; }
  .form-field--wide { grid-column: auto; }
  .contact-row { grid-template-columns: 1fr auto; }
  .contact-row .el-input:first-child { grid-column: 1 / -1; }
}
@media (max-width: 1180px) {
  .desktop-supplier-table { display: none; }
  .mobile-supplier-list { display: block; min-height: 150px; border-block: 1px solid var(--zl-border-soft); }
  .mobile-info-item { padding: 15px 2px; border-bottom: 1px solid var(--zl-border-soft); }
  .mobile-item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .supplier-code { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 13px; }
  .mobile-info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin-top: 12px; }
  .mobile-info-grid dt { color: var(--el-text-color-secondary); font-size: 12px; }
  .mobile-info-grid dd { margin-top: 3px; overflow-wrap: anywhere; }
  .record-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
}
</style>
