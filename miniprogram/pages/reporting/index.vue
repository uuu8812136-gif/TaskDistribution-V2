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

      <view v-if="canViewAttendance || canSubmitAttendance" class="module-row" @click="openAttendance">
        <view class="module-icon attendance-icon">勤</view>
        <view class="module-copy">
          <text class="module-title">出勤日报</text>
          <text class="module-meta">分部填报、部门汇总与审核</text>
        </view>
        <text class="module-arrow">〉</text>
      </view>

      <view v-if="canViewDailyReport" class="module-row" @click="openDailyReport">
        <view class="module-icon daily-report-icon">报</view>
        <view class="module-copy">
          <text class="module-title">生产日报</text>
          <text class="module-meta">生成记录与来源追溯</text>
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
    const canSubmitTransport = computed(() => (
      userStore.can('report.submit', { write: true, teamRequired: true }) &&
      (
        userStore.isSuperAdmin ||
        userStore.context.membership?.functionalRoleKeys?.includes('TRANSPORT_REPORTER')
      )
    ))
    const canViewSchedule = computed(() => userStore.can('report.view'))
    const canViewAttendance = computed(() => userStore.can('report.view'))
    const canViewDailyReport = computed(() => userStore.can('report.view'))
    const canSubmitAttendance = computed(() => userStore.can('report.submit', {
      write: true,
      teamRequired: true
    }))
    const canUseReporting = computed(() => (
      canViewTransport.value ||
      canSubmitTransport.value ||
      canViewSchedule.value ||
      canViewAttendance.value ||
      canViewDailyReport.value ||
      canSubmitAttendance.value
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

    const openAttendance = () => {
      if (!requireGlobalTeam()) return
      uni.navigateTo({ url: `/pages/reporting/attendance${teamQuery()}` })
    }

    const openDailyReport = () => {
      if (!requireGlobalTeam()) return
      uni.navigateTo({ url: `/pages/reporting/daily-report${teamQuery()}` })
    }

    return {
      userStore,
      teamOptions,
      teamIndex,
      selectedTeamName,
      canViewTransport,
      canSubmitTransport,
      canViewSchedule,
      canViewAttendance,
      canViewDailyReport,
      canSubmitAttendance,
      canUseReporting,
      onTeamChange,
      openTransport,
      openSchedule,
      openAttendance,
      openDailyReport
    }
  }
}
</script>

<style scoped lang="scss">
.reporting-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 24rpx 24rpx calc(136rpx + constant(safe-area-inset-bottom));
  padding: 24rpx 24rpx calc(136rpx + env(safe-area-inset-bottom));
  background: var(--zl-page-bg, #eef3fb);
}

.context-bar {
  min-height: 88rpx;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 20rpx 24rpx;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18));
  border-left: 6rpx solid var(--zl-primary, #4096ff);
  border-radius: var(--zl-card-radius, 16rpx);
  box-shadow: 0 8rpx 28rpx rgba(15, 23, 42, 0.06);
  margin-bottom: 24rpx;
}

.context-label { font-size: 24rpx; color: var(--zl-muted, #64748b); margin-right: 24rpx; }
.context-value { flex: 1; min-width: 0; font-size: 28rpx; color: var(--zl-text, #1f2733); text-align: right; }
.context-bar picker { flex: 1; min-width: 0; }
.context-picker { display: flex; align-items: center; justify-content: flex-end; font-size: 28rpx; color: var(--zl-text, #1f2733); }
.arrow { margin-left: 12rpx; color: var(--zl-muted, #64748b); }

.module-list { background: rgba(255, 255, 255, 0.96); border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18)); border-radius: var(--zl-card-radius, 16rpx); overflow: hidden; box-shadow: 0 8rpx 28rpx rgba(15, 23, 42, 0.06); }
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
.transport-icon { background: var(--zl-primary, #4096ff); }
.schedule-icon { background: var(--zl-success, #52c41a); }
.attendance-icon { background: var(--zl-warning, #e6a23c); }
.daily-report-icon { background: #13a8a8; }
.module-copy { flex: 1; min-width: 0; margin-left: 24rpx; }
.module-title { display: block; font-size: 30rpx; color: var(--zl-text, #1f2733); font-weight: 600; }
.module-meta { display: block; margin-top: 8rpx; font-size: 24rpx; color: var(--zl-muted, #64748b); }
.module-arrow { margin-left: 20rpx; color: #94a3b8; font-size: 32rpx; }
.empty-state { padding: 160rpx 0; text-align: center; }
.empty-title { font-size: 28rpx; color: #909399; }
</style>
