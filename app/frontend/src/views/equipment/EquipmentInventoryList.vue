<template>
  <div class="inventory-page">
    <header class="page-heading">
      <div>
        <h1>设备盘点</h1>
        <p>按批次核对设备实物和账面信息 · {{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <el-button v-if="canCreate" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        新建盘点批次
      </el-button>
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
        placeholder="搜索批次名称"
        @keyup.enter="applyFilters"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.status" clearable placeholder="流程状态" @change="applyFilters">
        <el-option v-for="item in INVENTORY_STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="filters.orgUnitId" clearable filterable placeholder="盘点组织" @change="applyFilters">
        <el-option v-for="item in options.orgUnits" :key="item._id" :label="item.name" :value="item._id" />
      </el-select>
      <el-checkbox v-if="session.isTeamMode" v-model="filters.pendingOnly" @change="applyFilters">只看我的待审</el-checkbox>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button circle aria-label="刷新" :loading="loading" @click="loadSessions">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell">
      <el-table v-loading="loading" :data="sessions" row-key="_id" stripe empty-text="暂无盘点批次">
        <el-table-column prop="name" label="批次名称" min-width="190" show-overflow-tooltip />
        <el-table-column prop="orgUnitNameSnapshot" label="盘点组织" min-width="150" />
        <el-table-column label="状态" min-width="190">
          <template #default="{ row }">
            <el-tag :type="inventoryStatusOption(row.status).type" effect="plain">
              {{ inventoryStatusOption(row.status).label }}
            </el-tag>
            <span v-if="row.reviewRound > 1" class="round-label">第{{ row.reviewRound }}轮</span>
          </template>
        </el-table-column>
        <el-table-column label="盘点进度" min-width="190">
          <template #default="{ row }">
            <div class="progress-cell">
              <el-progress :percentage="inventoryProgress(row).percent" :stroke-width="8" />
              <span>{{ row.checkedCount }}/{{ row.itemCount }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="differenceCount" label="差异项" width="90" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.differenceCount" type="danger" effect="plain">{{ row.differenceCount }}</el-tag>
            <span v-else>0</span>
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" min-width="170">
          <template #default="{ row }">{{ displayTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right" align="center">
          <template #default="{ row }">
            <el-button text type="primary" @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <footer class="pagination-row">
      <span>共 {{ total }} 个批次</span>
      <el-pagination
        v-model:current-page="filters.page"
        v-model:page-size="filters.pageSize"
        layout="prev, pager, next, sizes"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @change="loadSessions"
      />
    </footer>

    <el-dialog v-model="createVisible" title="新建盘点批次" width="min(680px, 94vw)" @closed="resetCreateForm">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="112px">
        <el-form-item label="批次名称" prop="name">
          <el-input v-model="createForm.name" maxlength="200" placeholder="例如 2026年第三季度设备盘点" />
        </el-form-item>
        <el-form-item label="盘点组织" prop="orgUnitId">
          <el-select v-model="createForm.orgUnitId" filterable placeholder="选择组织" @change="handleCreateOrgChange">
            <el-option v-for="item in options.orgUnits" :key="item._id" :label="item.name" :value="item._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="盘点人" prop="inventoryPersonId">
          <el-select v-model="createForm.inventoryPersonId" filterable placeholder="选择盘点人">
            <el-option
              v-for="item in availableInventoryPeople"
              :key="item._id"
              :label="`${item.name}${item.username ? ` (${item.username})` : ''}`"
              :value="item._id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="设备范围">
          <el-switch v-model="createForm.includeAll" active-text="该组织全部设备" inactive-text="选择部分设备" />
        </el-form-item>
        <el-form-item v-if="!createForm.includeAll" label="选择设备" prop="equipmentIds">
          <el-select
            v-model="createForm.equipmentIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :loading="equipmentLoading"
            placeholder="选择需要盘点的设备"
          >
            <el-option
              v-for="item in availableEquipment"
              :key="item._id"
              :label="`${item.assetCode} · ${item.name}`"
              :value="item._id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="createForm.description" type="textarea" :rows="3" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建批次</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  createEquipmentInventorySession,
  getEquipmentInventoryOptions,
  getEquipmentInventorySessions,
  getEquipmentList
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  INVENTORY_STATUS_OPTIONS,
  inventoryProgress,
  inventoryStatusOption
} from '@/utils/equipmentInventory'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const selectedTeamId = ref(String(route.query.teamId || ''))
const sessions = ref([])
const total = ref(0)
const loading = ref(false)
const createVisible = ref(false)
const creating = ref(false)
const equipmentLoading = ref(false)
const createFormRef = ref(null)
const availableEquipment = ref([])
const options = reactive({ orgUnits: [], inventoryPeople: [] })
const filters = reactive({ keyword: '', status: '', orgUnitId: '', pendingOnly: false, page: 1, pageSize: 20 })
const createForm = reactive(emptyCreateForm())
const canCreate = computed(() => session.can('equipment.inventory', { write: true, teamRequired: true }))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const availableInventoryPeople = computed(() => options.inventoryPeople.filter(
  (item) => item.orgUnitId === createForm.orgUnitId
))
const createRules = {
  name: [{ required: true, message: '请输入批次名称', trigger: 'blur' }],
  orgUnitId: [{ required: true, message: '请选择盘点组织', trigger: 'change' }],
  inventoryPersonId: [{ required: true, message: '请选择盘点人', trigger: 'change' }],
  equipmentIds: [{
    validator: (_rule, value, callback) => {
      if (!createForm.includeAll && (!Array.isArray(value) || value.length === 0)) callback(new Error('请选择设备'))
      else callback()
    },
    trigger: 'change'
  }]
}

function emptyCreateForm() {
  return { name: '', description: '', orgUnitId: '', inventoryPersonId: '', includeAll: true, equipmentIds: [] }
}

const displayTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'

function listParams() {
  return {
    ...requestTeamParams.value,
    keyword: filters.keyword.trim() || undefined,
    status: filters.status || undefined,
    orgUnitId: filters.orgUnitId || undefined,
    pendingOnly: filters.pendingOnly || undefined,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

async function loadOptions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getEquipmentInventoryOptions(requestTeamParams.value)
  options.orgUnits = result.orgUnits || []
  options.inventoryPeople = result.inventoryPeople || []
}

async function loadSessions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  loading.value = true
  try {
    const result = await getEquipmentInventorySessions(listParams())
    sessions.value = result.inventorySessions || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) selectedTeamId.value = session.teams[0]?._id || ''
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await Promise.all([loadOptions(), loadSessions()])
}

function applyFilters() {
  filters.page = 1
  loadSessions()
}

function resetFilters() {
  Object.assign(filters, { keyword: '', status: '', orgUnitId: '', pendingOnly: false, page: 1 })
  loadSessions()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: teamId ? { teamId } : {} })
  Object.assign(filters, { keyword: '', status: '', orgUnitId: '', pendingOnly: false, page: 1 })
  await Promise.all([loadOptions(), loadSessions()])
}

function openDetail(row) {
  router.push({
    name: 'EquipmentInventoryDetail',
    params: { inventorySessionId: row._id },
    query: requestTeamParams.value
  })
}

function openCreate() {
  createVisible.value = true
}

function resetCreateForm() {
  Object.assign(createForm, emptyCreateForm())
  availableEquipment.value = []
  createFormRef.value?.clearValidate()
}

async function handleCreateOrgChange(orgUnitId) {
  createForm.inventoryPersonId = ''
  createForm.equipmentIds = []
  availableEquipment.value = []
  if (!orgUnitId) return
  equipmentLoading.value = true
  try {
    const result = await getEquipmentList({ orgUnitId, page: 1, pageSize: 200 })
    availableEquipment.value = result.equipment || []
  } finally {
    equipmentLoading.value = false
  }
}

async function submitCreate() {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) return
  creating.value = true
  try {
    const result = await createEquipmentInventorySession({
      name: createForm.name.trim(),
      description: createForm.description.trim(),
      orgUnitId: createForm.orgUnitId,
      inventoryPersonId: createForm.inventoryPersonId,
      ...(createForm.includeAll ? {} : { equipmentIds: [...createForm.equipmentIds] })
    })
    ElMessage.success('盘点批次已创建')
    createVisible.value = false
    openDetail(result.inventorySession)
  } finally {
    creating.value = false
  }
}

onMounted(initialize)
</script>

<style scoped>
.inventory-page { min-width: 0; }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.page-heading h1 { margin: 0; color: #1f2733; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 6px 0 0; color: #64748b; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 0; border-top: 1px solid #dce4ee; border-bottom: 1px solid #dce4ee; }
.team-select { width: 190px; }
.keyword-input { width: 220px; }
.toolbar-spacer { flex: 1; }
.table-shell { overflow-x: auto; padding-top: 16px; }
.progress-cell { display: grid; grid-template-columns: minmax(100px, 1fr) auto; align-items: center; gap: 10px; }
.round-label { margin-left: 8px; color: #64748b; font-size: 12px; }
.pagination-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; color: #64748b; }
:deep(.el-select) { min-width: 180px; }
@media (max-width: 760px) {
  .page-heading, .pagination-row { align-items: stretch; flex-direction: column; }
  .toolbar > *, .keyword-input, .team-select { width: 100%; }
  .toolbar-spacer { display: none; }
}
</style>
