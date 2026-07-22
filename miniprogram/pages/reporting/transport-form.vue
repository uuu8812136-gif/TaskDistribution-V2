<template>
  <view class="form-page">
    <view class="form-section">
      <text class="section-title">运输信息</text>

      <view class="field-row">
        <text class="field-label required">所属组织</text>
        <picker
          v-if="isTeamScope"
          :range="orgOptions"
          range-key="label"
          :value="orgIndex"
          @change="onOrgChange"
        >
          <view class="picker-field">{{ selectedOrgLabel || '请选择所属组织' }}</view>
        </picker>
        <view v-else class="readonly-field">{{ selectedOrgLabel }}</view>
      </view>

      <view class="field-row">
        <text class="field-label required">运输日期</text>
        <picker mode="date" :value="form.reportDate" @change="onDateChange">
          <view class="picker-field">{{ form.reportDate }}</view>
        </picker>
      </view>

      <view class="field-grid">
        <view class="field-row compact">
          <text class="field-label required">班次</text>
          <picker :range="shiftOptions" :value="shiftIndex" @change="onShiftChange">
            <view class="picker-field">{{ form.shift }}</view>
          </picker>
        </view>
        <view class="field-row compact">
          <text class="field-label required">出车类型</text>
          <picker :range="dispatchOptions" :value="dispatchIndex" @change="onDispatchChange">
            <view class="picker-field">{{ form.dispatchType }}</view>
          </picker>
        </view>
      </view>

      <view class="field-row">
        <text class="field-label required">运输车次</text>
        <input v-model="form.tripLabel" class="text-field" maxlength="50" placeholder="例如：第1车" />
      </view>
      <view class="field-row">
        <text class="field-label required">运输路线</text>
        <input v-model="form.route" class="text-field" maxlength="200" placeholder="请输入运输路线" />
      </view>
      <view class="field-grid">
        <view class="field-row compact">
          <text class="field-label required">车牌号</text>
          <input v-model="form.vehiclePlate" class="text-field" maxlength="50" placeholder="车牌号" />
        </view>
        <view class="field-row compact">
          <text class="field-label">车型</text>
          <input v-model="form.vehicleType" class="text-field" maxlength="100" placeholder="车型" />
        </view>
      </view>
      <view class="field-row">
        <text class="field-label required">司机姓名</text>
        <input v-model="form.driverName" class="text-field" maxlength="100" placeholder="请输入司机姓名" />
      </view>
    </view>

    <view class="form-section">
      <view class="section-heading">
        <text class="section-title">装载明细</text>
        <text class="section-total">合计 {{ loadTotal }}</text>
      </view>
      <view class="load-grid">
        <view v-for="field in loadFields" :key="field.key" class="load-row">
          <text class="load-label">{{ field.label }}</text>
          <input
            v-model="form.loadDetails[field.key]"
            class="quantity-field"
            type="number"
            maxlength="10"
            placeholder="0"
          />
        </view>
      </view>
    </view>

    <view class="form-section">
      <view class="section-heading">
        <text class="section-title required">现场照片</text>
        <text class="photo-count">{{ photos.length }}/10</text>
      </view>
      <view class="photo-grid">
        <view v-for="(photo, index) in photos" :key="photo.path" class="photo-item">
          <image class="photo-image" :src="photo.path" mode="aspectFill" @click="previewPhoto(index)" />
          <button class="remove-photo" title="移除照片" @click="removePhoto(index)">×</button>
        </view>
        <button v-if="photos.length < 10" class="add-photo" @click="choosePhotos">
          <text class="add-symbol">＋</text>
          <text class="add-label">拍照/相册</text>
        </button>
      </view>
      <text class="photo-rule">每车提交2至10张现场照片</text>
    </view>

    <view class="form-section">
      <text class="section-title">备注</text>
      <textarea v-model="form.remark" class="remark-field" maxlength="2000" placeholder="选填" />
    </view>

    <view class="action-bar">
      <button class="cancel-button" :disabled="submitting" @click="cancel">取消</button>
      <button class="submit-button" :loading="submitting" :disabled="submitting" @click="submit">
        {{ submitting ? '提交中...' : '提交记录' }}
      </button>
    </view>
  </view>
</template>

<script>
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  createTransportRecord,
  getOrgUnits,
  getUsers,
  uploadTransportPhoto
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  REPORTING_MODULE_SCOPES,
  TRANSPORT_DISPATCH_OPTIONS,
  TRANSPORT_LOAD_FIELDS,
  TRANSPORT_SHIFT_OPTIONS,
  buildOrgUnitOptions,
  buildTransportFields,
  buildTransportPayload,
  businessNaturalDate,
  createEmptyTransportLoad,
  transportLoadTotal
} from '@/utils/reporting.js'

function photoName(file, index) {
  const path = String(file?.path || file?.tempFilePath || '')
  const pathName = path.split(/[\\/]/).pop() || ''
  const extension = /\.(?:jpe?g|png|gif|webp)$/i.exec(pathName)?.[0] || '.jpg'
  return file?.name || `现场照片_${Date.now()}_${index + 1}${extension}`
}

export default {
  name: 'TransportRecordForm',
  setup() {
    const userStore = useUserStore()
    const form = reactive({
      orgUnitId: userStore.context?.orgUnit?._id || '',
      reportDate: businessNaturalDate(),
      shift: TRANSPORT_SHIFT_OPTIONS[0],
      tripLabel: '',
      route: '',
      dispatchType: TRANSPORT_DISPATCH_OPTIONS[0],
      vehiclePlate: '',
      vehicleType: '',
      driverName: '',
      loadDetails: createEmptyTransportLoad(),
      remark: ''
    })
    const photos = ref([])
    const uploadedPhotoIds = ref([])
    const submitting = ref(false)
    const orgUnits = ref(userStore.context?.orgUnit ? [userStore.context.orgUnit] : [])
    const orgUsers = ref([])
    const isTeamScope = computed(() => (
      userStore.moduleDataScopes[REPORTING_MODULE_SCOPES.TRANSPORT] === 'TEAM'
    ))
    const orgOptions = computed(() => buildOrgUnitOptions(orgUnits.value, orgUsers.value))
    const orgIndex = computed(() => Math.max(
      0,
      orgOptions.value.findIndex((option) => option.value === form.orgUnitId)
    ))
    const selectedOrgLabel = computed(() => (
      orgOptions.value.find((option) => option.value === form.orgUnitId)?.label ||
      userStore.context?.orgUnit?.name ||
      ''
    ))
    const shiftIndex = computed(() => TRANSPORT_SHIFT_OPTIONS.indexOf(form.shift))
    const dispatchIndex = computed(() => TRANSPORT_DISPATCH_OPTIONS.indexOf(form.dispatchType))
    const loadTotal = computed(() => transportLoadTotal(form.loadDetails))

    const loadOrganizations = async () => {
      if (!isTeamScope.value) return
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
      if (!form.orgUnitId && orgOptions.value.length === 1) {
        form.orgUnitId = orgOptions.value[0].value
      }
    }

    onLoad(() => {
      if (!userStore.can('report.submit', { write: true, teamRequired: true })) {
        uni.showToast({ title: '无权限提交运输记录', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadOrganizations()
    })

    const onOrgChange = (event) => {
      form.orgUnitId = orgOptions.value[Number(event.detail.value)]?.value || ''
    }
    const onDateChange = (event) => { form.reportDate = event.detail.value }
    const onShiftChange = (event) => {
      form.shift = TRANSPORT_SHIFT_OPTIONS[Number(event.detail.value)]
    }
    const onDispatchChange = (event) => {
      form.dispatchType = TRANSPORT_DISPATCH_OPTIONS[Number(event.detail.value)]
    }

    const choosePhotos = () => {
      const remaining = 10 - photos.value.length
      uni.chooseImage({
        count: remaining,
        sizeType: ['compressed'],
        sourceType: ['camera'],
        success: (response) => {
          const selected = (response.tempFiles || []).map((file, index) => ({
            path: file.path || file.tempFilePath,
            name: photoName(file, index),
            size: file.size || 0
          })).filter((file) => file.path)
          photos.value = [...photos.value, ...selected].slice(0, 10)
        }
      })
    }
    const previewPhoto = (index) => uni.previewImage({
      current: photos.value[index]?.path,
      urls: photos.value.map((photo) => photo.path)
    })
    const removePhoto = (index) => {
      photos.value.splice(index, 1)
      if (index < uploadedPhotoIds.value.length) uploadedPhotoIds.value.splice(index, 1)
    }

    const submit = async () => {
      if (submitting.value) return
      try {
        if (isTeamScope.value && !form.orgUnitId) throw new TypeError('请选择所属组织')
        buildTransportFields(form)
        if (photos.value.length < 2 || photos.value.length > 10) {
          throw new TypeError('现场照片必须为2至10张')
        }
      } catch (error) {
        uni.showToast({ title: error.message, icon: 'none' })
        return
      }

      submitting.value = true
      try {
        for (let index = uploadedPhotoIds.value.length; index < photos.value.length; index += 1) {
          const fileId = await uploadTransportPhoto(photos.value[index])
          uploadedPhotoIds.value.push(fileId)
        }
        const payload = buildTransportPayload(form, uploadedPhotoIds.value)
        await createTransportRecord(payload)
        uni.showToast({ title: '提交成功', icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      } catch (error) {
        console.error('提交运输记录失败:', error)
      } finally {
        submitting.value = false
      }
    }

    const cancel = () => uni.navigateBack()

    return {
      form,
      photos,
      submitting,
      isTeamScope,
      orgOptions,
      orgIndex,
      selectedOrgLabel,
      shiftOptions: TRANSPORT_SHIFT_OPTIONS,
      shiftIndex,
      dispatchOptions: TRANSPORT_DISPATCH_OPTIONS,
      dispatchIndex,
      loadFields: TRANSPORT_LOAD_FIELDS,
      loadTotal,
      onOrgChange,
      onDateChange,
      onShiftChange,
      onDispatchChange,
      choosePhotos,
      previewPhoto,
      removePhoto,
      submit,
      cancel
    }
  }
}
</script>

<style scoped lang="scss">
.form-page { min-height: 100vh; box-sizing: border-box; padding: 0 0 calc(132rpx + constant(safe-area-inset-bottom)); padding: 0 0 calc(132rpx + env(safe-area-inset-bottom)); background: var(--zl-page-bg, #eef3fb); }
.form-section { padding: 28rpx 24rpx; margin-bottom: 16rpx; background: #ffffff; }
.section-title { display: block; margin-bottom: 24rpx; color: #303133; font-size: 30rpx; font-weight: 600; }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24rpx; }
.section-heading .section-title { margin-bottom: 0; }
.section-total { color: var(--zl-primary, #4096ff); font-size: 25rpx; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20rpx; }
.field-row { min-width: 0; margin-bottom: 24rpx; }
.field-row:last-child { margin-bottom: 0; }
.field-label { display: block; margin-bottom: 12rpx; color: #606266; font-size: 25rpx; }
.required::before { content: '*'; margin-right: 5rpx; color: #f56c6c; }
.text-field, .picker-field, .readonly-field { width: 100%; height: var(--zl-control-height, 80rpx); box-sizing: border-box; padding: 0 20rpx; border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.22)); border-radius: var(--zl-control-radius, 20rpx); color: var(--zl-text, #1f2733); font-size: 26rpx; }
.picker-field, .readonly-field { line-height: 78rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.readonly-field { background: var(--zl-surface-soft, #f5f8fc); color: var(--zl-muted, #64748b); }
.load-grid { border-top: 1px solid #ebeef5; }
.load-row { min-height: 78rpx; display: flex; align-items: center; border-bottom: 1px solid #ebeef5; }
.load-label { flex: 1; min-width: 0; padding-right: 20rpx; color: #606266; font-size: 24rpx; }
.quantity-field { width: 150rpx; height: 64rpx; box-sizing: border-box; padding: 0 16rpx; background: var(--zl-surface-soft, #f5f8fc); border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18)); border-radius: 16rpx; text-align: right; color: var(--zl-text, #1f2733); font-size: 26rpx; }
.photo-count { color: #909399; font-size: 24rpx; }
.photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16rpx; }
.photo-item, .add-photo { position: relative; width: 100%; aspect-ratio: 1; min-width: 0; box-sizing: border-box; border-radius: 16rpx; overflow: hidden; }
.photo-image { width: 100%; height: 100%; }
.remove-photo { position: absolute; top: 0; right: 0; width: 48rpx; height: 48rpx; line-height: 44rpx; margin: 0; padding: 0; border-radius: 0 0 0 8rpx; background: rgba(0, 0, 0, 0.62); color: #ffffff; font-size: 34rpx; }
.remove-photo::after, .add-photo::after, .cancel-button::after, .submit-button::after { border: none; }
.add-photo { height: auto; margin: 0; padding: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1; border: 1px dashed #94a3b8; background: var(--zl-surface-soft, #f5f8fc); color: var(--zl-muted, #64748b); }
.add-symbol { font-size: 48rpx; line-height: 1; }
.add-label { margin-top: 12rpx; font-size: 22rpx; }
.photo-rule { display: block; margin-top: 16rpx; color: #909399; font-size: 22rpx; }
.remark-field { width: 100%; min-height: 180rpx; box-sizing: border-box; padding: 18rpx 20rpx; border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.22)); border-radius: var(--zl-control-radius, 20rpx); font-size: 26rpx; }
.action-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: flex; align-items: center; gap: 20rpx; padding: 16rpx 24rpx calc(16rpx + constant(safe-area-inset-bottom)); padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: rgba(255, 255, 255, 0.97); border-top: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18)); box-shadow: 0 -8rpx 28rpx rgba(15, 23, 42, 0.06); }
.cancel-button, .submit-button { height: 84rpx; line-height: 84rpx; margin: 0; padding: 0; border-radius: var(--zl-control-radius, 20rpx); font-size: 27rpx; }
.cancel-button { width: 180rpx; background: #f5f7fa; color: #606266; }
.submit-button { flex: 1; background: var(--zl-primary, #4096ff); color: #ffffff; }
</style>
