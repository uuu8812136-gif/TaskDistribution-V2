<template>
  <view class="form-page">
    <view v-if="policy.timeRestrictionsBypassed" class="acceptance-test-notice">
      验收测试账号已临时关闭出勤日期和 09:00 时间限制
    </view>
    <view class="form-section">
      <text class="section-title">基本信息</text>
      <view class="field-row">
        <text class="field-label required">所属分部</text>
        <picker
          v-if="policy.isOfficer"
          :range="orgUnits"
          range-key="name"
          :value="orgIndex"
          @change="onOrgChange"
        >
          <view class="picker-field">{{ selectedOrgName || '请选择所属分部' }}</view>
        </picker>
        <view v-else class="readonly-field">{{ selectedOrgName || '所属分部' }}</view>
      </view>
      <view class="field-row">
        <text class="field-label required">提报日期</text>
        <picker mode="date" :value="form.reportDate" @change="onDateChange">
          <view class="picker-field">{{ form.reportDate }}</view>
        </picker>
      </view>
      <view class="field-grid">
        <view class="field-row compact">
          <text class="field-label">编制人数</text>
          <input v-model="form.authorizedHeadcount" type="number" class="text-field" placeholder="0" />
        </view>
        <view class="field-row compact">
          <text class="field-label">在册人数</text>
          <input v-model="form.registeredHeadcount" type="number" class="text-field" placeholder="0" />
        </view>
      </view>
    </view>

    <view v-for="shift in shiftSections" :key="shift.key" class="form-section">
      <text class="section-title">{{ shift.label }}</text>
      <view class="field-row">
        <text class="field-label">实际出勤人数</text>
        <input
          v-model="form[shift.key].actualAttendanceCount"
          type="number"
          class="text-field"
          placeholder="0"
        />
      </view>
      <view v-for="item in namedFields" :key="item.key" class="named-row">
        <view class="field-row compact count-field">
          <text class="field-label">{{ item.label }}人数</text>
          <input v-model="form[shift.key][item.key].count" type="number" class="text-field" placeholder="0" />
        </view>
        <view class="field-row compact names-field">
          <text class="field-label">{{ item.label }}姓名</text>
          <input
            v-model="form[shift.key][item.key].names"
            class="text-field"
            maxlength="1000"
            placeholder="多个姓名用顿号分隔"
          />
        </view>
      </view>
    </view>

    <view class="form-section">
      <text class="section-title">其他情况</text>
      <view class="field-row">
        <text class="field-label">帮产去向</text>
        <input v-model="form.support.destination" class="text-field" maxlength="200" placeholder="例如：物流技术部" />
      </view>
      <view class="field-row">
        <text class="field-label">帮产人数</text>
        <input v-model="form.support.count" type="number" class="text-field" placeholder="0" />
      </view>
      <view class="field-row">
        <text class="field-label">帮产姓名</text>
        <input v-model="form.support.names" class="text-field" maxlength="1000" placeholder="多个姓名用顿号分隔" />
      </view>
      <view class="field-row">
        <text class="field-label">其他情况备注</text>
        <textarea v-model="form.otherRemark" class="textarea-field" maxlength="2000" placeholder="选填" />
      </view>
      <view v-if="editingId || policy.isOfficer" class="field-row">
        <text :class="['field-label', { required: policy.lateReasonRequired }]">
          {{ policy.lateReasonRequired ? '补报/修正原因' : '修改说明' }}
        </text>
        <textarea v-model="form.reason" class="textarea-field reason-field" maxlength="2000" placeholder="请输入原因" />
      </view>
    </view>

    <view class="submit-bar">
      <button class="cancel-button" @click="goBack">取消</button>
      <button class="submit-button" :loading="submitting" @click="submit">保存</button>
    </view>
  </view>
</template>

<script>
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  createAttendanceSubmission,
  getAttendanceOptions,
  getAttendanceSubmission,
  updateAttendanceSubmission
} from '@/api/index.js'
import {
  ATTENDANCE_NAMED_FIELDS,
  buildAttendancePayload,
  createEmptyAttendanceForm
} from '@/utils/reporting.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'

export default {
  name: 'AttendanceForm',
  setup() {
    const form = reactive(createEmptyAttendanceForm())
    const orgUnits = ref([])
    const policy = ref({})
    const editingId = ref('')
    const submitting = ref(false)
    const shiftSections = Object.freeze([
      { key: 'dayShift', label: '白班' },
      { key: 'nightShift', label: '夜班' }
    ])
    const namedFields = ATTENDANCE_NAMED_FIELDS
    const orgIndex = computed(() => Math.max(
      0,
      orgUnits.value.findIndex((item) => item._id === form.orgUnitId)
    ))
    const selectedOrgName = computed(() => (
      orgUnits.value.find((item) => item._id === form.orgUnitId)?.name || ''
    ))

    const toInputShift = (shift = {}) => ({
      actualAttendanceCount: String(shift.actualAttendanceCount ?? ''),
      ...Object.fromEntries(namedFields.map(({ key }) => [
        key,
        {
          count: String(shift[key]?.count ?? ''),
          names: (shift[key]?.names || []).join('、')
        }
      ]))
    })

    const fillRecord = (record) => {
      Object.assign(form, {
        orgUnitId: record.orgUnitId,
        reportDate: record.reportDate,
        authorizedHeadcount: String(record.authorizedHeadcount ?? ''),
        registeredHeadcount: String(record.registeredHeadcount ?? ''),
        dayShift: toInputShift(record.dayShift),
        nightShift: toInputShift(record.nightShift),
        support: {
          destination: record.support?.destination || '',
          count: String(record.support?.count ?? ''),
          names: (record.support?.names || []).join('、')
        },
        otherRemark: record.otherRemark || '',
        reason: ''
      })
    }

    onLoad(async (options) => {
      editingId.value = options?.id || ''
      try {
        const optionsResponse = await getAttendanceOptions()
        orgUnits.value = optionsResponse.orgUnits || []
        policy.value = optionsResponse.attendancePolicy || {}
        if (editingId.value) {
          const response = await getAttendanceSubmission(editingId.value)
          if (!response.attendanceSubmission?.accessPolicy?.editable) {
            uni.showToast({ title: '该日报已锁定', icon: 'none' })
            setTimeout(() => uni.navigateBack(), 400)
            return
          }
          fillRecord(response.attendanceSubmission)
        } else {
          form.reportDate = policy.value.currentBusinessDate || form.reportDate
          form.orgUnitId = policy.value.reporterOrgUnitId || orgUnits.value[0]?._id || ''
        }
      } catch (error) {
        console.error('加载出勤表单失败:', error)
      }
    })

    const onOrgChange = (event) => {
      form.orgUnitId = orgUnits.value[Number(event.detail.value)]?._id || ''
    }
    const onDateChange = (event) => { form.reportDate = event.detail.value }
    const goBack = () => uni.navigateBack()
    const submit = async () => {
      if (submitting.value) return
      let payload
      try {
        payload = buildAttendancePayload(form)
        if (policy.value.lateReasonRequired && !payload.reason) {
          throw new TypeError('09:00后补报或修正必须填写原因')
        }
      } catch (error) {
        uni.showToast({ title: requestErrorMessage(error, '出勤日报内容校验失败'), icon: 'none' })
        return
      }
      submitting.value = true
      try {
        if (editingId.value) await updateAttendanceSubmission(editingId.value, payload)
        else await createAttendanceSubmission(payload)
        uni.showToast({ title: editingId.value ? '已更新' : '已提交', icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      } catch (error) {
        console.error('保存出勤日报失败:', error)
      } finally {
        submitting.value = false
      }
    }

    return {
      form,
      orgUnits,
      policy,
      editingId,
      submitting,
      shiftSections,
      namedFields,
      orgIndex,
      selectedOrgName,
      onOrgChange,
      onDateChange,
      goBack,
      submit
    }
  }
}
</script>

<style scoped lang="scss">
.form-page { min-height: 100vh; box-sizing: border-box; padding: 20rpx 24rpx 150rpx; background: var(--zl-page-bg, #eef3fb); }
.acceptance-test-notice { padding: 18rpx 22rpx; margin-bottom: 20rpx; background: #fff7e6; border: 1px solid #ffd591; border-radius: 12rpx; color: #ad6800; font-size: 24rpx; line-height: 1.5; }
.form-section { padding: 24rpx; margin-bottom: 20rpx; background: rgba(255,255,255,.97); border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 16rpx; box-shadow: 0 8rpx 28rpx rgba(15,23,42,.05); }
.section-title { display: block; padding-bottom: 18rpx; margin-bottom: 8rpx; border-bottom: 1px solid #ebeef5; font-size: 30rpx; font-weight: 600; color: #303133; }
.field-row { min-width: 0; margin-top: 20rpx; }
.field-label { display: block; margin-bottom: 10rpx; font-size: 24rpx; color: #606266; }
.field-label.required::before { content: '*'; margin-right: 6rpx; color: #f56c6c; }
.field-grid, .named-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx; }
.text-field, .picker-field, .readonly-field { width: 100%; height: 76rpx; box-sizing: border-box; padding: 0 20rpx; background: #f5f8fc; border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 10rpx; font-size: 25rpx; color: #303133; }
.text-field { line-height: 76rpx; }
.picker-field, .readonly-field { display: flex; align-items: center; }
.readonly-field { color: #64748b; }
.count-field { min-width: 0; }
.names-field { min-width: 0; }
.textarea-field { width: 100%; min-height: 132rpx; box-sizing: border-box; padding: 18rpx 20rpx; background: #f5f8fc; border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 10rpx; font-size: 25rpx; line-height: 1.55; }
.reason-field { min-height: 112rpx; }
.submit-bar { position: fixed; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: 1fr 2fr; gap: 16rpx; padding: 18rpx 24rpx calc(18rpx + env(safe-area-inset-bottom)); background: rgba(255,255,255,.98); border-top: 1px solid #e4e7ed; }
.cancel-button, .submit-button { height: 80rpx; line-height: 80rpx; margin: 0; padding: 0; border-radius: 12rpx; font-size: 27rpx; }
.cancel-button::after, .submit-button::after { border: none; }
.cancel-button { background: #f3f4f6; color: #606266; }
.submit-button { background: #4096ff; color: #fff; }
</style>
