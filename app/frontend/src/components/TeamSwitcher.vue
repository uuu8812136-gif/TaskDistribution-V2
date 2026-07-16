<template>
  <el-dropdown trigger="click" :disabled="loading" @command="handleCommand">
    <el-button class="team-trigger" :loading="loading">
      <el-icon v-if="!loading"><OfficeBuilding /></el-icon>
      <span class="team-name">{{ currentLabel }}</span>
      <el-icon class="el-icon--right"><ArrowDown /></el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu class="team-menu">
        <el-dropdown-item
          v-for="team in session.teams"
          :key="team._id"
          :command="`team:${team._id}`"
          :disabled="session.isTeamMode && team._id === session.activeTeamId"
        >
          <div class="team-option">
            <span>{{ team.name }}</span>
            <small v-if="team.code">{{ team.code }}</small>
          </div>
        </el-dropdown-item>
        <el-dropdown-item v-if="!session.teams.length" disabled>
          暂无可用团队
        </el-dropdown-item>
        <el-dropdown-item
          v-if="session.isSuperAdmin && !session.isGlobalReadOnly"
          command="global"
          divided
        >
          <el-icon><View /></el-icon>
          全部团队（只读）
        </el-dropdown-item>
        <el-dropdown-item command="manage" divided>
          <el-icon><Grid /></el-icon>
          团队选择页
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'

const router = useRouter()
const session = useSessionStore()
const loading = ref(false)

const currentLabel = computed(() => {
  if (session.isGlobalReadOnly) return '全部团队（只读）'
  return session.activeTeam?.name || '选择团队'
})

const handleCommand = async (command) => {
  if (command === 'manage') {
    await router.push({ name: 'TeamSelect' })
    return
  }

  loading.value = true
  try {
    if (command === 'global') {
      await session.enterGlobalReadOnly()
      ElMessage.success('已进入全部团队只读视图')
    } else if (command.startsWith('team:')) {
      const teamId = command.slice(5)
      await session.switchTeam(teamId)
      ElMessage.success(`已切换到${session.activeTeam?.name || '所选团队'}`)
    }
    await router.replace({ name: 'Dashboard' })
  } catch {
    // 请求层统一展示错误，保留当前上下文。
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="scss">
.team-trigger {
  max-width: 240px;
}

.team-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.team-option {
  width: 220px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  small {
    flex: 0 0 auto;
    color: #909399;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

@media (max-width: 720px) {
  .team-trigger {
    max-width: 120px;
    padding-inline: 8px;
  }
}
</style>
