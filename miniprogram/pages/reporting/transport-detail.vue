<template>
  <view class="detail-page">
    <view v-if="record" class="detail-content">
      <view class="detail-section summary-section">
        <view class="summary-header">
          <text class="summary-date">{{ record.reportDate }}</text>
          <text class="summary-tag">{{ record.shift }} · {{ record.tripLabel }}</text>
        </view>
        <text class="summary-route">{{ record.route }}</text>
      </view>

      <view class="detail-section">
        <text class="section-title">运输信息</text>
        <view class="info-list">
          <view class="info-row"><text class="label">所属组织</text><text class="value">{{ displayOrg }}</text></view>
          <view class="info-row"><text class="label">出车类型</text><text class="value">{{ record.dispatchType }}</text></view>
          <view class="info-row"><text class="label">车牌号</text><text class="value">{{ record.vehiclePlate }}</text></view>
          <view class="info-row"><text class="label">车型</text><text class="value">{{ record.vehicleType || '-' }}</text></view>
          <view class="info-row"><text class="label">司机姓名</text><text class="value">{{ record.driverName }}</text></view>
          <view class="info-row"><text class="label">发车时间</text><text class="value">{{ formatDate(record.submittedAt) }}</text></view>
        </view>
      </view>

      <view class="detail-section">
        <view class="section-heading">
          <text class="section-title">装载明细</text>
          <text class="total-text">合计 {{ record.loadTotal || 0 }}</text>
        </view>
        <view class="load-list">
          <view v-for="field in loadFields" :key="field.key" class="load-row">
            <text class="load-label">{{ field.label }}</text>
            <text class="load-value">{{ record.loadDetails?.[field.key] || 0 }}</text>
          </view>
        </view>
      </view>

      <view class="detail-section">
        <view class="section-heading">
          <text class="section-title">现场照片</text>
          <text class="photo-count">{{ record.photoFileIds?.length || 0 }}张</text>
        </view>
        <view class="photo-list">
          <button
            v-for="(fileId, index) in record.photoFileIds"
            :key="fileId"
            class="photo-row"
            :loading="openingFileId === fileId"
            @click="openPhoto(fileId)"
          >
            <text class="photo-index">{{ index + 1 }}</text>
            <text class="photo-name">{{ photoName(fileId, index) }}</text>
            <text class="photo-action">查看</text>
          </button>
        </view>
      </view>

      <view v-if="record.remark" class="detail-section">
        <text class="section-title">备注</text>
        <text class="remark-text">{{ record.remark }}</text>
      </view>
    </view>

    <view v-else-if="!loading" class="empty-state">记录不存在或不可访问</view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  downloadPrivateFile,
  getOrgUnits,
  getPrivateFileMetadata,
  getTransportRecord,
  getUsers
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import { formatDate } from '@/utils/format.js'
import {
  TRANSPORT_LOAD_FIELDS,
  buildOrgUnitOptions,
  orgUnitLabel,
  scopedReportingParams
} from '@/utils/reporting.js'

export default {
  name: 'TransportRecordDetail',
  setup() {
    const userStore = useUserStore()
    const recordId = ref('')
    const selectedTeamId = ref('')
    const record = ref(null)
    const loading = ref(false)
    const openingFileId = ref('')
    const fileMetadata = ref({})
    const downloadedFiles = ref({})
    const orgUnits = ref([])
    const orgUsers = ref([])
    const orgOptions = computed(() => buildOrgUnitOptions(orgUnits.value, orgUsers.value))
    const displayOrg = computed(() => orgUnitLabel(
      record.value?.orgUnitId,
      orgOptions.value,
      userStore.context?.orgUnit
    ))
    const readParams = () => scopedReportingParams(
      userStore.mode,
      selectedTeamId.value
    )

    const loadOrgLabels = async () => {
      if (!userStore.isTeamMode) return
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
    }

    const loadMetadata = async () => {
      const ids = record.value?.photoFileIds || []
      const results = await Promise.allSettled(ids.map(async (fileId) => {
        const response = await getPrivateFileMetadata(fileId, readParams())
        return [fileId, response.file]
      }))
      fileMetadata.value = Object.fromEntries(
        results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
      )
    }

    const loadRecord = async () => {
      loading.value = true
      try {
        const response = await getTransportRecord(recordId.value, readParams())
        record.value = response.transportRecord || null
        await Promise.allSettled([loadOrgLabels(), loadMetadata()])
      } catch (error) {
        console.error('加载运输详情失败:', error)
      } finally {
        loading.value = false
      }
    }

    onLoad((options) => {
      recordId.value = options?.id || ''
      selectedTeamId.value = options?.teamId || ''
      if (!recordId.value || !userStore.can('report.view')) {
        uni.showToast({ title: '无权限查看运输详情', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadRecord()
    })

    const photoName = (fileId, index) => (
      fileMetadata.value[fileId]?.originalName || `现场照片 ${index + 1}`
    )
    const openPhoto = async (fileId) => {
      if (openingFileId.value) return
      openingFileId.value = fileId
      try {
        let tempFilePath = downloadedFiles.value[fileId]
        if (!tempFilePath) {
          const response = await downloadPrivateFile(fileId, readParams())
          tempFilePath = response.tempFilePath
          downloadedFiles.value = { ...downloadedFiles.value, [fileId]: tempFilePath }
        }
        uni.previewImage({ current: tempFilePath, urls: [tempFilePath] })
      } catch (error) {
        console.error('打开现场照片失败:', error)
      } finally {
        openingFileId.value = ''
      }
    }

    return {
      record,
      loading,
      openingFileId,
      loadFields: TRANSPORT_LOAD_FIELDS,
      displayOrg,
      formatDate,
      photoName,
      openPhoto
    }
  }
}
</script>

<style scoped lang="scss">
.detail-page { min-height: 100vh; background: var(--zl-page-bg, #eef3fb); }
.detail-content { padding-bottom: 24rpx; }
.detail-section { padding: 28rpx 24rpx; margin-bottom: 16rpx; background: #ffffff; }
.summary-section { border-top: 6rpx solid var(--zl-primary, #4096ff); }
.summary-header { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.summary-date { font-size: 34rpx; color: #303133; font-weight: 600; }
.summary-tag { flex-shrink: 0; padding: 6rpx 14rpx; border-radius: 14rpx; background: #eaf3ff; color: var(--zl-primary, #4096ff); font-size: 23rpx; }
.summary-route { display: block; margin-top: 18rpx; color: #606266; font-size: 28rpx; word-break: break-all; }
.section-title { display: block; margin-bottom: 22rpx; color: #303133; font-size: 29rpx; font-weight: 600; }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22rpx; }
.section-heading .section-title { margin-bottom: 0; }
.total-text { color: var(--zl-primary, #4096ff); font-size: 25rpx; }
.info-row, .load-row { min-height: 72rpx; display: flex; align-items: center; justify-content: space-between; gap: 24rpx; border-bottom: 1px solid #ebeef5; }
.info-row:last-child, .load-row:last-child { border-bottom: none; }
.label, .load-label { color: #909399; font-size: 24rpx; }
.value, .load-value { flex: 1; min-width: 0; text-align: right; color: #303133; font-size: 25rpx; word-break: break-all; }
.load-value { flex: 0 0 120rpx; }
.photo-count { color: #909399; font-size: 24rpx; }
.photo-row { width: 100%; min-height: 80rpx; box-sizing: border-box; display: flex; align-items: center; margin: 0; padding: 12rpx 0; line-height: 1.4; border-bottom: 1px solid #ebeef5; border-radius: 0; background: #ffffff; text-align: left; }
.photo-row:last-child { border-bottom: none; }
.photo-row::after { border: none; }
.photo-index { width: 48rpx; height: 48rpx; line-height: 48rpx; flex: 0 0 48rpx; border-radius: 50%; background: #eaf3ff; color: var(--zl-primary, #4096ff); font-size: 23rpx; text-align: center; }
.photo-name { flex: 1; min-width: 0; margin: 0 20rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #606266; font-size: 24rpx; }
.photo-action { flex-shrink: 0; color: var(--zl-primary, #4096ff); font-size: 24rpx; }
.remark-text { display: block; color: #606266; font-size: 25rpx; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.empty-state { padding: 180rpx 24rpx; text-align: center; color: #909399; font-size: 27rpx; }
</style>
