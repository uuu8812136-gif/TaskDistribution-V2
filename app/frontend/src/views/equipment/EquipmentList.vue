<template>
  <div class="equipment-page">
    <header class="page-heading">
      <div>
        <h1>设备台账</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canImport" @click="importDialogVisible = true">
          <el-icon><Upload /></el-icon>
          导入 Excel
        </el-button>
        <el-button v-if="session.hasPermission('equipment.export')" :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出
        </el-button>
        <el-button v-if="canCreate" type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建设备
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
        placeholder="搜索编号、名称、规格、厂家或地点"
        @keyup.enter="applyFilters"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.assetType" clearable placeholder="资产类型" @change="applyFilters">
        <el-option
          v-for="item in EQUIPMENT_ASSET_TYPE_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="设备状态">
        <el-option v-for="item in EQUIPMENT_STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.orgUnitId" clearable filterable placeholder="所属组织">
        <el-option v-for="item in options.orgUnits" :key="item._id" :label="item.name" :value="item._id" />
      </el-select>
      <el-select v-model="filters.categoryId" clearable filterable placeholder="设备分类">
        <el-option v-for="item in activeCategories" :key="item._id" :label="item.name" :value="item._id" />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button @click="goCategories">
        <el-icon><Collection /></el-icon>
        分类管理
      </el-button>
      <el-button :loading="loading" circle aria-label="刷新" @click="loadAssets">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell asset-table-shell">
      <el-table
        v-loading="loading"
        :data="assets"
        :style="{ minWidth: `${tableMinWidth}px` }"
        class="asset-table"
        row-key="_id"
        stripe
        empty-text="暂无设备数据"
      >
        <el-table-column
          v-for="column in tableColumns"
          :key="column.key"
          :label="column.label"
          :width="column.width"
          :min-width="column.minWidth"
          :align="column.align || 'left'"
          :fixed="['sourceSequence', 'assetCode', 'name'].includes(column.key) ? 'left' : undefined"
          show-overflow-tooltip
        >
          <template #default="{ row }">
            <el-tag
              v-if="column.key === 'issueCount' && tableCellValue(row, column) > 0"
              type="warning"
              effect="plain"
              size="small"
            >
              {{ tableCellValue(row, column) }}
            </el-tag>
            <span v-else>{{ tableCellValue(row, column) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button text type="primary" @click="goDetail(row)">详情</el-button>
              <el-button v-if="canEdit" text type="primary" @click="openEdit(row)">编辑</el-button>
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
        @change="loadAssets"
      />
    </footer>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑设备' : '新建设备'"
      width="min(760px, 95vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
        <div class="form-grid">
          <el-form-item label="所属组织" prop="orgUnitId">
            <el-select v-model="form.orgUnitId" filterable class="full-width" @change="form.custodianUserId = ''">
              <el-option v-for="item in options.orgUnits" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item label="设备分类" prop="categoryId">
            <el-select v-model="form.categoryId" filterable class="full-width">
              <el-option v-for="item in activeCategories" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item label="资产编号" prop="assetCode">
            <el-input v-model="form.assetCode" maxlength="100" />
          </el-form-item>
          <el-form-item label="设备名称" prop="name">
            <el-input v-model="form.name" maxlength="200" />
          </el-form-item>
          <el-form-item label="规格型号">
            <el-input v-model="form.specification" maxlength="500" />
          </el-form-item>
          <el-form-item label="生产厂家">
            <el-input v-model="form.manufacturer" maxlength="200" />
          </el-form-item>
          <el-form-item label="数量" prop="quantity">
            <el-input-number v-model="form.quantity" :min="0" :precision="0" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="单位">
            <el-input v-model="form.unit" maxlength="50" />
          </el-form-item>
          <el-form-item label="购置日期">
            <el-date-picker v-model="form.acquisitionDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
          </el-form-item>
          <el-form-item label="原值">
            <el-input-number v-model="form.originalValue" :min="0" :precision="2" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="保管人">
            <el-select v-model="form.custodianUserId" clearable filterable class="full-width">
              <el-option v-for="item in formCustodians" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item label="存放地点">
            <el-input v-model="form.location" maxlength="500" />
          </el-form-item>
        </div>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="2000" show-word-limit />
        </el-form-item>
        <el-form-item label="操作说明">
          <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
        <el-alert
          v-if="activeCategories.length === 0"
          title="请先建立至少一个启用的设备分类"
          type="warning"
          :closable="false"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="activeCategories.length === 0" @click="submitForm">
          保存
        </el-button>
      </template>
    </el-dialog>

    <EquipmentImportDialog
      v-model="importDialogVisible"
      :org-units="options.orgUnits"
      :categories="categories"
      :custodians="options.custodians"
      @published="handleImportPublished"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import EquipmentImportDialog from './components/EquipmentImportDialog.vue'
import {
  createEquipment,
  exportEquipment,
  getEquipmentCategories,
  getEquipmentList,
  getEquipmentOptions,
  updateEquipment
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  EQUIPMENT_STATUS_OPTIONS,
  buildEquipmentPayload,
  entityName,
  optionForValue,
  saveBlob
} from '@/utils/equipment'
import {
  EQUIPMENT_ASSET_TYPE_OPTIONS,
  equipmentAssetTableColumns,
  equipmentFieldValue,
  equipmentTableMinWidth
} from '@/utils/equipmentAssetDisplay'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const importDialogVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const assets = ref([])
const categories = ref([])
const total = ref(0)
const selectedTeamId = ref(String(route.query.teamId || ''))
const options = reactive({ orgUnits: [], custodians: [] })
const filters = reactive({
  keyword: '',
  assetType: '',
  status: '',
  orgUnitId: '',
  categoryId: '',
  page: 1,
  pageSize: 20
})
const form = reactive(emptyForm())

const canCreate = computed(() => session.can('equipment.create', { write: true, teamRequired: true }))
const canEdit = computed(() => session.can('equipment.edit', { write: true, teamRequired: true }))
const canImport = computed(() => session.can('equipment.import', { write: true, teamRequired: true }))
const activeCategories = computed(() => categories.value.filter((item) => item.status === 'ACTIVE'))
const formCustodians = computed(() => options.custodians.filter((item) => item.orgUnitId === form.orgUnitId))
const tableColumns = computed(() => equipmentAssetTableColumns(filters.assetType))
const tableMinWidth = computed(() => equipmentTableMinWidth(tableColumns.value))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))

async function handleImportPublished() {
  filters.page = 1
  await Promise.all([loadAssets(), loadCategories(), loadOptions()])
}

const rules = {
  orgUnitId: [{ required: true, message: '请选择所属组织', trigger: 'change' }],
  categoryId: [{ required: true, message: '请选择设备分类', trigger: 'change' }],
  assetCode: [{ required: true, message: '请输入资产编号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  quantity: [{ required: true, message: '请输入数量', trigger: 'change' }]
}

function emptyForm() {
  return {
    orgUnitId: '',
    categoryId: '',
    assetCode: '',
    name: '',
    specification: '',
    manufacturer: '',
    quantity: 1,
    unit: '台',
    acquisitionDate: '',
    originalValue: null,
    custodianUserId: '',
    location: '',
    remark: '',
    reason: ''
  }
}

const statusOption = (value) => optionForValue(EQUIPMENT_STATUS_OPTIONS, value)
const categoryName = (id) => entityName(categories.value, id)
const orgUnitName = (id) => entityName(options.orgUnits, id)
const custodianName = (id) => id ? entityName(options.custodians, id) : '-'

function tableCellValue(row, column) {
  if (column.key === 'categoryName') {
    return row.categoryName || categoryName(row.categoryId)
  }
  if (column.key === 'custodianDisplayName') {
    return row.custodianDisplayName || custodianName(row.custodianUserId)
  }
  if (column.key === 'orgUnitNameSnapshot') {
    return row.orgUnitNameSnapshot || orgUnitName(row.orgUnitId)
  }
  if (column.key === 'conditionText') {
    return row.conditionText || statusOption(row.status).label
  }
  return equipmentFieldValue(row, column.key)
}

async function loadReferenceData() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const [categoryResult, optionResult] = await Promise.all([
    getEquipmentCategories({ ...requestTeamParams.value, pageSize: 200 }),
    getEquipmentOptions(requestTeamParams.value)
  ])
  categories.value = categoryResult.categories || []
  options.orgUnits = optionResult.orgUnits || []
  options.custodians = optionResult.custodians || []
}

async function loadAssets() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  loading.value = true
  try {
    const result = await getEquipmentList({
      ...requestTeamParams.value,
      ...filters,
      keyword: filters.keyword.trim() || undefined,
      assetType: filters.assetType || undefined,
      status: filters.status || undefined,
      orgUnitId: filters.orgUnitId || undefined,
      categoryId: filters.categoryId || undefined
    })
    assets.value = result.equipment || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (!selectedTeamId.value && session.isGlobalReadOnly) return
  await Promise.all([loadReferenceData(), loadAssets()])
  if (route.query.edit && canEdit.value) {
    const item = assets.value.find((asset) => asset._id === route.query.edit)
    if (item) openEdit(item)
  }
}

function applyFilters() {
  filters.page = 1
  loadAssets()
}

function resetFilters() {
  Object.assign(filters, { keyword: '', assetType: '', status: '', orgUnitId: '', categoryId: '', page: 1 })
  loadAssets()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: { ...route.query, teamId, edit: undefined } })
  Object.assign(filters, { keyword: '', assetType: '', status: '', orgUnitId: '', categoryId: '', page: 1 })
  await Promise.all([loadReferenceData(), loadAssets()])
}

function resetForm() {
  editingId.value = ''
  Object.assign(form, emptyForm())
  formRef.value?.clearValidate()
}

function openCreate() {
  resetForm()
  if (options.orgUnits.length === 1) form.orgUnitId = options.orgUnits[0]._id
  dialogVisible.value = true
}

function openEdit(item) {
  editingId.value = item._id
  Object.assign(form, {
    ...emptyForm(),
    ...item,
    acquisitionDate: item.acquisitionDate ? dayjs(item.acquisitionDate).format('YYYY-MM-DD') : '',
    originalValue: item.originalValue ?? null,
    custodianUserId: item.custodianUserId || '',
    reason: ''
  })
  dialogVisible.value = true
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const payload = buildEquipmentPayload(form)
    if (editingId.value) await updateEquipment(editingId.value, payload)
    else await createEquipment(payload)
    ElMessage.success(editingId.value ? '设备已更新' : '设备已创建')
    dialogVisible.value = false
    await loadAssets()
  } finally {
    submitting.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await exportEquipment({
      ...requestTeamParams.value,
      keyword: filters.keyword.trim() || undefined,
      assetType: filters.assetType || undefined,
      status: filters.status || undefined,
      orgUnitId: filters.orgUnitId || undefined,
      categoryId: filters.categoryId || undefined
    })
    saveBlob(blob, `设备台账-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`)
  } finally {
    exporting.value = false
  }
}

function goCategories() {
  router.push({ name: 'EquipmentCategories', query: requestTeamParams.value })
}

function goDetail(item) {
  router.push({
    name: 'EquipmentDetail',
    params: { id: item._id },
    query: requestTeamParams.value
  })
}

onMounted(initialize)
</script>

<style scoped lang="scss">
.equipment-page { min-width: 0; }
.page-heading, .toolbar, .pagination-row, .heading-actions { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #909399; }
.heading-actions { gap: 8px; }
.toolbar { flex-wrap: wrap; gap: 8px; padding: 14px 0; border-block: 1px solid var(--zl-border-soft); }
.toolbar .el-select { width: 150px; }
.toolbar .team-select { width: 190px; }
.keyword-input { width: min(320px, 100%); }
.toolbar-spacer { flex: 1; }
.table-shell { margin-top: 16px; overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.asset-table-shell { overflow-x: auto; }
.asset-table { width: 100%; }
.table-actions { justify-content: center; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.full-width { width: 100%; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-actions { flex-wrap: wrap; justify-content: flex-start; }
  .toolbar > *, .toolbar .el-select, .toolbar .team-select, .keyword-input { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
