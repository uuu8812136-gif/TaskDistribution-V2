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
      <view class="asset-actions">
        <button v-if="canApplyStatus && equipment.status !== 'SCRAPPED'" class="status-button" @click="openStatusApplication">状态申请</button>
        <button v-if="canRepair" class="repair-button" @click="openRepair">发起维修</button>
        <button v-if="canRecordHours" class="hours-button" @click="openRuntimeReading">记录运行小时</button>
        <button
          v-if="canUseRestDay"
          class="rest-day-button"
          :loading="restDaySubmitting"
          :disabled="restDaySubmitting || selectedRestDayPlanIds.length === 0"
          @click="markRestDay"
        >本日休班，设备不需点检</button>
      </view>
    </view>

    <view class="section-heading">
      <text>点检与保养</text>
      <text class="section-count">{{ scheduleTasks.length }} 项</text>
    </view>
    <view class="schedule-list">
      <view v-for="group in scheduleGroups" :key="group.routineType" class="schedule-group">
        <view class="schedule-group-heading">
          <text>{{ group.label }}</text>
          <text>{{ group.entries.length }} 项</text>
        </view>
        <view v-for="entry in group.entries" :key="entry.taskKey" class="schedule-row">
          <checkbox
            v-if="canMarkRestDay(entry)"
            class="rest-day-checkbox"
            color="#1677ff"
            :checked="isRestDaySelected(entry)"
            @click.stop="toggleRestDay(entry)"
          />
          <view class="schedule-top">
            <view class="schedule-copy">
              <text class="schedule-name">{{ entry.rule.name }}</text>
              <text class="schedule-meta">{{ scheduleDescription(entry.rule.schedule) }}</text>
            </view>
            <text class="due-tag" :class="`tone-${dueStateTone(entry.dueState)}`">{{ dueStateLabel(entry.dueState) }}</text>
          </view>
          <view class="due-grid">
            <text v-if="entry.plan">开始：{{ formatDate(entry.plan.scheduledFor, 'YYYY-MM-DD HH:mm') || '-' }}</text>
            <text v-if="entry.plan">截止：{{ formatDate(entry.plan.dueAt, 'YYYY-MM-DD HH:mm') || '-' }}</text>
            <text v-if="entry.nextDueAt">日期：{{ formatDate(entry.nextDueAt, 'YYYY-MM-DD HH:mm') }}</text>
            <text v-if="entry.runtimeStatus === 'WAITING_FOR_READING'">运行小时：待录入读数</text>
            <text v-else-if="entry.nextDueRuntimeHours != null">小时：{{ entry.nextDueRuntimeHours }} h</text>
            <text v-if="entry.lastRecord">上次：{{ formatDate(entry.lastRecord.performedAt, 'YYYY-MM-DD HH:mm') }}</text>
          </view>
          <button v-if="canExecute(entry)" class="execute-button" @click="openExecute(entry)">
            执行{{ routineTypeLabel(entry.routineType) }}
          </button>
          <text v-else-if="hasExecutionPermission(entry)" class="execution-unavailable">
            {{ routineExecutionStatusLabel(entry) }}
          </text>
        </view>
      </view>
    </view>
    <view v-if="!loading && schedules.length === 0" class="empty-state">当前设备类型尚未配置点检或保养规则</view>

    <view class="section-heading">
      <text>本月稽查情况</text>
      <text class="section-count">{{ monthlyActivity.routineTotal + monthlyActivity.repairTotal }} 条</text>
    </view>
    <view class="activity-list">
      <view v-for="record in monthlyActivity.routineRecords" :key="record._id" class="activity-row">
        <view class="schedule-copy">
          <text class="schedule-name">{{ routineTypeLabel(record.routineType) }} · {{ resultLabel(record.overallResult) }}</text>
          <text class="schedule-meta">{{ formatDate(record.performedAt, 'YYYY-MM-DD HH:mm') || '-' }}</text>
        </view>
        <text class="activity-status">{{ record.exception?.status === 'OPEN' ? '异常处理中' : record.overallResult === 'ABNORMAL' ? '异常' : '正常' }}</text>
      </view>
      <view v-for="repair in monthlyActivity.repairs" :key="repair._id" class="activity-row">
        <view class="schedule-copy">
          <text class="schedule-name">维修 · {{ repairTypeLabel(repair.type) }}</text>
          <text class="schedule-meta">{{ formatDate(repair.createdAt, 'YYYY-MM-DD HH:mm') || '-' }}</text>
        </view>
        <text class="activity-status">{{ repairStatusLabel(repair.status) }}</text>
      </view>
      <view v-if="!loading && monthlyActivity.routineTotal + monthlyActivity.repairTotal === 0" class="empty-activity">{{ monthlyActivity.month || '本月' }}暂无点检、保养或维修记录</view>
    </view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import {
  getEquipmentDetail,
  getEquipmentRepairs,
  getEquipmentRoutineRecords,
  getEquipmentRoutineSchedule,
  markEquipmentRoutinePlansRestDay
} from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import {
  dueStateLabel,
  dueStateTone,
  expandRoutineScheduleTasks,
  groupRoutineSchedules,
  isRoutineScheduleExecutable,
  loadEquipmentMonthlyActivity,
  normalizeRoutineSchedules,
  routineExecutionStatusLabel,
  routineTypeLabel,
  scheduleDescription
} from '@/utils/equipment.js'
import { repairStatusLabel, repairTypeLabel } from '@/utils/equipmentRepair.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentDetail',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const teamId = ref('')
    const equipment = ref(null)
    const schedules = ref([])
    const selectedRestDayPlanIds = ref([])
    const restDaySubmitting = ref(false)
    const monthlyActivity = ref({ month: '', routineRecords: [], routineTotal: 0, repairs: [], repairTotal: 0 })
    const currentRuntimeHours = ref(null)
    const loading = ref(false)
    const scheduleTasks = computed(() => expandRoutineScheduleTasks(schedules.value))
    const scheduleGroups = computed(() => groupRoutineSchedules(scheduleTasks.value))
    const requestParams = () => userStore.isGlobalReadOnly && teamId.value ? { teamId: teamId.value } : {}

    const canRecordHours = computed(() => (
      userStore.can('equipment.edit', { write: true, teamRequired: true })
    ))
    const canRepair = computed(() => (
      userStore.can('equipment.repair', { write: true, teamRequired: true })
    ))
    const canApplyStatus = computed(() => (
      userStore.can('equipment.status.apply', { write: true, teamRequired: true }) &&
      userStore.context.membership?.functionalRoleKeys?.includes('ASSET_ADMIN')
    ))
    const canUseRestDay = computed(() => userStore.isTeamMode && userStore.can(
      'equipment.inspect',
      { write: true, teamRequired: true }
    ))
    const hasExecutionPermission = (entry) => userStore.isTeamMode && userStore.can(
      entry.routineType === 'MAINTENANCE' ? 'equipment.maintain' : 'equipment.inspect',
      { write: true, teamRequired: true }
    )
    const canExecute = (entry) => hasExecutionPermission(entry) && isRoutineScheduleExecutable(entry)
    const canMarkRestDay = (entry) => (
      canUseRestDay.value &&
      entry?.routineType === 'INSPECTION' &&
      entry?.restDayEligible === true &&
      Boolean(entry?.planId)
    )
    const isRestDaySelected = (entry) => selectedRestDayPlanIds.value.includes(entry?.planId)
    const toggleRestDay = (entry) => {
      if (!canMarkRestDay(entry) || restDaySubmitting.value) return
      const planId = entry.planId
      selectedRestDayPlanIds.value = isRestDaySelected(entry)
        ? selectedRestDayPlanIds.value.filter((value) => value !== planId)
        : [...selectedRestDayPlanIds.value, planId]
    }
    const confirmRestDay = () => new Promise((resolve) => {
      uni.showModal({
        title: '本日休班，设备不需点检',
        content: `确认将选中的 ${selectedRestDayPlanIds.value.length} 条点检计划设为休班吗？`,
        confirmText: '确认休班',
        success: ({ confirm }) => resolve(confirm),
        fail: () => resolve(false)
      })
    })
    const markRestDay = async () => {
      if (!selectedRestDayPlanIds.value.length || restDaySubmitting.value) return
      if (!await confirmRestDay()) return
      restDaySubmitting.value = true
      try {
        const result = await markEquipmentRoutinePlansRestDay({
          planIds: [...selectedRestDayPlanIds.value]
        })
        selectedRestDayPlanIds.value = []
        await load()
        const count = Number(result?.cancelledCount || 0)
        uni.showToast({ title: count > 0 ? `已设为休班 ${count} 项` : '所选计划已是休班', icon: 'success' })
      } catch (error) {
        uni.showToast({ title: requestErrorMessage(error, '休班设置失败'), icon: 'none' })
      } finally {
        restDaySubmitting.value = false
      }
    }
    const load = async () => {
      if (!equipmentId.value || loading.value) return
      loading.value = true
      try {
        const [detail, schedule, activity] = await Promise.all([
          getEquipmentDetail(equipmentId.value, requestParams()),
          getEquipmentRoutineSchedule(equipmentId.value, requestParams()),
          loadEquipmentMonthlyActivity(equipmentId.value, {
            teamId: requestParams().teamId || '',
            fetchRecords: getEquipmentRoutineRecords,
            fetchRepairs: getEquipmentRepairs
          })
        ])
        equipment.value = {
          ...detail.equipment,
          currentRuntimeHours: schedule.equipment?.currentRuntimeHours ?? detail.equipment?.currentRuntimeHours ?? null,
          runtimeHoursUpdatedAt: schedule.equipment?.runtimeHoursUpdatedAt ?? detail.equipment?.runtimeHoursUpdatedAt ?? null
        }
        schedules.value = normalizeRoutineSchedules(schedule)
        selectedRestDayPlanIds.value = []
        monthlyActivity.value = activity
        currentRuntimeHours.value = equipment.value.currentRuntimeHours
      } finally {
        loading.value = false
      }
    }
    const openExecute = (entry) => uni.navigateTo({
      url: `/pages/equipment/execute?equipmentId=${equipmentId.value}&ruleId=${entry.ruleId}${entry.planId ? `&planId=${entry.planId}` : ''}`
    })
    const openRuntimeReading = () => {
      const currentQuery = currentRuntimeHours.value == null
        ? ''
        : `&currentHours=${encodeURIComponent(currentRuntimeHours.value)}`
      uni.navigateTo({
        url: `/pages/equipment/runtime-reading?equipmentId=${equipmentId.value}${currentQuery}`
      })
    }
    const openRepair = () => uni.navigateTo({
      url: `/pages/equipment/repair-form?equipmentId=${equipmentId.value}`
    })
    const openStatusApplication = () => uni.navigateTo({
      url: `/pages/equipment/status-application-form?equipmentId=${equipmentId.value}`
    })
    const statusLabel = (value) => ({
      IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废'
    }[value] || value || '-')
    const resultLabel = (value) => ({ NORMAL: '正常', COMPLETED: '完成', ABNORMAL: '异常' }[value] || value || '-')

    onLoad((options) => {
      equipmentId.value = options.id || ''
      teamId.value = options.teamId || ''
    })
    onShow(load)
    return {
      userStore, equipment, schedules, scheduleTasks, scheduleGroups, monthlyActivity, currentRuntimeHours, loading, canRecordHours, canRepair, canApplyStatus,
      canUseRestDay, selectedRestDayPlanIds, restDaySubmitting, canExecute, hasExecutionPermission, canMarkRestDay, isRestDaySelected, toggleRestDay, markRestDay,
      openExecute, openRuntimeReading, openRepair, openStatusApplication, statusLabel, formatDate,
      resultLabel, dueStateLabel, dueStateTone, routineTypeLabel, routineExecutionStatusLabel, scheduleDescription, repairStatusLabel, repairTypeLabel
    }
  }
}
</script>

<style scoped lang="scss">
.detail-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .schedule-list, .activity-list { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
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
.asset-actions { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 22rpx; }
.hours-button, .repair-button, .status-button, .execute-button { height: 72rpx; line-height: 72rpx; margin: 0; border-radius: 8rpx; font-size: 25rpx; }
.asset-actions .hours-button, .asset-actions .repair-button, .asset-actions .status-button { flex: 1; min-width: 0; }
.hours-button { color: #245d3f; background: #eaf7ef; }
.repair-button { color: #fff; background: #4096ff; }
.status-button { color: #8a4b08; background: #fff5e6; }
.rest-day-button { flex: 0 0 100%; height: 72rpx; line-height: 72rpx; margin: 0; border-radius: 8rpx; color: #7a4b00; background: #fff4d6; font-size: 24rpx; }
.section-heading { display: flex; justify-content: space-between; margin: 30rpx 0 14rpx; color: #1f2733; font-size: 29rpx; font-weight: 600; }
.section-count { color: #64748b; font-size: 23rpx; font-weight: 400; }
.schedule-list { overflow: hidden; }
.schedule-group + .schedule-group { border-top: 1px solid #dce4ee; }
.schedule-group-heading { display: flex; align-items: center; justify-content: space-between; padding: 14rpx 24rpx; color: #52606d; background: #f7f9fc; font-size: 22rpx; font-weight: 600; }
.schedule-row { padding: 24rpx; border-top: 1px solid #e8edf3; }
.rest-day-checkbox { display: block; width: 44rpx; height: 44rpx; margin-bottom: 8rpx; }
.schedule-name { color: #1f2733; font-size: 28rpx; font-weight: 600; }
.schedule-meta { margin-top: 7rpx; color: #64748b; font-size: 23rpx; }
.due-tag { flex: 0 0 auto; padding: 7rpx 12rpx; border-radius: 8rpx; font-size: 21rpx; }
.tone-danger { color: #b42318; background: #feeceb; }
.tone-warning { color: #9a6700; background: #fff4cc; }
.tone-success { color: #2f855a; background: #eaf7ef; }
.tone-info { color: #52606d; background: #edf2f7; }
.due-grid { display: flex; flex-wrap: wrap; gap: 10rpx 24rpx; margin-top: 16rpx; color: #64748b; font-size: 22rpx; }
.execute-button { margin-top: 22rpx; color: #fff; background: #4096ff; }
.execution-unavailable { display: block; margin-top: 22rpx; padding: 20rpx; color: #52606d; background: #f2f4f7; border-radius: 8rpx; text-align: center; font-size: 24rpx; }
.empty-state { padding: 140rpx 20rpx; color: #909399; text-align: center; font-size: 25rpx; }
.activity-list { overflow: hidden; }
.activity-row { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; padding: 22rpx 24rpx; border-bottom: 1px solid #e8edf3; }
.activity-row:last-child { border-bottom: 0; }
.activity-status { flex: 0 0 auto; max-width: 240rpx; color: #52606d; font-size: 21rpx; text-align: right; overflow-wrap: anywhere; }
.empty-activity { padding: 50rpx 20rpx; color: #909399; text-align: center; font-size: 23rpx; }
</style>
