<template>
  <view class="schedule-page">
    <view class="mode-tabs">
      <button :class="['mode-tab', { active: mode === 'daily' }]" @click="changeMode('daily')">日排产</button>
      <button :class="['mode-tab', { active: mode === 'monthly' }]" @click="changeMode('monthly')">月排产</button>
    </view>

    <template v-if="mode === 'daily'">
      <view class="toolbar">
        <view class="slot-tabs">
          <button :class="['slot-tab', { active: dailySlot === 'current' }]" @click="changeDailySlot('current')">当月</button>
          <button :class="['slot-tab', { active: dailySlot === 'previous' }]" @click="changeDailySlot('previous')">上月</button>
        </view>
        <text class="month-label">{{ dailyMonth || '-' }}</text>
      </view>

      <view v-if="dailySchedules.length" class="org-picker-row">
        <text class="picker-label">所属组织</text>
        <picker :range="dailyOrgOptions" range-key="label" :value="dailyOrgIndex" @change="onDailyOrgChange">
          <view class="org-picker">{{ currentDailyOrgLabel }} 〉</view>
        </picker>
      </view>

      <view v-if="currentDailySchedule" class="daily-content">
        <view class="forecast-row">
          <text>本月生产计划（预测）</text>
          <text class="forecast-value">{{ displayQuantity(currentDailySchedule.productionPlanForecast) }}</text>
        </view>
        <scroll-view class="table-scroll" scroll-x enhanced>
          <view class="daily-table">
            <view class="table-row table-header">
              <text class="date-cell">日期</text>
              <text v-for="field in dailyFields" :key="field.key" class="quantity-cell">{{ field.label }}</text>
              <text class="quantity-cell total-cell">合计</text>
            </view>
            <view v-for="entry in currentDailySchedule.dailyEntries" :key="entry.date" class="table-row">
              <view class="date-cell">
                <text>{{ entry.date.slice(8) }}日</text>
                <text class="weekday">{{ weekday(entry.date) }}</text>
              </view>
              <text v-for="field in dailyFields" :key="field.key" class="quantity-cell">
                {{ displayQuantity(entry[field.key]) }}
              </text>
              <text class="quantity-cell total-cell">{{ entry.total || 0 }}</text>
            </view>
          </view>
        </scroll-view>
      </view>
      <view v-else-if="!loading" class="empty-state">{{ dailyMonth || '该月份' }}暂无日排产</view>
    </template>

    <template v-else>
      <view class="toolbar monthly-toolbar">
        <text class="picker-label">排产月份</text>
        <picker mode="date" fields="month" :value="monthlyMonth" @change="onMonthlyMonthChange">
          <view class="month-picker">{{ monthlyMonth }} 〉</view>
        </picker>
      </view>

      <view v-if="monthlySchedules.length" class="monthly-list">
        <view v-for="schedule in monthlySchedules" :key="schedule._id" class="monthly-card">
          <view class="monthly-header">
            <text class="monthly-org">{{ displayOrg(schedule.orgUnitId) }}</text>
            <text class="monthly-total">合计 {{ schedule.monthlyTotals?.total || 0 }}</text>
          </view>
          <view class="monthly-grid">
            <view v-for="field in monthlyFields" :key="field.key" class="monthly-cell">
              <text class="monthly-label">{{ field.label }}</text>
              <text class="monthly-value">{{ displayQuantity(schedule.monthlyTotals?.[field.key]) }}</text>
            </view>
          </view>
        </view>
      </view>
      <view v-else-if="!loading" class="empty-state">{{ monthlyMonth }}暂无月排产</view>
    </template>

    <view v-if="loading" class="loading-state">加载中...</view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  getDailyProductionSchedules,
  getMonthlyProductionSchedules,
  getOrgUnits,
  getUsers
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  DAILY_SCHEDULE_FIELDS,
  MONTHLY_SCHEDULE_FIELDS,
  buildOrgUnitOptions,
  businessNaturalMonth,
  orgUnitLabel,
  scopedReportingParams
} from '@/utils/reporting.js'

export default {
  name: 'ProductionScheduleView',
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const mode = ref('daily')
    const dailySlot = ref('current')
    const dailyMonth = ref('')
    const dailySchedules = ref([])
    const dailyOrgIndex = ref(0)
    const monthlyMonth = ref(businessNaturalMonth())
    const monthlySchedules = ref([])
    const loading = ref(false)
    const orgUnits = ref([])
    const orgUsers = ref([])
    let requestVersion = 0

    const orgOptions = computed(() => buildOrgUnitOptions(orgUnits.value, orgUsers.value))
    const dailyOrgOptions = computed(() => dailySchedules.value.map((schedule) => ({
      value: schedule.orgUnitId,
      label: orgUnitLabel(schedule.orgUnitId, orgOptions.value, userStore.context?.orgUnit)
    })))
    const currentDailySchedule = computed(() => dailySchedules.value[dailyOrgIndex.value] || null)
    const currentDailyOrgLabel = computed(() => (
      dailyOrgOptions.value[dailyOrgIndex.value]?.label || '请选择组织'
    ))

    const readParams = (extra = {}) => scopedReportingParams(
      userStore.mode,
      selectedTeamId.value,
      extra
    )

    const loadOrgLabels = async () => {
      if (!userStore.isTeamMode) return
      const requests = []
      if (userStore.can('org.manage', { teamRequired: true })) {
        requests.push(getOrgUnits({ status: 'ACTIVE' }).then((response) => {
          orgUnits.value = response.orgUnits || []
        }))
      }
      if (userStore.can('member.view', { teamRequired: true })) {
        requests.push(getUsers({ limit: 1000 }).then((response) => {
          orgUsers.value = response.users || []
        }))
      }
      await Promise.allSettled(requests)
    }

    const loadDaily = async () => {
      const version = ++requestVersion
      loading.value = true
      try {
        const response = await getDailyProductionSchedules(dailySlot.value, readParams())
        if (version !== requestVersion) return
        dailyMonth.value = response.month || ''
        dailySchedules.value = response.schedules || []
        dailyOrgIndex.value = 0
      } catch (error) {
        console.error('加载日排产失败:', error)
      } finally {
        if (version === requestVersion) loading.value = false
        uni.stopPullDownRefresh()
      }
    }

    const loadMonthly = async () => {
      const version = ++requestVersion
      loading.value = true
      try {
        const response = await getMonthlyProductionSchedules(readParams({
          month: monthlyMonth.value,
          page: 1,
          pageSize: 100
        }))
        if (version !== requestVersion) return
        monthlySchedules.value = response.productionSchedules || []
      } catch (error) {
        console.error('加载月排产失败:', error)
      } finally {
        if (version === requestVersion) loading.value = false
        uni.stopPullDownRefresh()
      }
    }

    onLoad((options) => {
      selectedTeamId.value = options?.teamId || ''
      if (!userStore.can('report.view')) {
        uni.showToast({ title: '无权限查看排产', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadOrgLabels()
      loadDaily()
    })

    onPullDownRefresh(() => {
      if (mode.value === 'daily') loadDaily()
      else loadMonthly()
    })

    const changeMode = (nextMode) => {
      if (mode.value === nextMode) return
      mode.value = nextMode
      if (nextMode === 'daily') loadDaily()
      else loadMonthly()
    }
    const changeDailySlot = (slot) => {
      if (dailySlot.value === slot) return
      dailySlot.value = slot
      loadDaily()
    }
    const onDailyOrgChange = (event) => {
      dailyOrgIndex.value = Number(event.detail.value)
    }
    const onMonthlyMonthChange = (event) => {
      monthlyMonth.value = event.detail.value
      loadMonthly()
    }
    const displayQuantity = (value) => (
      value === null || value === undefined || value === '' ? '-' : value
    )
    const displayOrg = (orgUnitId) => orgUnitLabel(
      orgUnitId,
      orgOptions.value,
      userStore.context?.orgUnit
    )
    const weekday = (date) => {
      const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      const parsed = new Date(`${date}T00:00:00+08:00`)
      return labels[parsed.getDay()] || ''
    }

    return {
      mode,
      dailySlot,
      dailyMonth,
      dailySchedules,
      dailyOrgOptions,
      dailyOrgIndex,
      currentDailySchedule,
      currentDailyOrgLabel,
      monthlyMonth,
      monthlySchedules,
      loading,
      dailyFields: DAILY_SCHEDULE_FIELDS,
      monthlyFields: MONTHLY_SCHEDULE_FIELDS,
      changeMode,
      changeDailySlot,
      onDailyOrgChange,
      onMonthlyMonthChange,
      displayQuantity,
      displayOrg,
      weekday
    }
  }
}
</script>

<style scoped lang="scss">
.schedule-page { min-height: 100vh; box-sizing: border-box; padding-bottom: calc(32rpx + constant(safe-area-inset-bottom)); padding-bottom: calc(32rpx + env(safe-area-inset-bottom)); background: var(--zl-page-bg, #eef3fb); }
.mode-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6rpx; padding: 16rpx 24rpx; background: #ffffff; border-bottom: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18)); }
.mode-tab, .slot-tab { height: var(--zl-control-height, 80rpx); line-height: var(--zl-control-height, 80rpx); margin: 0; padding: 0; border-radius: var(--zl-control-radius, 20rpx); background: var(--zl-surface-soft, #f5f8fc); color: var(--zl-muted, #64748b); font-size: 26rpx; }
.mode-tab:first-child, .slot-tab:first-child, .mode-tab:last-child, .slot-tab:last-child { border-radius: var(--zl-control-radius, 20rpx); }
.mode-tab.active, .slot-tab.active { background: var(--zl-primary, #4096ff); color: #ffffff; }
.mode-tab::after, .slot-tab::after { border: none; }
.toolbar { min-height: 104rpx; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 20rpx; padding: 12rpx 24rpx; margin-top: 16rpx; background: #ffffff; }
.slot-tabs { width: 272rpx; display: grid; grid-template-columns: 1fr 1fr; gap: 6rpx; }
.slot-tab { height: 68rpx; line-height: 68rpx; font-size: 24rpx; }
.month-label { color: #303133; font-size: 27rpx; font-weight: 600; }
.org-picker-row { min-height: 84rpx; display: flex; align-items: center; justify-content: space-between; padding: 0 24rpx; background: #ffffff; border-top: 1px solid #ebeef5; }
.picker-label { color: #909399; font-size: 24rpx; }
.org-picker, .month-picker { color: #303133; font-size: 25rpx; }
.daily-content { margin-top: 16rpx; background: #ffffff; }
.forecast-row { min-height: 80rpx; display: flex; align-items: center; justify-content: space-between; padding: 0 24rpx; color: #606266; font-size: 25rpx; border-bottom: 1px solid #ebeef5; }
.forecast-value { color: var(--zl-primary, #4096ff); font-size: 30rpx; font-weight: 600; }
.table-scroll { width: 100%; }
.daily-table { width: 1160rpx; }
.table-row { min-height: 72rpx; display: grid; grid-template-columns: 120rpx repeat(7, 130rpx); align-items: stretch; border-bottom: 1px solid #ebeef5; }
.table-header { min-height: 82rpx; background: #f5f7fa; color: #606266; font-weight: 600; }
.date-cell, .quantity-cell { box-sizing: border-box; display: flex; align-items: center; justify-content: center; padding: 10rpx 8rpx; border-right: 1px solid #ebeef5; font-size: 23rpx; text-align: center; }
.date-cell { flex-direction: column; color: #303133; }
.weekday { margin-top: 3rpx; color: #909399; font-size: 19rpx; }
.quantity-cell { color: #606266; }
.total-cell { border-right: none; color: var(--zl-primary, #4096ff); font-weight: 600; }
.monthly-toolbar { margin-bottom: 16rpx; }
.monthly-list { padding: 0 24rpx; }
.monthly-card { padding: 24rpx; margin-bottom: 20rpx; background: rgba(255, 255, 255, 0.96); border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18)); border-left: 6rpx solid var(--zl-success, #52c41a); border-radius: var(--zl-card-radius, 16rpx); box-shadow: 0 8rpx 28rpx rgba(15, 23, 42, 0.05); }
.monthly-header { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; padding-bottom: 18rpx; border-bottom: 1px solid #ebeef5; }
.monthly-org { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #303133; font-size: 28rpx; font-weight: 600; }
.monthly-total { flex-shrink: 0; color: var(--zl-success, #52c41a); font-size: 25rpx; }
.monthly-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20rpx 28rpx; padding-top: 20rpx; }
.monthly-cell { min-width: 0; }
.monthly-label { display: block; color: #909399; font-size: 22rpx; }
.monthly-value { display: block; margin-top: 6rpx; color: #303133; font-size: 28rpx; }
.empty-state, .loading-state { padding: 180rpx 24rpx; text-align: center; color: #909399; font-size: 27rpx; }
</style>
