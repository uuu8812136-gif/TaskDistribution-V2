<template>
  <div class="contract-page">
    <header class="page-heading">
      <div>
        <h1>供应商结算费用</h1>
        <p>按月份维护供应商结算金额，合同状态由供应商合同实时关联。</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImport" @click="openImport">
          <el-icon><Upload /></el-icon>
          导入月度费用
        </el-button>
        <el-button v-if="canExport" :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出当前结果
        </el-button>
        <el-button v-if="canManage" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新增结算费用
        </el-button>
      </div>
    </header>

    <section class="toolbar settlement-toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
      <el-date-picker v-model="filters.month" type="month" value-format="YYYY-MM" placeholder="月份" />
      <el-input v-model="filters.supplierCode" clearable placeholder="供应商编码（精确）" @keyup.enter="applyFilters" />
      <el-input v-model="filters.supplierName" clearable placeholder="供应商名称" @keyup.enter="applyFilters">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.hasSignedContract" clearable placeholder="是否签订合同">
        <el-option v-for="item in YES_NO_OPTIONS" :key="String(item.value)" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.contractValid" clearable placeholder="合同是否有效">
        <el-option v-for="item in YES_NO_OPTIONS" :key="String(item.value)" :label="item.label" :value="item.value" />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <el-tooltip content="刷新" placement="top">
        <el-button circle :loading="loading" aria-label="刷新供应商结算费用" @click="loadSettlements">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </el-tooltip>
    </section>

    <section class="totals-band" aria-label="当前筛选结果金额汇总">
      <div v-for="item in SETTLEMENT_AMOUNT_FIELDS" :key="item.key">
        <span>{{ item.label }}</span>
        <strong>¥ {{ formatMoney(totals[item.key]) }}</strong>
      </div>
    </section>

    <el-alert
      v-if="session.isGlobalReadOnly && !selectedTeamId"
      title="请选择一个项目团队后查看供应商结算费用"
      type="info"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      :closable="false"
      show-icon
    >
      <template #default><el-button text type="primary" @click="loadSettlements">重新加载</el-button></template>
    </el-alert>

    <template v-else>
      <section class="table-shell desktop-settlement-table">
        <el-table
          v-loading="loading"
          :data="settlements"
          row-key="_id"
          stripe
          :empty-text="loadError ? '加载失败，请重新加载' : '暂无供应商结算费用'"
          show-summary
          :summary-method="getSummaries"
        >
          <el-table-column prop="month" label="月份" min-width="92" />
          <el-table-column prop="supplierCode" label="供应商编码" min-width="120" />
          <el-table-column prop="supplierName" label="供应商名称" min-width="170" />
          <el-table-column
            v-for="item in SETTLEMENT_AMOUNT_FIELDS"
            :key="item.key"
            :prop="item.key"
            :label="item.label"
            min-width="140"
            align="right"
          >
            <template #default="{ row }">{{ formatMoney(row[item.key]) }}</template>
          </el-table-column>
          <el-table-column label="签订合同" min-width="92" align="center">
            <template #default="{ row }">
              <el-tag :type="row.hasSignedContract ? 'success' : 'info'" effect="plain">
                {{ booleanLabel(row.hasSignedContract) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="合同有效" min-width="92" align="center">
            <template #default="{ row }">
              <el-tag :type="row.contractValid ? 'success' : 'danger'" effect="plain">
                {{ row.contractValid ? '有效' : '到期' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remarks" label="备注" min-width="150" show-overflow-tooltip />
          <el-table-column label="操作" min-width="150" align="right">
            <template #default="{ row }">
              <div class="table-actions table-actions--right">
                <el-button v-if="canManage" text :icon="Edit" @click="openEdit(row)">编辑</el-button>
                <el-button
                  v-if="canManage"
                  text
                  type="danger"
                  :icon="Delete"
                  :loading="deletingId === row._id"
                  @click="handleDelete(row)"
                >删除</el-button>
                <span v-if="!canManage">只读</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-loading="loading" class="mobile-settlement-list">
        <el-empty v-if="!loading && !loadError && !settlements.length" description="暂无供应商结算费用" />
        <article v-for="row in settlements" :key="row._id" class="mobile-info-item">
          <div class="mobile-item-heading">
            <strong>{{ row.supplierName }}</strong>
            <span>{{ row.month }}</span>
          </div>
          <p class="supplier-code">{{ row.supplierCode }}</p>
          <dl class="mobile-amount-grid">
            <div v-for="item in SETTLEMENT_AMOUNT_FIELDS" :key="item.key">
              <dt>{{ item.label }}</dt>
              <dd>¥ {{ formatMoney(row[item.key]) }}</dd>
            </div>
          </dl>
          <div class="mobile-status-row">
            <el-tag :type="row.hasSignedContract ? 'success' : 'info'" effect="plain" size="small">
              {{ row.hasSignedContract ? '已签合同' : '未签合同' }}
            </el-tag>
            <el-tag :type="row.contractValid ? 'success' : 'danger'" effect="plain" size="small">
              {{ row.contractValid ? '合同有效' : '合同到期' }}
            </el-tag>
          </div>
          <p v-if="row.remarks" class="mobile-remarks">{{ row.remarks }}</p>
          <div v-if="canManage" class="record-actions">
            <el-button text :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" :loading="deletingId === row._id" @click="handleDelete(row)">删除</el-button>
          </div>
        </article>
      </section>

      <footer class="pagination-row">
        <span>共 {{ total }} 条结算记录</span>
        <el-pagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          :pager-count="5"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="loadSettlements"
          @size-change="applyFilters"
        />
      </footer>
    </template>

    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑供应商结算费用' : '新增供应商结算费用'"
      width="min(760px, 95vw)"
      append-to-body
      :close-on-click-modal="!submitting"
      :close-on-press-escape="!submitting"
      :show-close="!submitting"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <div class="settlement-form-grid">
          <el-form-item label="月份" prop="month">
            <el-date-picker v-model="form.month" type="month" value-format="YYYY-MM" class="full-width" />
          </el-form-item>
          <el-form-item label="供应商" prop="supplierId">
            <el-select
              v-model="form.supplierId"
              filterable
              class="full-width"
              placeholder="按名称或编码选择"
              :disabled="Boolean(editingId)"
              @change="syncSelectedSupplier"
            >
              <el-option
                v-for="item in supplierOptions"
                :key="item._id"
                :label="`${item.code} · ${item.name}`"
                :value="item._id"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-for="item in SETTLEMENT_AMOUNT_FIELDS" :key="item.key" :label="item.label" :prop="item.key">
            <el-input-number v-model="form[item.key]" :min="0" :precision="2" :step="100" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="是否签订合同">
            <el-input :model-value="selectedSupplierStatus.hasSignedContract" disabled />
          </el-form-item>
          <el-form-item label="合同是否有效">
            <el-input :model-value="selectedSupplierStatus.contractValid" disabled />
          </el-form-item>
          <el-form-item label="备注" class="form-field--wide">
            <el-input v-model="form.remarks" type="textarea" :rows="3" maxlength="5000" show-word-limit />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button :disabled="submitting" @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importVisible" title="导入供应商结算费用" width="min(620px, 94vw)" append-to-body :show-close="!importing">
      <el-alert title="请使用供应商结算费用月度模板，月份与供应商编码重复时系统会提示" type="info" :closable="false" show-icon />
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
import { Delete, Edit } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createSupplierSettlement,
  deleteSupplierSettlement,
  exportSupplierSettlements,
  getSupplierSettlements,
  getSuppliers,
  importSupplierSettlements,
  updateSupplierSettlement
} from '@/api/contract'
import { useSessionStore } from '@/stores/session'
import {
  SETTLEMENT_AMOUNT_FIELDS,
  YES_NO_OPTIONS,
  booleanLabel,
  formatMoney,
  saveContractBlob
} from '@/utils/contract'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const settlements = ref([])
const supplierOptions = ref([])
const total = ref(0)
const totals = reactive(Object.fromEntries(SETTLEMENT_AMOUNT_FIELDS.map((item) => [item.key, 0])))
const selectedTeamId = ref(String(route.query.teamId || ''))
const loading = ref(false)
const loadError = ref('')
const exporting = ref(false)
const submitting = ref(false)
const importing = ref(false)
const deletingId = ref('')
const formVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const importVisible = ref(false)
const importFiles = ref([])
const importFile = ref(null)
let listRequestId = 0

const filters = reactive({
  month: '',
  supplierCode: '',
  supplierName: '',
  hasSignedContract: '',
  contractValid: '',
  page: 1,
  pageSize: 20
})
const form = reactive(emptyForm())
const rules = {
  month: [{ required: true, message: '请选择月份', trigger: 'change' }],
  supplierId: [{ required: true, message: '请选择供应商', trigger: 'change' }],
  ...Object.fromEntries(SETTLEMENT_AMOUNT_FIELDS.map((item) => [item.key, [
    { required: true, message: `请输入${item.label}`, trigger: 'change' },
    { type: 'number', min: 0, message: `${item.label}不能小于 0`, trigger: 'change' }
  ]]))
}

const canManage = computed(() => session.can('contract.settlement.manage', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('contract.settlement.import', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('contract.settlement.export'))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const selectedSupplierStatus = computed(() => {
  const option = supplierOptions.value.find((item) => item._id === form.supplierId)
  if (!option) return { hasSignedContract: '选择供应商后自动关联', contractValid: '选择供应商后自动关联' }
  return {
    hasSignedContract: option.hasSignedContract ? '已签订' : '未签订',
    contractValid: option.contractValid ? '有效' : '到期'
  }
})

function emptyForm() {
  return {
    month: dayjs().format('YYYY-MM'),
    supplierId: '',
    supplierName: '',
    supplierCode: '',
    productLaunchAmount: 0,
    warehousingLogisticsFee: 0,
    overstorageProductAmount: 0,
    overstorageLogisticsFee: 0,
    remarks: ''
  }
}

function queryParams() {
  return {
    ...requestTeamParams.value,
    month: filters.month || undefined,
    supplierCode: filters.supplierCode.trim() || undefined,
    supplierName: filters.supplierName.trim() || undefined,
    hasSignedContract: filters.hasSignedContract === '' ? undefined : filters.hasSignedContract,
    contractValid: filters.contractValid === '' ? undefined : filters.contractValid,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

function getSummaries({ columns }) {
  return columns.map((column, index) => {
    if (index === 0) return '筛选结果合计'
    if (SETTLEMENT_AMOUNT_FIELDS.some((item) => item.key === column.property)) {
      return formatMoney(totals[column.property])
    }
    return ''
  })
}

async function loadSupplierOptions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  try {
    const collected = []
    const pageSize = 100
    for (let page = 1; page <= 100; page += 1) {
      const result = await getSuppliers({ ...requestTeamParams.value, page, pageSize })
      const batch = result.suppliers || []
      collected.push(...batch)
      const totalSuppliers = Number(result.total)
      if (batch.length < pageSize || Number.isFinite(totalSuppliers) && collected.length >= totalSuppliers) break
    }
    supplierOptions.value = collected
  } catch {
    supplierOptions.value = []
  }
}

async function loadSettlements() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    settlements.value = []
    total.value = 0
    Object.keys(totals).forEach((key) => { totals[key] = 0 })
    return
  }
  const requestId = ++listRequestId
  loading.value = true
  loadError.value = ''
  try {
    const result = await getSupplierSettlements(queryParams())
    if (requestId !== listRequestId) return
    settlements.value = result.settlements || []
    total.value = Number(result.total) || 0
    for (const item of SETTLEMENT_AMOUNT_FIELDS) totals[item.key] = Number(result.totals?.[item.key]) || 0
  } catch (error) {
    if (requestId === listRequestId) loadError.value = error?.message || '供应商结算费用加载失败，请稍后重试'
  } finally {
    if (requestId === listRequestId) loading.value = false
  }
}

function applyFilters() {
  filters.page = 1
  loadSettlements()
}

function resetFilters() {
  Object.assign(filters, {
    month: '', supplierCode: '', supplierName: '', hasSignedContract: '', contractValid: '', page: 1
  })
  loadSettlements()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: teamId ? { teamId } : {} })
  supplierOptions.value = []
  resetFilters()
  await loadSupplierOptions()
}

function resetForm() {
  editingId.value = ''
  Object.assign(form, emptyForm())
  formRef.value?.clearValidate()
}

function openCreate() {
  resetForm()
  formVisible.value = true
}

function openEdit(row) {
  editingId.value = row._id
  Object.assign(form, emptyForm(), {
    ...row,
    supplierId: String(row.supplierId?._id || row.supplierId || '')
  })
  formVisible.value = true
}

function syncSelectedSupplier(supplierId) {
  const option = supplierOptions.value.find((item) => item._id === supplierId)
  form.supplierName = option?.name || ''
  form.supplierCode = String(option?.code || '')
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  syncSelectedSupplier(form.supplierId)
  submitting.value = true
  try {
    const payload = {
      month: form.month,
      supplierId: form.supplierId,
      supplierCode: String(form.supplierCode),
      ...Object.fromEntries(SETTLEMENT_AMOUNT_FIELDS.map((item) => [item.key, Number(form[item.key]) || 0])),
      remarks: String(form.remarks || '').trim()
    }
    if (editingId.value) await updateSupplierSettlement(editingId.value, payload)
    else await createSupplierSettlement(payload)
    ElMessage.success(editingId.value ? '结算费用已更新' : '结算费用已新增')
    formVisible.value = false
    await loadSettlements()
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除 ${row.month} 的“${row.supplierName}”结算费用吗？`,
      '删除结算费用',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  deletingId.value = row._id
  try {
    await deleteSupplierSettlement(row._id, { reason: '后台供应商结算费用删除' })
    ElMessage.success('结算费用已删除')
    if (settlements.value.length === 1 && filters.page > 1) filters.page -= 1
    await loadSettlements()
  } finally {
    deletingId.value = ''
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await exportSupplierSettlements({ ...queryParams(), page: undefined, pageSize: undefined })
    saveContractBlob(blob, `供应商结算费用-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
    ElMessage.success('供应商结算费用已导出')
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
    ElMessage.warning('请选择 .xlsx 格式的供应商结算费用文件')
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
    const result = await importSupplierSettlements(importFile.value, requestTeamParams.value)
    const count = Number(result.importedCount ?? result.createdCount ?? result.totalImported)
    ElMessage.success(Number.isFinite(count) ? `已导入 ${count} 条结算费用` : '供应商结算费用导入完成')
    importVisible.value = false
    filters.page = 1
    await loadSettlements()
  } finally {
    importing.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
    if (selectedTeamId.value) await router.replace({ query: { teamId: selectedTeamId.value } })
  }
  await Promise.all([loadSupplierOptions(), loadSettlements()])
}

onMounted(initialize)
</script>

<style scoped lang="scss">
.page-heading p { margin-top: 6px; color: var(--el-text-color-secondary); }
.settlement-toolbar { margin-bottom: 14px; }
.settlement-toolbar .team-select { width: 190px; }
.settlement-toolbar .el-input, .settlement-toolbar .el-date-editor { width: 180px; }
.settlement-toolbar .el-select { width: 150px; }
.totals-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; border-block: 1px solid var(--zl-border-soft); }
.totals-band > div { min-width: 0; padding: 12px 16px; border-right: 1px solid var(--zl-border-soft); }
.totals-band > div:last-child { border-right: 0; }
.totals-band span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.totals-band strong { display: block; margin-top: 5px; font-size: 18px; overflow-wrap: anywhere; }
.desktop-settlement-table { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 6px; }
.table-actions--right { justify-content: flex-end; }
.mobile-settlement-list { display: none; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: var(--el-text-color-secondary); }
.settlement-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.form-field--wide { grid-column: 1 / -1; }
.full-width { width: 100%; }
.import-upload { margin-top: 18px; }
@media (max-width: 1180px) {
  .desktop-settlement-table { display: none; }
  .mobile-settlement-list { display: block; min-height: 150px; border-block: 1px solid var(--zl-border-soft); }
  .mobile-info-item { padding: 15px 2px; border-bottom: 1px solid var(--zl-border-soft); }
  .mobile-item-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .supplier-code { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 13px; }
  .mobile-amount-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
  .mobile-amount-grid dt { min-height: 32px; color: var(--el-text-color-secondary); font-size: 12px; }
  .mobile-amount-grid dd { margin-top: 3px; font-weight: 600; overflow-wrap: anywhere; }
  .mobile-status-row, .record-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .mobile-remarks { margin-top: 10px; color: var(--el-text-color-regular); overflow-wrap: anywhere; }
}
@media (max-width: 900px) {
  .settlement-toolbar > *, .settlement-toolbar .team-select, .settlement-toolbar .el-input, .settlement-toolbar .el-date-editor, .settlement-toolbar .el-select { width: 100%; }
  .totals-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .totals-band > div:nth-child(2) { border-right: 0; }
  .totals-band > div:nth-child(-n + 2) { border-bottom: 1px solid var(--zl-border-soft); }
  .pagination-row { align-items: flex-start; flex-direction: column; }
  .pagination-row :deep(.el-pagination__sizes), .pagination-row :deep(.el-pagination__jump), .pagination-row :deep(.el-pagination__total) { display: none; }
}
@media (max-width: 600px) {
  .settlement-form-grid { grid-template-columns: 1fr; }
  .form-field--wide { grid-column: auto; }
}
</style>
