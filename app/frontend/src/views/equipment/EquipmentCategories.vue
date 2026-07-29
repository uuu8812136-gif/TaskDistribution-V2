<template>
  <div class="category-page">
    <header class="page-heading">
      <div class="heading-main">
        <el-button circle aria-label="返回设备台账" @click="goBack">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>设备分类</h1>
          <p>设置台账和点检保养规则使用的分类 · 当前团队共享</p>
        </div>
      </div>
      <el-button v-if="canCreate" type="primary" @click="openCreate(null)">
        <el-icon><Plus /></el-icon>
        新增分类
      </el-button>
    </header>

    <section class="toolbar">
      <el-input v-model="keyword" clearable placeholder="搜索分类名称" @input="applyFilter">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-checkbox v-model="showDisabled" @change="applyFilter">显示停用分类</el-checkbox>
      <span class="toolbar-spacer" />
      <span>共 {{ visibleCount }} 个分类</span>
      <el-button :loading="loading" circle aria-label="刷新" @click="loadCategories">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <section class="table-shell">
      <el-table
        v-loading="loading"
        :data="tree"
        row-key="_id"
        default-expand-all
        :tree-props="{ children: 'children' }"
        empty-text="暂无设备分类"
      >
        <el-table-column prop="name" label="分类名称" min-width="230" />
        <el-table-column label="分类层级" min-width="140">
          <template #default="{ row }">{{ categoryLevelLabel(categoryDepth(row)) }}</template>
        </el-table-column>
        <el-table-column prop="sortOrder" label="排序值" width="100" align="right" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="categoryStatus(row.status).type" effect="plain" size="small">
              {{ categoryStatus(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="245" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <template v-if="canEdit">
                <el-button text type="primary" @click="openEdit(row)">编辑</el-button>
                <el-button v-if="row.status === 'ACTIVE' && categoryDepth(row) < 4" text type="primary" @click="openCreate(row)">新增下级</el-button>
                <el-button v-if="row.status === 'ACTIVE'" text type="danger" @click="disableCategory(row)">停用</el-button>
                <template v-else>
                  <el-button text type="success" @click="enableCategory(row)">启用</el-button>
                  <el-button
                    text
                    type="danger"
                    :loading="deletingId === row._id"
                    @click="deleteCategory(row)"
                  >
                    删除
                  </el-button>
                </template>
              </template>
              <span v-else>-</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑分类' : '新增分类'"
      width="min(520px, 94vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
        <el-form-item label="上级分类">
          <el-tree-select
            v-model="form.parentId"
            :data="parentOptions"
            node-key="value"
            clearable
            check-strictly
            default-expand-all
            class="full-width"
            placeholder="留空则作为根分类"
          />
        </el-form-item>
        <el-form-item :label="currentLevelLabel" prop="name">
          <el-input v-model="form.name" maxlength="100" />
        </el-form-item>
        <el-form-item label="排序值" prop="sortOrder">
          <el-input-number v-model="form.sortOrder" :min="0" :max="2147483647" :step="10" controls-position="right" class="full-width" />
        </el-form-item>
        <el-form-item label="操作说明">
          <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createEquipmentCategory,
  deleteEquipmentCategory,
  disableEquipmentCategory,
  getEquipmentCategories,
  updateEquipmentCategory
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  CATEGORY_STATUS_OPTIONS,
  buildCategoryTree,
  equipmentCategoryPath,
  optionForValue
} from '@/utils/equipment'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const submitting = ref(false)
const deletingId = ref('')
const dialogVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const categories = ref([])
const keyword = ref('')
const showDisabled = ref(true)
const form = reactive(emptyForm())

const requestParams = computed(() => route.query.teamId ? { teamId: String(route.query.teamId) } : {})
const hasTeamCategoryScope = computed(() => (
  session.isSuperAdmin ||
  session.context.membership?.role === 'PROJECT_ADMIN' ||
  session.moduleDataScopes.equipment === 'TEAM'
))
const canCreate = computed(() => (
  hasTeamCategoryScope.value && session.can('equipment.create', { write: true, teamRequired: true })
))
const canEdit = computed(() => (
  hasTeamCategoryScope.value && session.can('equipment.edit', { write: true, teamRequired: true })
))
const filtered = computed(() => {
  const search = keyword.value.trim().toLocaleLowerCase('zh-CN')
  return categories.value.filter((item) => (
    (showDisabled.value || item.status === 'ACTIVE') &&
    (!search || item.name.toLocaleLowerCase('zh-CN').includes(search))
  ))
})
const tree = computed(() => buildCategoryTree(filtered.value))
const visibleCount = computed(() => filtered.value.length)
const parentOptions = computed(() => {
  const convert = (items) => items
    .filter((item) => (
      item._id !== editingId.value && item.status === 'ACTIVE' && categoryDepth(item) < 4
    ))
    .map((item) => ({
      value: item._id,
      label: item.name,
      children: convert(item.children || [])
    }))
  return convert(buildCategoryTree(categories.value))
})
const currentLevelLabel = computed(() => {
  const parent = categories.value.find((item) => item._id === form.parentId)
  return categoryLevelLabel(parent ? categoryDepth(parent) + 1 : 1)
})

const rules = {
  name: [{ required: true, message: '请输入分类名称', trigger: 'blur' }],
  sortOrder: [{ required: true, message: '请输入排序值', trigger: 'change' }]
}

function emptyForm() {
  return { parentId: '', name: '', sortOrder: 0, reason: '' }
}

const categoryStatus = (status) => optionForValue(CATEGORY_STATUS_OPTIONS, status)
const categoryDepth = (item) => equipmentCategoryPath(categories.value, item?._id).length || 1
const categoryLevelLabel = (depth) => ([
  '设备所属大类',
  '设备所属类型',
  '设备一级名称',
  '设备二级名称'
][Math.min(Math.max(Number(depth) || 1, 1), 4) - 1])
const applyFilter = () => undefined

async function loadCategories() {
  loading.value = true
  try {
    const result = await getEquipmentCategories({
      ...requestParams.value,
      pageSize: 200
    })
    categories.value = result.categories || []
  } finally {
    loading.value = false
  }
}

function resetForm() {
  editingId.value = ''
  Object.assign(form, emptyForm())
  formRef.value?.clearValidate()
}

function openCreate(parent) {
  if (parent && categoryDepth(parent) >= 4) return
  resetForm()
  form.parentId = parent?._id || ''
  dialogVisible.value = true
}

function openEdit(item) {
  editingId.value = item._id
  Object.assign(form, {
    parentId: item.parentId || '',
    name: item.name,
    sortOrder: item.sortOrder || 0,
    reason: ''
  })
  dialogVisible.value = true
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const payload = {
      parentId: form.parentId || null,
      name: form.name.trim(),
      sortOrder: Number(form.sortOrder),
      reason: form.reason.trim() || null
    }
    if (editingId.value) await updateEquipmentCategory(editingId.value, payload)
    else await createEquipmentCategory(payload)
    ElMessage.success(editingId.value ? '分类已更新' : '分类已创建')
    dialogVisible.value = false
    await loadCategories()
  } finally {
    submitting.value = false
  }
}

async function disableCategory(item) {
  await ElMessageBox.confirm(`停用分类“${item.name}”？`, '停用分类', {
    type: 'warning',
    confirmButtonText: '停用',
    cancelButtonText: '取消'
  })
  await disableEquipmentCategory(item._id, { reason: '后台分类管理停用' })
  ElMessage.success('分类已停用')
  await loadCategories()
}

async function enableCategory(item) {
  await updateEquipmentCategory(item._id, {
    status: 'ACTIVE',
    reason: '后台分类管理启用'
  })
  ElMessage.success('分类已启用')
  await loadCategories()
}

async function deleteCategory(item) {
  try {
    await ElMessageBox.confirm(
      `确定永久删除分类“${item.name}”吗？删除后无法恢复。`,
      '删除分类',
      {
        type: 'warning',
        confirmButtonText: '删除',
        confirmButtonClass: 'el-button--danger',
        cancelButtonText: '取消'
      }
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    throw error
  }
  deletingId.value = item._id
  try {
    await deleteEquipmentCategory(item._id, { reason: '后台分类管理永久删除' })
    ElMessage.success('分类已删除')
    await loadCategories()
  } finally {
    deletingId.value = ''
  }
}

function goBack() {
  router.push({ name: 'Equipment', query: requestParams.value })
}

onMounted(() => {
  if (session.isGlobalReadOnly && !route.query.teamId) router.replace({ name: 'Equipment' })
  else loadCategories()
})
</script>

<style scoped lang="scss">
.page-heading, .heading-main, .toolbar { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 18px; margin-bottom: 18px; }
.heading-main { min-width: 0; gap: 12px; }
.heading-main h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: 0; }
.heading-main p { margin: 0; color: #909399; }
.toolbar { gap: 8px; padding: 14px 0; border-block: 1px solid var(--zl-border-soft); }
.toolbar .el-input { width: min(300px, 100%); }
.toolbar-spacer { flex: 1; }
.table-shell { margin-top: 16px; overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.table-actions { justify-content: center; }
.full-width { width: 100%; }
@media (max-width: 680px) {
  .page-heading { align-items: flex-start; }
  .toolbar { align-items: flex-start; flex-direction: column; }
  .toolbar > *, .toolbar .el-input { width: 100%; }
  .toolbar > .el-button.is-circle { width: var(--zl-control-height); align-self: flex-end; }
  .toolbar-spacer { display: none; }
}
</style>
