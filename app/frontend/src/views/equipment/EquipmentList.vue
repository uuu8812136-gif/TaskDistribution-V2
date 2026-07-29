<template>
  <div class="equipment-page">
    <header class="page-heading">
      <div>
        <h1>设备台账</h1>
        <p>维护设备资料、照片、状态和二维码 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
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
        class="asset-table"
        row-key="_id"
        stripe
        empty-text="暂无设备数据"
      >
        <el-table-column type="expand" width="48">
          <template #default="{ row }">
            <div class="asset-expanded-content">
              <section v-for="group in EQUIPMENT_DETAIL_GROUPS" :key="group.title" class="asset-field-group">
                <h3>{{ group.title }}</h3>
                <dl class="asset-field-grid">
                  <div
                    v-for="field in group.fields"
                    :key="field.key"
                    class="asset-field"
                    :class="{ 'asset-field--wide': field.span }"
                  >
                    <dt>{{ field.label }}</dt>
                    <dd>{{ tableCellValue(row, field) }}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="序号" width="68" align="center">
          <template #default="{ row }">{{ tableCellValue(row, { key: 'sourceSequence' }) }}</template>
        </el-table-column>
        <el-table-column label="固定资产编号" min-width="142" show-overflow-tooltip>
          <template #default="{ row }"><strong>{{ row.assetCode || '-' }}</strong></template>
        </el-table-column>
        <el-table-column label="设备名称与分类" min-width="300">
          <template #default="{ row }">
            <div class="asset-name-cell">
              <strong>{{ equipmentDisplayName(row) }}</strong>
              <span>{{ equipmentCategorySummary(row) }}</span>
              <div v-if="equipmentBadgeItems(row).length" class="asset-badges">
                <el-tag
                  v-for="badge in equipmentBadgeItems(row)"
                  :key="badge.key"
                  :type="badge.type"
                  effect="plain"
                  size="small"
                >
                  {{ badge.label }}
                </el-tag>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="所在部室与使用人" min-width="170">
          <template #default="{ row }">
            <div class="asset-usage-cell">
              <strong>{{ tableCellValue(row, { key: 'orgUnitNameSnapshot' }) }}</strong>
              <span>{{ tableCellValue(row, { key: 'custodianDisplayName' }) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="statusOption(row.status).type" effect="plain" size="small">
              {{ statusOption(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="194" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button text type="primary" @click="goDetail(row)">详情</el-button>
              <el-button v-if="canEdit" text type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button
                v-if="canEdit"
                text
                type="danger"
                :loading="deletingId === row._id"
                @click="handleDelete(row)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-loading="loading" class="asset-card-list">
      <el-empty v-if="!loading && assets.length === 0" description="暂无设备数据" :image-size="72" />
      <article v-for="row in assets" :key="row._id" class="asset-card">
        <header class="asset-card-heading">
          <div>
            <span>固定资产编号</span>
            <strong>{{ row.assetCode || '-' }}</strong>
          </div>
          <el-tag :type="statusOption(row.status).type" effect="plain" size="small">
            {{ statusOption(row.status).label }}
          </el-tag>
        </header>
        <div class="asset-card-summary">
          <strong>{{ equipmentDisplayName(row) }}</strong>
          <span>{{ equipmentCategorySummary(row) }}</span>
          <span>{{ tableCellValue(row, { key: 'orgUnitNameSnapshot' }) }} · {{ tableCellValue(row, { key: 'custodianDisplayName' }) }}</span>
        </div>
        <div class="asset-card-actions">
          <el-button text type="primary" @click="goDetail(row)">详情</el-button>
          <el-button v-if="canEdit" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            v-if="canEdit"
            text
            type="danger"
            :loading="deletingId === row._id"
            @click="handleDelete(row)"
          >
            删除
          </el-button>
        </div>
        <details class="asset-card-details">
          <summary>查看完整信息</summary>
          <section v-for="group in EQUIPMENT_DETAIL_GROUPS" :key="group.title" class="asset-field-group">
            <h3>{{ group.title }}</h3>
            <dl class="asset-field-grid">
              <div
                v-for="field in group.fields"
                :key="field.key"
                class="asset-field"
                :class="{ 'asset-field--wide': field.span }"
              >
                <dt>{{ field.label }}</dt>
                <dd>{{ tableCellValue(row, field) }}</dd>
              </div>
            </dl>
          </section>
        </details>
      </article>
    </section>

    <footer class="pagination-row">
      <span>共 {{ total }} 条</span>
      <el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :pager-count="5"
        layout="sizes, prev, pager, next"
        @change="loadAssets"
      />
    </footer>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑设备' : '新建设备'"
      class="equipment-editor-dialog"
      width="min(980px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
        <section class="form-section">
          <h3>设备分类</h3>
          <div class="form-grid">
            <el-form-item label="设备所属大类" prop="categoryId">
              <el-select v-model="form.majorCategoryId" filterable class="full-width" @change="handleCategoryLevelChange(0)">
                <el-option v-for="item in majorCategoryOptions" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
            <el-form-item label="设备所属类型">
              <el-select v-model="form.equipmentTypeCategoryId" clearable filterable class="full-width" :disabled="!form.majorCategoryId" @change="handleCategoryLevelChange(1)">
                <el-option v-for="item in equipmentTypeOptions" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
            <el-form-item label="设备一级名称">
              <el-select v-model="form.primaryCategoryId" clearable filterable class="full-width" :disabled="!form.equipmentTypeCategoryId" @change="handleCategoryLevelChange(2)">
                <el-option v-for="item in primaryCategoryOptions" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
            <el-form-item label="设备二级名称">
              <el-select v-model="form.secondaryCategoryId" clearable filterable class="full-width" :disabled="!form.primaryCategoryId" @change="handleCategoryLevelChange(3)">
                <el-option v-for="item in secondaryCategoryOptions" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
          </div>
        </section>

        <section class="form-section">
          <h3>设备标识</h3>
          <div class="form-grid">
            <el-form-item label="序号">
              <el-input v-model="form.sourceSequence" maxlength="100" />
            </el-form-item>
            <el-form-item label="固定资产编号" prop="assetCode">
              <el-input v-model="form.assetCode" maxlength="100" />
            </el-form-item>
            <el-form-item label="车牌号">
              <el-input v-model="form.plateNumber" maxlength="100" />
            </el-form-item>
            <el-form-item label="环保编号">
              <el-input v-model="form.environmentalRegistrationCode" maxlength="200" />
            </el-form-item>
            <el-form-item label="产品/品牌编码">
              <el-input v-model="form.productCode" maxlength="500" />
            </el-form-item>
            <el-form-item label="型号规格">
              <el-input v-model="form.specification" maxlength="500" />
            </el-form-item>
          </div>
        </section>

        <section class="form-section">
          <h3>技术参数</h3>
          <div class="form-grid">
            <el-form-item label="单位">
              <el-input v-model="form.unit" maxlength="50" />
            </el-form-item>
            <el-form-item label="出厂日期">
              <el-date-picker v-model="form.productionDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
            </el-form-item>
            <el-form-item label="启用日期">
              <el-date-picker v-model="form.activationDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
            </el-form-item>
            <el-form-item label="车长">
              <el-input v-model="form.vehicleLength" maxlength="100" />
            </el-form-item>
            <el-form-item label="吨位">
              <el-input v-model="form.ratedCapacityText" maxlength="100" />
            </el-form-item>
            <el-form-item label="高位/低位">
              <el-input v-model="form.forkliftPosition" maxlength="100" />
            </el-form-item>
            <el-form-item label="设备动力类型">
              <el-select v-model="form.powerType" clearable filterable allow-create class="full-width">
                <el-option v-for="item in POWER_TYPE_OPTIONS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="排放标准">
              <el-input v-model="form.emissionStandard" maxlength="100" />
            </el-form-item>
            <el-form-item label="品牌">
              <el-input v-model="form.brand" maxlength="200" />
            </el-form-item>
            <el-form-item label="生产厂家">
              <el-input v-model="form.manufacturer" maxlength="200" />
            </el-form-item>
          </div>
        </section>

        <section class="form-section">
          <h3>数量与使用信息</h3>
          <div class="form-grid">
            <el-form-item label="账存数量">
              <el-input-number v-model="form.bookQuantity" :min="0" :precision="0" controls-position="right" class="full-width" />
            </el-form-item>
            <el-form-item label="实盘数量">
              <el-input-number v-model="form.physicalQuantity" :min="0" :precision="0" controls-position="right" class="full-width" />
            </el-form-item>
            <el-form-item label="所在部室" prop="orgUnitId">
              <el-select v-model="form.orgUnitId" filterable class="full-width" @change="form.custodianUserId = ''">
                <el-option v-for="item in options.orgUnits" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
            <el-form-item label="使用人">
              <el-select v-model="form.custodianUserId" clearable filterable class="full-width">
                <el-option v-for="item in formCustodians" :key="item._id" :label="item.name" :value="item._id" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态">
              <div class="readonly-field">
                <el-tag :type="formStatusOption.type" effect="plain">{{ formStatusOption.label }}</el-tag>
              </div>
            </el-form-item>
            <el-form-item label="存放地点">
              <el-input v-model="form.location" maxlength="500" />
            </el-form-item>
          </div>
        </section>

        <section class="form-section">
          <h3>照片与备注</h3>
          <el-form-item label="设备照片（支持上传1-10张照片）">
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
          <el-form-item label="操作说明">
            <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
          </el-form-item>
        </section>
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

    <el-dialog v-model="photoPreviewVisible" title="设备照片" width="min(760px, 94vw)" append-to-body @closed="clearPhotoPreview">
      <img v-if="photoPreviewUrl" :src="photoPreviewUrl" :alt="photoPreviewName" class="preview-image" />
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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import EquipmentImportDialog from './components/EquipmentImportDialog.vue'
import {
  createEquipment,
  deleteEquipment,
  exportEquipment,
  getEquipmentCategories,
  getEquipmentList,
  getEquipmentOptions,
  updateEquipment
} from '@/api/equipment'
import { deleteFile, downloadFileBlob, getFileMetadata, uploadTemporaryFile } from '@/api/file'
import { useSessionStore } from '@/stores/session'
import {
  cleanupTemporaryFiles,
  managedFileId,
  prepareAttachmentReferences
} from '@/utils/attachments'
import {
  EQUIPMENT_STATUS_OPTIONS,
  buildEquipmentPayload,
  entityName,
  equipmentCategoryChildren,
  equipmentCategoryPath,
  optionForValue,
  saveBlob
} from '@/utils/equipment'
import {
  EQUIPMENT_ASSET_TYPE_OPTIONS,
  EQUIPMENT_DETAIL_GROUPS,
  equipmentFieldValue,
  normalizeEquipmentPhotoIds
} from '@/utils/equipmentAssetDisplay'

const POWER_TYPE_OPTIONS = Object.freeze(['锂电', '铅酸', '柴油'])

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const deletingId = ref('')
const dialogVisible = ref(false)
const importDialogVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const photoFileList = ref([])
const photoPreviewVisible = ref(false)
const photoPreviewUrl = ref('')
const photoPreviewName = ref('')
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
const majorCategoryOptions = computed(() => equipmentCategoryChildren(categories.value))
const equipmentTypeOptions = computed(() => equipmentCategoryChildren(
  categories.value,
  form.majorCategoryId
))
const primaryCategoryOptions = computed(() => equipmentCategoryChildren(
  categories.value,
  form.equipmentTypeCategoryId
))
const secondaryCategoryOptions = computed(() => equipmentCategoryChildren(
  categories.value,
  form.primaryCategoryId
))
const formCustodians = computed(() => options.custodians.filter((item) => item.orgUnitId === form.orgUnitId))
const formStatusOption = computed(() => optionForValue(
  EQUIPMENT_STATUS_OPTIONS,
  form.status || 'IN_USE'
))
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
  assetCode: [{ required: true, message: '请输入固定资产编号', trigger: 'blur' }]
}

function emptyForm() {
  return {
    orgUnitId: '',
    categoryId: '',
    majorCategoryId: '',
    equipmentTypeCategoryId: '',
    primaryCategoryId: '',
    secondaryCategoryId: '',
    majorCategoryName: '',
    equipmentTypeName: '',
    primaryName: '',
    secondaryName: '',
    sourceSequence: '',
    assetCode: '',
    name: '',
    plateNumber: '',
    environmentalRegistrationCode: '',
    productCode: '',
    specification: '',
    manufacturer: '',
    brand: '',
    vehicleLength: '',
    ratedCapacityText: '',
    forkliftPosition: '',
    powerType: '',
    emissionStandard: '',
    quantity: 1,
    bookQuantity: 1,
    physicalQuantity: 1,
    unit: '台',
    acquisitionDate: '',
    productionDate: '',
    activationDate: '',
    originalValue: null,
    custodianUserId: '',
    status: 'IN_USE',
    location: '',
    photoFileIds: [],
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

function equipmentDisplayName(row) {
  return row.secondaryName || row.primaryName || row.name || '-'
}

function equipmentCategorySummary(row) {
  const path = [
    row.majorCategoryName,
    row.equipmentTypeName,
    row.primaryName,
    row.secondaryName
  ].map((value) => String(value || '').trim()).filter(Boolean)
  return path.length ? path.join(' / ') : (row.categoryName || categoryName(row.categoryId))
}

function equipmentBadgeItems(row) {
  const photoCount = Number(equipmentFieldValue(row, 'photoCount')) || 0
  const issueCount = Number(equipmentFieldValue(row, 'issueCount')) || 0
  return [
    photoCount > 0 ? { key: 'photos', label: `${photoCount} 张照片`, type: 'info' } : null,
    issueCount > 0 ? { key: 'issues', label: `${issueCount} 项异常`, type: 'warning' } : null
  ].filter(Boolean)
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
    if (item) await openEdit(item)
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
  photoFileList.value = []
  formRef.value?.clearValidate()
}

function syncCategorySelection() {
  const ids = [
    form.majorCategoryId,
    form.equipmentTypeCategoryId,
    form.primaryCategoryId,
    form.secondaryCategoryId
  ].filter(Boolean)
  form.categoryId = ids.at(-1) || ''
  form.majorCategoryName = form.majorCategoryId ? categoryName(form.majorCategoryId) : ''
  form.equipmentTypeName = form.equipmentTypeCategoryId
    ? categoryName(form.equipmentTypeCategoryId)
    : ''
  form.primaryName = form.primaryCategoryId ? categoryName(form.primaryCategoryId) : ''
  form.secondaryName = form.secondaryCategoryId ? categoryName(form.secondaryCategoryId) : ''
}

function handleCategoryLevelChange(level) {
  const fields = [
    'majorCategoryId',
    'equipmentTypeCategoryId',
    'primaryCategoryId',
    'secondaryCategoryId'
  ]
  fields.slice(level + 1).forEach((field) => { form[field] = '' })
  syncCategorySelection()
  formRef.value?.validateField('categoryId').catch(() => {})
}

function applyCategoryPath(categoryId) {
  const path = equipmentCategoryPath(categories.value, categoryId).slice(0, 4)
  form.majorCategoryId = path[0]?._id || ''
  form.equipmentTypeCategoryId = path[1]?._id || ''
  form.primaryCategoryId = path[2]?._id || ''
  form.secondaryCategoryId = path[3]?._id || ''
  syncCategorySelection()
}

function openCreate() {
  resetForm()
  if (options.orgUnits.length === 1) form.orgUnitId = options.orgUnits[0]._id
  dialogVisible.value = true
}

async function openEdit(item) {
  editingId.value = item._id
  Object.assign(form, {
    ...emptyForm(),
    ...item,
    acquisitionDate: item.acquisitionDate ? dayjs(item.acquisitionDate).format('YYYY-MM-DD') : '',
    productionDate: item.productionDate ? dayjs(item.productionDate).format('YYYY-MM-DD') : '',
    activationDate: item.activationDate ? dayjs(item.activationDate).format('YYYY-MM-DD') : '',
    originalValue: item.originalValue ?? null,
    bookQuantity: item.bookQuantity ?? item.quantity ?? 1,
    physicalQuantity: item.physicalQuantity ?? item.quantity ?? 1,
    custodianUserId: item.custodianUserId || '',
    reason: ''
  })
  applyCategoryPath(item.categoryId)
  const metadataResults = await Promise.allSettled(
    normalizeEquipmentPhotoIds(item.photoFileIds).map((fileId) => (
      getFileMetadata(fileId, requestTeamParams.value.teamId)
    ))
  )
  photoFileList.value = metadataResults.map((result, index) => {
    const fileId = normalizeEquipmentPhotoIds(item.photoFileIds)[index]
    const metadata = result.status === 'fulfilled' ? result.value.file : null
    return {
      uid: fileId,
      fileId,
      name: metadata?.originalName || `设备照片-${index + 1}`,
      size: metadata?.size || 0,
      mimeType: metadata?.mimeType || '',
      status: 'success'
    }
  })
  dialogVisible.value = true
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(photoFileList.value, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    const payload = buildEquipmentPayload({
      ...form,
      photoFileIds: prepared.references.map(({ fileId }) => fileId)
    })
    if (editingId.value) await updateEquipment(editingId.value, payload)
    else await createEquipment(payload)
    uploadedFileIds = []
    ElMessage.success(editingId.value ? '设备已更新' : '设备已创建')
    dialogVisible.value = false
    await loadAssets()
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

async function handleDelete(item) {
  try {
    await ElMessageBox.confirm(
      `确定删除设备“${item.name || item.assetCode}”吗？删除后不可恢复。`,
      '删除设备',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  deletingId.value = item._id
  try {
    await deleteEquipment(item._id, { reason: '后台设备台账删除' })
    ElMessage.success('设备已删除')
    if (assets.value.length === 1 && filters.page > 1) filters.page -= 1
    await loadAssets()
  } finally {
    deletingId.value = ''
  }
}

function handlePhotoChange(file, fileList) {
  if (!file.raw) return
  if (!file.raw.type?.startsWith('image/')) {
    ElMessage.warning('设备照片只能选择图片文件')
    photoFileList.value = fileList.filter((item) => item.uid !== file.uid)
  }
}

function handlePhotoExceed() {
  ElMessage.warning('设备照片最多上传10张')
}

function clearPhotoPreview() {
  if (photoPreviewUrl.value) URL.revokeObjectURL(photoPreviewUrl.value)
  photoPreviewUrl.value = ''
  photoPreviewName.value = ''
}

async function previewPhoto(file) {
  clearPhotoPreview()
  photoPreviewName.value = file.name || '设备照片'
  if (file.raw) photoPreviewUrl.value = URL.createObjectURL(file.raw)
  else {
    const fileId = managedFileId(file)
    if (!fileId) return
    const blob = await downloadFileBlob(fileId, requestTeamParams.value.teamId)
    photoPreviewUrl.value = URL.createObjectURL(blob)
  }
  photoPreviewVisible.value = true
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
onBeforeUnmount(clearPhotoPreview)
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
.asset-table-shell { overflow: hidden; }
.asset-table { width: 100%; }
.table-actions { justify-content: center; }
.asset-name-cell,
.asset-usage-cell { min-width: 0; display: grid; gap: 5px; }
.asset-name-cell > strong,
.asset-usage-cell > strong { overflow-wrap: anywhere; color: var(--zl-text); }
.asset-name-cell > span,
.asset-usage-cell > span { color: var(--zl-muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.asset-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.asset-expanded-content { padding: 8px 24px 22px; background: #f8fbff; }
.asset-field-group + .asset-field-group { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--zl-border-soft); }
.asset-field-group h3 { margin: 0 0 10px; color: var(--zl-text); font-size: 14px; letter-spacing: 0; }
.asset-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0 20px; margin: 0; }
.asset-field { min-width: 0; padding: 9px 0; border-bottom: 1px solid #e8eef7; }
.asset-field--wide { grid-column: 1 / -1; }
.asset-field dt { margin: 0 0 4px; color: var(--zl-muted); font-size: 12px; }
.asset-field dd { margin: 0; color: var(--zl-text); line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
.asset-card-list { display: none; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.form-section + .form-section { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--zl-border-soft); }
.form-section h3 { margin: 0 0 14px; color: var(--zl-text); font-size: 15px; letter-spacing: 0; }
.readonly-field { min-height: 32px; display: flex; align-items: center; }
.preview-image { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; object-fit: contain; }
:global(.equipment-editor-dialog .el-dialog__body) { max-height: 72vh; overflow-y: auto; }
.full-width { width: 100%; }
@media (max-width: 1180px) {
  .asset-table-shell { display: none; }
  .asset-card-list { display: grid; gap: 12px; margin-top: 16px; }
  .asset-card { min-width: 0; padding: 16px; background: var(--zl-surface-solid); border: 1px solid var(--zl-border-soft); border-radius: 8px; box-shadow: 0 4px 14px rgb(30 64 175 / 5%); }
  .asset-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .asset-card-heading > div { min-width: 0; display: grid; gap: 4px; }
  .asset-card-heading span { color: var(--zl-muted); font-size: 12px; }
  .asset-card-heading strong { overflow-wrap: anywhere; }
  .asset-card-summary { display: grid; gap: 5px; margin-top: 13px; }
  .asset-card-summary span { color: var(--zl-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .asset-card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .asset-card-actions .el-button { margin: 0; }
  .asset-card-details { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--zl-border-soft); }
  .asset-card-details summary { width: fit-content; color: var(--zl-primary-deep); cursor: pointer; font-size: 13px; font-weight: 600; list-style-position: inside; }
  .asset-card-details[open] summary { margin-bottom: 12px; }
  .asset-expanded-content { padding: 0; background: transparent; }
}
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-actions { flex-wrap: wrap; justify-content: flex-start; }
  .toolbar > *, .toolbar .el-select, .toolbar .team-select, .keyword-input { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow: visible; }
  .pagination-row :deep(.el-pagination__sizes) { display: none; }
  .form-grid { grid-template-columns: 1fr; }
  .asset-field-grid { grid-template-columns: 1fr; }
}
</style>
