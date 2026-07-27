<template>
  <view class="repair-detail-page">
    <view v-if="repair" class="asset-band">
      <view class="asset-heading">
        <view class="asset-copy">
          <text class="asset-name">{{ repair.equipmentSnapshot?.name || '-' }}</text>
          <text class="asset-code">{{ repair.equipmentSnapshot?.assetCode || '-' }}</text>
        </view>
        <text class="status-tag" :class="`tone-${repairStatusTone(repair.status)}`">
          {{ repairStatusLabel(repair.status) }}
        </text>
      </view>
      <view class="asset-grid">
        <view><text>维修类型</text><strong>{{ repairTypeLabel(repair.type) }}</strong></view>
        <view><text>所属分部</text><strong>{{ repair.equipmentSnapshot?.orgUnitName || '-' }}</strong></view>
        <view><text>存放地点</text><strong>{{ repair.equipmentSnapshot?.location || '-' }}</strong></view>
        <view><text>更新时间</text><strong>{{ formatDate(repair.updatedAt, 'YYYY-MM-DD HH:mm') || '-' }}</strong></view>
      </view>
    </view>

    <view v-if="repair?.type === 'FAULT_REPORT'" class="section-band">
      <text class="section-title">故障报修信息</text>
      <view class="detail-grid">
        <view><text>报修时间</text><strong>{{ formatDate(repair.reportTime, 'YYYY-MM-DD HH:mm') }}</strong></view>
        <view><text>地点</text><strong>{{ repair.reportLocation || '-' }}</strong></view>
        <view><text>联系人</text><strong>{{ repair.contactName || '-' }}</strong></view>
        <view><text>电话</text><strong>{{ repair.contactPhone || '-' }}</strong></view>
        <view><text>车牌号</text><strong>{{ repair.plateNumber || '-' }}</strong></view>
      </view>
      <view class="long-value"><text>故障描述</text><strong>{{ repair.faultDescription || '-' }}</strong></view>
      <view class="photo-list">
        <button v-for="(photo, index) in repair.photoAttachments" :key="photo.fileId" @click="previewRepairPhoto(photo)">
          查看现场照片 {{ index + 1 }}
        </button>
      </view>
    </view>

    <view v-else-if="repair" class="section-band">
      <text class="section-title">维修信息</text>
      <view class="detail-grid">
        <view><text>维修日期</text><strong>{{ formatDate(repair.repairDate, 'YYYY-MM-DD') }}</strong></view>
        <view><text>维修人</text><strong>{{ repair.repairerName || '-' }}</strong></view>
      </view>
      <view class="long-value"><text>维修说明</text><strong>{{ repair.repairDescription || '-' }}</strong></view>
    </view>

    <view v-if="repair?.type === 'PARTS_REPAIR'" class="section-band">
      <view class="section-heading"><text class="section-title">配件明细</text><strong>¥{{ Number(repair.totalAmount || 0).toFixed(2) }}</strong></view>
      <view class="part-table">
        <view v-for="part in repair.partItems" :key="part.itemKey" class="part-display-row">
          <view><strong>{{ part.name }}</strong><text>{{ part.specification || '无规格' }}</text></view>
          <view class="part-price">
            <text>{{ part.quantity == null ? '待定数量' : `${part.quantity} × ¥${Number(part.unitPrice).toFixed(2)}` }}</text>
            <strong>{{ part.amount == null ? '待定价' : `¥${Number(part.amount).toFixed(2)}` }}</strong>
          </view>
        </view>
      </view>
    </view>

    <view v-if="repair?.summaryText" class="section-band summary-band">
      <view class="section-heading">
        <text class="section-title">维修摘要</text>
        <button class="copy-summary" @click="copyRepairSummary">复制</button>
      </view>
      <text class="summary-text">{{ repair.summaryText }}</text>
    </view>

    <view v-if="repair?.availableActions?.length" class="section-band action-band">
      <text class="section-title">当前待办</text>
      <view class="action-grid">
        <button
          v-for="action in repair.availableActions"
          :key="action"
          :class="{
            primary: action === primaryAction,
            danger: ['REJECT_TO_CREATOR', 'REJECT_TO_PREVIOUS', 'VOID'].includes(action),
            active: selectedAction === action
          }"
          @click="selectAction(action)"
        >
          {{ repairActionLabel(action) }}
        </button>
      </view>

      <view v-if="selectedAction" class="action-form">
        <template v-if="showRepairCorrections">
          <label class="field-row">
            <text>维修日期</text>
            <picker mode="date" :value="actionForm.repairDate" @change="actionForm.repairDate = $event.detail.value">
              <view>{{ actionForm.repairDate }}</view>
            </picker>
          </label>
          <label class="field-row"><text>维修人</text><input v-model="actionForm.repairerName" /></label>
          <label class="field-block"><text>维修说明</text><textarea v-model="actionForm.repairDescription" maxlength="5000" /></label>
          <view v-if="repair.type === 'PARTS_REPAIR'" class="part-editor">
            <view class="part-editor-heading"><text>可修正配件明细</text><button @click="addPart">添加</button></view>
            <view v-for="(part, index) in actionForm.partItems" :key="part.itemKey" class="edit-part-row">
              <view>
                <input v-model="part.name" placeholder="配件名称" />
                <input v-model="part.specification" placeholder="规格型号" />
                <input v-model="part.remark" placeholder="备注" />
              </view>
              <button :disabled="actionForm.partItems.length <= 1" @click="removePart(index)">删除</button>
            </view>
          </view>
        </template>

        <template v-if="showFaultResubmit">
          <label class="field-row">
            <text>报修地点</text>
            <view class="location-control">
              <input v-model="actionForm.reportLocation" />
              <picker v-if="repairLocations.length" :range="repairLocations" @change="selectRepairLocation">
                <text>选择</text>
              </picker>
            </view>
          </label>
          <label class="field-row"><text>车牌号</text><input v-model="actionForm.plateNumber" /></label>
          <label class="field-row"><text>联系人</text><input v-model="actionForm.contactName" /></label>
          <label class="field-row"><text>联系电话</text><input v-model="actionForm.contactPhone" type="number" /></label>
          <label class="field-block"><text>故障描述</text><textarea v-model="actionForm.faultDescription" maxlength="5000" /></label>
          <text class="form-hint">重新提交保留原现场照片</text>
        </template>

        <view v-if="showPricing" class="pricing-editor">
          <view v-for="part in actionForm.partItems" :key="part.itemKey" class="pricing-row">
            <view class="pricing-copy"><strong>{{ part.name }}</strong><text>{{ part.specification || '-' }}</text></view>
            <label><text>数量</text><input v-model="part.quantity" type="digit" /></label>
            <label><text>单价</text><input v-model="part.unitPrice" type="digit" /></label>
            <strong class="line-total">¥{{ repairLineAmount(part).toFixed(2) }}</strong>
          </view>
          <view class="pricing-total">合计 ¥{{ pricingTotal.toFixed(2) }}</view>
        </view>

        <label class="field-block note-field">
          <text>{{ noteRequired ? '处理意见（必填）' : '处理说明' }}</text>
          <textarea v-model="actionForm.note" maxlength="2000" placeholder="填写审核、驳回或作废意见" />
        </label>
        <button class="submit-action" :loading="submitting" :disabled="submitting" @click="submitAction">
          确认{{ repairActionLabel(selectedAction) }}
        </button>
      </view>
    </view>

    <view v-if="repair" class="section-band">
      <text class="section-title">流程记录</text>
      <view class="timeline">
        <view v-for="item in reversedLogs" :key="item._id" class="timeline-row">
          <view class="timeline-dot" />
          <view class="timeline-copy">
            <strong>{{ repairActionLabel(item.action) }}</strong>
            <text>{{ repairStatusLabel(item.fromStatus) }} → {{ repairStatusLabel(item.toStatus) }}</text>
            <text v-if="item.note" class="timeline-note">{{ item.note }}</text>
            <small>{{ formatDate(item.actedAt, 'YYYY-MM-DD HH:mm') }} · {{ item.actorName || '未知操作人' }} · {{ repairPositionLabel(item.actorPositionKey) }}</small>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { computed, reactive, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import {
  downloadPrivateFile,
  getEquipmentRepair,
  getEquipmentRepairLocations,
  transitionEquipmentRepair
} from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import {
  createRepairPart,
  repairActionLabel,
  repairLineAmount,
  repairPositionLabel,
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel
} from '@/utils/equipmentRepair.js'

export default {
  name: 'EquipmentRepairDetail',
  setup() {
    const repairId = ref('')
    const teamId = ref('')
    const repair = ref(null)
    const repairLocations = ref([])
    const selectedAction = ref('')
    const submitting = ref(false)
    const actionForm = reactive(emptyActionForm())
    const reversedLogs = computed(() => [...(repair.value?.actionLogs || [])].reverse())
    const primaryAction = computed(() => repair.value?.availableActions?.find((action) => (
      !['REJECT_TO_CREATOR', 'REJECT_TO_PREVIOUS', 'VOID'].includes(action)
    )) || '')
    const showPricing = computed(() => selectedAction.value === 'CONFIRM_PRICING')
    const showRepairCorrections = computed(() => (
      repair.value?.type !== 'FAULT_REPORT' &&
      ['SUB_DEPARTMENT_APPROVE', 'RESUBMIT'].includes(selectedAction.value)
    ))
    const showFaultResubmit = computed(() => (
      repair.value?.type === 'FAULT_REPORT' && selectedAction.value === 'RESUBMIT'
    ))
    const noteRequired = computed(() => [
      'DEPUTY_APPROVE',
      'MANAGER_APPROVE',
      'REJECT_TO_CREATOR',
      'REJECT_TO_PREVIOUS',
      'VOID'
    ].includes(selectedAction.value))
    const pricingTotal = computed(() => actionForm.partItems.reduce(
      (sum, item) => sum + repairLineAmount(item),
      0
    ))

    function emptyActionForm() {
      return {
        note: '',
        reportLocation: '',
        plateNumber: '',
        contactName: '',
        contactPhone: '',
        faultDescription: '',
        repairDate: '',
        repairerName: '',
        repairDescription: '',
        partItems: []
      }
    }

    const load = async () => {
      if (!repairId.value) return
      const result = await getEquipmentRepair(
        repairId.value,
        teamId.value ? { teamId: teamId.value } : {}
      )
      repair.value = result.repair
      if (selectedAction.value && !repair.value.availableActions.includes(selectedAction.value)) {
        selectedAction.value = ''
      }
    }

    const selectAction = (action) => {
      selectedAction.value = action
      Object.assign(actionForm, emptyActionForm(), {
        reportLocation: repair.value.reportLocation,
        plateNumber: repair.value.plateNumber,
        contactName: repair.value.contactName,
        contactPhone: repair.value.contactPhone,
        faultDescription: repair.value.faultDescription,
        repairDate: formatDate(repair.value.repairDate, 'YYYY-MM-DD'),
        repairerName: repair.value.repairerName,
        repairDescription: repair.value.repairDescription,
        partItems: repair.value.partItems.map((item) => ({
          ...item,
          quantity: item.quantity ?? 1,
          unitPrice: item.unitPrice ?? 0
        }))
      })
    }

    const selectRepairLocation = (event) => {
      actionForm.reportLocation = repairLocations.value[Number(event.detail.value)] || actionForm.reportLocation
    }

    const copyRepairSummary = () => {
      if (!repair.value?.summaryText) return
      uni.setClipboardData({ data: repair.value.summaryText })
    }

    const addPart = () => {
      if (actionForm.partItems.length >= 100) return
      actionForm.partItems.push(createRepairPart(actionForm.partItems.length))
    }
    const removePart = (index) => {
      if (actionForm.partItems.length > 1) actionForm.partItems.splice(index, 1)
    }

    const validate = () => {
      if (noteRequired.value && !actionForm.note.trim()) return '请填写处理意见'
      if (showPricing.value && actionForm.partItems.some((item) => (
        !(Number(item.quantity) > 0) || Number(item.unitPrice) < 0
      ))) return '请填写有效数量和单价'
      if (showRepairCorrections.value && (!actionForm.repairDate || !actionForm.repairerName.trim())) {
        return '请填写维修日期和维修人'
      }
      if (showRepairCorrections.value && repair.value.type === 'PARTS_REPAIR' &&
          actionForm.partItems.some((item) => !item.name.trim())) return '请填写配件名称'
      if (showFaultResubmit.value && (!actionForm.reportLocation.trim() || !actionForm.contactName.trim() ||
          !actionForm.contactPhone.trim() || !actionForm.faultDescription.trim())) return '请完整填写报修信息'
      return ''
    }

    const buildPayload = () => {
      const payload = {
        action: selectedAction.value,
        revision: repair.value.revision,
        note: actionForm.note
      }
      if (showPricing.value) {
        payload.partItems = actionForm.partItems.map((item) => ({
          itemKey: item.itemKey,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice)
        }))
      }
      if (showRepairCorrections.value) {
        payload.corrections = {
          repairDate: actionForm.repairDate,
          repairerName: actionForm.repairerName,
          repairDescription: actionForm.repairDescription,
          ...(repair.value.type === 'PARTS_REPAIR'
            ? {
                partItems: actionForm.partItems.map((item) => ({
                  itemKey: item.itemKey,
                  name: item.name,
                  specification: item.specification,
                  remark: item.remark
                }))
              }
            : {})
        }
      }
      if (showFaultResubmit.value) {
        payload.corrections = {
          reportTime: repair.value.reportTime,
          reportLocation: actionForm.reportLocation,
          plateNumber: actionForm.plateNumber,
          contactName: actionForm.contactName,
          contactPhone: actionForm.contactPhone,
          faultDescription: actionForm.faultDescription
        }
      }
      return payload
    }

    const submitAction = async () => {
      const validationMessage = validate()
      if (validationMessage) return uni.showToast({ title: validationMessage, icon: 'none' })
      submitting.value = true
      try {
        const result = await transitionEquipmentRepair(repair.value._id, buildPayload())
        repair.value = result.repair
        selectedAction.value = ''
        uni.showToast({ title: '处理成功', icon: 'success' })
      } catch (error) {
        if (error.code === 'EQUIPMENT_REPAIR_CONFLICT') await load()
      } finally {
        submitting.value = false
      }
    }

    const previewRepairPhoto = async (photo) => {
      try {
        const result = await downloadPrivateFile(
          photo.fileId,
          teamId.value ? { teamId: teamId.value } : {}
        )
        uni.previewImage({ current: result.tempFilePath, urls: [result.tempFilePath] })
      } catch {}
    }

    onLoad((options) => {
      repairId.value = options.repairId || ''
      teamId.value = options.teamId || ''
    })
    onShow(async () => {
      await Promise.all([
        load(),
        getEquipmentRepairLocations(teamId.value ? { teamId: teamId.value } : {}).then((result) => {
          repairLocations.value = result.locations || []
        })
      ])
    })
    return {
      repair,
      repairLocations,
      selectedAction,
      actionForm,
      submitting,
      reversedLogs,
      primaryAction,
      showPricing,
      showRepairCorrections,
      showFaultResubmit,
      noteRequired,
      pricingTotal,
      selectAction,
      selectRepairLocation,
      copyRepairSummary,
      addPart,
      removePart,
      submitAction,
      previewRepairPhoto,
      repairActionLabel,
      repairLineAmount,
      repairPositionLabel,
      repairStatusLabel,
      repairStatusTone,
      repairTypeLabel,
      formatDate
    }
  }
}
</script>

<style scoped lang="scss">
.repair-detail-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .section-band { margin-bottom: 20rpx; padding: 24rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.asset-heading, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.asset-copy { min-width: 0; flex: 1; }
.asset-name, .asset-code { display: block; overflow-wrap: anywhere; }
.asset-name { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.asset-code { margin-top: 5rpx; color: #667085; font-size: 23rpx; }
.status-tag { flex: 0 0 auto; max-width: 260rpx; padding: 8rpx 12rpx; border-radius: 7rpx; font-size: 20rpx; text-align: center; overflow-wrap: anywhere; }
.tone-success { color: #245d3f; background: #eaf7ef; }
.tone-warning { color: #9a6700; background: #fff4cc; }
.tone-danger { color: #b42318; background: #feeceb; }
.asset-grid, .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx 28rpx; margin-top: 24rpx; padding-top: 20rpx; border-top: 1px solid #e8edf3; }
.asset-grid text, .asset-grid strong, .detail-grid text, .detail-grid strong, .long-value text, .long-value strong { display: block; overflow-wrap: anywhere; }
.asset-grid text, .detail-grid text, .long-value text { color: #667085; font-size: 21rpx; }
.asset-grid strong, .detail-grid strong, .long-value strong { margin-top: 5rpx; color: #1f2733; font-size: 24rpx; font-weight: 600; }
.section-title { color: #1f2733; font-size: 28rpx; font-weight: 600; }
.long-value { margin-top: 20rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }
.photo-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12rpx; margin-top: 20rpx; }
.photo-list button { min-width: 0; height: 66rpx; margin: 0; color: #1677ff; background: #edf5ff; font-size: 22rpx; line-height: 66rpx; }
.section-heading > strong { color: #245d3f; font-size: 27rpx; }
.part-display-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; padding: 18rpx 0; border-bottom: 1px solid #e8edf3; }
.part-display-row > view { min-width: 0; }
.part-display-row strong, .part-display-row text { display: block; overflow-wrap: anywhere; }
.part-display-row strong { color: #1f2733; font-size: 24rpx; }
.part-display-row text { margin-top: 4rpx; color: #667085; font-size: 21rpx; }
.part-price { flex: 0 0 230rpx; text-align: right; }
.action-band { border-color: #9cc7ad; }
.action-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12rpx; margin-top: 18rpx; }
.action-grid button { min-width: 0; min-height: 70rpx; padding: 8rpx 6rpx; border: 1px solid #dce4ee; border-radius: 8rpx; color: #52606d; background: #f7faff; font-size: 20rpx; line-height: 1.35; overflow-wrap: anywhere; }
.action-grid button.primary { grid-column: 1 / -1; min-height: 78rpx; border-color: #8bc5a2; color: #fff; background: #2f7d52; font-size: 24rpx; }
.action-grid button.danger { border-color: #f0b8b4; color: #b42318; background: #feeceb; }
.action-grid button.active { border-color: #1677ff; box-shadow: 0 0 0 2rpx rgba(22, 119, 255, .2); }
.action-form { margin-top: 22rpx; padding-top: 20rpx; border-top: 1px solid #e8edf3; }
.field-row { display: grid; grid-template-columns: 150rpx minmax(0, 1fr); align-items: center; min-height: 84rpx; border-bottom: 1px solid #e8edf3; }
.field-row text, .field-block > text { color: #344054; font-size: 23rpx; }
.field-row input, .field-row picker { min-width: 0; text-align: right; font-size: 24rpx; }
.location-control { display: flex; align-items: center; justify-content: flex-end; gap: 14rpx; min-width: 0; }
.location-control input { flex: 1; }
.location-control picker { flex: 0 0 auto; padding: 8rpx 12rpx; border-left: 1px solid #dce4ee; color: #1677ff; font-size: 21rpx; }
.field-block { display: grid; gap: 12rpx; padding: 18rpx 0; }
.field-block textarea { width: 100%; height: 160rpx; padding: 15rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; font-size: 23rpx; }
.form-hint { display: block; color: #667085; font-size: 21rpx; }
.part-editor-heading { display: flex; align-items: center; justify-content: space-between; margin: 12rpx 0; color: #344054; font-size: 23rpx; }
.part-editor-heading button { width: 110rpx; height: 58rpx; margin: 0; color: #245d3f; background: #eaf7ef; font-size: 22rpx; line-height: 58rpx; }
.edit-part-row { display: grid; grid-template-columns: minmax(0, 1fr) 90rpx; align-items: center; gap: 12rpx; padding: 14rpx 0; border-bottom: 1px solid #e8edf3; }
.edit-part-row > view { display: grid; gap: 9rpx; }
.edit-part-row input { height: 60rpx; padding: 0 12rpx; border: 1px solid #dce4ee; border-radius: 6rpx; font-size: 22rpx; }
.edit-part-row button { width: 90rpx; height: 58rpx; margin: 0; color: #b42318; background: #feeceb; font-size: 21rpx; line-height: 58rpx; }
.pricing-row { display: grid; grid-template-columns: minmax(0, 1fr) 130rpx 130rpx 130rpx; align-items: end; gap: 10rpx; padding: 16rpx 0; border-bottom: 1px solid #e8edf3; }
.pricing-copy strong, .pricing-copy text { display: block; overflow-wrap: anywhere; }
.pricing-copy text { color: #667085; font-size: 20rpx; }
.pricing-row label text { display: block; color: #667085; font-size: 19rpx; }
.pricing-row input { height: 56rpx; padding: 0 10rpx; border: 1px solid #dce4ee; border-radius: 6rpx; font-size: 22rpx; }
.line-total { color: #245d3f; text-align: right; font-size: 22rpx; }
.pricing-total { padding-top: 14rpx; color: #245d3f; text-align: right; font-size: 26rpx; font-weight: 700; }
.note-field { margin-top: 10rpx; }
.submit-action { height: 78rpx; margin: 16rpx 0 0; border-radius: 8rpx; color: #fff; background: #4096ff; font-size: 25rpx; line-height: 78rpx; }
.copy-summary { width: 104rpx; height: 58rpx; margin: 0; border: 1px solid #b8d8c4; border-radius: 8rpx; color: #245d3f; background: #eaf7ef; font-size: 22rpx; line-height: 56rpx; }
.summary-text { display: block; margin-top: 16rpx; padding: 18rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f7faff; color: #344054; font-size: 22rpx; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.timeline { margin-top: 20rpx; }
.timeline-row { display: grid; grid-template-columns: 24rpx minmax(0, 1fr); gap: 14rpx; padding-bottom: 24rpx; }
.timeline-dot { width: 16rpx; height: 16rpx; margin-top: 8rpx; border: 4rpx solid #b8d8c4; border-radius: 50%; background: #245d3f; }
.timeline-copy strong, .timeline-copy text, .timeline-copy small { display: block; overflow-wrap: anywhere; }
.timeline-copy strong { color: #1f2733; font-size: 24rpx; }
.timeline-copy text { margin-top: 4rpx; color: #667085; font-size: 21rpx; }
.timeline-copy .timeline-note { color: #344054; white-space: pre-wrap; }
.timeline-copy small { margin-top: 5rpx; color: #909399; font-size: 19rpx; }
</style>
