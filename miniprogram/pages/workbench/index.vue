<template>
  <view class="workbench-page">
    <view class="context-band">
      <text class="context-kicker">当前项目团队</text>
      <text class="context-name">{{ userStore.activeTeam?.name || (userStore.isGlobalReadOnly ? '全部团队只读' : '未选择') }}</text>
    </view>

    <view class="module-list">
      <view v-if="canUseReporting" class="module-row" @click="openReporting">
        <view class="module-icon reporting-icon">报</view>
        <view class="module-copy">
          <text class="module-title">数据提报</text>
          <text class="module-meta">运输记录与生产排产</text>
        </view>
        <text class="module-arrow">〉</text>
      </view>
      <view v-if="canUseEquipment" class="module-row" @click="openEquipment">
        <view class="module-icon equipment-icon">设</view>
        <view class="module-copy">
          <text class="module-title">设备现场</text>
          <text class="module-meta">扫码、点检、保养与运行小时</text>
        </view>
        <text class="module-arrow">〉</text>
      </view>
    </view>

    <view v-if="!canUseReporting && !canUseEquipment" class="empty-state">
      <text>暂无工作台权限</text>
    </view>
    <CustomTabbar />
  </view>
</template>

<script>
import { computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import CustomTabbar from '@/components/custom-tab-bar/CustomTabBar.vue'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'WorkbenchIndex',
  components: { CustomTabbar },
  setup() {
    const userStore = useUserStore()
    const canUseReporting = computed(() => (
      userStore.hasPermission(['report.view', 'report.submit'], 'any')
    ))
    const canUseEquipment = computed(() => userStore.hasPermission('equipment.view'))
    onShow(() => uni.$emit('tabbar-update'))
    return {
      userStore,
      canUseReporting,
      canUseEquipment,
      openReporting: () => uni.navigateTo({ url: '/pages/reporting/index' }),
      openEquipment: () => uni.navigateTo({ url: '/pages/equipment/index' })
    }
  }
}
</script>

<style scoped lang="scss">
.workbench-page { min-height: 100vh; box-sizing: border-box; padding: 24rpx 24rpx calc(136rpx + env(safe-area-inset-bottom)); background: var(--zl-page-bg, #eef3fb); }
.context-band { padding: 28rpx 24rpx; margin-bottom: 24rpx; background: #ffffff; border: 1px solid var(--zl-border, #dce4ee); border-left: 6rpx solid #4096ff; border-radius: 8rpx; }
.context-kicker { display: block; color: #64748b; font-size: 23rpx; }
.context-name { display: block; margin-top: 8rpx; color: #1f2733; font-size: 32rpx; font-weight: 600; }
.module-list { overflow: hidden; background: #ffffff; border: 1px solid var(--zl-border, #dce4ee); border-radius: 8rpx; }
.module-row { display: flex; align-items: center; min-height: 132rpx; padding: 24rpx; box-sizing: border-box; border-bottom: 1px solid #e8edf3; }
.module-row:last-child { border-bottom: 0; }
.module-icon { display: flex; align-items: center; justify-content: center; width: 72rpx; height: 72rpx; flex: 0 0 72rpx; border-radius: 8rpx; color: #fff; font-size: 29rpx; font-weight: 700; }
.reporting-icon { background: #4096ff; }
.equipment-icon { background: #2f855a; }
.module-copy { min-width: 0; flex: 1; margin-left: 22rpx; }
.module-title, .module-meta { display: block; }
.module-title { color: #1f2733; font-size: 30rpx; font-weight: 600; }
.module-meta { margin-top: 7rpx; color: #64748b; font-size: 24rpx; }
.module-arrow { color: #94a3b8; font-size: 34rpx; }
.empty-state { padding: 160rpx 0; color: #909399; text-align: center; font-size: 27rpx; }
</style>
