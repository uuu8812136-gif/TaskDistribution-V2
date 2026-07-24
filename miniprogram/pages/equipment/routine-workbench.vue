<template>
  <view class="routine-workbench-page">
    <view class="tab-row">
      <button :class="{ active: activeTab === 'plans' }" @click="switchTab('plans')">逾期提醒</button>
      <button :class="{ active: activeTab === 'exceptions' }" @click="switchTab('exceptions')">异常处理</button>
    </view>

    <view v-if="activeTab === 'plans'" class="list-band">
      <view
        v-for="plan in plans"
        :key="plan._id"
        :class="['list-row', { focused: String(plan._id) === focusedPlanId }]"
      >
        <view class="row-heading">
          <strong>{{ plan.equipment?.name || '-' }}</strong>
          <text :class="planStatusClass(plan.status)">{{ planStatusLabel(plan.status) }}</text>
        </view>
        <text>{{ plan.equipment?.assetCode || '-' }} · {{ plan.windowName }}</text>
        <text>{{ routineLabel(plan.routineType) }}截止 {{ formatTime(plan.dueAt) }}</text>
        <text>{{ plan.orgUnit?.name || '-' }}</text>
      </view>
      <view v-if="!loading && plans.length === 0" class="empty-state">当前没有逾期计划</view>
    </view>

    <view v-else class="list-band">
      <view v-for="item in exceptions" :key="item._id" class="list-row clickable" @click="openException(item)">
        <view class="row-heading">
          <strong>{{ item.equipment?.name || '-' }}</strong>
          <text :class="item.status === 'RESOLVED' ? 'success-tag' : 'danger-tag'">
            {{ item.status === 'RESOLVED' ? '已解决' : '处理中' }}
          </text>
        </view>
        <text>{{ item.summary }}</text>
        <text>{{ stageLabel(item.currentStage) }} · {{ formatTime(item.updatedAt) }}</text>
      </view>
      <view v-if="!loading && exceptions.length === 0" class="empty-state">当前没有异常处理单</view>
    </view>
  </view>
</template>

<script>
import { onUnmounted, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import {
  getEquipmentRoutineExceptions,
  getEquipmentRoutinePlan,
  getEquipmentRoutinePlans
} from '@/api/index.js'
import { createLatestRequestGate } from '@/utils/latestRequest.js'

export default {
  name: 'EquipmentRoutineWorkbench',
  setup() {
    const activeTab = ref('plans')
    const plans = ref([])
    const exceptions = ref([])
    const loading = ref(false)
    const teamId = ref('')
    const focusedPlanId = ref('')
    const requestGate = createLatestRequestGate()
    const query = (request) => ({
      ...(request.teamId ? { teamId: request.teamId } : {}),
      page: 1,
      pageSize: 100
    })
    const load = async () => {
      const request = requestGate.begin({
        tab: activeTab.value,
        teamId: teamId.value,
        planId: focusedPlanId.value
      })
      loading.value = true
      try {
        if (request.tab === 'plans') {
          const [result, focusedResult] = await Promise.all([
            getEquipmentRoutinePlans({ ...query(request), status: 'OVERDUE' }),
            request.planId
              ? getEquipmentRoutinePlan(request.planId, query(request)).catch(() => null)
              : Promise.resolve(null)
          ])
          if (!requestGate.isCurrent(request)) return
          const rows = result.plans || []
          const focusedPlan = focusedResult?.plan
          const mergedRows = focusedPlan && !rows.some((plan) => String(plan._id) === request.planId)
            ? [focusedPlan, ...rows]
            : rows
          plans.value = request.planId
            ? [...mergedRows].sort((left, right) => (
                Number(String(right._id) === request.planId) -
                Number(String(left._id) === request.planId)
              ))
            : mergedRows
        } else {
          const result = await getEquipmentRoutineExceptions(query(request))
          if (!requestGate.isCurrent(request)) return
          exceptions.value = result.exceptions || []
        }
      } finally {
        if (requestGate.isCurrent(request)) {
          loading.value = false
          uni.stopPullDownRefresh()
        }
      }
    }
    const switchTab = (tab) => {
      activeTab.value = tab
      load()
    }
    const openException = (item) => {
      uni.navigateTo({
        url: `/pages/equipment/routine-exception?exceptionId=${item._id}${teamId.value ? `&teamId=${teamId.value}` : ''}`
      })
    }
    const routineLabel = (value) => value === 'MAINTENANCE' ? '保养' : '点检'
    const planStatusLabel = (value) => ({
      OVERDUE: '已逾期',
      COMPLETED: '已完成',
      CANCELLED: '已取消',
      PENDING: '待执行',
      DUE: '待执行'
    }[value] || value || '待执行')
    const planStatusClass = (value) => ({
      'danger-tag': value === 'OVERDUE',
      'success-tag': value === 'COMPLETED',
      'neutral-tag': !['OVERDUE', 'COMPLETED'].includes(value)
    })
    const stageLabel = (value) => ({
      TEAM_LEADER: '班组长处理',
      SUB_DEPARTMENT_MANAGER: '分部负责人处理',
      ASSET_ADMIN: '设备管理员处理',
      RESOLVED: '已解决'
    }[value] || value || '-')
    const formatTime = (value) => value ? String(value).replace('T', ' ').slice(0, 16) : '-'
    onLoad((options) => {
      teamId.value = options.teamId || ''
      focusedPlanId.value = options.planId || ''
      if (options.tab === 'exceptions') activeTab.value = 'exceptions'
    })
    onShow(load)
    onPullDownRefresh(load)
    onUnmounted(() => requestGate.invalidate())
    return {
      activeTab, plans, exceptions, loading, focusedPlanId, switchTab, openException,
      routineLabel, planStatusLabel, planStatusClass, stageLabel, formatTime
    }
  }
}
</script>

<style scoped lang="scss">
.routine-workbench-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.tab-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10rpx; margin-bottom: 20rpx; }
.tab-row button { height: 72rpx; line-height: 72rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #52606d; background: #fff; font-size: 25rpx; }
.tab-row button.active { color: #fff; background: #1677ff; }
.list-band { overflow: hidden; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.list-row { display: grid; gap: 8rpx; padding: 22rpx 24rpx; border-bottom: 1px solid #e8edf3; }
.list-row.focused { background: #edf5ff; box-shadow: inset 6rpx 0 #1677ff; }
.list-row:last-child { border-bottom: 0; }
.list-row > text { color: #64748b; font-size: 23rpx; overflow-wrap: anywhere; }
.clickable:active { background: #f3f7fb; }
.row-heading { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.row-heading strong { min-width: 0; color: #1f2733; font-size: 28rpx; overflow-wrap: anywhere; }
.danger-tag, .success-tag, .neutral-tag { flex: 0 0 auto; padding: 5rpx 9rpx; border-radius: 6rpx; font-size: 20rpx; }
.danger-tag { color: #b42318; background: #feeceb; }
.success-tag { color: #245d3f; background: #eaf7ef; }
.neutral-tag { color: #475467; background: #eef2f6; }
.empty-state { padding: 150rpx 20rpx; color: #909399; text-align: center; font-size: 25rpx; }
</style>
