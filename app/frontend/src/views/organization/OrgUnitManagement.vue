<template>
  <div class="org-page">
    <header class="page-heading">
      <div>
        <h1>组织架构</h1>
        <p>维护当前团队的五级组织树，层级与路径由服务端自动计算</p>
      </div>
      <PermissionGuard permission="org.manage" write team-required team-admin-only>
        <el-button type="primary" @click="openCreateDialog(null)">
          <el-icon><Plus /></el-icon>
          新增根组织
        </el-button>
      </PermissionGuard>
    </header>

    <section class="toolbar">
      <el-input
        v-model="keyword"
        clearable
        placeholder="搜索组织名称或编码"
        class="keyword-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-checkbox v-model="showDisabled">显示已停用组织</el-checkbox>
      <span class="toolbar-spacer" />
      <span class="record-count">共 {{ visibleUnits.length }} 个组织</span>
      <el-button :loading="loading" @click="loadOrgUnits">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </section>

    <div class="table-shell">
      <el-table
        v-loading="loading"
        :data="orgTree"
        row-key="_id"
        :expand-row-keys="expandedRowKeys"
        :row-class-name="orgRowClassName"
        :tree-props="{ children: 'children' }"
        empty-text="暂无组织，请先新增根组织"
        @expand-change="handleExpandChange"
      >
        <el-table-column label="组织名称" min-width="240">
          <template #default="{ row }">
            <div class="name-cell">
              <span>{{ row.name }}</span>
              <small>{{ row.code }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ typeLabel(row.type) }}</template>
        </el-table-column>
        <el-table-column label="层级" width="82" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">第 {{ row.level }} 级</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sortOrder" label="排序值" width="88" align="right" />
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'danger'" size="small" effect="plain">
              {{ row.status === 'ACTIVE' ? '正常' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="292" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button text type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-tooltip
                :disabled="row.level < 5 && row.status === 'ACTIVE'"
                :content="row.level >= 5 ? '组织最多五级' : '停用组织下不能新增子组织'"
              >
                <span class="table-action-item">
                  <el-button
                    text
                    type="primary"
                    :disabled="row.level >= 5 || row.status !== 'ACTIVE'"
                    @click="openCreateDialog(row)"
                  >
                    新增下级
                  </el-button>
                </span>
              </el-tooltip>
              <el-button
                v-if="row.status === 'ACTIVE'"
                text
                type="danger"
                @click="changeStatus(row, 'DISABLED')"
              >
                停用
              </el-button>
              <el-button v-else text type="success" @click="changeStatus(row, 'ACTIVE')">
                启用
              </el-button>
              <el-button
                text
                type="danger"
                :loading="deletingUnitId === row._id"
                :disabled="Boolean(deletingUnitId) && deletingUnitId !== row._id"
                @click="removeOrgUnit(row)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingUnit ? '编辑组织' : '新增组织'"
      width="min(620px, 94vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form
        ref="orgFormRef"
        :model="orgForm"
        :rules="orgRules"
        label-position="top"
        status-icon
      >
        <div class="form-grid">
          <el-form-item label="上级组织">
            <el-tree-select
              v-model="orgForm.parentId"
              :data="parentOptions"
              node-key="value"
              check-strictly
              clearable
              default-expand-all
              filterable
              :render-after-expand="false"
              placeholder="留空则作为根组织"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="组织类型" prop="type">
            <el-select v-model="orgForm.type" class="full-width">
              <el-option
                v-for="item in ORG_UNIT_TYPE_OPTIONS"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="组织编码" prop="code" :error="codeServerError">
            <el-input
              v-model="orgForm.code"
              maxlength="50"
              placeholder="仅限字母、数字、下划线和连字符"
              @input="codeServerError = ''"
              @blur="orgForm.code = orgForm.code.trim().toUpperCase()"
            />
          </el-form-item>
          <el-form-item label="组织名称" prop="name">
            <el-input v-model="orgForm.name" maxlength="100" />
          </el-form-item>
          <el-form-item label="排序值" prop="sortOrder">
            <el-input-number
              v-model="orgForm.sortOrder"
              :min="0"
              :max="2147483647"
              :step="10"
              controls-position="right"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="预计层级">
            <el-input :model-value="`${prospectiveLevel} / 5`" disabled />
          </el-form-item>
        </div>
        <el-form-item label="变更说明">
          <el-input
            v-model="orgForm.reason"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
            placeholder="可填写新增、改名、移动或排序原因"
          />
        </el-form-item>
        <el-alert
          v-if="prospectiveLevel > 5"
          title="调整后将超过五级组织限制，请重新选择上级组织"
          type="error"
          :closable="false"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="prospectiveLevel > 5"
          @click="submitOrgUnit"
        >
          {{ editingUnit ? '保存变更' : '创建组织' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PermissionGuard from '@/components/PermissionGuard.vue'
import { createOrgUnit, deleteOrgUnit, getOrgUnits, updateOrgUnit } from '@/api/teamManagement'
import {
  ORG_UNIT_STATUS,
  ORG_UNIT_TYPE_OPTIONS,
  buildOrgUnitPayload,
  buildOrgUnitTree,
  managementErrorMessage,
  reconcileExpandedOrgUnitIds
} from '@/utils/teamManagement'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const editingUnit = ref(null)
const orgFormRef = ref(null)
const codeServerError = ref('')
const deletingUnitId = ref('')
const units = ref([])
const expandedRowKeys = ref([])
const hasLoadedOrgUnits = ref(false)
const keyword = ref('')
const showDisabled = ref(true)
const orgForm = reactive(createEmptyForm())

const orgRules = {
  type: [{ required: true, message: '请选择组织类型', trigger: 'change' }],
  code: [
    { required: true, message: '请输入组织编码', trigger: 'blur' },
    {
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,48}[A-Za-z0-9])?$/,
      message: '编码仅支持字母、数字、下划线和连字符，首尾需为字母或数字',
      trigger: 'blur'
    }
  ],
  name: [{ required: true, message: '请输入组织名称', trigger: 'blur' }],
  sortOrder: [{ required: true, message: '请输入排序值', trigger: 'change' }]
}

const visibleUnits = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase('zh-CN')
  return units.value.filter((unit) => {
    if (!showDisabled.value && unit.status !== ORG_UNIT_STATUS.ACTIVE) return false
    if (!query) return true
    return [unit.name, unit.code].some((value) => (
      String(value || '').toLocaleLowerCase('zh-CN').includes(query)
    ))
  })
})

const orgTree = computed(() => buildOrgUnitTree(visibleUnits.value))

const parentOptions = computed(() => mapParentOptions(buildOrgUnitTree(units.value)))

const prospectiveLevel = computed(() => {
  if (!orgForm.parentId) return 1
  const parent = units.value.find((unit) => unit._id === orgForm.parentId)
  return (parent?.level || 5) + 1
})

function createEmptyForm() {
  return {
    parentId: null,
    type: 'SUB_DEPARTMENT',
    code: '',
    name: '',
    status: ORG_UNIT_STATUS.ACTIVE,
    sortOrder: 0,
    reason: ''
  }
}

function typeLabel(type) {
  return ORG_UNIT_TYPE_OPTIONS.find((item) => item.value === type)?.label || type
}

function orgRowClassName({ row }) {
  const level = Math.min(5, Math.max(1, Number(row.level) || 1))
  return `org-row org-row--level-${level}`
}

function handleExpandChange(row, expanded) {
  const current = new Set(expandedRowKeys.value.map(String))
  const rowId = String(row._id)
  if (expanded) current.add(rowId)
  else current.delete(rowId)
  expandedRowKeys.value = [...current]
}

function isUnavailableParent(unit) {
  if (unit.status !== ORG_UNIT_STATUS.ACTIVE || unit.level >= 5) return true
  const editingId = editingUnit.value?._id
  if (!editingId) return false
  return unit._id === editingId || String(unit.path || '').includes(`/${editingId}/`)
}

function mapParentOptions(nodes) {
  return nodes.map((node) => ({
    value: node._id,
    label: `${node.name}（第 ${node.level} 级）`,
    disabled: isUnavailableParent(node),
    children: mapParentOptions(node.children || [])
  }))
}

async function loadOrgUnits() {
  loading.value = true
  try {
    const result = await getOrgUnits()
    units.value = result.orgUnits || []
    expandedRowKeys.value = reconcileExpandedOrgUnitIds(
      units.value,
      hasLoadedOrgUnits.value ? expandedRowKeys.value : null
    )
    hasLoadedOrgUnits.value = true
  } catch (error) {
    ElMessage.error(managementErrorMessage(error, '加载组织架构失败'))
  } finally {
    loading.value = false
  }
}

function openCreateDialog(parent) {
  editingUnit.value = null
  Object.assign(orgForm, createEmptyForm(), {
    parentId: parent?._id || null,
    type: parent ? 'SUB_DEPARTMENT' : 'DEPARTMENT'
  })
  codeServerError.value = ''
  dialogVisible.value = true
}

function openEditDialog(unit) {
  editingUnit.value = unit
  Object.assign(orgForm, {
    parentId: unit.parentId || null,
    type: unit.type,
    code: unit.code,
    name: unit.name,
    status: unit.status,
    sortOrder: unit.sortOrder,
    reason: ''
  })
  codeServerError.value = ''
  dialogVisible.value = true
}

async function submitOrgUnit() {
  const valid = await orgFormRef.value?.validate().catch(() => false)
  if (!valid || prospectiveLevel.value > 5) return

  submitting.value = true
  codeServerError.value = ''
  try {
    const payload = buildOrgUnitPayload(orgForm)
    if (editingUnit.value) await updateOrgUnit(editingUnit.value._id, payload)
    else await createOrgUnit(payload)
    ElMessage.success(editingUnit.value ? '组织已更新' : '组织已创建')
    dialogVisible.value = false
    await loadOrgUnits()
  } catch (error) {
    if (error?.response?.data?.code === 'CODE_EXISTS') {
      codeServerError.value = '该组织编码已在当前团队使用'
    }
    ElMessage.error(managementErrorMessage(error, '保存组织失败'))
  } finally {
    submitting.value = false
  }
}

async function changeStatus(unit, status) {
  const enabling = status === ORG_UNIT_STATUS.ACTIVE
  try {
    const { value } = await ElMessageBox.prompt(
      enabling
        ? `确认重新启用“${unit.name}”？`
        : `停用“${unit.name}”前，必须先停用其活动子组织和成员。`,
      enabling ? '启用组织' : '停用组织',
      {
        confirmButtonText: enabling ? '确认启用' : '确认停用',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '填写变更原因（将写入审计日志）',
        inputValidator: (reason) => Boolean(reason?.trim()) || '请填写变更原因',
        type: 'warning'
      }
    )
    await updateOrgUnit(unit._id, { status, reason: value.trim() })
    ElMessage.success(enabling ? '组织已启用' : '组织已停用')
    await loadOrgUnits()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, enabling ? '启用组织失败' : '停用组织失败'))
  }
}

async function removeOrgUnit(unit) {
  if (deletingUnitId.value) return
  deletingUnitId.value = unit._id
  try {
    const { value } = await ElMessageBox.prompt(
      `确认删除“${unit.name}”并将其移出当前组织树？历史记录和审计信息会继续保留。仅无下级、无成员且无业务数据的组织可以删除。`,
      '删除组织',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '填写删除原因（将写入审计日志）',
        inputValidator: (reason) => Boolean(reason?.trim()) || '请填写删除原因',
        type: 'warning',
        distinguishCancelAndClose: true
      }
    )
    await deleteOrgUnit(unit._id, value.trim())
    expandedRowKeys.value = expandedRowKeys.value.filter((id) => id !== String(unit._id))
    ElMessage.success('组织已移出当前组织树，历史记录与审计信息已保留')
    await loadOrgUnits()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, '删除组织失败'))
  } finally {
    deletingUnitId.value = ''
  }
}

function resetForm() {
  Object.assign(orgForm, createEmptyForm())
  editingUnit.value = null
  codeServerError.value = ''
  orgFormRef.value?.clearValidate()
}

onMounted(loadOrgUnits)
</script>

<style scoped lang="scss">
.org-page {
  width: 100%;
  min-width: 0;
}

.page-heading,
.toolbar,
.name-cell {
  display: flex;
}

.page-heading {
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;

  h1 {
    margin: 0;
    color: #303133;
    font-size: 22px;
    line-height: 1.4;
  }

  p {
    margin: 3px 0 0;
    color: #909399;
    font-size: 13px;
  }
}

.toolbar {
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  background: var(--zl-surface);
  border: 1px solid var(--zl-border-soft);
  border-bottom: 0;
}

.keyword-input {
  width: min(320px, 100%);
}

.toolbar-spacer {
  flex: 1;
}

.record-count {
  color: #909399;
  font-size: 13px;
}

.table-shell {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--zl-border-soft);
  border-radius: 0 0 16px 16px;
}

.table-actions { justify-content: center; }
.table-action-item { display: inline-flex; }

.name-cell {
  min-width: 0;
  flex-direction: column;
  gap: 1px;

  span,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small {
    color: #909399;
  }
}

:deep(.el-table__body tr.org-row--level-1 > td.el-table__cell) {
  background: #e7f1ff !important;
}

:deep(.el-table__body tr.org-row--level-2 > td.el-table__cell) {
  background: #eaf8ee !important;
}

:deep(.el-table__body tr.org-row--level-3 > td.el-table__cell) {
  background: #fff0f5 !important;
}

:deep(.el-table__body tr.org-row--level-4 > td.el-table__cell) {
  background: #fff7e5 !important;
}

:deep(.el-table__body tr.org-row--level-5 > td.el-table__cell) {
  background: #f2efff !important;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px;
}

.full-width {
  width: 100%;
}

@media (max-width: 680px) {
  .page-heading {
    align-items: flex-start;
  }

  .toolbar-spacer {
    display: none;
  }

  .keyword-input {
    width: 100%;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
