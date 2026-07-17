<template>
  <view class="page">
    <view v-if="equipment" class="asset-band">
      <text class="asset-name">{{ equipment.name }}</text>
      <text class="asset-code">{{ equipment.assetCode }}</text>
      <text class="asset-meta">当前状态：{{ equipmentStatusLabel(equipment.status) }}</text>
    </view>

    <view v-else class="form-band">
      <text class="section-title">选择设备</text>
      <input v-model="keyword" class="search" placeholder="输入设备名称或编号" confirm-type="search" @confirm="searchEquipment" />
      <view class="equipment-options">
        <view v-for="item in equipmentOptions" :key="item._id" class="equipment-option" @click="selectEquipment(item)">
          <text>{{ item.name }}</text><text>{{ item.assetCode }}</text>
        </view>
      </view>
    </view>

    <view class="form-band">
      <text class="section-title">申请类型</text>
      <view class="type-segment">
        <button v-for="item in STATUS_APPLICATION_TYPES" :key="item.value" :class="{ active: form.applicationType === item.value }" @click="form.applicationType = item.value">{{ item.label }}</button>
      </view>
      <label class="field-block"><text>申请原因</text><textarea v-model="form.reason" maxlength="5000" placeholder="请说明闲置、停用或报废原因" /></label>
      <view class="photo-field">
        <view class="photo-heading"><text>附件照片</text><text>{{ photos.length }}/10</text></view>
        <view class="photo-grid">
          <view v-for="(photo, index) in photos" :key="photo.tempFilePath" class="photo-item">
            <image :src="photo.tempFilePath" mode="aspectFill" @click="previewPhoto(index)" />
            <button class="remove" @click="photos.splice(index, 1)">×</button>
          </view>
          <button v-if="photos.length < 10" class="add-photo" @click="choosePhotos">添加照片</button>
        </view>
      </view>
    </view>
    <button class="submit" :loading="submitting" :disabled="submitting || !equipment" @click="submit">提交申请</button>
  </view>
</template>

<script>
import { reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { createEquipmentStatusApplication, deleteTemporaryPrivateFile, getEquipmentDetail, getEquipmentList, uploadEquipmentStatusAttachment } from '@/api/index.js'
import { STATUS_APPLICATION_TYPES } from '@/utils/equipmentStatusApplication.js'

export default {
  name: 'EquipmentStatusApplicationForm',
  setup() {
    const equipment = ref(null)
    const equipmentOptions = ref([])
    const keyword = ref('')
    const photos = ref([])
    const submitting = ref(false)
    const form = reactive({ applicationType: 'IDLE', reason: '' })
    const equipmentStatusLabel = (value) => ({ IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废' }[value] || value || '-')

    const searchEquipment = async () => {
      const result = await getEquipmentList({ page: 1, pageSize: 50, keyword: keyword.value.trim() })
      equipmentOptions.value = (result.equipment || []).filter((item) => item.status !== 'SCRAPPED')
    }
    const selectEquipment = (item) => { equipment.value = item; equipmentOptions.value = [] }
    const choosePhotos = async () => {
      try {
        const result = await uni.chooseMedia({ count: 10 - photos.value.length, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'] })
        photos.value.push(...(result.tempFiles || []).map((item) => ({ tempFilePath: item.tempFilePath, name: `status-${Date.now()}.jpg` })))
      } catch (error) {
        if (!String(error?.errMsg || '').includes('cancel')) uni.showToast({ title: '选择附件失败', icon: 'none' })
      }
    }
    const previewPhoto = (index) => uni.previewImage({ current: photos.value[index].tempFilePath, urls: photos.value.map((item) => item.tempFilePath) })
    const submit = async () => {
      if (!equipment.value || !form.reason.trim()) return uni.showToast({ title: '请选择设备并填写申请原因', icon: 'none' })
      submitting.value = true
      const uploaded = []
      try {
        for (const photo of photos.value) uploaded.push(await uploadEquipmentStatusAttachment(photo))
        const result = await createEquipmentStatusApplication({
          equipmentId: equipment.value._id,
          applicationType: form.applicationType,
          reason: form.reason,
          attachments: uploaded.map((fileId) => ({ fileId })),
          idempotencyKey: `mini-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        })
        uploaded.length = 0
        uni.showToast({ title: '提交成功', icon: 'success' })
        setTimeout(() => uni.redirectTo({ url: `/pages/equipment/status-application-detail?applicationId=${result.application._id}` }), 400)
      } catch (error) {
        await Promise.allSettled(uploaded.map((fileId) => deleteTemporaryPrivateFile(fileId, 'Status application submission failed')))
      } finally { submitting.value = false }
    }

    onLoad(async (options) => {
      if (options.equipmentId) {
        const result = await getEquipmentDetail(options.equipmentId)
        equipment.value = result.equipment
      } else await searchEquipment()
    })
    return { STATUS_APPLICATION_TYPES, equipment, equipmentOptions, keyword, photos, form, submitting, equipmentStatusLabel, searchEquipment, selectEquipment, choosePhotos, previewPhoto, submit }
  }
}
</script>

<style scoped lang="scss">
.page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .form-band { margin-bottom: 18rpx; padding: 24rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.asset-name, .asset-code, .asset-meta { display: block; overflow-wrap: anywhere; }.asset-name { color: #1f2733; font-size: 31rpx; font-weight: 700; }.asset-code, .asset-meta { margin-top: 6rpx; color: #667085; font-size: 23rpx; }
.section-title { color: #1f2733; font-size: 27rpx; font-weight: 650; }.search { height: 70rpx; margin-top: 16rpx; padding: 0 16rpx; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 24rpx; }
.equipment-options { max-height: 420rpx; overflow-y: auto; }.equipment-option { display: flex; justify-content: space-between; gap: 16rpx; padding: 20rpx 0; border-bottom: 1px solid #e8edf3; color: #344054; font-size: 23rpx; }
.type-segment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 18rpx; border: 1px solid #cfd8e3; border-radius: 8rpx; overflow: hidden; }.type-segment button { min-width: 0; height: 72rpx; margin: 0; border-radius: 0; color: #52606d; background: #fff; font-size: 23rpx; line-height: 72rpx; }.type-segment button.active { color: #fff; background: #4096ff; }
.field-block { display: grid; gap: 12rpx; margin-top: 22rpx; color: #344054; font-size: 24rpx; }.field-block textarea { width: 100%; height: 190rpx; padding: 16rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 24rpx; }
.photo-heading { display: flex; justify-content: space-between; margin-top: 22rpx; color: #344054; font-size: 23rpx; }.photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12rpx; margin-top: 14rpx; }.photo-item, .add-photo { position: relative; aspect-ratio: 1; min-width: 0; margin: 0; border: 1px solid #dce4ee; border-radius: 8rpx; overflow: hidden; }.photo-item image { width: 100%; height: 100%; }.remove { position: absolute; top: 4rpx; right: 4rpx; width: 44rpx; height: 44rpx; margin: 0; padding: 0; border-radius: 50%; color: #fff; background: rgba(31,39,51,.75); line-height: 40rpx; }.add-photo { color: #1677ff; background: #edf5ff; font-size: 22rpx; line-height: 1.4; }
.submit { height: 82rpx; margin: 26rpx 0 0; color: #fff; background: #4096ff; font-size: 26rpx; line-height: 82rpx; }
</style>
