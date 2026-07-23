<template>
  <view class="inventory-detail-page">
    <view v-if="inventorySession" class="summary-band">
      <view class="summary-heading">
        <view>
          <text class="batch-name">{{ inventorySession.name }}</text>
          <text class="batch-org">{{ inventorySession.orgUnitNameSnapshot }}</text>
        </view>
        <text :class="['status-label', `status-${inventoryStatusTone(inventorySession.status)}`]">
          {{ inventoryStatusLabel(inventorySession.status) }}
        </text>
      </view>
      <view class="summary-grid">
        <view><text>盘点进度</text><strong>{{ inventorySession.checkedCount }}/{{ inventorySession.itemCount }}</strong></view>
        <view><text>差异项</text><strong :class="{ danger: inventorySession.differenceCount > 0 }">{{ inventorySession.differenceCount }}</strong></view>
        <view><text>审批轮次</text><strong>第{{ inventorySession.reviewRound }}轮</strong></view>
      </view>
      <text v-if="inventorySession.status === 'RETURNED'" class="returned-hint">请修改盘点明细后重新提交，新轮次会从分部经理重新审核。</text>
      <button v-if="inventorySession.canInventory" class="scan-button" :disabled="scanning" @click="startInventoryScan">
        {{ scanning ? '正在扫码' : '扫码盘点设备' }}
      </button>
      <button
        v-if="inventorySession.canInventory"
        class="submit-button"
        :disabled="inventorySession.checkedCount !== inventorySession.itemCount || transitioning"
        @click="submitBatch"
      >
        {{ inventorySession.status === 'RETURNED' ? '修订后重新提交' : '提交审核' }}
      </button>
      <view v-if="inventorySession.canApprove" class="review-actions">
        <button class="return-button" :disabled="transitioning" @click="reviewBatch('RETURN')">退回修改</button>
        <button class="approve-button" :disabled="transitioning" @click="reviewBatch('APPROVE')">审核通过</button>
      </view>
    </view>

    <view class="item-section">
      <view class="section-heading">
        <text>盘点明细</text>
        <text>{{ items.length }}项</text>
      </view>
      <view class="item-list">
        <view v-for="item in items" :key="item._id" class="item-row" @click="openItem(item)">
          <view class="item-main">
            <text class="item-name">{{ item.equipmentNameSnapshot }}</text>
            <text class="item-code">{{ item.assetCodeSnapshot }}</text>
          </view>
          <view class="item-side">
            <text v-if="item.actualPresent === null" class="unchecked">未盘点</text>
            <text v-else-if="item.differenceTypes.length" class="difference">{{ inventoryDifferenceText(item.differenceTypes) }}</text>
            <text v-else class="matched">账实一致</text>
            <text class="row-arrow">〉</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="approvals.length" class="approval-section">
      <view class="section-heading"><text>审批记录</text><text>{{ approvals.length }}条</text></view>
      <view class="approval-list">
        <view v-for="approval in approvals" :key="approval._id" class="approval-row">
          <view class="approval-marker" :class="{ returned: approval.decision === 'RETURN' }" />
          <view class="approval-copy">
            <text class="approval-title">第{{ approval.reviewRound }}轮 · {{ approvalStageLabel(approval.stage) }}</text>
            <text class="approval-result">{{ decisionLabel(approval.decision) }}</text>
            <text v-if="approval.comment" class="approval-comment">{{ approval.comment }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="itemEditorVisible" class="editor-mask" @click.self="closeItem">
      <view class="item-editor">
        <view class="editor-heading">
          <view>
            <text class="editor-title">{{ itemForm.equipmentName }}</text>
            <text class="editor-code">{{ itemForm.assetCode }}</text>
          </view>
          <text class="close-action" @click="closeItem">关闭</text>
        </view>
        <view class="snapshot-row">
          <text>账面状态 {{ equipmentStatusLabel(itemForm.bookStatus) }}</text>
          <text>账面数量 {{ itemForm.bookQuantity }}</text>
        </view>
        <text class="field-label">现场是否存在</text>
        <view class="presence-control">
          <view :class="['presence-option', { active: itemForm.actualPresent }]" @click="itemForm.actualPresent = true">现场存在</view>
          <view :class="['presence-option', { active: !itemForm.actualPresent }]" @click="itemForm.actualPresent = false">现场未找到</view>
        </view>
        <template v-if="itemForm.actualPresent">
          <text class="field-label">实盘状态</text>
          <picker :range="statusOptions" range-key="label" :value="statusIndex" @change="onStatusChange">
            <view class="picker-field">{{ equipmentStatusLabel(itemForm.actualStatus) }} 〉</view>
          </picker>
          <text class="field-label">实盘数量</text>
          <input v-model="itemForm.actualQuantity" class="input-field" type="digit" placeholder="输入实盘数量" />
          <text class="field-label">实盘位置</text>
          <input v-model="itemForm.actualLocation" class="input-field" maxlength="500" placeholder="输入实盘位置" />
        </template>
        <text class="field-label">差异说明</text>
        <textarea v-model="itemForm.differenceNote" class="textarea-field" maxlength="5000" placeholder="存在差异时必填" />
        <view class="photo-heading">
          <text class="field-label">现场照片</text>
          <text>{{ existingPhotoIds.length + selectedPhotos.length }}/10</text>
        </view>
        <view class="photo-grid">
          <view v-for="(fileId, index) in existingPhotoIds" :key="fileId" class="existing-photo">已上传{{ index + 1 }}</view>
          <view v-for="(photo, index) in selectedPhotos" :key="photo.path" class="photo-preview">
            <image :src="photo.path" mode="aspectFill" />
            <text @click="removePhoto(index)">删除</text>
          </view>
          <view v-if="existingPhotoIds.length + selectedPhotos.length < 10" class="camera-entry" @click="takePhoto">拍照</view>
        </view>
        <text class="photo-hint">差异项至少1张照片；现场采集仅调用相机。</text>
        <button class="save-button" :loading="savingItem" :disabled="savingItem" @click="saveItem">保存盘点结果</button>
      </view>
    </view>
  </view>
</template>

<script>
import { computed, reactive, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import {
  deleteTemporaryPrivateFile,
  getEquipmentInventorySession,
  reviewEquipmentInventorySession,
  scanEquipmentInventoryItem,
  submitEquipmentInventorySession,
  updateEquipmentInventoryItem,
  uploadEquipmentInventoryPhoto
} from '@/api/index.js'
import { parseEquipmentQrPayload } from '@/utils/equipment.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import {
  EQUIPMENT_STATUS_OPTIONS,
  approvalStageLabel,
  inventoryDifferenceText,
  inventoryItemPayload,
  inventoryStatusLabel,
  inventoryStatusTone
} from '@/utils/equipmentInventory.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentInventoryDetail',
  setup() {
    const userStore = useUserStore()
    const inventorySessionId = ref('')
    const teamId = ref('')
    const inventorySession = ref(null)
    const items = ref([])
    const approvals = ref([])
    const loading = ref(false)
    const scanning = ref(false)
    const savingItem = ref(false)
    const transitioning = ref(false)
    const itemEditorVisible = ref(false)
    const selectedPhotos = ref([])
    const existingPhotoIds = ref([])
    const itemForm = reactive(emptyItemForm())
    const statusOptions = EQUIPMENT_STATUS_OPTIONS
    const statusIndex = computed(() => Math.max(0, statusOptions.findIndex((item) => item.value === itemForm.actualStatus)))

    function emptyItemForm() {
      return {
        _id: '', equipmentName: '', assetCode: '', bookStatus: 'IN_USE', bookQuantity: 0,
        actualPresent: true, actualStatus: 'IN_USE', actualQuantity: 0, actualLocation: '',
        differenceNote: '', expectedVersion: 0
      }
    }

    const loadDetail = async () => {
      if (!inventorySessionId.value || loading.value) return
      loading.value = true
      try {
        const response = await getEquipmentInventorySession(inventorySessionId.value, {
          page: 1,
          pageSize: 200,
          ...(teamId.value ? { teamId: teamId.value } : {})
        })
        inventorySession.value = response.inventorySession
        items.value = response.items || []
        approvals.value = response.approvals || []
      } finally {
        loading.value = false
        uni.stopPullDownRefresh()
      }
    }

    const openItem = (item) => {
      if (!inventorySession.value?.canInventory) return
      Object.assign(itemForm, {
        _id: item._id,
        equipmentName: item.equipmentNameSnapshot,
        assetCode: item.assetCodeSnapshot,
        bookStatus: item.bookStatus,
        bookQuantity: item.bookQuantity ?? 0,
        actualPresent: item.actualPresent ?? true,
        actualStatus: item.actualStatus || item.bookStatus,
        actualQuantity: item.actualQuantity ?? item.bookQuantity ?? 0,
        actualLocation: item.actualLocation || item.bookLocation || '',
        differenceNote: item.differenceNote || '',
        expectedVersion: item.version
      })
      existingPhotoIds.value = [...(item.photoFileIds || [])]
      selectedPhotos.value = []
      itemEditorVisible.value = true
    }

    const closeItem = () => {
      if (!savingItem.value) itemEditorVisible.value = false
    }

    const onStatusChange = (event) => {
      itemForm.actualStatus = statusOptions[Number(event.detail.value)]?.value || itemForm.bookStatus
    }

    const takePhoto = () => {
      if (existingPhotoIds.value.length + selectedPhotos.value.length >= 10) return
      uni.chooseImage({
        count: Math.min(10 - existingPhotoIds.value.length - selectedPhotos.value.length, 3),
        sourceType: ['camera'],
        success: ({ tempFiles = [], tempFilePaths = [] }) => {
          const files = tempFiles.length
            ? tempFiles.map((file) => ({ path: file.path || file.tempFilePath, name: `inventory-${Date.now()}.jpg` }))
            : tempFilePaths.map((path) => ({ path, name: `inventory-${Date.now()}.jpg` }))
          selectedPhotos.value.push(...files.filter((file) => file.path))
        }
      })
    }

    const removePhoto = (index) => selectedPhotos.value.splice(index, 1)

    const saveItem = async () => {
      if (itemForm.actualPresent && (itemForm.actualQuantity === '' || Number(itemForm.actualQuantity) < 0)) {
        return uni.showToast({ title: '请输入有效实盘数量', icon: 'none' })
      }
      savingItem.value = true
      const uploadedIds = []
      try {
        for (const photo of selectedPhotos.value) {
          uploadedIds.push(await uploadEquipmentInventoryPhoto(photo))
        }
        await updateEquipmentInventoryItem(
          inventorySessionId.value,
          itemForm._id,
          inventoryItemPayload(itemForm, [...existingPhotoIds.value, ...uploadedIds])
        )
        uni.showToast({ title: '盘点结果已保存', icon: 'success' })
        itemEditorVisible.value = false
        await loadDetail()
      } catch (error) {
        await Promise.allSettled(uploadedIds.map((fileId) => deleteTemporaryPrivateFile(fileId)))
        uni.showToast({ title: requestErrorMessage(error, '盘点结果保存失败'), icon: 'none' })
      } finally {
        savingItem.value = false
      }
    }

    const handleScanResult = async (rawValue) => {
      const payload = parseEquipmentQrPayload(rawValue)
      if (!payload?.token) throw new Error('无效设备二维码')
      const response = await scanEquipmentInventoryItem(inventorySessionId.value, payload.token)
      openItem(response.item)
    }

    const startInventoryScan = () => {
      if (scanning.value) return
      scanning.value = true
      uni.scanCode({
        onlyFromCamera: true,
        scanType: ['qrCode'],
        success: ({ result }) => handleScanResult(result).catch((error) => {
          uni.showToast({ title: requestErrorMessage(error, '该设备不在本批次'), icon: 'none' })
        }),
        fail: (error) => {
          if (!String(error?.errMsg || '').includes('cancel')) {
            uni.showToast({ title: '扫码失败，请检查相机权限', icon: 'none' })
          }
        },
        complete: () => { scanning.value = false }
      })
    }

    const editableModal = (title, placeholder) => new Promise((resolve) => {
      uni.showModal({
        title,
        editable: true,
        placeholderText: placeholder,
        confirmText: '确认',
        success: (result) => resolve(result.confirm ? String(result.content || '') : null),
        fail: () => resolve(null)
      })
    })

    const submitBatch = async () => {
      const comment = await editableModal('提交盘点批次', '提交说明（可选）')
      if (comment === null) return
      transitioning.value = true
      try {
        await submitEquipmentInventorySession(inventorySessionId.value, {
          expectedVersion: inventorySession.value.version,
          comment: comment.trim()
        })
        uni.showToast({ title: '已提交审核', icon: 'success' })
        await loadDetail()
      } finally {
        transitioning.value = false
      }
    }

    const reviewBatch = async (decision) => {
      const comment = await editableModal(
        decision === 'RETURN' ? '退回盘点人修改' : '审核通过',
        decision === 'RETURN' ? '必须填写退回原因' : '审批意见（可选）'
      )
      if (comment === null) return
      if (decision === 'RETURN' && !comment.trim()) {
        return uni.showToast({ title: '请填写退回原因', icon: 'none' })
      }
      transitioning.value = true
      try {
        await reviewEquipmentInventorySession(inventorySessionId.value, {
          decision,
          comment: comment.trim(),
          expectedVersion: inventorySession.value.version
        })
        uni.showToast({ title: decision === 'RETURN' ? '已退回' : '审核通过', icon: 'success' })
        await loadDetail()
      } finally {
        transitioning.value = false
      }
    }

    const equipmentStatusLabel = (value) => statusOptions.find((item) => item.value === value)?.label || value || '-'
    const decisionLabel = (value) => ({ SUBMIT: '提交审核', APPROVE: '审核通过', RETURN: '退回修改' }[value] || value)

    onLoad((options) => {
      inventorySessionId.value = options.id || ''
      teamId.value = options.teamId || ''
    })
    onShow(() => {
      if (inventorySessionId.value && userStore.hasPermission('equipment.inventory')) loadDetail()
    })
    onPullDownRefresh(loadDetail)
    return {
      inventorySession,
      items,
      approvals,
      scanning,
      savingItem,
      transitioning,
      itemEditorVisible,
      itemForm,
      selectedPhotos,
      existingPhotoIds,
      statusOptions,
      statusIndex,
      openItem,
      closeItem,
      onStatusChange,
      takePhoto,
      removePhoto,
      saveItem,
      startInventoryScan,
      submitBatch,
      reviewBatch,
      equipmentStatusLabel,
      decisionLabel,
      approvalStageLabel,
      inventoryDifferenceText,
      inventoryStatusLabel,
      inventoryStatusTone
    }
  }
}
</script>

<style scoped lang="scss">
.inventory-detail-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.summary-band, .item-section, .approval-section, .item-editor { border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.summary-band { padding: 24rpx; }
.summary-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.batch-name, .batch-org { display: block; }
.batch-name { color: #1f2733; font-size: 31rpx; font-weight: 700; }
.batch-org { margin-top: 7rpx; color: #64748b; font-size: 23rpx; }
.status-label { padding: 6rpx 10rpx; border: 1px solid; border-radius: 6rpx; font-size: 20rpx; }
.status-neutral { color: #52606d; border-color: #cbd5e1; background: #f8fafc; }
.status-warning { color: #8a4b08; border-color: #f5c98b; background: #fff8e8; }
.status-danger { color: #b42318; border-color: #f2c1bd; background: #fff3f2; }
.status-success { color: #245d3f; border-color: #b7dfc8; background: #edf9f2; }
.summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rpx; margin-top: 22rpx; background: #e8edf3; }
.summary-grid view { padding: 18rpx 12rpx; background: #f8fafc; text-align: center; }
.summary-grid text, .summary-grid strong { display: block; }
.summary-grid text { color: #64748b; font-size: 21rpx; }
.summary-grid strong { margin-top: 7rpx; color: #1f2733; font-size: 28rpx; }
.summary-grid .danger { color: #b42318; }
.returned-hint { display: block; padding: 16rpx; margin-top: 18rpx; border-left: 5rpx solid #e6a23c; color: #8a4b08; background: #fff8e8; font-size: 22rpx; line-height: 1.5; }
.scan-button, .submit-button, .approve-button, .return-button, .save-button { height: 76rpx; line-height: 76rpx; margin: 18rpx 0 0; border-radius: 8rpx; font-size: 25rpx; }
.scan-button { color: #1d5fa7; border: 1px solid #9fc8f5; background: #edf6ff; }
.submit-button, .approve-button, .save-button { color: #fff; background: #1677ff; }
.review-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12rpx; }
.return-button { color: #b42318; border: 1px solid #efb5b0; background: #fff3f2; }
.item-section, .approval-section { margin-top: 20rpx; overflow: hidden; }
.section-heading { display: flex; align-items: center; justify-content: space-between; padding: 20rpx 24rpx; border-bottom: 1px solid #e8edf3; color: #1f2733; font-size: 27rpx; font-weight: 600; }
.section-heading text:last-child { color: #64748b; font-size: 22rpx; font-weight: 400; }
.item-row { display: flex; align-items: center; min-height: 102rpx; padding: 18rpx 24rpx; box-sizing: border-box; border-bottom: 1px solid #e8edf3; }
.item-row:last-child { border-bottom: 0; }
.item-main { min-width: 0; flex: 1; }
.item-name, .item-code { display: block; overflow-wrap: anywhere; }
.item-name { color: #1f2733; font-size: 27rpx; font-weight: 600; }
.item-code { margin-top: 5rpx; color: #64748b; font-size: 22rpx; }
.item-side { display: flex; align-items: center; max-width: 290rpx; margin-left: 16rpx; font-size: 22rpx; text-align: right; }
.unchecked { color: #94a3b8; }.difference { color: #b42318; }.matched { color: #245d3f; }
.row-arrow { margin-left: 10rpx; color: #94a3b8; font-size: 30rpx; }
.approval-row { display: flex; gap: 16rpx; padding: 20rpx 24rpx; border-bottom: 1px solid #e8edf3; }
.approval-row:last-child { border-bottom: 0; }
.approval-marker { width: 18rpx; height: 18rpx; flex: 0 0 18rpx; margin-top: 8rpx; border-radius: 50%; background: #2f855a; }
.approval-marker.returned { background: #d92d20; }
.approval-title, .approval-result, .approval-comment { display: block; }
.approval-title { color: #1f2733; font-size: 25rpx; font-weight: 600; }
.approval-result { margin-top: 5rpx; color: #52606d; font-size: 22rpx; }
.approval-comment { margin-top: 8rpx; color: #64748b; font-size: 22rpx; line-height: 1.5; }
.editor-mask { position: fixed; inset: 0; z-index: 90; display: flex; align-items: flex-end; background: rgba(15, 23, 42, 0.52); }
.item-editor { width: 100%; max-height: 92vh; padding: 26rpx 24rpx calc(28rpx + env(safe-area-inset-bottom)); box-sizing: border-box; overflow-y: auto; border-radius: 8rpx 8rpx 0 0; }
.editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.editor-title, .editor-code { display: block; }.editor-title { color: #1f2733; font-size: 30rpx; font-weight: 700; }.editor-code { margin-top: 5rpx; color: #64748b; font-size: 22rpx; }
.close-action { color: #1677ff; font-size: 24rpx; }
.snapshot-row { display: flex; justify-content: space-between; gap: 16rpx; padding: 16rpx; margin-top: 20rpx; color: #52606d; background: #f4f7fa; font-size: 22rpx; }
.field-label { display: block; margin: 22rpx 0 10rpx; color: #344054; font-size: 24rpx; font-weight: 600; }
.presence-control { display: grid; grid-template-columns: 1fr 1fr; gap: 8rpx; padding: 6rpx; border-radius: 8rpx; background: #edf1f5; }
.presence-option { height: 64rpx; line-height: 64rpx; border-radius: 6rpx; color: #64748b; text-align: center; font-size: 24rpx; }
.presence-option.active { color: #1d5fa7; background: #fff; font-weight: 600; }
.picker-field, .input-field, .textarea-field { width: 100%; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f9fbfd; font-size: 24rpx; }
.picker-field, .input-field { height: 72rpx; line-height: 72rpx; padding: 0 18rpx; }
.textarea-field { height: 150rpx; padding: 16rpx 18rpx; }
.photo-heading { display: flex; align-items: center; justify-content: space-between; color: #64748b; font-size: 22rpx; }
.photo-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10rpx; }
.existing-photo, .photo-preview, .camera-entry { aspect-ratio: 1; border: 1px solid #dce4ee; border-radius: 8rpx; overflow: hidden; }
.existing-photo, .camera-entry { display: flex; align-items: center; justify-content: center; color: #64748b; background: #f4f7fa; font-size: 20rpx; }
.camera-entry { color: #1677ff; border-style: dashed; }
.photo-preview { position: relative; }.photo-preview image { width: 100%; height: 100%; }.photo-preview text { position: absolute; right: 0; bottom: 0; padding: 4rpx 7rpx; color: #fff; background: rgba(180, 35, 24, 0.86); font-size: 18rpx; }
.photo-hint { display: block; margin-top: 10rpx; color: #64748b; font-size: 21rpx; }
</style>
