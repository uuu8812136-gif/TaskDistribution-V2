<template>
  <view class="reading-page">
    <view class="form-band">
      <text class="form-title">记录累计运行小时</text>
      <text class="form-meta">读数只能增加，提交后不可覆盖历史记录</text>
      <view class="current-band">
        <text class="current-label">当前累计运行</text>
        <text class="current-value">{{ currentHours == null ? '待录入' : `${currentHours} h` }}</text>
        <text v-if="latestRecordedAt" class="current-meta">最近更新：{{ formatDate(latestRecordedAt, 'YYYY-MM-DD HH:mm') }}</text>
      </view>
      <view class="field-block">
        <text class="field-label">累计运行小时</text>
        <input v-model="hours" type="digit" class="field-input" :disabled="submitting || loading" placeholder="例如 1200.5" />
        <text class="field-hint">新读数不能小于当前累计值</text>
      </view>
      <view class="field-block">
        <text class="field-label">记录说明</text>
        <textarea v-model="reason" class="field-textarea" :disabled="submitting" maxlength="500" placeholder="班次、仪表位置或其他说明" />
      </view>
      <button class="submit-button" :loading="submitting" :disabled="submitting || loading" @click="submit">提交读数</button>
    </view>
    <view class="history-band">
      <view class="history-heading">
        <text>最近读数</text>
        <text>{{ readings.length ? `${readings.length} 条` : '' }}</text>
      </view>
      <view v-if="loading" class="history-empty">正在加载读数</view>
      <view v-else-if="loadError" class="history-empty">{{ loadError }}</view>
      <view v-else-if="readings.length === 0" class="history-empty">暂无历史读数</view>
      <template v-else>
        <view v-for="reading in readings" :key="reading._id" class="history-row">
          <view class="history-copy">
            <text class="history-hours">{{ reading.hours }} h</text>
            <text class="history-meta">{{ formatDate(reading.recordedAt, 'YYYY-MM-DD HH:mm') }} · {{ sourceLabel(reading.source) }}</text>
            <text v-if="reading.reason" class="history-reason">{{ reading.reason }}</text>
          </view>
        </view>
      </template>
    </view>
  </view>
</template>

<script>
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { createEquipmentRuntimeReading, getEquipmentRuntimeReadings } from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import { buildRuntimeReadingPayload } from '@/utils/equipment.js'
import { useUserStore } from '@/stores/user.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'

export default {
  name: 'EquipmentRuntimeReading',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const currentHours = ref(null)
    const latestRecordedAt = ref(null)
    const readings = ref([])
    const loading = ref(false)
    const loadError = ref('')
    const hours = ref('')
    const reason = ref('')
    const submitting = ref(false)
    const sourceLabel = (value) => ({
      MANUAL: '人工录入',
      INSPECTION: '点检提交',
      MAINTENANCE: '保养提交'
    }[value] || value || '系统记录')
    const loadReadings = async () => {
      if (!equipmentId.value) return
      loading.value = true
      loadError.value = ''
      try {
        const response = await getEquipmentRuntimeReadings(equipmentId.value, { page: 1, pageSize: 5 })
        readings.value = Array.isArray(response?.readings) ? response.readings : []
        const latest = readings.value[0]
        if (latest) {
          currentHours.value = Number(latest.hours)
          latestRecordedAt.value = latest.recordedAt || null
          if (!hours.value) hours.value = String(latest.hours)
        }
      } catch {
        loadError.value = '历史读数暂时无法加载'
      } finally {
        loading.value = false
      }
    }
    const submit = async () => {
      if (submitting.value) return
      if (!userStore.can('equipment.edit', { write: true, teamRequired: true })) {
        uni.showToast({ title: '当前上下文不可记录读数', icon: 'none' })
        return
      }
      try {
        const payload = buildRuntimeReadingPayload({
          hours: hours.value,
          reason: reason.value,
          currentHours: currentHours.value
        })
        submitting.value = true
        const reading = await createEquipmentRuntimeReading(equipmentId.value, payload)
        currentHours.value = Number(reading?.hours ?? payload.hours)
        latestRecordedAt.value = reading?.recordedAt || new Date().toISOString()
        uni.showToast({ title: '运行小时已记录', icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      } catch (error) {
        uni.showToast({ title: requestErrorMessage(error, '运行小时提交失败'), icon: 'none' })
      } finally {
        submitting.value = false
      }
    }
    onLoad((options) => {
      equipmentId.value = options.equipmentId || ''
      if (options.currentHours !== undefined && options.currentHours !== '') {
        const value = Number(options.currentHours)
        if (Number.isFinite(value) && value >= 0) {
          currentHours.value = value
          hours.value = String(value)
        }
      }
      loadReadings()
    })
    return {
      currentHours, latestRecordedAt, readings, loading, loadError, hours, reason, submitting,
      formatDate, sourceLabel, submit
    }
  }
}
</script>

<style scoped lang="scss">
.reading-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.form-band, .history-band { padding: 28rpx 24rpx; background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.history-band { margin-top: 20rpx; }
.form-title, .form-meta, .field-label { display: block; }
.form-title { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.form-meta { margin-top: 8rpx; color: #64748b; font-size: 23rpx; }
.current-band { display: grid; grid-template-columns: auto 1fr; gap: 8rpx 18rpx; margin-top: 24rpx; padding: 18rpx 20rpx; border-radius: 8rpx; background: #f1f7ff; }
.current-label { color: #52606d; font-size: 23rpx; }
.current-value { color: #1d5fa7; font-size: 29rpx; font-weight: 700; text-align: right; }
.current-meta { grid-column: 1 / -1; color: #64748b; font-size: 21rpx; }
.field-block { margin-top: 28rpx; }
.field-label { margin-bottom: 10rpx; color: #344054; font-size: 25rpx; }
.field-input, .field-textarea { width: 100%; box-sizing: border-box; background: #f4f7fa; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 26rpx; }
.field-input { height: 80rpx; padding: 0 20rpx; }
.field-textarea { min-height: 180rpx; padding: 18rpx 20rpx; }
.field-hint { display: block; margin-top: 7rpx; color: #64748b; font-size: 21rpx; }
.submit-button { height: 82rpx; line-height: 82rpx; margin: 32rpx 0 0; border-radius: 8rpx; color: #fff; background: #4096ff; font-size: 27rpx; }
.history-heading { display: flex; justify-content: space-between; color: #1f2733; font-size: 27rpx; font-weight: 600; }
.history-heading text:last-child { color: #64748b; font-size: 22rpx; font-weight: 400; }
.history-empty { padding: 48rpx 10rpx 20rpx; color: #909399; text-align: center; font-size: 23rpx; }
.history-row { padding: 18rpx 0; border-top: 1px solid #e8edf3; }
.history-copy, .history-hours, .history-meta, .history-reason { display: block; }
.history-hours { color: #1f2733; font-size: 27rpx; font-weight: 600; }
.history-meta { margin-top: 5rpx; color: #64748b; font-size: 21rpx; }
.history-reason { margin-top: 7rpx; color: #52606d; font-size: 22rpx; overflow-wrap: anywhere; }
</style>
