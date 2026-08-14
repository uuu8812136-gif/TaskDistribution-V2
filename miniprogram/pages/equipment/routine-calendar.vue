<template>
  <view class="calendar-page">
    <view v-if="!canView" class="state-band">
      <text class="state-title">无设备查看权限</text>
      <text class="state-copy">请联系当前项目团队管理员开通设备模块权限。</text>
    </view>

    <template v-else>
      <view class="calendar-header">
        <view class="calendar-heading">
          <text class="calendar-title">月度点检日历</text>
          <text class="calendar-subtitle">{{ equipment?.name || '设备' }}</text>
          <text class="calendar-code">固定资产编号：{{ equipment?.assetCode || '-' }}</text>
        </view>
        <view class="month-switcher">
          <button class="month-button" :disabled="loading" @click="changeMonth(-1)">上月</button>
          <text class="month-label">{{ monthLabel }}</text>
          <button class="month-button" :disabled="loading" @click="changeMonth(1)">下月</button>
        </view>
      </view>

      <view v-if="errorMessage" class="state-band error-state">
        <text class="state-title">日历加载失败</text>
        <text class="state-copy">{{ errorMessage }}</text>
        <button class="retry-button" :disabled="loading" @click="loadCalendar">重新加载</button>
      </view>

      <view v-else class="calendar-band">
        <view class="week-row">
          <text v-for="label in weekLabels" :key="label" class="week-label">{{ label }}</text>
        </view>
        <view v-if="loading" class="calendar-loading">正在加载本月点检计划</view>
        <view v-else class="calendar-grid">
          <view
            v-for="(cell, index) in cells"
            :key="cell?.date || `blank-${index}`"
            :class="['day-cell', cell ? `day-${statusTone(cell.summary.status)}` : 'day-blank']"
          >
            <template v-if="cell">
              <text class="day-number">{{ cell.day }}</text>
              <text v-if="cell.summary.planCount" class="day-count">{{ cell.summary.planCount }}项</text>
            </template>
          </view>
        </view>
        <view class="legend-row">
          <view v-for="item in legend" :key="item.tone" class="legend-item">
            <view :class="['legend-dot', `day-${item.tone}`]"></view>
            <text>{{ item.label }}</text>
          </view>
        </view>
      </view>
    </template>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onShow, onUnload } from '@dcloudio/uni-app'
import { getEquipmentRoutineCalendar } from '@/api/index.js'
import { equipmentBusinessMonthRange } from '@/utils/equipment.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import {
  normalizeRoutineCalendarMonth,
  routineCalendarGrid,
  routineCalendarMonthLabel,
  routineCalendarStatusTone,
  shiftRoutineCalendarMonth
} from '@/utils/equipmentRoutineCalendar.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRoutineCalendar',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const teamId = ref('')
    const equipment = ref(null)
    const month = ref(equipmentBusinessMonthRange().month)
    const days = ref([])
    const loading = ref(false)
    const errorMessage = ref('')
    let requestVersion = 0
    const canView = computed(() => userStore.hasPermission('equipment.view'))
    const monthLabel = computed(() => routineCalendarMonthLabel(month.value))
    const cells = computed(() => routineCalendarGrid(month.value, days.value))
    const weekLabels = ['一', '二', '三', '四', '五', '六', '日']
    const legend = [
      { tone: 'normal', label: '正常完成' },
      { tone: 'pending', label: '未点检/逾期' },
      { tone: 'abnormal', label: '点检异常' },
      { tone: 'rest', label: '休班无计划' },
      { tone: 'upcoming', label: '未到期' }
    ]
    const loadCalendar = async () => {
      if (!canView.value || !equipmentId.value || loading.value) return
      const version = ++requestVersion
      loading.value = true
      errorMessage.value = ''
      try {
        const response = await getEquipmentRoutineCalendar(equipmentId.value, {
          month: month.value,
          ...(teamId.value ? { teamId: teamId.value } : {})
        }, { showLoading: false, silentError: true })
        if (version !== requestVersion) return
        equipment.value = response?.equipment || equipment.value
        days.value = Array.isArray(response?.days) ? response.days : []
      } catch (error) {
        if (version === requestVersion) errorMessage.value = requestErrorMessage(error, '点检日历暂时无法加载')
      } finally {
        if (version === requestVersion) loading.value = false
      }
    }
    const changeMonth = (delta) => {
      month.value = shiftRoutineCalendarMonth(month.value, delta)
      loadCalendar()
    }
    onLoad((options) => {
      equipmentId.value = String(options.equipmentId || '')
      teamId.value = String(options.teamId || '')
      if (options.month) {
        try { month.value = normalizeRoutineCalendarMonth(options.month, month.value) } catch {}
      }
      if (!equipmentId.value) errorMessage.value = '缺少设备信息，请返回扫码页重新进入'
    })
    onShow(() => loadCalendar())
    onUnload(() => { requestVersion += 1 })
    return {
      canView,
      equipment,
      monthLabel,
      cells,
      weekLabels,
      legend,
      loading,
      errorMessage,
      loadCalendar,
      changeMonth,
      statusTone: routineCalendarStatusTone
    }
  }
}
</script>

<style scoped lang="scss">
.calendar-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.calendar-header, .calendar-band, .state-band { border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.calendar-header { padding: 24rpx; }
.calendar-heading { min-width: 0; }
.calendar-title, .calendar-subtitle, .calendar-code { display: block; }
.calendar-title { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.calendar-subtitle { margin-top: 7rpx; color: #64748b; font-size: 22rpx; overflow-wrap: anywhere; }
.calendar-code { margin-top: 5rpx; color: #475569; font-size: 22rpx; overflow-wrap: anywhere; }
.month-switcher { display: grid; grid-template-columns: 112rpx minmax(0, 1fr) 112rpx; align-items: center; gap: 14rpx; margin-top: 22rpx; }
.month-button { height: 62rpx; line-height: 62rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #1d5fa7; background: #eaf3ff; font-size: 23rpx; }
.month-label { color: #1f2733; text-align: center; font-size: 29rpx; font-weight: 600; }
.calendar-band { margin-top: 20rpx; padding: 20rpx; }
.week-row, .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8rpx; }
.week-label { padding: 8rpx 0; color: #64748b; text-align: center; font-size: 22rpx; }
.day-cell { min-height: 86rpx; padding: 10rpx 4rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 6rpx; text-align: center; }
.day-blank { border-color: transparent; background: transparent; }
.day-normal { border-color: #2f9e5b; background: #c8ead4; }
.day-pending { border-color: #cbd5e1; background: #fff; }
.day-abnormal { border-color: #d94a42; background: #ffd6d2; }
.day-rest { border-color: #3b82f6; background: #dbeafe; }
.day-upcoming { border-color: #94a3b8; background: #f1f5f9; }
.day-number, .day-count { display: block; }
.day-number { color: #1f2733; font-size: 25rpx; font-weight: 600; }
.day-count { margin-top: 5rpx; color: #64748b; font-size: 18rpx; }
.calendar-loading { padding: 150rpx 0; color: #64748b; text-align: center; font-size: 24rpx; }
.legend-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14rpx 22rpx; margin-top: 22rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }
.legend-item { display: flex; align-items: center; gap: 10rpx; color: #52606d; font-size: 21rpx; }
.legend-dot { width: 24rpx; height: 24rpx; border: 1px solid #dce4ee; border-radius: 4rpx; box-sizing: border-box; }
.legend-dot.day-normal { background: #c8ead4; border-color: #2f9e5b; }
.legend-dot.day-pending { background: #fff; border-color: #cbd5e1; }
.legend-dot.day-abnormal { background: #ffd6d2; border-color: #d94a42; }
.legend-dot.day-rest { background: #dbeafe; border-color: #3b82f6; }
.legend-dot.day-upcoming { background: #f1f5f9; border-color: #94a3b8; }
.state-band { margin-top: 20rpx; padding: 80rpx 30rpx; text-align: center; }
.state-title, .state-copy { display: block; }
.state-title { color: #1f2733; font-size: 29rpx; font-weight: 600; }
.state-copy { margin-top: 12rpx; color: #64748b; font-size: 23rpx; line-height: 1.6; }
.retry-button { height: 64rpx; line-height: 64rpx; margin: 24rpx auto 0; border-radius: 8rpx; color: #1d5fa7; background: #eaf3ff; font-size: 23rpx; }
</style>
