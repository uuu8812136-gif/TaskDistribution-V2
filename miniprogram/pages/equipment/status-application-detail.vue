<template>
  <view class="page">
    <view v-if="application" class="asset-band">
      <view class="asset-heading">
        <view class="asset-copy"><text class="name">{{ application.equipmentSnapshot?.name }}</text><text class="code">{{ application.equipmentSnapshot?.assetCode }}</text></view>
        <text :class="['status', `tone-${statusTone(application.workflowStatus)}`]">{{ workflowLabel(application.workflowStatus) }}</text>
      </view>
      <view class="grid">
        <view><text>申请类型</text><strong>{{ typeLabel(application.applicationType) }}</strong></view>
        <view><text>状态变更</text><strong>{{ equipmentStatusLabel(application.sourceStatus) }} → {{ equipmentStatusLabel(application.targetStatus) }}</strong></view>
        <view><text>所属分部</text><strong>{{ application.equipmentSnapshot?.orgUnitName || '-' }}</strong></view>
        <view><text>申请版本</text><strong>{{ application.revision }}</strong></view>
      </view>
      <view class="reason"><text>申请原因</text><strong>{{ application.reason }}</strong></view>
    </view>

    <view v-if="application?.attachments?.length" class="section">
      <text class="section-title">申请附件（{{ application.attachments.length }}）</text>
      <view class="attachment-list">
        <button v-for="file in application.attachments" :key="file.fileId" @click="previewAttachment(file)">{{ file.originalName || '查看附件' }}</button>
      </view>
    </view>

    <view v-if="application?.availableActions?.length" class="section action-section">
      <text class="section-title">当前可处理</text>
      <view class="action-grid">
        <button v-for="action in application.availableActions" :key="action" :class="{ danger: action === 'REJECT' || action === 'VOID', active: selectedAction === action }" @click="openAction(action)">{{ actionLabel(action) }}</button>
      </view>
      <view v-if="selectedAction" class="action-form">
        <label v-if="selectedAction === 'RESUBMIT'" class="field-block"><text>申请原因</text><textarea v-model="actionForm.reason" maxlength="5000" /></label>
        <template v-if="selectedAction === 'RESUBMIT'">
          <view class="resubmit-files">
            <text>附件（{{ existingAttachments.length + newPhotos.length }}/10）</text>
            <view v-for="(file, index) in existingAttachments" :key="file.fileId" class="existing-file"><text @click="previewAttachment(file)">{{ file.originalName || '附件' }}</text><button @click="existingAttachments.splice(index, 1)">删除</button></view>
            <view class="photo-grid">
              <view v-for="(photo, index) in newPhotos" :key="photo.tempFilePath" class="photo"><image :src="photo.tempFilePath" mode="aspectFill" /><button @click="newPhotos.splice(index, 1)">×</button></view>
              <button v-if="existingAttachments.length + newPhotos.length < 10" class="add-photo" @click="choosePhotos">添加照片</button>
            </view>
          </view>
        </template>
        <label class="field-block"><text>{{ selectedAction === 'RESUBMIT' ? '重提说明（选填）' : '处理意见' }}</text><textarea v-model="actionForm.opinion" maxlength="2000" /></label>
        <button class="submit-action" :loading="submitting" @click="submitAction">确认{{ actionLabel(selectedAction) }}</button>
      </view>
    </view>

    <view class="section">
      <text class="section-title">审批历史</text>
      <view class="timeline">
        <view v-for="item in [...approvals].reverse()" :key="item._id" class="timeline-row">
          <view class="dot" />
          <view class="timeline-copy"><strong>{{ actionLabel(item.action) }}</strong><text>{{ workflowLabel(item.fromStatus) }} → {{ workflowLabel(item.toStatus) }}</text><text v-if="item.opinion">{{ item.opinion }}</text><small>{{ formatTime(item.actedAt) }} · 版本 {{ item.applicationRevision }}</small></view>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { reactive, ref } from 'vue'
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app'
import { deleteTemporaryPrivateFile, downloadPrivateFile, getEquipmentStatusApplication, transitionEquipmentStatusApplication, uploadEquipmentStatusAttachment } from '@/api/index.js'
import { actionLabel, statusTone, typeLabel, workflowLabel } from '@/utils/equipmentStatusApplication.js'

export default {
  name: 'EquipmentStatusApplicationDetail',
  setup() {
    const applicationId = ref('')
    const teamId = ref('')
    const application = ref(null)
    const approvals = ref([])
    const selectedAction = ref('')
    const submitting = ref(false)
    const existingAttachments = ref([])
    const newPhotos = ref([])
    const actionForm = reactive({ opinion: '', reason: '' })
    const equipmentStatusLabel = (value) => ({ IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废' }[value] || value || '-')
    const formatTime = (value) => value ? String(value).replace('T', ' ').slice(0, 16) : '-'

    const load = async () => {
      try {
        const result = await getEquipmentStatusApplication(applicationId.value, teamId.value ? { teamId: teamId.value } : {})
        application.value = result.application
        approvals.value = result.approvals || []
      } finally { uni.stopPullDownRefresh() }
    }
    const openAction = (action) => {
      selectedAction.value = action
      actionForm.opinion = ''
      actionForm.reason = application.value.reason
      existingAttachments.value = (application.value.attachments || []).map((item) => ({ ...item }))
      newPhotos.value = []
    }
    const choosePhotos = async () => {
      const remaining = 10 - existingAttachments.value.length - newPhotos.value.length
      if (remaining <= 0) return
      try {
        const result = await uni.chooseMedia({ count: remaining, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'] })
        newPhotos.value.push(...(result.tempFiles || []).map((item) => ({ tempFilePath: item.tempFilePath, name: `status-${Date.now()}.jpg` })))
      } catch (error) {
        if (!String(error?.errMsg || '').includes('cancel')) uni.showToast({ title: '选择附件失败', icon: 'none' })
      }
    }
    const previewAttachment = async (file) => {
      try {
        const result = await downloadPrivateFile(file.fileId, teamId.value ? { teamId: teamId.value } : {})
        if (String(file.mimeType || '').startsWith('image/')) uni.previewImage({ current: result.tempFilePath, urls: [result.tempFilePath] })
        else uni.openDocument({ filePath: result.tempFilePath, showMenu: true })
      } catch { uni.showToast({ title: '附件打开失败', icon: 'none' }) }
    }
    const submitAction = async () => {
      if (selectedAction.value !== 'RESUBMIT' && !actionForm.opinion.trim()) return uni.showToast({ title: '请填写处理意见', icon: 'none' })
      if (selectedAction.value === 'RESUBMIT' && !actionForm.reason.trim()) return uni.showToast({ title: '请填写申请原因', icon: 'none' })
      submitting.value = true
      const uploaded = []
      try {
        const payload = { action: selectedAction.value, revision: application.value.revision, opinion: actionForm.opinion }
        if (selectedAction.value === 'RESUBMIT') {
          for (const photo of newPhotos.value) uploaded.push(await uploadEquipmentStatusAttachment(photo))
          payload.corrections = { reason: actionForm.reason, attachments: [...existingAttachments.value.map((file) => ({ fileId: file.fileId })), ...uploaded.map((fileId) => ({ fileId }))] }
        }
        await transitionEquipmentStatusApplication(application.value._id, payload)
        uploaded.length = 0
        selectedAction.value = ''
        await load()
        uni.showToast({ title: '处理成功', icon: 'success' })
      } catch (error) {
        await Promise.allSettled(uploaded.map((fileId) => deleteTemporaryPrivateFile(fileId, 'Status action failed')))
        if (error?.code === 'EQUIPMENT_STATUS_APPLICATION_CONFLICT') await load()
      } finally { submitting.value = false }
    }

    onLoad((options) => { applicationId.value = options.applicationId || ''; teamId.value = options.teamId || ''; load() })
    onPullDownRefresh(load)
    return { application, approvals, selectedAction, existingAttachments, newPhotos, actionForm, submitting, equipmentStatusLabel, formatTime, actionLabel, statusTone, typeLabel, workflowLabel, openAction, choosePhotos, previewAttachment, submitAction }
  }
}
</script>

<style scoped lang="scss">
.page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }.asset-band, .section { margin-bottom: 18rpx; padding: 24rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.asset-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16rpx; }.asset-copy { min-width: 0; flex: 1; }.name, .code, .reason text, .reason strong { display: block; overflow-wrap: anywhere; }.name { color: #1f2733; font-size: 31rpx; font-weight: 700; }.code { margin-top: 5rpx; color: #667085; font-size: 22rpx; }
.status { max-width: 260rpx; padding: 7rpx 11rpx; border-radius: 7rpx; font-size: 20rpx; text-align: center; overflow-wrap: anywhere; }.tone-info { color: #1d5fa7; background: #edf5ff; }.tone-success { color: #245d3f; background: #eaf7ef; }.tone-warning { color: #8a4b08; background: #fff5e6; }.tone-danger { color: #b42318; background: #feeceb; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; margin-top: 22rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }.grid text, .grid strong { display: block; overflow-wrap: anywhere; }.grid text, .reason text { color: #667085; font-size: 21rpx; }.grid strong, .reason strong { margin-top: 5rpx; color: #1f2733; font-size: 24rpx; }.reason { margin-top: 18rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }
.section-title { color: #1f2733; font-size: 27rpx; font-weight: 650; }.attachment-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10rpx; margin-top: 16rpx; }.attachment-list button { min-width: 0; height: 66rpx; margin: 0; color: #1677ff; background: #edf5ff; font-size: 21rpx; line-height: 66rpx; overflow: hidden; }
.action-section { border-color: #9cc7ad; }.action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10rpx; margin-top: 16rpx; }.action-grid button { min-width: 0; min-height: 68rpx; margin: 0; padding: 8rpx; color: #245d3f; background: #eaf7ef; font-size: 21rpx; line-height: 1.35; }.action-grid button.danger { color: #b42318; background: #feeceb; }.action-grid button.active { box-shadow: 0 0 0 2rpx #1677ff; }
.action-form { margin-top: 20rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }.field-block { display: grid; gap: 10rpx; margin-top: 14rpx; color: #344054; font-size: 23rpx; }.field-block textarea { width: 100%; height: 150rpx; padding: 14rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 23rpx; }.submit-action { height: 72rpx; margin: 18rpx 0 0; color: #fff; background: #4096ff; font-size: 24rpx; line-height: 72rpx; }
.resubmit-files { margin-top: 14rpx; color: #344054; font-size: 22rpx; }.existing-file { display: grid; grid-template-columns: minmax(0, 1fr) 90rpx; align-items: center; gap: 10rpx; padding: 10rpx 0; border-bottom: 1px solid #e8edf3; }.existing-file text { color: #1677ff; overflow-wrap: anywhere; }.existing-file button { width: 90rpx; height: 52rpx; margin: 0; color: #b42318; background: #feeceb; font-size: 20rpx; line-height: 52rpx; }.photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10rpx; margin-top: 12rpx; }.photo, .add-photo { position: relative; aspect-ratio: 1; min-width: 0; margin: 0; border: 1px solid #dce4ee; border-radius: 8rpx; overflow: hidden; }.photo image { width: 100%; height: 100%; }.photo button { position: absolute; top: 3rpx; right: 3rpx; width: 42rpx; height: 42rpx; margin: 0; padding: 0; border-radius: 50%; color: #fff; background: rgba(31,39,51,.75); line-height: 38rpx; }.add-photo { color: #1677ff; background: #edf5ff; font-size: 21rpx; line-height: 1.4; }
.timeline { margin-top: 18rpx; }.timeline-row { display: grid; grid-template-columns: 22rpx minmax(0, 1fr); gap: 12rpx; padding-bottom: 22rpx; }.dot { width: 14rpx; height: 14rpx; margin-top: 8rpx; border: 4rpx solid #b8d8c4; border-radius: 50%; background: #245d3f; }.timeline-copy strong, .timeline-copy text, .timeline-copy small { display: block; overflow-wrap: anywhere; }.timeline-copy strong { color: #1f2733; font-size: 24rpx; }.timeline-copy text { margin-top: 4rpx; color: #344054; font-size: 21rpx; }.timeline-copy small { margin-top: 5rpx; color: #909399; font-size: 19rpx; }
</style>
