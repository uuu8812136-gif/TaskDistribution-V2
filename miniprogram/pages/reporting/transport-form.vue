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
        <picker :range="tripOptions" range-key="label" :value="tripIndex" @change="onTripChange">
          <view class="picker-field">{{ selectedTripLabel || '请选择运输车次' }}</view>
        </picker>
      </view>
      <view class="field-row">
        <text class="field-label required">运输路线</text>
        <picker :range="routeOptions" range-key="label" :value="routeIndex" @change="onRouteChange">
          <view class="picker-field">{{ selectedRouteLabel || '请选择运输路线' }}</view>
        </picker>
      </view>
      <view class="field-row">
        <text class="field-label required">车牌号</text>
        <picker :range="vehiclePlateOptions" range-key="label" :value="vehiclePlateIndex" @change="onVehiclePlateChange">
          <view class="picker-field">{{ selectedVehiclePlateLabel || '请选择车牌号' }}</view>
        </picker>
      </view>
      <view class="field-row">
        <text class="field-label required">车型</text>
        <picker
          :range="vehicleTypeOptions"
          range-key="label"
          :value="vehicleTypeIndex"
          data-testid="transport-vehicle-type-picker"
          @change="onVehicleTypeChange"
        >
          <view class="picker-field">{{ selectedVehicleTypeLabel || '请选择车型' }}</view>
        </picker>
      </view>
      <view class="field-row">
        <text class="field-label required">司机姓名</text>
        <picker :range="driverOptions" range-key="label" :value="driverIndex" @change="onDriverChange">
          <view class="picker-field">{{ selectedDriverLabel || '请选择司机姓名' }}</view>
        </picker>
      </view>
    </view>

    <view class="form-section">
      <view class="section-heading">
        <text class="section-title">装载明细</text>
        <text class="section-total">合计 {{ loadTotal }}</text>
      </view>
      <view class="load-grid">
        <view v-for="item in form.loadItems" :key="item.typeId || item.legacyKey" class="load-row">
          <text class="load-label">{{ item.name }}{{ item.unavailable ? '（已停用或已删除）' : '' }}</text>
          <input
            v-model="item.quantity"
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
    getTransportMasterData,
    getUsers,
  uploadTransportPhoto
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  REPORTING_MODULE_SCOPES,
  TRANSPORT_DISPATCH_OPTIONS,
  TRANSPORT_SHIFT_OPTIONS,
  buildOrgUnitOptions,
  buildTransportFields,
  buildTransportPayload,
  businessNaturalDate,
  configuredTransportLoadItems,
  transportLoadTotal
} from '@/utils/reporting.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'

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
      tripMasterId: '',
      tripLabel: '',
      routeMasterId: '',
      route: '',
      dispatchType: TRANSPORT_DISPATCH_OPTIONS[0],
      vehiclePlateMasterId: '',
      vehiclePlate: '',
      vehicleTypeMasterId: '',
      vehicleType: '',
      driverMasterId: '',
      driverName: '',
      loadItems: [],
      remark: ''
    })
    const photos = ref([])
    const uploadedPhotoIds = ref([])
    const submitting = ref(false)
    const orgUnits = ref(userStore.context?.orgUnit ? [userStore.context.orgUnit] : [])
    const orgUsers = ref([])
    const masterData = ref([])
    const canSubmit = computed(() => (
      userStore.can('report.submit', { write: true, teamRequired: true }) &&
      (
        userStore.isSuperAdmin ||
        userStore.context.membership?.functionalRoleKeys?.includes('TRANSPORT_REPORTER')
      )
    ))
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
    const optionsFor = (kind) => computed(() => masterData.value
       .filter((item) => item.kind === kind && item.status === 'ACTIVE')
       .map((item) => ({
         value: item._id,
         label: item.name,
         item
       })))
    const tripOptions = optionsFor('TRIP')
    const routeOptions = optionsFor('ROUTE')
    const vehiclePlateOptions = optionsFor('VEHICLE_PLATE')
    const vehicleTypeOptions = optionsFor('VEHICLE_TYPE')
    const driverOptions = optionsFor('DRIVER')
    const optionIndex = (options, value) => Math.max(
      0,
      options.value.findIndex((option) => option.value === value)
    )
    const optionLabel = (options, value) => (
      options.value.find((option) => option.value === value)?.label || ''
    )
    const tripIndex = computed(() => optionIndex(tripOptions, form.tripMasterId))
    const routeIndex = computed(() => optionIndex(routeOptions, form.routeMasterId))
    const vehiclePlateIndex = computed(() => optionIndex(vehiclePlateOptions, form.vehiclePlateMasterId))
    const vehicleTypeIndex = computed(() => optionIndex(vehicleTypeOptions, form.vehicleTypeMasterId))
    const driverIndex = computed(() => optionIndex(driverOptions, form.driverMasterId))
    const selectedTripLabel = computed(() => optionLabel(tripOptions, form.tripMasterId))
    const selectedRouteLabel = computed(() => optionLabel(routeOptions, form.routeMasterId))
    const selectedVehiclePlateLabel = computed(() => optionLabel(vehiclePlateOptions, form.vehiclePlateMasterId))
    const selectedVehicleTypeLabel = computed(() => optionLabel(vehicleTypeOptions, form.vehicleTypeMasterId))
    const selectedDriverLabel = computed(() => optionLabel(driverOptions, form.driverMasterId))
    const loadTotal = computed(() => transportLoadTotal(form.loadItems))

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

    const loadMasterData = async () => {
      const response = await getTransportMasterData()
      masterData.value = response.masterData || []
      form.loadItems = configuredTransportLoadItems(masterData.value)
    }

    onLoad(() => {
      if (!canSubmit.value) {
        uni.showToast({ title: '无权限提交运输记录', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      Promise.all([loadOrganizations(), loadMasterData()]).catch((error) => {
        console.error('加载运输基础资料失败:', error)
        uni.showToast({
          title: requestErrorMessage(error, '运输基础资料加载失败，请稍后重试'),
          icon: 'none'
        })
      })
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
    const onTripChange = (event) => {
      const selected = tripOptions.value[Number(event.detail.value)]
      form.tripMasterId = selected?.value || ''
      form.tripLabel = selected?.item?.name || ''
    }
    const onRouteChange = (event) => {
      const selected = routeOptions.value[Number(event.detail.value)]
      form.routeMasterId = selected?.value || ''
      form.route = selected?.item?.name || ''
    }
    const onVehiclePlateChange = (event) => {
      const selected = vehiclePlateOptions.value[Number(event.detail.value)]
      form.vehiclePlateMasterId = selected?.value || ''
      form.vehiclePlate = selected?.item?.name || ''
    }
    const onVehicleTypeChange = (event) => {
      const selected = vehicleTypeOptions.value[Number(event.detail.value)]
      form.vehicleTypeMasterId = selected?.value || ''
      form.vehicleType = selected?.item?.name || ''
    }
    const onDriverChange = (event) => {
      const selected = driverOptions.value[Number(event.detail.value)]
      form.driverMasterId = selected?.value || ''
      form.driverName = selected?.item?.name || ''
    }

    const choosePhotos = () => {
      const remaining = 10 - photos.value.length
      uni.chooseImage({
        count: remaining,
        sizeType: ['compressed'],
        sourceType: ['camera', 'album'],
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
        if (!form.tripMasterId) throw new TypeError('请选择运输车次')
        if (!form.routeMasterId) throw new TypeError('请选择运输路线')
        if (!form.vehiclePlateMasterId) throw new TypeError('请选择车牌号')
        if (!form.vehicleTypeMasterId) throw new TypeError('请选择车型')
        if (!form.driverMasterId) throw new TypeError('请选择司机姓名')
        if (!form.loadItems.length) throw new TypeError('请先在后台维护装载明细类型')
        buildTransportFields(form)
        if (photos.value.length < 2 || photos.value.length > 10) {
          throw new TypeError('现场照片必须为2至10张')
        }
      } catch (error) {
        uni.showToast({ title: requestErrorMessage(error, '运输记录内容校验失败'), icon: 'none' })
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
      tripOptions,
      tripIndex,
      selectedTripLabel,
      routeOptions,
      routeIndex,
      selectedRouteLabel,
      vehiclePlateOptions,
      vehiclePlateIndex,
      selectedVehiclePlateLabel,
      vehicleTypeOptions,
      vehicleTypeIndex,
      selectedVehicleTypeLabel,
      driverOptions,
      driverIndex,
      selectedDriverLabel,
      loadTotal,
      onOrgChange,
      onDateChange,
      onShiftChange,
      onDispatchChange,
      onTripChange,
      onRouteChange,
      onVehiclePlateChange,
      onVehicleTypeChange,
      onDriverChange,
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
