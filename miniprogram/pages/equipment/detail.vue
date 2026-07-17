<template>
  <view class="detail-page">
    <view v-if="equipment" class="asset-band">
      <view class="asset-heading">
        <view class="asset-copy">
          <text class="asset-name">{{ equipment.name }}</text>
          <text class="asset-code">{{ equipment.assetCode }}</text>
        </view>
        <text class="asset-status">{{ statusLabel(equipment.status) }}</text>
      </view>
      <view class="asset-grid">
        <view><text>规格型号</text><strong>{{ equipment.specification || '-' }}</strong></view>
        <view><text>存放地点</text><strong>{{ equipment.location || '-' }}</strong></view>
        <view><text>累计运行</text><strong>{{ currentRuntimeHours == null ? '待录入' : `${currentRuntimeHours} h` }}</strong></view>
        <view><text>更新时间</text><strong>{{ formatDate(equipment.runtimeHoursUpdatedAt || equipment.updatedAt, 'YYYY-MM-DD HH:mm') || '-' }}</strong></view>
      </view>
      <button v-if="canRecordHours" class="hours-button" @click="openRuntimeReading">记录运行小时</button>
    </view>

    <view class="section-heading">
      <text>点检与保养</text>
      <text class="section-count">{{ schedules.length }} 项</text>
    </view>
    <view class="schedule-list">
      <view v-for="entry in schedules" :key="entry.ruleId" class="schedule-row">
        <view class="schedule-top">
          <view class="schedule-copy">
            <text class="schedule-name">{{ entry.rule.name }}</text>
            <text class="schedule-meta">{{ routineTypeLabel(entry.routineType) }} · {{ scheduleDescription(entry.rule.schedule) }}</text>
          </view>
          <text class="due-tag" :class="`tone-${dueStateTone(entry.dueState)}`">{{ dueStateLabel(entry.dueState) }}</text>
        </view>
        <view class="due-grid">
          <text v-if="entry.nextDueAt">日期：{{ formatDate(entry.nextDueAt, 'YYYY-MM-DD HH:mm') }}</text>
          <text v-if="entry.runtimeStatus === 'WAITING_FOR_READING'">运行小时：待录入读数</text>
          <text v-else-if="entry.nextDueRuntimeHours != null">小时：{{ entry.nextDueRuntimeHours }} h</text>
          <text v-if="entry.lastRecord">上次：{{ formatDate(entry.lastRecord.performedAt, 'YYYY-MM-DD HH:mm') }}</text>
        </view>
        <button v-if="canExecute(entry)" class="execute-button" @click="openExecute(entry)">
          执行{{ routineTypeLabel(entry.routineType) }}
        </button>
      </view>
    </view>
    <view v-if="!loading && schedules.length === 0" class="empty-state">当前设备类型尚未配置点检或保养规则</view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { getEquipmentDetail, getEquipmentRoutineSchedule } from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import {
  dueStateLabel,
  dueStateTone,
  normalizeRoutineSchedules,
  routineTypeLabel,
  scheduleDescription
} from '@/utils/equipment.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentDetail',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const teamId = ref('')
    const equipment = ref(null)
    const schedules = ref([])
    const currentRuntimeHours = ref(null)
    const loading = ref(false)
    const requestParams = () => teamId.value ? { teamId: teamId.value } : {}

    const canRecordHours = computed(() => (
      userStore.can('equipment.edit', { write: true, teamRequired: true })
    ))
    const canExecute = (entry) => userStore.isTeamMode && userStore.can(
      entry.routineType === 'MAINTENANCE' ? 'equipment.maintain' : 'equipment.inspect',
      { write: true, teamRequired: true }
    )
    const load = async () => {
      if (!equipmentId.value || loading.value) return
      loading.value = true
      try {
        const [detail, schedule] = await Promise.all([
          getEquipmentDetail(equipmentId.value, requestParams()),
          getEquipmentRoutineSchedule(equipmentId.value, requestParams())
        ])
        equipment.value = {
          ...detail.equipment,
          currentRuntimeHours: schedule.equipment?.currentRuntimeHours ?? detail.equipment?.currentRuntimeHours ?? null,
          runtimeHoursUpdatedAt: schedule.equipment?.runtimeHoursUpdatedAt ?? detail.equipment?.runtimeHoursUpdatedAt ?? null
        }
        schedules.value = normalizeRoutineSchedules(schedule)
        currentRuntimeHours.value = equipment.value.currentRuntimeHours
      } finally {
        loading.value = false
      }
    }
    const openExecute = (entry) => uni.navigateTo({
      url: `/pages/equipment/execute?equipmentId=${equipmentId.value}&ruleId=${entry.ruleId}`
    })
    const openRuntimeReading = () => uni.navigateTo({
      url: `/pages/equipment/runtime-reading?equipmentId=${equipmentId.value}`
    })
    const statusLabel = (value) => ({
      IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废'
    }[value] || value || '-')

    onLoad((options) => {
      equipmentId.value = options.id || ''
      teamId.value = options.teamId || ''
    })
    onShow(load)
    return {
      userStore, equipment, schedules, currentRuntimeHours, loading, canRecordHours,
      canExecute, openExecute, openRuntimeReading, statusLabel, formatDate,
      dueStateLabel, dueStateTone, routineTypeLabel, scheduleDescription
    }
  }
}
</script>

<style scoped lang="scss">
.detail-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .schedule-list { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.asset-band { padding: 24rpx; }
.asset-heading, .schedule-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.asset-copy, .schedule-copy { min-width: 0; flex: 1; }
.asset-name, .asset-code, .schedule-name, .schedule-meta { display: block; overflow-wrap: anywhere; }
.asset-name { color: #1f2733; font-size: 34rpx; font-weight: 700; }
.asset-code { margin-top: 6rpx; color: #64748b; font-size: 24rpx; }
.asset-status { padding: 8rpx 14rpx; border-radius: 8rpx; color: #2f855a; background: #eaf7ef; font-size: 22rpx; }
.asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20rpx 28rpx; margin-top: 28rpx; padding-top: 22rpx; border-top: 1px solid #e8edf3; }
.asset-grid text, .asset-grid strong { display: block; overflow-wrap: anywhere; }
.asset-grid text { color: #64748b; font-size: 22rpx; }
.asset-grid strong { margin-top: 7rpx; color: #1f2733; font-size: 25rpx; font-weight: 600; }
.hours-button, .execute-button { height: 72rpx; line-height: 72rpx; margin: 22rpx 0 0; border-radius: 8rpx; font-size: 25rpx; }
.hours-button { color: #245d3f; background: #eaf7ef; }
.section-heading { display: flex; justify-content: space-between; margin: 30rpx 0 14rpx; color: #1f2733; font-size: 29rpx; font-weight: 600; }
.section-count { color: #64748b; font-size: 23rpx; font-weight: 400; }
.schedule-list { overflow: hidden; }
.schedule-row { padding: 24rpx; border-bottom: 1px solid #e8edf3; }
.schedule-row:last-child { border-bottom: 0; }
.schedule-name { color: #1f2733; font-size: 28rpx; font-weight: 600; }
.schedule-meta { margin-top: 7rpx; color: #64748b; font-size: 23rpx; }
.due-tag { flex: 0 0 auto; padding: 7rpx 12rpx; border-radius: 8rpx; font-size: 21rpx; }
.tone-danger { color: #b42318; background: #feeceb; }
.tone-warning { color: #9a6700; background: #fff4cc; }
.tone-success { color: #2f855a; background: #eaf7ef; }
.tone-info { color: #52606d; background: #edf2f7; }
.due-grid { display: flex; flex-wrap: wrap; gap: 10rpx 24rpx; margin-top: 16rpx; color: #64748b; font-size: 22rpx; }
.execute-button { color: #fff; background: #4096ff; }
.empty-state { padding: 140rpx 20rpx; color: #909399; text-align: center; font-size: 25rpx; }
</style>
