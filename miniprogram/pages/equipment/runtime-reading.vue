<template>
  <view class="reading-page">
    <view class="form-band">
      <text class="form-title">记录累计运行小时</text>
      <text class="form-meta">读数只能增加，提交后不可覆盖历史记录</text>
      <view class="field-block">
        <text class="field-label">累计运行小时</text>
        <input v-model="hours" type="digit" class="field-input" placeholder="例如 1200.5" />
      </view>
      <view class="field-block">
        <text class="field-label">记录说明</text>
        <textarea v-model="reason" class="field-textarea" maxlength="500" placeholder="班次、仪表位置或其他说明" />
      </view>
      <button class="submit-button" :loading="submitting" @click="submit">提交读数</button>
    </view>
  </view>
</template>

<script>
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { createEquipmentRuntimeReading } from '@/api/index.js'
import { buildRuntimeReadingPayload } from '@/utils/equipment.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRuntimeReading',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const hours = ref('')
    const reason = ref('')
    const submitting = ref(false)
    const submit = async () => {
      if (!userStore.can('equipment.edit', { write: true, teamRequired: true })) {
        uni.showToast({ title: '当前上下文不可记录读数', icon: 'none' })
        return
      }
      try {
        const payload = buildRuntimeReadingPayload({
          hours: hours.value,
          reason: reason.value
        })
        submitting.value = true
        await createEquipmentRuntimeReading(equipmentId.value, payload)
        uni.showToast({ title: '运行小时已记录', icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      } catch (error) {
        uni.showToast({ title: error.message || '提交失败', icon: 'none' })
      } finally {
        submitting.value = false
      }
    }
    onLoad((options) => { equipmentId.value = options.equipmentId || '' })
    return { hours, reason, submitting, submit }
  }
}
</script>

<style scoped lang="scss">
.reading-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.form-band { padding: 28rpx 24rpx; background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.form-title, .form-meta, .field-label { display: block; }
.form-title { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.form-meta { margin-top: 8rpx; color: #64748b; font-size: 23rpx; }
.field-block { margin-top: 28rpx; }
.field-label { margin-bottom: 10rpx; color: #344054; font-size: 25rpx; }
.field-input, .field-textarea { width: 100%; box-sizing: border-box; background: #f4f7fa; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 26rpx; }
.field-input { height: 80rpx; padding: 0 20rpx; }
.field-textarea { min-height: 180rpx; padding: 18rpx 20rpx; }
.submit-button { height: 82rpx; line-height: 82rpx; margin: 32rpx 0 0; border-radius: 8rpx; color: #fff; background: #4096ff; font-size: 27rpx; }
</style>
