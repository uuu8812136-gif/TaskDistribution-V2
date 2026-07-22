<template>
  <div class="routine-rules-page">
    <header class="page-heading">
      <div>
        <h1>点检与保养规则</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }} · 同类型设备可同时启用多条独立规则</p>
      </div>
      <div class="heading-actions">
        <el-dropdown
          v-if="canManageActiveType"
          split-button
          type="primary"
          trigger="click"
          @click="openCreate"
          @command="openPresetCreate"
        >
          新增规则
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="preset in createPresets" :key="preset.value" :command="preset.value">
                {{ preset.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <el-tabs v-model="activeRoutineType" class="routine-tabs" @tab-change="handleTypeChange">
      <el-tab-pane
        v-for="item in availableRoutineTypes"
        :key="item.value"
        :label="`${item.label}规则`"
        :name="item.value"
      />
    </el-tabs>

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
        placeholder="搜索规则名称或内容"
        @keyup.enter="applyFilters"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-tree-select
        v-model="filters.categoryId"
        :data="filterCategoryOptions"
        node-key="value"
        clearable
        check-strictly
        default-expand-all
        filterable
        class="category-select"
        placeholder="设备类型"
      />
      <el-select v-model="filters.scheduleMode" clearable class="mode-select" placeholder="周期模式">
        <el-option
          v-for="item in ROUTINE_SCHEDULE_MODE_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-select v-model="filters.status" clearable class="status-select" placeholder="状态">
        <el-option
          v-for="item in ROUTINE_RULE_STATUS_OPTIONS"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button @click="resetFilters">重置</el-button>
      <span class="toolbar-spacer" />
      <el-button :loading="loading" circle aria-label="刷新规则" @click="loadRules">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell rules-table">
      <el-table v-loading="loading" :data="rules" row-key="_id" stripe empty-text="暂无点检或保养规则">
        <el-table-column label="规则" min-width="230" fixed="left">
          <template #default="{ row }">
            <div class="rule-name-cell">
              <strong>{{ row.name }}</strong>
              <span>{{ row.description || checklistSummary(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="设备类型" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ categoryName(row.categoryId) }}</template>
        </el-table-column>
        <el-table-column label="周期" min-width="230">
          <template #default="{ row }">
            <el-tag effect="plain" type="primary">{{ routineScheduleLabel(row.schedule) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="检查项" width="90" align="right">
          <template #default="{ row }">{{ row.checklistItems?.length || 0 }} 项</template>
        </el-table-column>
        <el-table-column label="提交要求" min-width="150">
          <template #default="{ row }">
            <div class="requirements-cell">
              <span>{{ optionForValue(ROUTINE_PHOTO_POLICY_OPTIONS, row.photoPolicy).label }}</span>
              <span>{{ row.abnormalNoteRequired === false ? '异常说明选填' : '异常说明必填' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="optionForValue(ROUTINE_RULE_STATUS_OPTIONS, row.status).type" effect="plain" size="small">
              {{ optionForValue(ROUTINE_RULE_STATUS_OPTIONS, row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ displayTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="176" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions rule-actions">
              <el-button text type="primary" @click="openView(row)">查看</el-button>
              <el-button v-if="canManageType(row.routineType)" text type="primary" @click="openEdit(row)">编辑</el-button>
              <el-dropdown
                v-if="canManageType(row.routineType)"
                trigger="click"
                @command="handleRowCommand($event, row)"
              >
                <el-button text circle title="更多操作" aria-label="更多规则操作">
                  <el-icon><MoreFilled /></el-icon>
                </el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="copy">
                      <el-icon><CopyDocument /></el-icon>
                      复制规则
                    </el-dropdown-item>
                    <el-dropdown-item v-if="row.status === 'ACTIVE'" command="disable" divided>
                      <el-icon><CircleClose /></el-icon>
                      停用规则
                    </el-dropdown-item>
                    <el-dropdown-item v-else command="enable" divided>
                      <el-icon><CircleCheck /></el-icon>
                      启用规则
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
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
        @change="loadRules"
      />
    </footer>

    <EquipmentRuleDialog
      v-model="dialogVisible"
      :rule="selectedRule"
      :copy="copying"
      :read-only="viewing"
      :routine-type="activeRoutineType"
      :allowed-routine-types="availableRoutineTypes.map((item) => item.value)"
      :categories="categories"
      :default-category-id="filters.categoryId"
      :schedule-preset="newRuleSchedulePreset"
      :submitting="submitting"
      @submit="saveRule"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import EquipmentRuleDialog from './components/EquipmentRuleDialog.vue'
import {
  createEquipmentRoutineRule,
  disableEquipmentRoutineRule,
  getEquipmentCategories,
  getEquipmentRoutineRule,
  getEquipmentRoutineRules,
  updateEquipmentRoutineRule
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  ROUTINE_PHOTO_POLICY_OPTIONS,
  ROUTINE_RULE_STATUS_OPTIONS,
  ROUTINE_SCHEDULE_MODE_OPTIONS,
  ROUTINE_TYPE_OPTIONS,
  buildCategoryTree,
  optionForValue,
  routineScheduleLabel
} from '@/utils/equipment'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const viewing = ref(false)
const copying = ref(false)
const newRuleSchedulePreset = ref('')
const selectedRule = ref(null)
const rules = ref([])
const categories = ref([])
const total = ref(0)
const selectedTeamId = ref(String(route.query.teamId || ''))
const filters = reactive({
  keyword: '',
  categoryId: String(route.query.categoryId || ''),
  scheduleMode: '',
  status: '',
  page: 1,
  pageSize: 20
})
const createPresets = Object.freeze([
  { value: 'DAY', label: '新增每日规则' },
  { value: 'WEEK', label: '新增每周规则' },
  { value: 'MONTH', label: '新增每月规则' },
  { value: 'RUNTIME_HOURS', label: '新增运行小时规则' },
  { value: 'COMBINED', label: '新增日历 + 运行小时规则' }
])

const availableRoutineTypes = computed(() => ROUTINE_TYPE_OPTIONS)
const requestedRoutineType = String(route.query.routineType || '')
const activeRoutineType = ref(
  availableRoutineTypes.value.some((item) => item.value === requestedRoutineType)
    ? requestedRoutineType
    : availableRoutineTypes.value[0]?.value || 'INSPECTION'
)
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const managerIdentityAllowed = computed(() => {
  const membership = session.context.membership
  return session.isSuperAdmin ||
    membership?.positionKey === 'DEPARTMENT_MANAGER' ||
    membership?.functionalRoleKeys?.includes('ASSET_ADMIN')
})
const hasTeamEquipmentScope = computed(() => (
  session.isSuperAdmin || session.moduleDataScopes.equipment === 'TEAM'
))
const canManageActiveType = computed(() => canManageType(activeRoutineType.value))
const filterCategoryOptions = computed(() => {
  const convert = (items) => items.map((item) => ({
    value: item._id,
    label: item.name,
    children: convert(item.children || [])
  }))
  return convert(buildCategoryTree(categories.value))
})

function canManageType(routineType) {
  const permission = routineType === 'MAINTENANCE' ? 'equipment.maintain' : 'equipment.inspect'
  return managerIdentityAllowed.value && hasTeamEquipmentScope.value && session.can(
    ['equipment.edit', permission],
    { write: true, teamRequired: true }
  )
}

function categoryName(category) {
  const categoryId = category?._id || category
  return categories.value.find((item) => item._id === categoryId)?.name || category?.name || '-'
}

function checklistSummary(rule) {
  return (rule.checklistItems || []).map((item) => item.name).filter(Boolean).slice(0, 3).join('、') || '-'
}

const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

async function loadCategories() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getEquipmentCategories({ ...requestTeamParams.value, pageSize: 200 })
  categories.value = result.categories || []
}

async function loadRules() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  loading.value = true
  try {
    const result = await getEquipmentRoutineRules({
      ...requestTeamParams.value,
      routineType: activeRoutineType.value,
      keyword: filters.keyword.trim() || undefined,
      categoryId: filters.categoryId || undefined,
      scheduleMode: filters.scheduleMode || undefined,
      status: filters.status || undefined,
      page: filters.page,
      pageSize: filters.pageSize
    })
    rules.value = result.rules || result.routineRules || []
    total.value = result.total ?? rules.value.length
  } finally {
    loading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await Promise.all([loadCategories(), loadRules()])
}

async function applyFilters() {
  filters.page = 1
  await router.replace({
    query: {
      ...route.query,
      categoryId: filters.categoryId || undefined
    }
  })
  await loadRules()
}

async function resetFilters() {
  Object.assign(filters, { keyword: '', categoryId: '', scheduleMode: '', status: '', page: 1 })
  await router.replace({ query: { ...route.query, categoryId: undefined } })
  await loadRules()
}

async function handleTypeChange() {
  filters.page = 1
  selectedRule.value = null
  await router.replace({ query: { ...route.query, routineType: activeRoutineType.value } })
  await loadRules()
}

async function handleTeamChange(teamId) {
  await router.replace({ query: { ...route.query, teamId, categoryId: undefined } })
  Object.assign(filters, { keyword: '', categoryId: '', scheduleMode: '', status: '', page: 1 })
  await Promise.all([loadCategories(), loadRules()])
}

function openCreate() {
  selectedRule.value = null
  viewing.value = false
  copying.value = false
  newRuleSchedulePreset.value = ''
  dialogVisible.value = true
}

function openPresetCreate(preset) {
  selectedRule.value = null
  viewing.value = false
  copying.value = false
  newRuleSchedulePreset.value = preset
  dialogVisible.value = true
}

async function fetchRule(row) {
  const result = await getEquipmentRoutineRule(row._id, requestTeamParams.value)
  return result.rule || result.routineRule || result
}

async function openView(row) {
  selectedRule.value = await fetchRule(row)
  viewing.value = true
  copying.value = false
  newRuleSchedulePreset.value = ''
  dialogVisible.value = true
}

async function openEdit(row) {
  selectedRule.value = await fetchRule(row)
  viewing.value = false
  copying.value = false
  newRuleSchedulePreset.value = ''
  dialogVisible.value = true
}

async function openCopy(row) {
  selectedRule.value = await fetchRule(row)
  viewing.value = false
  copying.value = true
  newRuleSchedulePreset.value = ''
  dialogVisible.value = true
}

async function saveRule(payload) {
  submitting.value = true
  try {
    if (selectedRule.value?._id && !copying.value) {
      await updateEquipmentRoutineRule(selectedRule.value._id, payload)
      ElMessage.success('规则已更新')
    } else {
      await createEquipmentRoutineRule(payload)
      ElMessage.success(copying.value ? '规则已复制' : '规则已创建')
    }
    dialogVisible.value = false
    await loadRules()
  } finally {
    submitting.value = false
  }
}

async function disableRule(row) {
  try {
    await ElMessageBox.confirm(`停用规则“${row.name}”？历史执行记录会继续保留。`, '停用规则', {
      type: 'warning',
      confirmButtonText: '停用',
      cancelButtonText: '取消'
    })
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    throw error
  }
  await disableEquipmentRoutineRule(row._id)
  ElMessage.success('规则已停用')
  await loadRules()
}

async function enableRule(row) {
  await updateEquipmentRoutineRule(row._id, { status: 'ACTIVE' })
  ElMessage.success('规则已启用')
  await loadRules()
}

async function handleRowCommand(command, row) {
  if (command === 'copy') await openCopy(row)
  if (command === 'disable') await disableRule(row)
  if (command === 'enable') await enableRule(row)
}

onMounted(initialize)
</script>

<style scoped lang="scss">
.routine-rules-page { min-width: 0; }
.page-heading,
.heading-actions,
.toolbar,
.pagination-row { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 20px; margin-bottom: 8px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #909399; }
.routine-tabs { margin-bottom: 2px; }
.toolbar { flex-wrap: wrap; gap: 8px; padding: 14px 0; border-block: 1px solid var(--zl-border-soft); }
.team-select { width: 190px; }
.keyword-input { width: min(290px, 100%); }
.category-select { width: 180px; }
.mode-select { width: 180px; }
.status-select { width: 120px; }
.toolbar-spacer { flex: 1; }
.rules-table { margin-top: 16px; overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 8px; }
.rule-name-cell,
.requirements-cell { min-width: 0; display: grid; gap: 4px; }
.rule-name-cell strong,
.rule-name-cell span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-name-cell span,
.requirements-cell { color: var(--zl-muted); font-size: 12px; }
.rule-actions { min-width: 136px; display: grid; grid-auto-flow: column; grid-auto-columns: max-content; justify-content: center; gap: 6px; }
.rule-actions .el-button { margin: 0; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #606266; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; flex-direction: column; }
  .heading-actions { width: 100%; }
  .toolbar > *,
  .team-select,
  .keyword-input,
  .category-select,
  .mode-select,
  .status-select { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
  .pagination-row { align-items: flex-start; flex-direction: column; overflow-x: auto; }
}
</style>
