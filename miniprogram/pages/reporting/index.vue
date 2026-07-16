<template>
  <view class="reporting-page">
    <view class="context-bar">
      <text class="context-label">项目团队</text>
      <picker
        v-if="userStore.isGlobalReadOnly"
        :range="teamOptions"
        range-key="name"
        :value="teamIndex"
        @change="onTeamChange"
      >
        <view class="context-picker">
          <text>{{ selectedTeamName || '请选择团队' }}</text>
          <text class="arrow">〉</text>
        </view>
      </picker>
      <text v-else class="context-value">{{ userStore.activeTeam?.name || '未选择' }}</text>
    </view>

    <view v-if="canUseReporting" class="module-list">
      <view v-if="canViewTransport || canSubmitTransport" class="module-row" @click="openTransport">
        <view class="module-icon transport-icon">运</view>
        <view class="module-copy">
          <text class="module-title">运输记录</text>
          <text class="module-meta">现场提报与运输记录</text>
        </view>
        <text class="module-arrow">〉</text>
      </view>

      <view v-if="canViewSchedule" class="module-row" @click="openSchedule">
        <view class="module-icon schedule-icon">排</view>
        <view class="module-copy">
          <text class="module-title">生产排产</text>
          <text class="module-meta">日排产与月排产</text>
        </view>
        <text class="module-arrow">〉</text>
      </view>
    </view>

    <view v-else class="empty-state">
      <text class="empty-title">暂无数据提报权限</text>
    </view>

    <CustomTabbar />
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useUserStore } from '@/stores/user.js'
import CustomTabbar from '@/components/custom-tab-bar/CustomTabBar.vue'

export default {
  name: 'ReportingIndex',
  components: { CustomTabbar },
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const teamOptions = computed(() => userStore.teams || [])
    const teamIndex = computed(() => Math.max(
      0,
      teamOptions.value.findIndex((team) => team._id === selectedTeamId.value)
    ))
    const selectedTeamName = computed(() => (
      teamOptions.value.find((team) => team._id === selectedTeamId.value)?.name || ''
    ))
    const canViewTransport = computed(() => userStore.can('report.view'))
    const canSubmitTransport = computed(() => userStore.can('report.submit', {
      write: true,
      teamRequired: true
    }))
    const canViewSchedule = computed(() => userStore.can('report.view'))
    const canUseReporting = computed(() => (
      canViewTransport.value || canSubmitTransport.value || canViewSchedule.value
    ))

    onShow(() => {
      uni.$emit('tabbar-update')
      if (
        userStore.isGlobalReadOnly &&
        !selectedTeamId.value &&
        teamOptions.value.length === 1
      ) {
        selectedTeamId.value = teamOptions.value[0]._id
      }
    })

    const onTeamChange = (event) => {
      selectedTeamId.value = teamOptions.value[Number(event.detail.value)]?._id || ''
    }

    const requireGlobalTeam = () => {
      if (!userStore.isGlobalReadOnly || selectedTeamId.value) return true
      uni.showToast({ title: '请先选择项目团队', icon: 'none' })
      return false
    }

    const teamQuery = () => userStore.isGlobalReadOnly
      ? `?teamId=${encodeURIComponent(selectedTeamId.value)}`
      : ''

    const openTransport = () => {
      if (!requireGlobalTeam()) return
      if (canViewTransport.value) {
        uni.navigateTo({ url: `/pages/reporting/transport-list${teamQuery()}` })
      } else {
        uni.navigateTo({ url: '/pages/reporting/transport-form' })
      }
    }

    const openSchedule = () => {
      if (!requireGlobalTeam()) return
      uni.navigateTo({ url: `/pages/reporting/schedule${teamQuery()}` })
    }

    return {
      userStore,
      teamOptions,
      teamIndex,
      selectedTeamName,
      canViewTransport,
      canSubmitTransport,
      canViewSchedule,
      canUseReporting,
      onTeamChange,
      openTransport,
      openSchedule
    }
  }
}
</script>

<style scoped lang="scss">
.reporting-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 24rpx 24rpx 180rpx;
  background: #f5f7fa;
}

.context-bar {
  min-height: 88rpx;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 20rpx 24rpx;
  background: #ffffff;
  border-left: 6rpx solid #409eff;
  border-radius: 8rpx;
  margin-bottom: 24rpx;
}

.context-label { font-size: 24rpx; color: #909399; margin-right: 24rpx; }
.context-value { flex: 1; min-width: 0; font-size: 28rpx; color: #303133; text-align: right; }
.context-bar picker { flex: 1; min-width: 0; }
.context-picker { display: flex; align-items: center; justify-content: flex-end; font-size: 28rpx; color: #303133; }
.arrow { margin-left: 12rpx; color: #909399; }

.module-list { background: #ffffff; border-radius: 8rpx; overflow: hidden; }
.module-row {
  min-height: 128rpx;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 24rpx;
  border-bottom: 1px solid #ebeef5;
}
.module-row:last-child { border-bottom: none; }
.module-icon {
  width: 72rpx;
  height: 72rpx;
  flex: 0 0 72rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8rpx;
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
}
.transport-icon { background: #409eff; }
.schedule-icon { background: #67c23a; }
.module-copy { flex: 1; min-width: 0; margin-left: 24rpx; }
.module-title { display: block; font-size: 30rpx; color: #303133; font-weight: 600; }
.module-meta { display: block; margin-top: 8rpx; font-size: 24rpx; color: #909399; }
.module-arrow { margin-left: 20rpx; color: #c0c4cc; font-size: 32rpx; }
.empty-state { padding: 160rpx 0; text-align: center; }
.empty-title { font-size: 28rpx; color: #909399; }
</style>
