<template>
  <view class="scan-page">
    <view v-if="userStore.isGlobalReadOnly" class="team-band">
      <view class="team-copy">
        <text class="team-label">查询项目团队</text>
        <text class="team-hint">跨团队模式仅可查看</text>
      </view>
      <picker :range="teamOptions" range-key="name" :value="teamIndex" @change="onTeamChange">
        <view class="team-picker">{{ selectedTeamName || '请选择团队' }} 〉</view>
      </picker>
    </view>

    <view v-if="!canView" class="permission-state">
      <text class="permission-title">无设备查看权限</text>
      <text class="permission-copy">请联系当前项目团队管理员开通设备模块权限。</text>
    </view>

    <template v-else>
      <view class="scan-band">
        <view class="scan-symbol">扫</view>
        <text class="scan-title">扫码查设备</text>
        <text class="scan-description">扫描设备上的二维码，快速查看台账并执行点检或保养。</text>
        <button class="primary-scan-button" :loading="scanning" :disabled="scanning || lookingUp" @click="startScan">
          {{ scanning ? '正在调起扫码' : '打开相机扫码' }}
        </button>
      </view>

      <view class="manual-band">
        <text class="manual-title">无法使用相机？</text>
        <text class="manual-hint">可粘贴完整二维码内容、二维码令牌或系统生成的设备链接。</text>
        <view class="manual-row">
          <input
            v-model="manualCode"
            class="manual-input"
            :disabled="lookingUp"
            maxlength="4096"
            placeholder="粘贴设备二维码内容"
            confirm-type="search"
            @confirm="lookupManualCode"
          />
          <button class="lookup-button" :loading="lookingUp" :disabled="lookingUp" @click="lookupManualCode">查询</button>
        </view>
      </view>

      <view v-if="statusMessage" class="status-band" :class="`status-${status}`">
        <text>{{ statusMessage }}</text>
        <view v-if="status === 'error'" class="status-actions">
          <button class="retry-button" @click="startScan">重新扫码</button>
          <button v-if="scanPermissionDenied" class="settings-button" @click="openCameraSettings">打开设置</button>
        </view>
      </view>

      <view v-if="equipment" class="result-band">
        <view class="result-heading">
          <view class="result-copy">
            <text class="result-kicker">已识别设备</text>
            <text class="equipment-name">{{ equipment.name }}</text>
            <text class="equipment-code">{{ equipment.assetCode }}</text>
          </view>
          <text class="equipment-status">{{ statusLabel(equipment.status) }}</text>
        </view>
        <view class="equipment-grid">
          <view>
            <text>规格型号</text>
            <strong>{{ equipment.specification || '-' }}</strong>
          </view>
          <view>
            <text>存放地点</text>
            <strong>{{ equipment.location || '-' }}</strong>
          </view>
          <view>
            <text>累计运行</text>
            <strong>{{ equipment.currentRuntimeHours == null ? '待录入' : `${equipment.currentRuntimeHours} h` }}</strong>
          </view>
          <view>
            <text>小时更新时间</text>
            <strong>{{ formatDate(equipment.runtimeHoursUpdatedAt, 'YYYY-MM-DD HH:mm') || '-' }}</strong>
          </view>
        </view>
        <view class="result-actions">
          <button class="detail-button" @click="openDetail">查看设备详情</button>
          <button v-if="canRepair" class="repair-button" @click="openRepair">发起维修</button>
          <button v-if="canRecordHours" class="hours-button" @click="openRuntimeReading">记录运行小时</button>
        </view>
      </view>

      <view v-if="equipment" class="routine-band">
        <view class="routine-heading">
          <view>
            <text class="routine-title">现场作业</text>
            <text class="routine-hint">{{ hasExecutableRoutine ? '选择要执行的点检或保养项' : '当前账号仅可查看设备信息' }}</text>
          </view>
          <text class="routine-count">{{ schedules.length }} 项</text>
        </view>
        <view v-for="group in scheduleGroups" :key="group.routineType" class="routine-group">
          <view class="routine-group-heading">
            <text>{{ group.label }}</text>
            <text>{{ group.entries.length }} 项</text>
          </view>
          <view v-for="entry in group.entries" :key="entry.ruleId" class="routine-row">
            <view class="routine-copy">
              <text class="routine-name">{{ entry.rule.name }}</text>
              <text class="routine-meta">{{ scheduleDescription(entry.rule.schedule) }}</text>
              <text class="routine-state">{{ dueStateLabel(entry.dueState) }}</text>
            </view>
            <button v-if="canExecute(entry)" class="execute-button" @click="openExecute(entry)">
              执行{{ routineTypeLabel(entry.routineType) }}
            </button>
            <text v-else class="read-only-label">仅查看</text>
          </view>
        </view>
        <view v-if="schedules.length === 0" class="routine-empty">该设备尚未配置点检或保养规则</view>
      </view>

      <view v-if="equipment" class="activity-band">
        <view class="routine-heading">
          <view>
            <text class="routine-title">本月稽查情况</text>
            <text class="routine-hint">{{ monthlyActivity.month || '-' }} 点检、保养与维修</text>
          </view>
          <text class="routine-count">{{ monthlyActivity.routineTotal + monthlyActivity.repairTotal }} 条</text>
        </view>
        <view v-if="activityLoading" class="routine-empty">正在加载本月记录</view>
        <template v-else>
          <view v-for="record in monthlyActivity.routineRecords.slice(0, 5)" :key="record._id" class="activity-row">
            <view class="routine-copy">
              <text class="routine-name">{{ routineTypeLabel(record.routineType) }} · {{ resultLabel(record.overallResult) }}</text>
              <text class="routine-meta">{{ formatDate(record.performedAt, 'YYYY-MM-DD HH:mm') || '-' }}</text>
            </view>
            <text class="read-only-label">{{ record.exception?.status === 'OPEN' ? '异常处理中' : record.overallResult === 'ABNORMAL' ? '异常' : '正常' }}</text>
          </view>
          <view v-for="repair in monthlyActivity.repairs.slice(0, 5)" :key="repair._id" class="activity-row">
            <view class="routine-copy">
              <text class="routine-name">维修 · {{ repairTypeLabel(repair.type) }}</text>
              <text class="routine-meta">{{ formatDate(repair.createdAt, 'YYYY-MM-DD HH:mm') || '-' }}</text>
            </view>
            <text class="read-only-label">{{ repairStatusLabel(repair.status) }}</text>
          </view>
          <view v-if="activityError" class="routine-empty">{{ activityError }}</view>
          <view v-else-if="monthlyActivity.routineTotal + monthlyActivity.repairTotal === 0" class="routine-empty">本月暂无点检、保养或维修记录</view>
        </template>
      </view>
    </template>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import {
  getEquipmentByQrToken,
  getEquipmentRepairs,
  getEquipmentRoutineRecords,
  getEquipmentRoutineSchedule
} from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import {
  dueStateLabel,
  classifyEquipmentScanFailure,
  equipmentLookupFailureMessage,
  groupRoutineSchedules,
  loadEquipmentMonthlyActivity,
  lookupEquipmentFromQr,
  routineTypeLabel,
  scheduleDescription
} from '@/utils/equipment.js'
import { repairStatusLabel, repairTypeLabel } from '@/utils/equipmentRepair.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentScan',
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const manualCode = ref('')
    const equipment = ref(null)
    const schedules = ref([])
    const monthlyActivity = ref({ month: '', routineRecords: [], routineTotal: 0, repairs: [], repairTotal: 0 })
    const activityLoading = ref(false)
    const activityError = ref('')
    const scanning = ref(false)
    const lookingUp = ref(false)
    const status = ref('idle')
    const statusMessage = ref('')
    const scanPermissionDenied = ref(false)
    let requestVersion = 0
    const canView = computed(() => userStore.hasPermission('equipment.view'))
    const canRepair = computed(() => userStore.can('equipment.repair', {
      write: true,
      teamRequired: true
    }))
    const canRecordHours = computed(() => userStore.can('equipment.edit', {
      write: true,
      teamRequired: true
    }))
    const teamOptions = computed(() => userStore.teams || [])
    const teamIndex = computed(() => Math.max(
      0,
      teamOptions.value.findIndex((team) => team._id === selectedTeamId.value)
    ))
    const selectedTeamName = computed(() => (
      teamOptions.value.find((team) => team._id === selectedTeamId.value)?.name || ''
    ))
    const scheduleGroups = computed(() => groupRoutineSchedules(schedules.value))
    const hasExecutableRoutine = computed(() => schedules.value.some((entry) => canExecute(entry)))
    const requestTeamId = () => userStore.isGlobalReadOnly ? selectedTeamId.value : ''

    const requireQueryContext = () => {
      if (!canView.value) {
        uni.showToast({ title: '没有设备查看权限', icon: 'none' })
        return false
      }
      if (userStore.isGlobalReadOnly && !selectedTeamId.value) {
        uni.showToast({ title: '请先选择项目团队', icon: 'none' })
        return false
      }
      return true
    }

    const resetResult = () => {
      equipment.value = null
      schedules.value = []
      monthlyActivity.value = { month: '', routineRecords: [], routineTotal: 0, repairs: [], repairTotal: 0 }
      activityLoading.value = false
      activityError.value = ''
      status.value = 'idle'
      statusMessage.value = ''
      scanPermissionDenied.value = false
    }

    const lookup = async (rawValue) => {
      if (!requireQueryContext() || lookingUp.value) return
      const version = ++requestVersion
      const requestedTeamId = requestTeamId()
      lookingUp.value = true
      status.value = 'loading'
      statusMessage.value = '正在查询设备…'
      scanPermissionDenied.value = false
      equipment.value = null
      schedules.value = []
      try {
        const result = await lookupEquipmentFromQr(rawValue, {
          teamId: requestedTeamId,
          fetchEquipment: getEquipmentByQrToken,
          fetchSchedule: getEquipmentRoutineSchedule
        })
        if (version !== requestVersion || requestedTeamId !== requestTeamId()) return
        equipment.value = result.equipment
        schedules.value = result.schedules
        activityLoading.value = true
        activityError.value = ''
        try {
          const activity = await loadEquipmentMonthlyActivity(result.equipment._id, {
            teamId: requestedTeamId,
            fetchRecords: getEquipmentRoutineRecords,
            fetchRepairs: getEquipmentRepairs
          })
          if (version !== requestVersion || requestedTeamId !== requestTeamId()) return
          monthlyActivity.value = activity
        } catch {
          if (version !== requestVersion || requestedTeamId !== requestTeamId()) return
          activityError.value = '本月稽查记录暂时无法加载'
        } finally {
          if (version === requestVersion) activityLoading.value = false
        }
        manualCode.value = ''
        status.value = 'found'
        statusMessage.value = '设备识别成功'
        try { uni.vibrateShort({ type: 'light' }) } catch {}
      } catch (error) {
        if (version !== requestVersion) return
        status.value = 'error'
        statusMessage.value = equipmentLookupFailureMessage(error)
        uni.showToast({ title: statusMessage.value, icon: 'none' })
      } finally {
        if (version === requestVersion) lookingUp.value = false
      }
    }

    const handleScanFailure = (error) => {
      const outcome = classifyEquipmentScanFailure(error)
      status.value = outcome.status
      statusMessage.value = outcome.message
      scanPermissionDenied.value = outcome.permissionDenied
      if (outcome.status === 'error') {
        uni.showToast({ title: outcome.message, icon: 'none' })
      }
    }

    const startScan = () => {
      if (!requireQueryContext() || scanning.value || lookingUp.value) return
      requestVersion += 1
      resetResult()
      scanning.value = true
      status.value = 'scanning'
      statusMessage.value = '请将设备二维码放入扫描框'
      try {
        uni.scanCode({
          onlyFromCamera: false,
          scanType: ['qrCode'],
          success: ({ result }) => lookup(result),
          fail: handleScanFailure,
          complete: () => { scanning.value = false }
        })
      } catch (error) {
        scanning.value = false
        handleScanFailure(error)
      }
    }

    const openCameraSettings = () => {
      uni.openSetting({
        fail: () => uni.showToast({ title: '请在微信系统设置中允许相机权限', icon: 'none' })
      })
    }

    const lookupManualCode = () => {
      if (!manualCode.value.trim()) {
        uni.showToast({ title: '请粘贴设备二维码内容', icon: 'none' })
        return
      }
      lookup(manualCode.value)
    }

    const canExecute = (entry) => userStore.isTeamMode && userStore.can(
      entry.routineType === 'MAINTENANCE' ? 'equipment.maintain' : 'equipment.inspect',
      { write: true, teamRequired: true }
    )

    const openDetail = () => {
      const teamId = requestTeamId()
      uni.navigateTo({
        url: `/pages/equipment/detail?id=${equipment.value._id}${teamId ? `&teamId=${teamId}` : ''}`
      })
    }

    const openRepair = () => uni.navigateTo({
      url: `/pages/equipment/repair-form?equipmentId=${equipment.value._id}`
    })

    const openRuntimeReading = () => {
      const currentQuery = equipment.value.currentRuntimeHours == null
        ? ''
        : `&currentHours=${encodeURIComponent(equipment.value.currentRuntimeHours)}`
      uni.navigateTo({
        url: `/pages/equipment/runtime-reading?equipmentId=${equipment.value._id}${currentQuery}`
      })
    }

    const openExecute = (entry) => {
      if (!canExecute(entry)) {
        uni.showToast({ title: '当前账号仅可查看', icon: 'none' })
        return
      }
      uni.navigateTo({
        url: `/pages/equipment/execute?equipmentId=${equipment.value._id}&ruleId=${entry.ruleId}`
      })
    }

    const onTeamChange = (event) => {
      requestVersion += 1
      lookingUp.value = false
      selectedTeamId.value = teamOptions.value[Number(event.detail.value)]?._id || ''
      resetResult()
    }

    const statusLabel = (value) => ({
      IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废'
    }[value] || value || '-')
    const resultLabel = (value) => ({ NORMAL: '正常', COMPLETED: '完成', ABNORMAL: '异常' }[value] || value || '-')

    onLoad((options) => {
      selectedTeamId.value = options.teamId || (userStore.isTeamMode ? userStore.activeTeamId : '') || ''
      if (options.auto === '1') setTimeout(startScan, 150)
    })
    onUnload(() => { requestVersion += 1 })

    return {
      userStore,
      canView,
      canRepair,
      canRecordHours,
      teamOptions,
      teamIndex,
      selectedTeamName,
      manualCode,
      equipment,
      schedules,
      scheduleGroups,
      monthlyActivity,
      activityLoading,
      activityError,
      scanning,
      lookingUp,
      status,
      statusMessage,
      scanPermissionDenied,
      hasExecutableRoutine,
      startScan,
      openCameraSettings,
      lookupManualCode,
      canExecute,
      openDetail,
      openRepair,
      openRuntimeReading,
      openExecute,
      onTeamChange,
      statusLabel,
      resultLabel,
      dueStateLabel,
      routineTypeLabel,
      scheduleDescription,
      repairStatusLabel,
      repairTypeLabel,
      formatDate
    }
  }
}
</script>

<style scoped lang="scss">
.scan-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.team-band, .scan-band, .manual-band, .status-band, .result-band, .routine-band, .activity-band, .permission-state { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.team-band { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; padding: 22rpx 24rpx; margin-bottom: 20rpx; }
.team-copy { min-width: 0; }
.team-label, .team-hint { display: block; }
.team-label { color: #1f2733; font-size: 26rpx; font-weight: 600; }
.team-hint { margin-top: 5rpx; color: #64748b; font-size: 21rpx; }
.team-picker { max-width: 320rpx; color: #1d5fa7; font-size: 24rpx; overflow-wrap: anywhere; text-align: right; }
.scan-band { display: flex; flex-direction: column; align-items: center; padding: 42rpx 30rpx 32rpx; text-align: center; border-top: 6rpx solid #4096ff; }
.scan-symbol { display: flex; align-items: center; justify-content: center; width: 104rpx; height: 104rpx; border: 3rpx solid #4096ff; border-radius: 8rpx; color: #1d5fa7; background: #edf6ff; font-size: 43rpx; font-weight: 700; }
.scan-title, .scan-description { display: block; }
.scan-title { margin-top: 22rpx; color: #1f2733; font-size: 36rpx; font-weight: 700; }
.scan-description { max-width: 590rpx; margin-top: 12rpx; color: #64748b; font-size: 24rpx; line-height: 1.65; }
.primary-scan-button { width: 100%; height: 82rpx; line-height: 82rpx; margin: 30rpx 0 0; border-radius: 8rpx; color: #fff; background: #1677ff; font-size: 28rpx; font-weight: 600; }
.manual-band, .result-band, .routine-band, .activity-band { margin-top: 20rpx; padding: 24rpx; }
.manual-title, .manual-hint { display: block; }
.manual-title { color: #1f2733; font-size: 27rpx; font-weight: 600; }
.manual-hint { margin-top: 7rpx; color: #64748b; font-size: 22rpx; line-height: 1.5; }
.manual-row { display: grid; grid-template-columns: minmax(0, 1fr) 124rpx; gap: 12rpx; margin-top: 18rpx; }
.manual-input { min-width: 0; height: 72rpx; padding: 0 18rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f7f9fc; font-size: 24rpx; }
.lookup-button { height: 72rpx; line-height: 72rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #1d5fa7; background: #eaf3ff; font-size: 25rpx; }
.status-band { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; margin-top: 20rpx; padding: 20rpx 24rpx; color: #52606d; font-size: 24rpx; }
.status-found { color: #245d3f; border-color: #b7dfc8; background: #edf9f2; }
.status-error { color: #b42318; border-color: #f2c1bd; background: #fff3f2; }
.status-scanning, .status-loading { color: #1d5fa7; border-color: #bfd7f4; background: #f1f7ff; }
.status-actions { display: flex; flex: 0 0 auto; gap: 10rpx; }
.retry-button, .settings-button { height: 58rpx; line-height: 58rpx; margin: 0; padding: 0 16rpx; border-radius: 8rpx; background: #fff; font-size: 22rpx; }
.retry-button { color: #b42318; }
.settings-button { color: #1d5fa7; }
.result-heading, .routine-heading, .routine-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.result-copy, .routine-copy { min-width: 0; flex: 1; }
.result-kicker, .equipment-name, .equipment-code, .routine-title, .routine-hint, .routine-name, .routine-meta { display: block; overflow-wrap: anywhere; }
.result-kicker { color: #2f855a; font-size: 21rpx; }
.equipment-name { margin-top: 6rpx; color: #1f2733; font-size: 33rpx; font-weight: 700; }
.equipment-code { margin-top: 6rpx; color: #64748b; font-size: 23rpx; }
.equipment-status { flex: 0 0 auto; padding: 7rpx 13rpx; border-radius: 8rpx; color: #245d3f; background: #eaf7ef; font-size: 21rpx; }
.equipment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx 26rpx; margin-top: 22rpx; padding-top: 20rpx; border-top: 1px solid #e8edf3; }
.equipment-grid text, .equipment-grid strong { display: block; overflow-wrap: anywhere; }
.equipment-grid text { color: #64748b; font-size: 21rpx; }
.equipment-grid strong { margin-top: 5rpx; color: #1f2733; font-size: 24rpx; }
.result-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12rpx; margin-top: 22rpx; }
.detail-button, .repair-button, .hours-button { width: 100%; height: 70rpx; line-height: 70rpx; margin: 0; border-radius: 8rpx; font-size: 25rpx; }
.detail-button { color: #1d5fa7; background: #eaf3ff; }
.repair-button { color: #fff; background: #245d3f; }
.hours-button { color: #8a4b08; background: #fff5e6; }
.routine-title { color: #1f2733; font-size: 28rpx; font-weight: 600; }
.routine-hint { margin-top: 5rpx; color: #64748b; font-size: 21rpx; }
.routine-count { color: #64748b; font-size: 22rpx; }
.routine-group { margin: 18rpx -24rpx 0; border-top: 1px solid #e8edf3; }
.routine-group-heading { display: flex; align-items: center; justify-content: space-between; padding: 14rpx 24rpx; color: #52606d; background: #f7f9fc; font-size: 22rpx; font-weight: 600; }
.routine-row { align-items: center; min-height: 94rpx; padding: 18rpx 24rpx; border-top: 1px solid #e8edf3; }
.activity-row { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; min-height: 78rpx; margin: 14rpx -24rpx 0; padding: 14rpx 24rpx 0; border-top: 1px solid #e8edf3; }
.routine-name { color: #1f2733; font-size: 26rpx; font-weight: 600; }
.routine-meta { margin-top: 5rpx; color: #64748b; font-size: 22rpx; }
.routine-state { display: block; margin-top: 5rpx; color: #1d5fa7; font-size: 21rpx; }
.execute-button { flex: 0 0 170rpx; height: 64rpx; line-height: 64rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #fff; background: #1677ff; font-size: 23rpx; }
.read-only-label { flex: 0 0 auto; color: #64748b; font-size: 22rpx; }
.routine-empty { margin-top: 18rpx; padding-top: 20rpx; border-top: 1px solid #e8edf3; color: #909399; text-align: center; font-size: 23rpx; }
.permission-state { padding: 140rpx 40rpx; text-align: center; }
.permission-title, .permission-copy { display: block; }
.permission-title { color: #1f2733; font-size: 31rpx; font-weight: 600; }
.permission-copy { margin-top: 12rpx; color: #64748b; font-size: 24rpx; line-height: 1.6; }
</style>
