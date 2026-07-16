<template>
  <div class="team-control-page">
    <header class="page-heading">
      <div>
        <h1>项目团队控制</h1>
        <p>仅超级管理员可见；跨团队浏览默认只读</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="session.isTeamMode" @click="returnToGlobal">
          <el-icon><View /></el-icon>
          返回全部团队
        </el-button>
        <el-button v-if="session.isGlobalReadOnly" type="primary" @click="openCreateDialog">
          <el-icon><Plus /></el-icon>
          创建团队
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="session.isGlobalReadOnly"
      title="全局控制模式：可以查看、创建和重新启用团队；不能在此修改团队业务数据。"
      type="info"
      :closable="false"
      show-icon
      class="mode-alert"
    />
    <el-alert
      v-else
      title="当前已进入具体团队。停用会立即阻止团队成员继续进入，但不会删除团队数据。"
      type="warning"
      :closable="false"
      show-icon
      class="mode-alert"
    />

    <section class="toolbar">
      <el-input
        v-model="keyword"
        clearable
        placeholder="搜索团队名称或编码"
        class="keyword-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <span class="toolbar-spacer" />
      <span class="mode-label">
        {{ session.isGlobalReadOnly ? '全部团队只读上下文' : `团队上下文：${session.activeTeam?.name || '-'}` }}
      </span>
      <el-button :loading="loading" @click="loadTeams">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </section>

    <div class="table-shell">
      <el-table
        v-loading="loading"
        :data="filteredTeams"
        row-key="_id"
        stripe
        empty-text="暂无团队"
      >
        <el-table-column label="团队" min-width="240">
          <template #default="{ row }">
            <div class="team-cell">
              <strong>{{ row.name }}</strong>
              <span>{{ row.code }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="时区" min-width="160">
          <template #default="{ row }">{{ row.settings?.timeZone || 'Asia/Shanghai' }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="178">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'danger'" effect="plain">
              {{ row.status === 'ACTIVE' ? '正常' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="190" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <template v-if="session.isGlobalReadOnly">
                <el-button
                  v-if="row.status === 'ACTIVE'"
                  text
                  type="primary"
                  :loading="switchingTeamId === row._id"
                  @click="enterTeam(row)"
                >
                  进入团队
                </el-button>
                <el-button
                  v-else
                  text
                  type="success"
                  @click="enableDisabledTeam(row)"
                >
                  重新启用
                </el-button>
              </template>
              <template v-else-if="row._id === session.activeTeamId">
                <el-button
                  v-if="row.status === 'ACTIVE'"
                  text
                  type="danger"
                  @click="disableActiveTeam(row)"
                >
                  停用当前团队
                </el-button>
                <span v-else class="muted">团队已停用</span>
              </template>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="createDialogVisible"
      title="创建项目团队"
      width="min(560px, 94vw)"
      destroy-on-close
      append-to-body
      @closed="resetCreateForm"
    >
      <el-form
        ref="teamFormRef"
        :model="teamForm"
        :rules="teamRules"
        label-position="top"
        status-icon
      >
        <div class="form-grid">
          <el-form-item label="团队编码" prop="code" :error="codeServerError">
            <el-input
              v-model="teamForm.code"
              maxlength="50"
              placeholder="例如 GEARBOX_LOGISTICS"
              @input="codeServerError = ''"
              @blur="teamForm.code = teamForm.code.trim().toUpperCase()"
            />
          </el-form-item>
          <el-form-item label="团队名称" prop="name">
            <el-input v-model="teamForm.name" maxlength="100" placeholder="例如 变速箱物流部" />
          </el-form-item>
          <el-form-item label="时区" prop="timeZone">
            <el-select v-model="teamForm.timeZone" filterable allow-create class="full-width">
              <el-option label="Asia/Shanghai" value="Asia/Shanghai" />
              <el-option label="UTC" value="UTC" />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="创建说明">
          <el-input
            v-model="teamForm.reason"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
            placeholder="可填写客户项目或创建依据"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitTeam">
          创建团队
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createTeam, disableTeam, enableTeam, getTeams } from '@/api/teamManagement'
import { useSessionStore } from '@/stores/session'
import { managementErrorMessage } from '@/utils/teamManagement'

const router = useRouter()
const session = useSessionStore()
const loading = ref(false)
const submitting = ref(false)
const switchingTeamId = ref('')
const createDialogVisible = ref(false)
const teamFormRef = ref(null)
const codeServerError = ref('')
const teams = ref([])
const keyword = ref('')
const teamForm = reactive(createEmptyTeamForm())

const teamRules = {
  code: [
    { required: true, message: '请输入团队编码', trigger: 'blur' },
    {
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,48}[A-Za-z0-9])?$/,
      message: '编码仅支持字母、数字、下划线和连字符，首尾需为字母或数字',
      trigger: 'blur'
    }
  ],
  name: [{ required: true, message: '请输入团队名称', trigger: 'blur' }],
  timeZone: [{ required: true, message: '请选择时区', trigger: 'change' }]
}

const filteredTeams = computed(() => {
  const query = keyword.value.trim().toLocaleLowerCase('zh-CN')
  if (!query) return teams.value
  return teams.value.filter((team) => [team.name, team.code].some((value) => (
    String(value || '').toLocaleLowerCase('zh-CN').includes(query)
  )))
})

function createEmptyTeamForm() {
  return { code: '', name: '', timeZone: 'Asia/Shanghai', reason: '' }
}

function formatDateTime(value) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value))
}

async function loadTeams() {
  loading.value = true
  try {
    const result = await getTeams()
    teams.value = result.teams || []
  } catch (error) {
    ElMessage.error(managementErrorMessage(error, '加载团队列表失败'))
  } finally {
    loading.value = false
  }
}

function openCreateDialog() {
  Object.assign(teamForm, createEmptyTeamForm())
  codeServerError.value = ''
  createDialogVisible.value = true
}

async function submitTeam() {
  const valid = await teamFormRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  codeServerError.value = ''
  try {
    await createTeam({
      code: teamForm.code,
      name: teamForm.name,
      settings: { timeZone: teamForm.timeZone },
      reason: teamForm.reason
    })
    ElMessage.success('项目团队已创建')
    createDialogVisible.value = false
    await Promise.all([loadTeams(), session.refreshTeams()])
  } catch (error) {
    if (error?.response?.data?.code === 'CODE_EXISTS') {
      codeServerError.value = '该团队编码已被使用'
    }
    ElMessage.error(managementErrorMessage(error, '创建团队失败'))
  } finally {
    submitting.value = false
  }
}

async function enterTeam(team) {
  switchingTeamId.value = team._id
  try {
    await session.switchTeam(team._id)
    ElMessage.success(`已进入${team.name}`)
    await loadTeams()
  } catch (error) {
    ElMessage.error(managementErrorMessage(error, '进入团队失败'))
  } finally {
    switchingTeamId.value = ''
  }
}

async function returnToGlobal() {
  try {
    await session.enterGlobalReadOnly()
    await loadTeams()
  } catch (error) {
    ElMessage.error(managementErrorMessage(error, '切换到全部团队失败'))
  }
}

async function enableDisabledTeam(team) {
  try {
    const { value } = await ElMessageBox.prompt(
      `重新启用“${team.name}”后，该团队成员可再次进入。`,
      '重新启用团队',
      {
        confirmButtonText: '确认启用',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '填写启用原因（将写入审计日志）',
        inputValidator: (reason) => Boolean(reason?.trim()) || '请填写启用原因',
        type: 'warning'
      }
    )
    await enableTeam(team._id, { reason: value.trim() })
    ElMessage.success('团队已重新启用')
    await Promise.all([loadTeams(), session.refreshTeams()])
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, '启用团队失败'))
  }
}

async function disableActiveTeam(team) {
  try {
    const { value } = await ElMessageBox.prompt(
      `停用“${team.name}”会阻止全部成员继续进入。现有数据不会删除，后续只能由超级管理员在全局控制模式重新启用。`,
      '停用当前团队',
      {
        confirmButtonText: '确认停用',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '填写停用原因（将写入审计日志）',
        inputValidator: (reason) => Boolean(reason?.trim()) || '请填写停用原因',
        type: 'warning',
        dangerouslyUseHTMLString: false
      }
    )
    await disableTeam(team._id, { reason: value.trim() })
    ElMessage.success('团队已停用，正在返回全部团队控制模式')
    try {
      await session.enterGlobalReadOnly()
      await loadTeams()
    } catch {
      await router.replace({ name: 'TeamSelect' })
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(managementErrorMessage(error, '停用团队失败'))
  }
}

function resetCreateForm() {
  Object.assign(teamForm, createEmptyTeamForm())
  codeServerError.value = ''
  teamFormRef.value?.clearValidate()
}

onMounted(loadTeams)
</script>

<style scoped lang="scss">
.team-control-page {
  width: 100%;
  min-width: 0;
}

.page-heading,
.heading-actions,
.toolbar,
.team-cell {
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

.heading-actions {
  gap: 8px;
}

.mode-alert {
  margin-bottom: 12px;
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

.mode-label {
  color: #606266;
  font-size: 13px;
}

.table-shell {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--zl-border-soft);
  border-radius: 0 0 16px 16px;
}

.table-actions { justify-content: center; }

.team-cell {
  min-width: 0;
  flex-direction: column;
  gap: 2px;

  strong,
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span {
    color: #909399;
    font-size: 12px;
  }
}

.muted {
  color: #909399;
  font-size: 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 18px;
}

.full-width {
  width: 100%;
}

@media (max-width: 650px) {
  .page-heading {
    align-items: flex-start;
  }

  .heading-actions {
    flex-direction: row;
    flex-wrap: wrap;
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
