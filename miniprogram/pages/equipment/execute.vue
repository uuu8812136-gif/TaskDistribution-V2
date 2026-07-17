<template>
  <view class="execute-page">
    <view v-if="rule" class="rule-band">
      <text class="rule-type">{{ routineTypeLabel(rule.routineType) }}</text>
      <text class="rule-name">{{ rule.name }}</text>
      <text class="rule-cycle">{{ scheduleDescription(rule.schedule) }}</text>
      <text v-if="rule.description" class="rule-description">{{ rule.description }}</text>
    </view>

    <view v-if="rule" class="items-band">
      <view v-for="(item, index) in rule.checklistItems" :key="item.key" class="item-row">
        <view class="item-heading">
          <text class="item-index">{{ index + 1 }}</text>
          <view class="item-copy">
            <text class="item-name">{{ item.name }}</text>
            <text v-if="item.description" class="item-instructions">{{ item.description }}</text>
          </view>
          <text class="required-mark" :class="{ optional: item.required === false }">
            {{ item.required === false ? '可跳过' : '必填' }}
          </text>
        </view>
        <view class="result-options">
          <button
            v-for="option in resultOptions(item)"
            :key="option.value"
            class="result-button"
            :class="{ active: itemResult(item).result === option.value, abnormal: option.value === 'ABNORMAL' }"
            :disabled="submitting"
            @click="selectResult(item, option.value)"
          >{{ option.label }}</button>
        </view>
        <textarea
          v-if="itemResult(item).result === 'ABNORMAL'"
          v-model="itemResult(item).note"
          class="item-note"
          maxlength="500"
          :disabled="submitting"
          placeholder="填写异常现象和现场情况"
        />
      </view>
    </view>

    <view v-if="rule" class="extra-band">
      <view v-if="needsRuntime" class="field-block">
        <text class="field-label">本次累计运行小时</text>
        <input v-model="runtimeHours" type="digit" class="field-input" :disabled="submitting" placeholder="请输入仪表读数" />
      </view>
      <view class="field-block">
        <view class="photo-heading">
          <text class="field-label">现场照片</text>
          <text class="photo-rule">{{ photoRuleLabel }}</text>
        </view>
        <view class="photo-grid">
          <view v-for="(photo, index) in photos" :key="photo.path" class="photo-item">
            <image :src="photo.path" mode="aspectFill" />
            <button class="remove-photo" :disabled="submitting" @click="removePhoto(index)">×</button>
          </view>
          <button v-if="!submitting && photos.length < 10" class="add-photo" @click="takePhoto">拍照</button>
        </view>
      </view>
      <view class="field-block">
        <text class="field-label">异常汇总与补充说明</text>
        <textarea v-model="abnormalSummary" class="overall-note" maxlength="2000" :disabled="submitting" placeholder="可填写异常情况、处理结果或交接信息" />
      </view>
      <button class="submit-button" :loading="submitting" :disabled="submitting" @click="submit">提交{{ routineTypeLabel(rule.routineType) }}</button>
    </view>
  </view>
</template>

<script>
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  createEquipmentRoutineRecord,
  deleteTemporaryPrivateFile,
  getEquipmentRoutineSchedule,
  getPrivateFileMetadataSilently,
  uploadEquipmentRoutinePhoto
} from '@/api/index.js'
import {
  buildRoutineRecordPayload,
  normalizeRoutineSchedules,
  resultOptionsFor,
  routineTypeLabel,
  scheduleDescription
} from '@/utils/equipment.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRoutineExecute',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const ruleId = ref('')
    const rule = ref(null)
    const results = reactive({})
    const runtimeHours = ref('')
    const abnormalSummary = ref('')
    const photos = ref([])
    const submitting = ref(false)
    const idempotencyKey = ref('')
    const needsRuntime = computed(() => ['RUNTIME_HOURS', 'COMBINED'].includes(rule.value?.schedule?.mode))
    const photoRuleLabel = computed(() => ({
      ALWAYS: '必须上传', ON_ABNORMAL: '异常时必须上传', NONE: '无需上传'
    }[rule.value?.photoPolicy] || '无需上传'))

    const itemKey = (item) => item.key
    const resultOptions = (item) => resultOptionsFor(rule.value?.routineType, item)
    const itemResult = (item) => {
      const key = itemKey(item)
      if (!results[key]) results[key] = reactive({ result: '', note: '' })
      return results[key]
    }
    const selectResult = (item, value) => {
      itemResult(item).result = value
      if (value !== 'ABNORMAL') itemResult(item).note = ''
    }
    const load = async () => {
      const response = await getEquipmentRoutineSchedule(equipmentId.value)
      const entry = normalizeRoutineSchedules(response).find((item) => item.ruleId === ruleId.value)
      if (!entry?.rule) {
        uni.showToast({ title: '规则不存在或已停用', icon: 'none' })
        return
      }
      rule.value = entry.rule
      runtimeHours.value = response.equipment?.currentRuntimeHours == null
        ? ''
        : String(response.equipment.currentRuntimeHours)
      rule.value.checklistItems.forEach((item) => itemResult(item))
    }
    const takePhoto = () => {
      if (submitting.value) return
      uni.chooseMedia({
      count: Math.min(10 - photos.value.length, 9),
      mediaType: ['image'],
      sourceType: ['camera'],
      success: ({ tempFiles }) => {
        const selected = (tempFiles || []).map((file, index) => ({
          path: file.tempFilePath,
          name: `equipment-${Date.now()}-${index + 1}.jpg`,
          fileId: ''
        }))
        photos.value = [...photos.value, ...selected].slice(0, 10)
      }
      })
    }
    const inspectUploadedPhoto = async (photo, deleteTemporary = false) => {
      if (!photo?.fileId) return 'NOT_UPLOADED'
      try {
        const response = await getPrivateFileMetadataSilently(photo.fileId)
        const file = response.file || response
        if (deleteTemporary && file.status === 'TEMPORARY') {
          await deleteTemporaryPrivateFile(photo.fileId, 'Routine submission did not complete')
          photo.fileId = ''
        }
        return file.status
      } catch {
        return 'UNKNOWN'
      }
    }
    const removePhoto = async (index) => {
      if (submitting.value) return
      const [removed] = photos.value.splice(index, 1)
      const status = await inspectUploadedPhoto(removed, true)
      if (status === 'ACTIVE') {
        uni.showToast({ title: `${routineTypeLabel(rule.value.routineType)}已提交`, icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      }
    }
    const cleanupTemporaryUploads = async () => {
      const statuses = await Promise.all(
        photos.value.map((photo) => inspectUploadedPhoto(photo, true))
      )
      return statuses.includes('ACTIVE')
    }
    const submit = async () => {
      if (submitting.value) return
      if (!rule.value || !userStore.isTeamMode) {
        uni.showToast({ title: '请进入具体团队后提交', icon: 'none' })
        return
      }
      const permission = rule.value.routineType === 'MAINTENANCE'
        ? 'equipment.maintain'
        : 'equipment.inspect'
      if (!userStore.can(permission, { write: true, teamRequired: true })) {
        uni.showToast({ title: '没有执行权限', icon: 'none' })
        return
      }
      submitting.value = true
      try {
        const placeholderFileIds = photos.value.map((_, index) => (
          String(index + 1).padStart(24, '0')
        ))
        buildRoutineRecordPayload({
          rule: rule.value,
          results,
          abnormalSummary: abnormalSummary.value,
          runtimeHours: runtimeHours.value,
          photoFileIds: placeholderFileIds,
          idempotencyKey: idempotencyKey.value
        })
        for (const photo of photos.value) {
          if (!photo.fileId) photo.fileId = await uploadEquipmentRoutinePhoto(photo)
        }
        const uploadedFileIds = photos.value.map((photo) => photo.fileId)
        const payload = buildRoutineRecordPayload({
          rule: rule.value,
          results,
          abnormalSummary: abnormalSummary.value,
          runtimeHours: runtimeHours.value,
          photoFileIds: uploadedFileIds,
          idempotencyKey: idempotencyKey.value
        })
        await createEquipmentRoutineRecord(equipmentId.value, payload)
        uni.showToast({ title: `${routineTypeLabel(rule.value.routineType)}已提交`, icon: 'success' })
        setTimeout(() => uni.navigateBack(), 500)
      } catch (error) {
        const alreadyCommitted = await cleanupTemporaryUploads()
        if (alreadyCommitted) {
          uni.showToast({ title: `${routineTypeLabel(rule.value.routineType)}已提交`, icon: 'success' })
          setTimeout(() => uni.navigateBack(), 500)
          return
        }
        uni.showToast({ title: error.message || '提交失败', icon: 'none' })
      } finally {
        submitting.value = false
      }
    }

    onLoad((options) => {
      equipmentId.value = options.equipmentId || ''
      ruleId.value = options.ruleId || ''
      idempotencyKey.value = `routine-${Date.now()}-${Math.random().toString(16).slice(2)}`
      load().catch((error) => uni.showToast({ title: error.message || '加载失败', icon: 'none' }))
    })
    return {
      rule, results, runtimeHours, abnormalSummary, photos, submitting, resultOptions, needsRuntime,
      photoRuleLabel, itemResult, selectResult, takePhoto, removePhoto, submit,
      routineTypeLabel, scheduleDescription
    }
  }
}
</script>

<style scoped lang="scss">
.execute-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.rule-band, .items-band, .extra-band { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.rule-band { padding: 24rpx; }
.rule-type { display: inline-block; padding: 7rpx 12rpx; border-radius: 8rpx; color: #245d3f; background: #eaf7ef; font-size: 21rpx; }
.rule-name, .rule-cycle, .rule-description { display: block; }
.rule-name { margin-top: 14rpx; color: #1f2733; font-size: 32rpx; font-weight: 700; }
.rule-cycle { margin-top: 8rpx; color: #4096ff; font-size: 24rpx; }
.rule-description { margin-top: 12rpx; color: #64748b; font-size: 24rpx; line-height: 1.6; }
.items-band, .extra-band { margin-top: 20rpx; overflow: hidden; }
.item-row { padding: 24rpx; border-bottom: 1px solid #e8edf3; }
.item-row:last-child { border-bottom: 0; }
.item-heading { display: flex; align-items: flex-start; gap: 14rpx; }
.item-index { display: flex; align-items: center; justify-content: center; width: 42rpx; height: 42rpx; flex: 0 0 42rpx; border-radius: 50%; color: #fff; background: #4096ff; font-size: 22rpx; }
.item-copy { min-width: 0; flex: 1; }
.item-name, .item-instructions { display: block; overflow-wrap: anywhere; }
.item-name { color: #1f2733; font-size: 27rpx; font-weight: 600; }
.item-instructions { margin-top: 6rpx; color: #64748b; font-size: 23rpx; }
.required-mark { color: #b42318; font-size: 21rpx; }
.required-mark.optional { color: #64748b; }
.result-options { display: flex; gap: 12rpx; margin-top: 18rpx; }
.result-button { flex: 1; height: 68rpx; line-height: 68rpx; margin: 0; padding: 0; border: 1px solid #dce4ee; border-radius: 8rpx; color: #52606d; background: #f7f9fb; font-size: 24rpx; }
.result-button.active { color: #245d3f; border-color: #52a675; background: #eaf7ef; }
.result-button.abnormal.active { color: #b42318; border-color: #ef8f87; background: #feeceb; }
.item-note, .overall-note, .field-input { width: 100%; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f7f9fb; font-size: 25rpx; }
.item-note { min-height: 148rpx; margin-top: 16rpx; padding: 16rpx; }
.extra-band { padding: 24rpx; }
.field-block { margin-bottom: 28rpx; }
.field-label { display: block; margin-bottom: 10rpx; color: #344054; font-size: 25rpx; }
.field-input { height: 76rpx; padding: 0 18rpx; }
.photo-heading { display: flex; align-items: center; justify-content: space-between; }
.photo-rule { color: #64748b; font-size: 21rpx; }
.photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12rpx; }
.photo-item, .add-photo { position: relative; width: 100%; aspect-ratio: 1; border-radius: 8rpx; overflow: hidden; }
.photo-item image { width: 100%; height: 100%; }
.remove-photo { position: absolute; top: 4rpx; right: 4rpx; width: 42rpx; height: 42rpx; line-height: 40rpx; margin: 0; padding: 0; border-radius: 50%; color: #fff; background: rgba(0,0,0,.64); font-size: 28rpx; }
.add-photo { display: flex; align-items: center; justify-content: center; margin: 0; border: 1px dashed #94a3b8; color: #52606d; background: #f7f9fb; font-size: 25rpx; }
.overall-note { min-height: 170rpx; padding: 16rpx; }
.submit-button { height: 82rpx; line-height: 82rpx; margin: 0; border-radius: 8rpx; color: #fff; background: #4096ff; font-size: 27rpx; }
</style>
