<template>
  <div class="contract-page">
    <header class="page-heading">
      <div>
        <h1>供应商合同管理</h1>
        <p>按供应商统一维护基本资料和各类合同历史 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImport" @click="openImport">
          <el-icon><Upload /></el-icon>
          导入 Excel
        </el-button>
        <el-button v-if="canExport" :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出当前结果
        </el-button>
        <el-button v-if="canManage" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建供应商
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
        <el-table-column label="主合同" min-width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="row.hasSignedContract ? 'success' : 'info'" effect="plain">
              {{ row.hasSignedContract ? '已签订' : '未签订' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="合同有效性" min-width="118" align="center">
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
        <el-table-column label="操作" min-width="210" align="right">
          <template #default="{ row }">
            <div class="table-actions table-actions--right">
              <el-button text type="primary" :icon="View" @click="openDetail(row)">查看</el-button>
              <el-button v-if="canManage" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button
                v-if="canManage"
                text
                type="danger"
                :icon="Delete"
                :loading="deletingId === row._id"
                @click="handleDelete(row)"
              >删除</el-button>
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
          <div><dt>主合同</dt><dd>{{ row.hasSignedContract ? '已签订' : '未签订' }}</dd></div>
          <div><dt>合同有效性</dt><dd>{{ contractValidityLabel(row) }}</dd></div>
          <div><dt>最新合同编号</dt><dd>{{ row.latestContractNumber || '-' }}</dd></div>
          <div><dt>最新截止日期</dt><dd>{{ formatDate(row.latestContractExpiryDate) }}</dd></div>
        </dl>
        <div class="record-actions">
          <el-button text type="primary" :icon="View" @click="openDetail(row)">查看</el-button>
          <el-button v-if="canManage" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
          <el-button
            v-if="canManage"
            text
            type="danger"
            :icon="Delete"
            :loading="deletingId === row._id"
            @click="handleDelete(row)"
          >删除</el-button>
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
      v-model="formVisible"
      :title="editingId ? '编辑供应商' : '新建供应商'"
      width="min(620px, 94vw)"
      :close-on-click-modal="!submitting"
      :close-on-press-escape="!submitting"
      :show-close="!submitting"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="112px">
        <el-form-item label="供应商名称" prop="name">
          <el-input v-model="form.name" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="供应商编码" prop="code">
          <el-input v-model="form.code" maxlength="100" placeholder="按文本保存，可保留前导零" />
        </el-form-item>
        <el-form-item label="托管属性" prop="trusteeAttribute">
          <el-segmented v-model="form.trusteeAttribute" :options="SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS" />
        </el-form-item>
        <el-form-item label="是否签订合同">
          <el-input :model-value="editingSupplier?.hasSignedContract ? '已签订' : '由主合同自动计算'" disabled />
        </el-form-item>
        <el-form-item label="合同是否有效">
          <el-input :model-value="editingSupplier ? contractValidityLabel(editingSupplier) : '由主合同自动计算'" disabled />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="submitting" @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="importVisible"
      title="导入供应商合同"
      width="min(620px, 94vw)"
      :close-on-click-modal="!importing"
      :show-close="!importing"
    >
      <el-alert
        title="请使用供应商合同管理模板，系统将按供应商编码导入五类合同资料"
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
import { Delete, Edit, View } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createSupplier,
  deleteSupplier,
  exportSuppliers,
  getSuppliers,
  importSuppliers,
  updateSupplier
} from '@/api/contract'
import { useSessionStore } from '@/stores/session'
import {
  SUPPLIER_TRUSTEE_ATTRIBUTE_OPTIONS,
  YES_NO_OPTIONS,
  optionLabel,
  saveContractBlob
} from '@/utils/contract'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const loadError = ref('')
const exporting = ref(false)
const submitting = ref(false)
const importing = ref(false)
const deletingId = ref('')
const formVisible = ref(false)
const importVisible = ref(false)
const editingId = ref('')
const editingSupplier = ref(null)
const formRef = ref(null)
const importFiles = ref([])
const importFile = ref(null)
const suppliers = ref([])
const total = ref(0)
const selectedTeamId = ref(String(route.query.teamId || ''))
let listRequestId = 0

const filters = reactive({
  code: '',
  name: '',
  trusteeAttribute: '',
  hasSignedContract: '',
  contractValid: '',
  page: 1,
  pageSize: 20
})
const form = reactive(emptyForm())
const rules = {
  name: [{ required: true, message: '请输入供应商名称', trigger: 'blur' }],
  code: [{ required: true, message: '请输入供应商编码', trigger: 'blur' }],
  trusteeAttribute: [{ required: true, message: '请选择托管属性', trigger: 'change' }]
}

const canManage = computed(() => session.can('contract.supplier.manage', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('contract.supplier.import', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('contract.supplier.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))

function emptyForm() {
  return { name: '', code: '', trusteeAttribute: 'NON_HOSTED' }
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
  if (!row?.hasSignedContract) return '无主合同'
  return row.contractValid ? '有效' : '无效'
}

function contractValidityType(row) {
  if (!row?.hasSignedContract) return 'info'
  return row.contractValid ? 'success' : 'danger'
}

async function loadSuppliers() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    suppliers.value = []
    total.value = 0
    return
  }
  const requestId = ++listRequestId
  loading.value = true
  loadError.value = ''
  try {
    const result = await getSuppliers(queryParams())
    if (requestId !== listRequestId) return
    suppliers.value = result.suppliers || []
    total.value = Number(result.total) || 0
  } catch (error) {
    if (requestId === listRequestId) loadError.value = error?.message || '供应商合同加载失败，请稍后重试'
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

function applyFilters() {
  filters.page = 1
  loadSuppliers()
}

function resetFilters() {
  Object.assign(filters, {
    code: '',
    name: '',
    trusteeAttribute: '',
    hasSignedContract: '',
    contractValid: '',
    page: 1
  })
  loadSuppliers()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: teamId ? { teamId } : {} })
  resetFilters()
}

function resetForm() {
  editingId.value = ''
  editingSupplier.value = null
  Object.assign(form, emptyForm())
  formRef.value?.clearValidate()
}

function openCreate() {
  resetForm()
  formVisible.value = true
}

function openEdit(row) {
  editingId.value = row._id
  editingSupplier.value = row
  Object.assign(form, {
    name: row.name || '',
    code: String(row.code || ''),
    trusteeAttribute: row.trusteeAttribute || 'NON_HOSTED'
  })
  formVisible.value = true
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (!form.name.trim() || !String(form.code).trim()) {
    ElMessage.warning('供应商名称和供应商编码不能只填写空格')
    return
  }
  submitting.value = true
  try {
    const payload = {
      name: form.name.trim(),
      code: String(form.code).trim(),
      trusteeAttribute: form.trusteeAttribute
    }
    if (editingId.value) await updateSupplier(editingId.value, payload)
    else await createSupplier(payload)
    ElMessage.success(editingId.value ? '供应商已更新' : '供应商已创建')
    formVisible.value = false
    await loadSuppliers()
  } finally {
    submitting.value = false
  }
}

function openDetail(row) {
  router.push({
    name: 'SupplierContractDetail',
    params: { supplierId: row._id },
    query: requestTeamParams.value
  })
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除空供应商“${row.name}”吗？已有合同或结算费用时系统会阻止删除。`,
      '删除供应商',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  deletingId.value = row._id
  try {
    await deleteSupplier(row._id, { reason: '后台供应商合同管理删除' })
    ElMessage.success('供应商已删除')
    if (suppliers.value.length === 1 && filters.page > 1) filters.page -= 1
    await loadSuppliers()
  } finally {
    deletingId.value = ''
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await exportSuppliers({ ...queryParams(), page: undefined, pageSize: undefined })
    saveContractBlob(blob, `供应商合同-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
    ElMessage.success('供应商合同已导出')
  } finally {
    exporting.value = false
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
    const result = await importSuppliers(importFile.value, requestTeamParams.value)
    const count = Number(result.importedCount ?? result.createdCount ?? result.totalImported)
    ElMessage.success(Number.isFinite(count) ? `已导入 ${count} 条供应商合同数据` : '供应商合同导入完成')
    importVisible.value = false
    filters.page = 1
    await loadSuppliers()
  } finally {
    importing.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
    if (selectedTeamId.value) await router.replace({ query: { teamId: selectedTeamId.value } })
  }
  await loadSuppliers()
}

onMounted(initialize)
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
.supplier-table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 6px; }
.mobile-supplier-list { display: none; }
.table-actions--right { justify-content: flex-end; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--el-text-color-secondary); }
.import-upload { margin-top: 18px; }
@media (max-width: 900px) {
  .contract-toolbar > *,
  .contract-toolbar .team-select,
  .contract-toolbar .code-input,
  .contract-toolbar .name-input,
  .contract-toolbar .el-select { width: 100%; }
  .pagination-row { align-items: flex-start; flex-direction: column; }
  .pagination-row :deep(.el-pagination__sizes),
  .pagination-row :deep(.el-pagination__jump) { display: none; }
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
