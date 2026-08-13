<template>
  <view class="repair-form-page">
    <view v-if="equipment" class="asset-band">
      <text class="asset-name">{{ equipment.name }}</text>
      <text class="asset-code">{{ equipment.assetCode }}</text>
      <view class="asset-meta">
        <text>{{ equipment.orgUnitNameSnapshot || '所属分部以设备台账为准' }}</text>
        <text>{{ equipment.location || '地点待填写' }}</text>
      </view>
    </view>

    <view class="form-section">
      <text class="section-title">维修类型</text>
      <view class="type-segment">
        <button
          v-for="item in REPAIR_TYPES"
          :key="item.value"
          class="type-option"
          :class="{ active: form.type === item.value }"
          @click="form.type = item.value"
        >
          {{ item.shortLabel || item.label }}
        </button>
      </view>
    </view>

    <view v-if="form.type === 'FAULT_REPORT'" class="form-section field-list">
      <label class="field-row">
        <text>报修日期</text>
        <picker mode="date" :value="form.reportDate" @change="form.reportDate = $event.detail.value">
          <view class="picker-value">{{ form.reportDate || '选择日期' }}</view>
        </picker>
      </label>
      <label class="field-row">
        <text>报修时间</text>
        <picker mode="time" :value="form.reportClock" @change="form.reportClock = $event.detail.value">
          <view class="picker-value">{{ form.reportClock || '选择时间' }}</view>
        </picker>
      </label>
      <label class="field-row">
        <text>地点</text>
        <view class="location-control">
          <input v-model="form.reportLocation" maxlength="500" placeholder="请输入现场地点" />
          <picker v-if="repairLocations.length" :range="repairLocations" @change="selectRepairLocation">
            <text>选择</text>
          </picker>
        </view>
      </label>
      <label class="field-row"><text>车牌号</text><input v-model="form.plateNumber" maxlength="100" placeholder="选填" /></label>
      <label class="field-row"><text>联系人</text><input v-model="form.contactName" maxlength="100" placeholder="请输入联系人" /></label>
      <label class="field-row"><text>联系电话</text><input v-model="form.contactPhone" type="number" maxlength="50" placeholder="请输入联系电话" /></label>
      <label class="field-block">
        <text>故障描述</text>
        <textarea v-model="form.faultDescription" maxlength="5000" placeholder="描述故障现象和现场情况" />
      </label>
      <view class="photo-field">
        <view class="photo-heading">
          <text>现场照片</text>
          <text>{{ photos.length }}/5</text>
        </view>
        <view class="photo-grid">
          <view v-for="(photo, index) in photos" :key="photo.tempFilePath" class="photo-item">
            <image :src="photo.tempFilePath" mode="aspectFill" @click="previewPhoto(index)" />
            <button class="remove-photo" aria-label="删除照片" @click="removePhoto(index)">×</button>
          </view>
          <button v-if="photos.length < 5" class="camera-button" @click="capturePhotos">
            <text class="camera-icon">＋</text>
            <text>拍照/相册</text>
          </button>
        </view>
      </view>
    </view>

    <view v-else class="form-section field-list">
      <label class="field-row">
        <text>维修日期</text>
        <picker mode="date" :value="form.repairDate" @change="form.repairDate = $event.detail.value">
          <view class="picker-value">{{ form.repairDate || '选择日期' }}</view>
        </picker>
      </label>
      <label class="field-row"><text>维修人</text><input v-model="form.repairerName" maxlength="200" placeholder="请输入维修人" /></label>
      <label class="field-block">
        <text>维修说明</text>
        <textarea v-model="form.repairDescription" maxlength="5000" placeholder="选填" />
      </label>
      <view v-if="form.type === 'PARTS_REPAIR'" class="parts-area">
        <view class="parts-heading">
          <text>配件明细</text>
          <button class="add-part" @click="addPart">添加</button>
        </view>
        <view v-for="(part, index) in form.partItems" :key="part.itemKey" class="part-row">
          <view class="part-index">{{ index + 1 }}</view>
          <view class="part-fields">
            <input v-model="part.name" maxlength="200" placeholder="配件名称" />
            <input v-model="part.specification" maxlength="300" placeholder="规格型号（选填）" />
            <input v-model="part.remark" maxlength="1000" placeholder="备注（选填）" />
          </view>
          <button class="delete-part" :disabled="form.partItems.length <= 1" @click="removePart(index)">删除</button>
        </view>
      </view>
    </view>

    <button class="submit-button" :loading="submitting" :disabled="submitting || !equipment" @click="submit">
      提交维修单
    </button>
  </view>
</template>

<script>
import { reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  createEquipmentRepair,
  deleteTemporaryPrivateFile,
  getEquipmentDetail,
  getEquipmentRepairLocations,
  getPrivateFileMetadataSilently,
  uploadEquipmentRepairPhoto
} from '@/api/index.js'
import { REPAIR_TYPES, createRepairPart } from '@/utils/equipmentRepair.js'

function today() {
  const date = new Date()
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function currentClock() {
  const value = new Date()
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
}

export default {
  name: 'EquipmentRepairForm',
  setup() {
    const equipmentId = ref('')
    const equipment = ref(null)
    const submitting = ref(false)
    const photos = ref([])
    const repairLocations = ref([])
    const form = reactive({
      type: 'FAULT_REPORT',
      reportDate: today(),
      reportClock: currentClock(),
      reportLocation: '',
      plateNumber: '',
      contactName: '',
      contactPhone: '',
      faultDescription: '',
      repairDate: today(),
      repairerName: '',
      repairDescription: '',
      partItems: [createRepairPart(0)]
    })

    const loadEquipment = async () => {
      const result = await getEquipmentDetail(equipmentId.value)
      equipment.value = result.equipment
      form.reportLocation ||= result.equipment.location || ''
      form.plateNumber ||= result.equipment.plateNumber || ''
    }

    const capturePhotos = async () => {
      const remaining = 5 - photos.value.length
      if (remaining <= 0) return
      try {
        const result = await uni.chooseMedia({
          count: remaining,
          mediaType: ['image'],
          sourceType: ['camera', 'album'],
          sizeType: ['compressed'],
          camera: 'back'
        })
        photos.value.push(...(result.tempFiles || []).map((item) => ({
          tempFilePath: item.tempFilePath,
          size: item.size,
          name: `repair-${Date.now()}.jpg`
        })))
      } catch (error) {
        if (!String(error?.errMsg || '').includes('cancel')) {
          uni.showToast({ title: '选择照片失败', icon: 'none' })
        }
      }
    }

    const previewPhoto = (index) => uni.previewImage({
      current: photos.value[index].tempFilePath,
      urls: photos.value.map((item) => item.tempFilePath)
    })
    const removePhoto = (index) => photos.value.splice(index, 1)
    const selectRepairLocation = (event) => {
      form.reportLocation = repairLocations.value[Number(event.detail.value)] || form.reportLocation
    }
    const addPart = () => {
      if (form.partItems.length >= 100) return uni.showToast({ title: '最多100条配件', icon: 'none' })
      form.partItems.push(createRepairPart(form.partItems.length))
    }
    const removePart = (index) => {
      if (form.partItems.length > 1) form.partItems.splice(index, 1)
    }

    const validate = () => {
      if (!equipmentId.value) return '设备信息缺失'
      if (form.type === 'FAULT_REPORT') {
        if (!form.reportDate || !form.reportClock || !form.reportLocation.trim() ||
            !form.contactName.trim() || !form.contactPhone.trim() || !form.faultDescription.trim()) {
          return '请完整填写报修信息'
        }
        if (photos.value.length < 1 || photos.value.length > 5) return '请上传1-5张现场照片'
      } else {
        if (!form.repairDate || !form.repairerName.trim()) return '请填写维修日期和维修人'
        if (form.type === 'PARTS_REPAIR' && form.partItems.some((item) => !item.name.trim())) {
          return '请填写每条配件名称'
        }
      }
      return ''
    }

    const submit = async () => {
      const validationMessage = validate()
      if (validationMessage) return uni.showToast({ title: validationMessage, icon: 'none' })
      submitting.value = true
      const uploadedFileIds = []
      try {
        if (form.type === 'FAULT_REPORT') {
          for (const photo of photos.value) {
            uploadedFileIds.push(await uploadEquipmentRepairPhoto({
              path: photo.tempFilePath,
              name: photo.name
            }))
          }
        }
        await createEquipmentRepair({
          type: form.type,
          equipmentId: equipmentId.value,
          idempotencyKey: `mini-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          ...(form.type === 'FAULT_REPORT'
            ? {
                reportTime: `${form.reportDate}T${form.reportClock}:00+08:00`,
                reportLocation: form.reportLocation,
                plateNumber: form.plateNumber,
                contactName: form.contactName,
                contactPhone: form.contactPhone,
                faultDescription: form.faultDescription,
                photoAttachments: uploadedFileIds.map((fileId) => ({ fileId }))
              }
            : {
                repairDate: form.repairDate,
                repairerName: form.repairerName,
                repairDescription: form.repairDescription,
                ...(form.type === 'PARTS_REPAIR'
                  ? {
                      partItems: form.partItems.map((item) => ({
                        itemKey: item.itemKey,
                        name: item.name,
                        specification: item.specification,
                        remark: item.remark
                      }))
                    }
                  : {})
              })
        })
        uploadedFileIds.length = 0
        uni.showToast({ title: '提交成功', icon: 'success' })
        setTimeout(() => uni.redirectTo({ url: '/pages/equipment/repair-list' }), 500)
      } catch (error) {
        await Promise.allSettled(uploadedFileIds.map(async (fileId) => {
          const metadata = await getPrivateFileMetadataSilently(fileId)
          if (metadata.file?.status === 'TEMPORARY') {
            await deleteTemporaryPrivateFile(fileId, 'Repair form submission failed')
          }
        }))
      } finally {
        submitting.value = false
      }
    }

    onLoad(async (options) => {
      equipmentId.value = options.equipmentId || ''
      if (!equipmentId.value) {
        uni.showToast({ title: '设备参数缺失', icon: 'none' })
        return
      }
      const locationsResult = await getEquipmentRepairLocations()
      repairLocations.value = locationsResult.locations || []
      await loadEquipment()
      if (REPAIR_TYPES.some((item) => item.value === options.type)) form.type = options.type
    })

    return {
      REPAIR_TYPES,
      equipment,
      form,
      photos,
      repairLocations,
      submitting,
      capturePhotos,
      previewPhoto,
      removePhoto,
      selectRepairLocation,
      addPart,
      removePart,
      submit
    }
  }
}
</script>

<style scoped lang="scss">
.repair-form-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .form-section { margin-bottom: 20rpx; padding: 24rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.asset-name, .asset-code { display: block; overflow-wrap: anywhere; }
.asset-name { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.asset-code { margin-top: 6rpx; color: #667085; font-size: 23rpx; }
.asset-meta { display: flex; flex-wrap: wrap; gap: 10rpx 28rpx; margin-top: 18rpx; color: #667085; font-size: 23rpx; }
.section-title, .parts-heading > text, .photo-heading > text:first-child { color: #1f2733; font-size: 27rpx; font-weight: 600; }
.type-segment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12rpx; margin-top: 18rpx; }
.type-option { width: 100%; min-width: 0; height: 76rpx; margin: 0; padding: 0 4rpx; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 10rpx; color: #344054; background: #fff; font-size: 23rpx; font-weight: 600; line-height: 74rpx; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: clip; }
.type-option::after { border: 0; }
.type-option.active { border-color: #1677ff; color: #fff; background: #1677ff; box-shadow: 0 4rpx 10rpx rgba(22, 119, 255, .22), inset 0 0 0 1px rgba(255, 255, 255, .18); }
.field-list { display: grid; gap: 0; }
.field-row { display: grid; grid-template-columns: 160rpx minmax(0, 1fr); align-items: center; min-height: 92rpx; border-bottom: 1px solid #e8edf3; }
.field-row > text, .field-block > text { color: #344054; font-size: 24rpx; }
.field-row input, .picker-value { min-width: 0; color: #1f2733; font-size: 25rpx; text-align: right; }
.location-control { display: flex; align-items: center; justify-content: flex-end; gap: 14rpx; min-width: 0; }
.location-control input { flex: 1; }
.location-control picker { flex: 0 0 auto; padding: 8rpx 12rpx; border-left: 1px solid #dce4ee; color: #1677ff; font-size: 22rpx; }
.field-block { display: grid; gap: 14rpx; padding: 22rpx 0; border-bottom: 1px solid #e8edf3; }
.field-block textarea { width: 100%; height: 180rpx; padding: 18rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 25rpx; }
.photo-field, .parts-area { padding-top: 24rpx; }
.photo-heading, .parts-heading { display: flex; align-items: center; justify-content: space-between; }
.photo-heading > text:last-child { color: #667085; font-size: 22rpx; }
.photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14rpx; margin-top: 16rpx; }
.photo-item, .camera-button { position: relative; aspect-ratio: 1; min-width: 0; border: 1px solid #dce4ee; border-radius: 8rpx; overflow: hidden; }
.photo-item image { width: 100%; height: 100%; }
.remove-photo { position: absolute; top: 4rpx; right: 4rpx; width: 46rpx; height: 46rpx; padding: 0; border-radius: 50%; color: #fff; background: rgba(31, 39, 51, .74); font-size: 30rpx; line-height: 42rpx; }
.camera-button { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8rpx; color: #4096ff; background: #f7faff; font-size: 22rpx; }
.camera-icon { font-size: 42rpx; line-height: 1; }
.add-part { width: 116rpx; height: 60rpx; margin: 0; color: #245d3f; background: #eaf7ef; font-size: 23rpx; line-height: 60rpx; }
.part-row { display: grid; grid-template-columns: 46rpx minmax(0, 1fr) 90rpx; align-items: center; gap: 12rpx; padding: 18rpx 0; border-bottom: 1px solid #e8edf3; }
.part-index { color: #667085; text-align: center; }
.part-fields { display: grid; gap: 10rpx; }
.part-fields input { height: 64rpx; padding: 0 14rpx; border: 1px solid #dce4ee; border-radius: 6rpx; font-size: 23rpx; }
.delete-part { width: 90rpx; height: 60rpx; margin: 0; padding: 0; color: #b42318; background: #feeceb; font-size: 22rpx; line-height: 60rpx; }
.submit-button { height: 84rpx; margin: 28rpx 0 18rpx; border-radius: 8rpx; color: #fff; background: #4096ff; font-size: 27rpx; line-height: 84rpx; }
</style>
