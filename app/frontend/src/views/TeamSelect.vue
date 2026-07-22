<template>
  <div class="team-select-page">
    <header class="page-header">
      <div>
        <h1>选择项目团队</h1>
        <p>{{ session.user?.name }}，请选择本次要进入的团队。</p>
      </div>
      <div class="header-actions">
        <el-button
          v-if="session.isSuperAdmin && !session.isGlobalReadOnly"
          :loading="switching === 'global'"
          :disabled="Boolean(switching) || refreshing || logoutSubmitting"
          @click="enterGlobal"
        >
          <el-icon><View /></el-icon>
          全部团队只读
        </el-button>
        <el-button
          text
          :loading="logoutSubmitting"
          :disabled="Boolean(switching) || refreshing || logoutSubmitting"
          @click="handleLogout"
        >
          <el-icon><SwitchButton /></el-icon>
          退出登录
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="session.isGlobalReadOnly"
      title="当前处于全部团队只读视图"
      type="warning"
      :closable="false"
      show-icon
    />

    <div v-if="teamsError" class="team-error" role="alert">
      <el-icon><WarningFilled /></el-icon>
      <span>{{ teamsError }}</span>
      <el-button link type="primary" :disabled="refreshing" @click="loadTeams">重新加载</el-button>
    </div>

    <div v-if="session.teams.length" v-loading="refreshing" class="team-grid">
      <button
        v-for="team in session.teams"
        :key="team._id"
        type="button"
        class="team-card"
        :class="{ active: session.isTeamMode && team._id === session.activeTeamId }"
        :disabled="Boolean(switching) || refreshing || logoutSubmitting"
        @click="selectTeam(team)"
      >
        <span class="team-icon"><el-icon><OfficeBuilding /></el-icon></span>
        <span class="team-copy">
          <strong>{{ team.name }}</strong>
          <span>{{ team.code || '项目团队' }}</span>
          <small v-if="team.membership?.positionKey">
            {{ team.membership.positionKey }}
          </small>
        </span>
        <el-icon v-if="switching === team._id" class="is-loading"><Loading /></el-icon>
        <el-icon v-else><ArrowRight /></el-icon>
      </button>
    </div>

    <el-empty
      v-if="!refreshing && !session.teams.length"
      :description="teamsError ? '未能加载项目团队' : '暂无可进入的项目团队'"
    >
      <el-button type="primary" @click="loadTeams">重新加载</el-button>
    </el-empty>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'

const router = useRouter()
const session = useSessionStore()
const refreshing = ref(false)
const switching = ref('')
const logoutSubmitting = ref(false)
const teamsError = ref('')

const loadTeams = async () => {
  if (refreshing.value) return
  refreshing.value = true
  teamsError.value = ''
  try {
    await session.refreshTeams()
  } catch {
    teamsError.value = session.teams.length
      ? '项目团队刷新失败，当前显示上次加载结果。'
      : '项目团队加载失败，请检查网络后重试。'
  } finally {
    refreshing.value = false
  }
}

const selectTeam = async (team) => {
  if (switching.value || refreshing.value || logoutSubmitting.value) return
  if (session.isTeamMode && team._id === session.activeTeamId) {
    await router.replace({ name: 'Dashboard' })
    return
  }

  switching.value = team._id
  try {
    await session.switchTeam(team._id)
    ElMessage.success(`已进入${team.name}`)
    await router.replace({ name: 'Dashboard' })
  } catch {
    // 请求层统一展示错误，用户可重新选择。
  } finally {
    switching.value = ''
  }
}

const enterGlobal = async () => {
  if (switching.value || refreshing.value || logoutSubmitting.value) return
  switching.value = 'global'
  try {
    await session.enterGlobalReadOnly()
    await router.replace({ name: 'Dashboard' })
  } catch {
    // 请求层统一展示错误，保留当前团队上下文。
  } finally {
    switching.value = ''
  }
}

const handleLogout = async () => {
  if (switching.value || refreshing.value || logoutSubmitting.value) return
  logoutSubmitting.value = true
  try {
    await session.logout()
  } catch {
    // 服务端不可达时也清理本地会话并退出。
  } finally {
    await router.replace({ name: 'Login' })
    logoutSubmitting.value = false
  }
}

onMounted(() => {
  if (!session.teams.length) loadTeams()
})
</script>

<style scoped lang="scss">
.team-select-page {
  min-height: 100vh;
  min-height: 100dvh;
  padding: 36px clamp(20px, 5vw, 72px);
  color: #303133;
  background: #f5f7fa;
}

.page-header {
  max-width: 1120px;
  margin: 0 auto 24px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;

  h1 {
    margin: 0 0 8px;
    font-size: 26px;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: #606266;
    overflow-wrap: anywhere;
  }
}

.header-actions {
  display: flex;
  align-items: center;
}

.el-alert,
.team-error,
.team-grid,
.el-empty {
  max-width: 1120px;
  margin-inline: auto;
}

.el-alert {
  margin-bottom: 18px;
}

.team-error {
  min-height: 40px;
  margin-bottom: 18px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border: 1px solid var(--el-color-danger-light-7);
  border-radius: 6px;

  span {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
}

.team-grid {
  min-height: 100px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

.team-card {
  min-height: 108px;
  padding: 18px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 14px;
  color: inherit;
  text-align: left;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.18s, box-shadow 0.18s;

  &:hover,
  &:focus-visible,
  &.active {
    border-color: #409eff;
    box-shadow: 0 3px 12px rgba(31, 45, 61, 0.09);
    outline: none;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.72;
  }
}

.team-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  color: #337ecc;
  background: #ecf5ff;
  border-radius: 6px;
  font-size: 21px;
}

.team-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong,
  span,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 16px;
  }

  span,
  small {
    color: #909399;
  }
}

@media (max-width: 640px) {
  .team-select-page {
    padding: 24px 14px;
  }

  .page-header {
    flex-direction: column;
  }

  .header-actions {
    width: 100%;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>
