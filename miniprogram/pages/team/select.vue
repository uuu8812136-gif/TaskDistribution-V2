<template>
  <view class="team-page">
    <view class="page-header">
      <text class="title">选择项目团队</text>
      <text class="subtitle">当前操作和数据范围将限定在所选团队内</text>
    </view>

    <view v-if="loading && teams.length === 0" class="state-text">加载中...</view>
    <view v-else-if="teams.length === 0" class="empty-state">
      <text class="empty-title">暂无可用项目团队</text>
      <text class="empty-text">请联系管理员开通团队成员资格</text>
    </view>

    <view v-else class="team-list">
      <button
        v-for="team in teams"
        :key="team._id"
        class="team-item"
        :class="{ active: team._id === userStore.activeTeamId }"
        :loading="switchingTeamId === team._id"
        :disabled="Boolean(switchingTeamId)"
        @click="selectTeam(team)"
      >
        <view class="team-copy">
          <text class="team-name">{{ team.name }}</text>
          <text v-if="team.code" class="team-code">{{ team.code }}</text>
        </view>
        <text class="team-action">进入</text>
      </button>
    </view>

    <view class="footer-actions">
      <button
        v-if="userStore.isSuperAdmin && !userStore.isGlobalReadOnly"
        class="secondary-button"
        :disabled="Boolean(switchingTeamId)"
        @click="useGlobalReadOnly"
      >
        返回跨团队只读
      </button>
      <button class="text-button" @click="logout">退出登录</button>
    </view>
  </view>
</template>

<script>
import { computed, onMounted, ref } from 'vue'
import { useUserStore } from '@/stores/user.js'
import { useMessageStore } from '@/stores/message.js'

export default {
  name: 'TeamSelect',
  setup() {
    const userStore = useUserStore()
    const messageStore = useMessageStore()
    const loading = ref(false)
    const switchingTeamId = ref('')
    const teams = computed(() => userStore.teams)

    onMounted(async () => {
      if (!userStore.isLogin) {
        uni.reLaunch({ url: '/pages/login/index' })
        return
      }
      loading.value = true
      try {
        await userStore.bootstrap()
        await userStore.refreshTeams()
      } catch (error) {
        console.error('加载团队失败:', error)
      } finally {
        loading.value = false
      }
    })

    const enterBusiness = async () => {
      await messageStore.fetchUnreadCount()
      uni.reLaunch({ url: '/pages/task/received' })
    }

    const selectTeam = async (team) => {
      if (switchingTeamId.value) return
      switchingTeamId.value = team._id
      try {
        await userStore.switchTeam(team._id)
        await enterBusiness()
      } catch (error) {
        console.error('切换团队失败:', error)
      } finally {
        switchingTeamId.value = ''
      }
    }

    const useGlobalReadOnly = async () => {
      if (switchingTeamId.value) return
      switchingTeamId.value = 'GLOBAL_READ_ONLY'
      try {
        await userStore.enterGlobalReadOnly()
        await enterBusiness()
      } catch (error) {
        console.error('切换跨团队只读模式失败:', error)
      } finally {
        switchingTeamId.value = ''
      }
    }

    const logout = () => userStore.logout()

    return {
      userStore,
      teams,
      loading,
      switchingTeamId,
      selectTeam,
      useGlobalReadOnly,
      logout
    }
  }
}
</script>

<style scoped lang="scss">
.team-page {
  min-height: 100vh;
  padding: 64rpx 32rpx;
  box-sizing: border-box;
  background: #f5f7fa;
}

.page-header {
  margin-bottom: 40rpx;
  .title { display: block; font-size: 40rpx; font-weight: 600; color: #303133; }
  .subtitle { display: block; margin-top: 12rpx; font-size: 26rpx; color: #606266; }
}

.team-list { display: flex; flex-direction: column; gap: 20rpx; }
.team-item {
  width: 100%;
  min-height: 112rpx;
  padding: 24rpx 28rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  background: #ffffff;
  border: 2rpx solid #e4e7ed;
  border-radius: 16rpx;
  &::after { border: none; }
  &.active { border-color: #409eff; }
}
.team-copy { flex: 1; min-width: 0; }
.team-name { display: block; font-size: 30rpx; color: #303133; font-weight: 600; }
.team-code { display: block; margin-top: 8rpx; font-size: 24rpx; color: #909399; }
.team-action { margin-left: 24rpx; font-size: 26rpx; color: #409eff; }
.state-text, .empty-state { padding: 120rpx 20rpx; text-align: center; color: #909399; }
.empty-title, .empty-text { display: block; }
.empty-title { font-size: 30rpx; color: #606266; }
.empty-text { margin-top: 12rpx; font-size: 24rpx; }
.footer-actions { margin-top: 48rpx; }
.secondary-button { background: #ffffff; color: #409eff; border: 2rpx solid #409eff; }
.secondary-button::after, .text-button::after { border: none; }
.text-button { margin-top: 20rpx; background: transparent; color: #909399; font-size: 26rpx; }
</style>
