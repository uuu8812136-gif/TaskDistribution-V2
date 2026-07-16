<template>
  <div class="member-page">
    <header class="page-heading">
      <div>
        <h1>团队成员</h1>
        <p>{{ session.activeTeam?.name || '当前团队' }}的账号、岗位和固定权限</p>
      </div>
      <PermissionGuard permission="member.manage" write team-required team-admin-only>
        <el-tooltip
          :disabled="canLoadOrganization"
          content="新增成员需要同时具备组织管理权限"
          placement="bottom"
        >
          <span>
            <el-button
              type="primary"
              :disabled="!canLoadOrganization"
              @click="openCreateDialog"
            >
              <el-icon><Plus /></el-icon>
              新增成员
            </el-button>
          </span>
        </el-tooltip>
      </PermissionGuard>
    </header>

    <section class="toolbar" aria-label="成员筛选">
      <el-input
        v-model="filters.keyword"
        clearable
        placeholder="搜索用户名、姓名、手机或组织"
        class="keyword-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="filters.role" clearable placeholder="全部成员类型">
        <el-option label="项目管理员" value="PROJECT_ADMIN" />
        <el-option label="普通成员" value="MEMBER" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="全部状态">
        <el-option label="正常" value="ACTIVE" />
        <el-option label="已停用" value="DISABLED" />
      </el-select>
      <el-button :loading="loading" @click="loadPageData">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </section>

    <div class="table-shell">
      <el-table
        v-loading="loading"
        :data="pagedMembers"
        row-key="_id"
        stripe
        table-layout="fixed"
        empty-text="当前筛选条件下暂无成员"
      >
        <el-table-column label="账号与姓名" min-width="190">
          <template #default="{ row }">
            <div class="primary-cell">
              <strong>{{ row.user?.name || '-' }}</strong>
              <span>{{ row.user?.username || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="组织" min-width="170" show-overflow-tooltip>
          <template #default="{ row }">
            <div class="primary-cell">
              <span class="main-text">{{ row.orgUnit?.name || '组织已失效' }}</span>
              <span>{{ row.orgUnit?.code || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="岗位" min-width="150">
          <template #default="{ row }">
            {{ positionLabel(row.positionKey) }}
          </template>
        </el-table-column>
        <el-table-column label="成员类型" width="120">
          <template #default="{ row }">
            <el-tag :type="row.role === 'PROJECT_ADMIN' ? 'warning' : 'info'" effect="plain">
              {{ row.role === 'PROJECT_ADMIN' ? '项目管理员' : '普通成员' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="职能角色" min-width="170">
          <template #default="{ row }">
            <div v-if="row.functionalRoleKeys?.length" class="tag-list">
              <el-tag
                v-for="roleKey in row.functionalRoleKeys"
                :key="roleKey"
                size="small"
                effect="plain"
              >
                {{ functionalRoleLabel(roleKey) }}
              </el-tag>
            </div>
            <span v-else class="muted">未设置</span>
          </template>
        </el-table-column>
        <el-table-column label="权限" width="88" align="center">
          <template #default="{ row }">
            <el-popover placement="left" :width="340" trigger="click">
              <template #reference>
                <el-button text type="primary">{{ row.permissionKeys?.length || 0 }} 项</el-button>
              </template>
              <div class="permission-summary">
                <template v-for="group in permissionGroupsFor(row.permissionKeys)" :key="group.key">
                  <strong>{{ group.label }}</strong>
                  <span>{{ group.labels.join('、') }}</span>
                </template>
                <el-empty
                  v-if="!row.permissionKeys?.length"
                  :image-size="42"
                  description="未授予固定权限"
                />
              </div>
            </el-popover>
          </template>
        </el-table-column>
        <el-table-column label="联系方式" min-width="185">
          <template #default="{ row }">
            <div class="primary-cell">
              <span class="main-text">{{ row.user?.phone || '-' }}</span>
              <span>{{ row.user?.email || '-' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="118">
          <template #default="{ row }">
            <div class="status-stack">
              <el-tag
                :type="row.status === 'ACTIVE' ? 'success' : 'danger'"
                size="small"
                effect="plain"
              >
                成员{{ row.status === 'ACTIVE' ? '正常' : '停用' }}
              </el-tag>
              <span v-if="row.user?.status !== 'active'" class="identity-warning">账号已停用</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="canManageMembers" label="操作" width="132" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <template v-if="canManageRow(row)">
                <el-button text type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button
                  v-if="row.status === 'ACTIVE'"
                  text
                  type="danger"
                  @click="disableMember(row)"
                >
                  停用
                </el-button>
                <el-button v-else text type="success" @click="enableMember(row)">启用</el-button>
              </template>
              <el-tooltip v-else content="项目管理员只能由超级管理员维护">
                <span class="muted">不可维护</span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="filteredMembers.length"
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.limit"
        :total="filteredMembers.length"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        class="pagination"
      />
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingMember ? '编辑成员关系' : '新增团队成员'"
      width="min(760px, 94vw)"
      destroy-on-close
      append-to-body
      @closed="resetMemberForm"
    >
      <el-alert
        v-if="editingMember"
        title="全局账号资料在此只读；本次仅修改当前团队中的组织、岗位、角色和权限。"
        type="info"
        :closable="false"
        show-icon
        class="dialog-alert"
      />
      <el-form
        ref="memberFormRef"
        :model="memberForm"
        :rules="memberRules"
        label-position="top"
        status-icon
      >
        <h2 class="form-section-title">全局账号</h2>
        <div class="form-grid">
          <el-form-item label="用户名" prop="username" :error="usernameServerError">
            <el-input
              v-model="memberForm.username"
              :disabled="Boolean(editingMember)"
              maxlength="50"
              autocomplete="off"
              @input="usernameServerError = ''"
            />
          </el-form-item>
          <el-form-item v-if="!editingMember" label="初始密码" prop="password">
            <el-input
              v-model="memberForm.password"
              type="password"
              show-password
              maxlength="200"
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="姓名" prop="name">
            <el-input v-model="memberForm.name" :disabled="Boolean(editingMember)" maxlength="100" />
          </el-form-item>
          <el-form-item label="手机">
            <el-input v-model="memberForm.phone" :disabled="Boolean(editingMember)" maxlength="30" />
          </el-form-item>
          <el-form-item label="邮箱" prop="email">
            <el-input v-model="memberForm.email" :disabled="Boolean(editingMember)" maxlength="254" />
          </el-form-item>
        </div>

        <h2 class="form-section-title">当前团队成员关系</h2>
        <div class="form-grid">
          <el-form-item label="所属组织" prop="orgUnitId">
            <el-tree-select
              v-model="memberForm.orgUnitId"
              :data="orgTreeOptions"
              node-key="value"
              check-strictly
              default-expand-all
              filterable
              :render-after-expand="false"
              placeholder="选择五级组织中的节点"
              class="full-width"
            />
          </el-form-item>
          <el-form-item label="固定岗位" prop="positionKey">
            <el-select v-model="memberForm.positionKey" class="full-width">
              <el-option
                v-for="position in POSITION_OPTIONS"
                :key="position.value"
                :label="`${position.label}（层级 ${position.level}）`"
                :value="position.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="成员类型" prop="role">
            <el-select v-model="memberForm.role" class="full-width" @change="handleRoleChange">
              <el-option label="普通成员" value="MEMBER" />
              <el-option
                v-if="canAssignProjectAdmin"
                label="项目管理员"
                value="PROJECT_ADMIN"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="职能角色">
            <el-checkbox-group v-model="memberForm.functionalRoleKeys" class="checkbox-line">
              <el-checkbox
                v-for="role in FUNCTIONAL_ROLE_OPTIONS"
                :key="role.value"
                :label="role.value"
              >
                {{ role.label }}
              </el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </div>

        <el-form-item label="固定权限" prop="permissionKeys">
          <div class="permission-editor">
            <section v-for="group in PERMISSION_GROUPS" :key="group.key" class="permission-group">
              <div class="permission-group-heading">
                <el-checkbox
                  :model-value="isPermissionGroupSelected(group)"
                  :indeterminate="isPermissionGroupIndeterminate(group)"
                  @change="togglePermissionGroup(group, $event)"
                >
                  {{ group.label }}
                </el-checkbox>
              </div>
              <el-checkbox-group v-model="memberForm.permissionKeys">
                <el-checkbox
                  v-for="permission in group.options"
                  :key="permission.value"
                  :label="permission.value"
                >
                  {{ permission.label }}
                </el-checkbox>
              </el-checkbox-group>
            </section>
          </div>
        </el-form-item>
        <el-form-item label="变更说明">
          <el-input
            v-model="memberForm.reason"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
            placeholder="可填写本次授权或调整原因"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitMember">
          {{ editingMember ? '保存变更' : '创建成员' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PermissionGuard from '@/components/PermissionGuard.vue'
import {
  createTeamMember,
  disableTeamMember,
  getOrgUnits,
  getTeamMembers,
  updateTeamMember
} from '@/api/teamManagement'
import { useSessionStore } from '@/stores/session'
import {
  FUNCTIONAL_ROLE_OPTIONS,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUS,
  PERMISSION_GROUPS,
  POSITION_OPTIONS,
  PROJECT_ADMIN_DEFAULT_PERMISSIONS,
  buildMemberCreatePayload,
  buildMemberUpdatePayload,
  buildOrgUnitTree,
  canManageMembership,
  managementErrorMessage
} from '@/utils/teamManagement'

const session = useSessionStore()
const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const editingMember = ref(null)
const memberFormRef = ref(null)
const usernameServerError = ref('')
const members = ref([])
const orgUnits = ref([])

const filters = reactive({ keyword: '', role: '', status: '' })
const pagination = reactive({ page: 1, limit: 20 })
const memberForm = reactive(createEmptyMemberForm())

const canManageMembers = computed(() => (
  session.can('member.manage', { write: true, teamRequired: true }) &&
  (session.isSuperAdmin || session.context.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN)
))
const canLoadOrganization = computed(() => session.hasPermission('org.manage'))
const canAssignProjectAdmin = computed(() => session.isSuperAdmin && session.isTeamMode)

const effectiveOrgUnits = computed(() => {
  if (orgUnits.value.length) return orgUnits.value
  const unique = new Map()
  for (const member of members.value) {
    if (member.orgUnit?._id) unique.set(member.orgUnit._id, member.orgUnit)
  }
  return [...unique.values()]
})

const orgTreeOptions = computed(() => mapOrgOptions(buildOrgUnitTree(effectiveOrgUnits.value)))
const positionMap = new Map(POSITION_OPTIONS.map((item) => [item.value, item.label]))
const functionalRoleMap = new Map(FUNCTIONAL_ROLE_OPTIONS.map((item) => [item.value, item.label]))

const filteredMembers = computed(() => {
  const keyword = filters.keyword.trim().toLocaleLowerCase('zh-CN')
  return members.value.filter((member) => {
    if (filters.role && member.role !== filters.role) return false
    if (filters.status && member.status !== filters.status) return false
    if (!keyword) return true
    return [
      member.user?.username,
      member.user?.name,
      member.user?.phone,
      member.user?.email,
      member.orgUnit?.name,
      member.orgUnit?.code
    ].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword))
  })
})

const pagedMembers = computed(() => {
  const start = (pagination.page - 1) * pagination.limit
  return filteredMembers.value.slice(start, start + pagination.limit)
})

const memberRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 50, message: '用户名长度为 3 至 50 个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入初始密码', trigger: 'blur' },
    { min: 6, max: 200, message: '密码长度为 6 至 200 个字符', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
  email: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
  orgUnitId: [{ required: true, message: '请选择所属组织', trigger: 'change' }],
  positionKey: [{ required: true, message: '请选择固定岗位', trigger: 'change' }],
  role: [{ required: true, message: '请选择成员类型', trigger: 'change' }]
}

function createEmptyMemberForm() {
  return {
    username: '',
    password: '',
    name: '',
    phone: '',
    email: '',
    orgUnitId: '',
    role: MEMBERSHIP_ROLES.MEMBER,
    positionKey: 'EMPLOYEE',
    functionalRoleKeys: [],
    permissionKeys: ['task.view'],
    status: MEMBERSHIP_STATUS.ACTIVE,
    reason: ''
  }
}

function mapOrgOptions(nodes) {
  return nodes.map((node) => ({
    value: node._id,
    label: `${node.name}（${node.code}）`,
    disabled: node.status !== 'ACTIVE',
    children: mapOrgOptions(node.children || [])
  }))
}

function positionLabel(key) {
  return positionMap.get(key) || key || '-'
}

function functionalRoleLabel(key) {
  return functionalRoleMap.get(key) || key
}

function permissionGroupsFor(keys = []) {
  const selected = new Set(keys)
  return PERMISSION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    labels: group.options.filter((item) => selected.has(item.value)).map((item) => item.label)
  })).filter((group) => group.labels.length)
}

function isPermissionGroupSelected(group) {
  return group.options.every((item) => memberForm.permissionKeys.includes(item.value))
}

function isPermissionGroupIndeterminate(group) {
  const count = group.options.filter((item) => memberForm.permissionKeys.includes(item.value)).length
  return count > 0 && count < group.options.length
}

function togglePermissionGroup(group, selected) {
  const groupKeys = new Set(group.options.map((item) => item.value))
  memberForm.permissionKeys = selected
    ? [...new Set([...memberForm.permissionKeys, ...groupKeys])]
    : memberForm.permissionKeys.filter((key) => !groupKeys.has(key))
}

function canManageRow(member) {
  return canManageMembership({
    isTeamMode: session.isTeamMode,
    isReadOnly: session.isReadOnly,
    isSuperAdmin: session.isSuperAdmin,
    membershipRole: session.context.membership?.role,
    permissionKeys: session.permissionKeys
  }, member)
}

async function loadAllMembers() {
  const first = await getTeamMembers({ page: 1, limit: 100 })
  const pages = Number(first.pagination?.pages) || 1
  const result = [...(first.members || [])]
  for (let page = 2; page <= pages; page += 1) {
    const response = await getTeamMembers({ page, limit: 100 })
    result.push(...(response.members || []))
  }
  members.value = result
}

async function loadPageData() {
  loading.value = true
  try {
    const jobs = [loadAllMembers()]
    if (canLoadOrganization.value) {
      jobs.push(getOrgUnits().then((result) => { orgUnits.value = result.orgUnits || [] }))
    }
    await Promise.all(jobs)
  } catch (error) {
    ElMessage.error(managementErrorMessage(error, '加载成员数据失败'))
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  editingMember.value = null
  Object.assign(memberForm, createEmptyMemberForm())
  usernameServerError.value = ''
  dialogVisible.value = true
}

function openEditDialog(member) {
  editingMember.value = member
  Object.assign(memberForm, {
    ...createEmptyMemberForm(),
    username: member.user?.username || '',
    name: member.user?.name || '',
    phone: member.user?.phone || '',
    email: member.user?.email || '',
    orgUnitId: member.orgUnitId,
    role: member.role,
    positionKey: member.positionKey,
    functionalRoleKeys: [...(member.functionalRoleKeys || [])],
    permissionKeys: [...(member.permissionKeys || [])],
    status: member.status
  })
  memberForm.password = ''
  usernameServerError.value = ''
  dialogVisible.value = true
}

function handleRoleChange(role) {
  if (role === MEMBERSHIP_ROLES.PROJECT_ADMIN) {
    memberForm.permissionKeys = [...PROJECT_ADMIN_DEFAULT_PERMISSIONS]
  }
}

async function submitMember() {
  const valid = await memberFormRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  usernameServerError.value = ''
  try {
    if (editingMember.value) {
      await updateTeamMember(
        editingMember.value._id,
        buildMemberUpdatePayload(memberForm)
      )
      ElMessage.success('成员关系已更新')
    } else {
      await createTeamMember(buildMemberCreatePayload(memberForm))
      memberForm.password = ''
      ElMessage.success('团队成员已创建')
    }
    dialogVisible.value = false
    await loadPageData()
  } catch (error) {
    if (error?.response?.data?.code === 'USERNAME_EXISTS') {
      usernameServerError.value = '该用户名已被使用，用户名在全系统必须唯一'
    }
    ElMessage.error(managementErrorMessage(error, '保存成员失败'))
  } finally {
    submitting.value = false
  }
}

async function disableMember(member) {
  try {
    const { value } = await ElMessageBox.prompt(
      `停用后，${member.user?.name || member.user?.username}将无法进入当前团队。`,
      '停用团队成员',
      {
        confirmButtonText: '确认停用',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '填写停用原因（将写入审计日志）',
        inputValidator: (reason) => Boolean(reason?.trim()) || '请填写停用原因',
        type: 'warning'
      }
    )
    await disableTeamMember(member._id, value.trim())
    ElMessage.success('成员已停用')
    await loadPageData()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, '停用成员失败'))
  }
}

async function enableMember(member) {
  try {
    await ElMessageBox.confirm(
      `确认恢复${member.user?.name || member.user?.username}在当前团队中的访问权限？`,
      '启用团队成员',
      { confirmButtonText: '确认启用', cancelButtonText: '取消', type: 'warning' }
    )
    await updateTeamMember(member._id, {
      status: MEMBERSHIP_STATUS.ACTIVE,
      reason: '管理员从成员列表重新启用'
    })
    ElMessage.success('成员已启用')
    await loadPageData()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, '启用成员失败'))
  }
}

function resetMemberForm() {
  memberForm.password = ''
  Object.assign(memberForm, createEmptyMemberForm())
  editingMember.value = null
  usernameServerError.value = ''
  memberFormRef.value?.clearValidate()
}

watch(
  () => [filters.keyword, filters.role, filters.status, pagination.limit],
  () => { pagination.page = 1 }
)

onMounted(loadPageData)
</script>

<style scoped lang="scss">
.member-page {
  width: 100%;
  min-width: 0;
}

.page-heading,
.toolbar,
.permission-group-heading {
  display: flex;
  align-items: center;
}

.page-heading {
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
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  background: var(--zl-surface);
  border: 1px solid var(--zl-border-soft);
  border-bottom: 0;
}

.keyword-input {
  width: min(330px, 100%);
}

.toolbar :deep(.el-select) {
  width: 150px;
}

.table-shell {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--zl-border-soft);
  border-radius: 0 0 16px 16px;
}

.table-actions { justify-content: center; }

.primary-cell,
.status-stack,
.permission-summary {
  display: flex;
  flex-direction: column;
}

.primary-cell {
  min-width: 0;
  gap: 2px;

  strong,
  .main-text {
    overflow: hidden;
    color: #303133;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span:not(.main-text) {
    overflow: hidden;
    color: #909399;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.status-stack {
  align-items: flex-start;
  gap: 4px;
}

.identity-warning {
  color: #c45656;
  font-size: 12px;
}

.muted {
  color: #909399;
  font-size: 12px;
}

.permission-summary {
  gap: 4px;
  color: #606266;
  font-size: 13px;

  strong:not(:first-child) {
    margin-top: 7px;
  }
}

.pagination {
  justify-content: flex-end;
  padding: 14px 12px;
}

.dialog-alert {
  margin-bottom: 18px;
}

.form-section-title {
  margin: 2px 0 12px;
  padding-bottom: 7px;
  color: #303133;
  font-size: 15px;
  border-bottom: 1px solid #ebeef5;
}

.form-section-title:not(:first-child) {
  margin-top: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px;
}

.full-width {
  width: 100%;
}

.checkbox-line {
  min-height: 32px;
}

.permission-editor {
  width: 100%;
  border: 1px solid #dcdfe6;
  border-radius: 12px;
  overflow: hidden;
}

.permission-group {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  min-height: 48px;
}

.permission-group + .permission-group {
  border-top: 1px solid #ebeef5;
}

.permission-group-heading {
  padding: 8px 12px;
  background: #f5f7fa;
  border-right: 1px solid #ebeef5;
}

.permission-group :deep(.el-checkbox-group) {
  display: grid;
  grid-template-columns: repeat(4, minmax(90px, 1fr));
  gap: 4px 12px;
  padding: 8px 12px;
}

.permission-group :deep(.el-checkbox) {
  margin-right: 0;
}

@media (max-width: 760px) {
  .page-heading {
    align-items: flex-start;
  }

  .toolbar > *,
  .toolbar :deep(.el-select) {
    width: 100%;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .permission-group {
    grid-template-columns: 1fr;
  }

  .permission-group-heading {
    border-right: 0;
    border-bottom: 1px solid #ebeef5;
  }

  .permission-group :deep(.el-checkbox-group) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pagination {
    justify-content: flex-start;
    overflow-x: auto;
  }
}
</style>
