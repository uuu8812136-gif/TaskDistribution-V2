<template>
  <view class="record-detail-page">
    <view v-if="!canView" class="state-band">
      <text class="state-title">无设备查看权限</text>
      <text class="state-copy">请联系当前项目团队管理员开通设备模块权限。</text>
    </view>

    <view v-else-if="!queryContextReady" class="state-band">
      <text class="state-title">记录参数不完整</text>
      <text class="state-copy">请返回执行记录列表后重新打开。</text>
    </view>

    <view v-else-if="loading" class="state-band">
      <text class="state-title">正在加载执行记录</text>
      <text class="state-copy">请稍候。</text>
    </view>

    <view v-else-if="errorMessage && !record" class="state-band error-state">
      <text class="state-title">记录加载失败</text>
      <text class="state-copy">{{ errorMessage }}</text>
      <button class="retry-button" @click="load">重新加载</button>
    </view>

    <template v-else-if="record">
      <view v-if="fallbackNotice" class="notice-band">{{ fallbackNotice }}</view>

      <view class="summary-band">
        <view class="summary-heading">
          <view class="summary-copy">
            <text class="summary-type">{{ routineTypeLabel(record.routineType) }}执行记录</text>
            <text class="summary-name">{{ equipment.name || '设备' }}</text>
            <text class="summary-code">{{ equipment.assetCode || '-' }}</text>
          </view>
          <text class="result-tag" :class="`result-${resultTone(record.overallResult)}`">
            {{ resultLabel(record.overallResult) }}
          </text>
        </view>
        <view class="summary-grid">
          <view><text>车牌号</text><strong>{{ routineRecordPlateNumber(record) }}</strong></view>
          <view><text>所属部门</text><strong>{{ record.orgUnit?.name || '-' }}</strong></view>
          <view><text>执行规则</text><strong>{{ routineRecordRuleName(record) }}</strong></view>
          <view><text>规则版本</text><strong>{{ record.ruleVersion ? `V${record.ruleVersion}` : '-' }}</strong></view>
          <view><text>执行人</text><strong>{{ routineRecordOperatorName(record) }}</strong></view>
          <view><text>执行运行小时</text><strong>{{ runtimeHoursLabel(record.performedRuntimeHours) }}</strong></view>
        </view>
        <view v-if="ruleSchedule" class="rule-description">
          <text>执行周期</text>
          <strong>{{ ruleSchedule }}</strong>
        </view>
      </view>

      <view class="section-heading">
        <text>对应计划</text>
        <text class="section-count">{{ record.planId ? '已关联' : '未关联' }}</text>
      </view>
      <view class="section-band plan-grid">
        <view><text>计划开始</text><strong>{{ displayTime(routineRecordPlanStart(record)) }}</strong></view>
        <view><text>计划截止</text><strong>{{ displayTime(routineRecordPlanDue(record)) }}</strong></view>
        <view><text>计划窗口</text><strong>{{ record.planWindowName || record.plan?.windowName || '-' }}</strong></view>
        <view><text>计划周期标识</text><strong>{{ record.planCycleKey || record.plan?.cycleKey || '-' }}</strong></view>
        <view><text>实际执行</text><strong>{{ displayTime(record.performedAt || record.createdAt) }}</strong></view>
        <view><text>关联计划编号</text><strong>{{ record.planId || '历史手动执行' }}</strong></view>
      </view>

      <view class="section-heading">
        <text>逐项结果</text>
        <text class="section-count">{{ itemResults.length }} 项</text>
      </view>
      <view class="section-band item-list">
        <view v-for="(item, index) in itemResults" :key="item.itemKey || index" class="item-row">
          <view class="item-heading">
            <text class="item-name">{{ item.itemName || routineRecordItemName(record, item, index) }}</text>
            <text class="item-result" :class="`item-${itemResultTone(item.result)}`">
              {{ itemResultLabel(item.result) }}
            </text>
          </view>
          <text v-if="item.itemDescription || itemDescription(item)" class="item-description">{{ item.itemDescription || itemDescription(item) }}</text>
          <view class="item-note">
            <text>备注</text>
            <strong>{{ item.note || '无' }}</strong>
          </view>
        </view>
        <view v-if="itemResults.length === 0" class="empty-section">该历史记录没有逐项结果</view>
      </view>

      <template v-if="showAbnormalSection">
        <view class="section-heading">
          <text>异常情况</text>
          <text class="section-count">{{ routineRecordAbnormalCount(record) }} 项异常</text>
        </view>
        <view class="section-band abnormal-band">
          <view><text>异常汇总</text><strong>{{ record.abnormalSummary || '未填写' }}</strong></view>
          <view><text>处理状态</text><strong>{{ exceptionStatusLabel(record.exception?.status) }}</strong></view>
          <view v-if="record.exception?.currentStage"><text>当前阶段</text><strong>{{ exceptionStageLabel(record.exception.currentStage) }}</strong></view>
        </view>
      </template>

      <view class="section-heading">
        <text>现场照片</text>
        <text class="section-count">{{ photos.length }} 张</text>
      </view>
      <view class="section-band photo-list">
        <view v-for="(photo, index) in photos" :key="photo.fileId" class="photo-row">
          <view class="photo-heading">
            <view class="photo-copy">
              <text class="photo-name">现场照片 {{ index + 1 }}</text>
              <text class="photo-meta">拍摄时间：{{ displayTime(photo.capturedAt) }}</text>
              <text class="photo-meta">定位状态：{{ locationStatusLabel(photo.locationStatus) }}</text>
              <text v-if="photo.address" class="photo-meta">地点：{{ photo.address }}</text>
            </view>
            <button
              class="preview-button"
              :loading="previewingFileId === photo.fileId"
              :disabled="Boolean(previewingFileId)"
              @click="previewPhoto(photo)"
            >查看</button>
          </view>
          <text v-if="photo.watermarkText" class="watermark-copy">水印：{{ photo.watermarkText }}</text>
        </view>
        <view v-if="photos.length === 0" class="empty-section">该记录没有现场照片</view>
      </view>
    </template>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { downloadPrivateFile, getEquipmentRoutineRecord } from '@/api/index.js'
import { routineTypeLabel, scheduleDescription } from '@/utils/equipment.js'
import { formatDate } from '@/utils/format.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import {
  readCachedRoutineRecord,
  routineRecordAbnormalCount,
  routineRecordEquipment,
  routineRecordItemRows,
  routineRecordItemName,
  routineRecordOperatorName,
  routineRecordPhotos,
  routineRecordPlanDue,
  routineRecordPlanStart,
  routineRecordPlateNumber,
  routineRecordRule,
  routineRecordRuleName
} from '@/utils/equipmentRoutineRecords.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRoutineRecordDetail',
  setup() {
    const userStore = useUserStore()
    const recordId = ref('')
    const equipmentId = ref('')
    const teamId = ref('')
    const record = ref(null)
    const loading = ref(false)
    const errorMessage = ref('')
    const fallbackNotice = ref('')
    const previewingFileId = ref('')
    const downloadedPhotos = ref({})
    let requestVersion = 0

    const canView = computed(() => userStore.hasPermission('equipment.view'))
    const queryContextReady = computed(() => (
      Boolean(recordId.value) && (!userStore.isGlobalReadOnly || Boolean(teamId.value))
    ))
    const requestTeamId = () => userStore.isGlobalReadOnly ? teamId.value : ''
    const cacheScopeTeamId = () => requestTeamId() || userStore.activeTeamId || ''
    const requestParams = () => requestTeamId() ? { teamId: requestTeamId() } : {}
    const equipment = computed(() => routineRecordEquipment(record.value))
    const rule = computed(() => routineRecordRule(record.value))
    const itemResults = computed(() => routineRecordItemRows(record.value))
    const photos = computed(() => routineRecordPhotos(record.value))
    const ruleSchedule = computed(() => rule.value?.schedule ? scheduleDescription(rule.value.schedule) : '')
    const showAbnormalSection = computed(() => (
      record.value?.overallResult === 'ABNORMAL' ||
      Boolean(record.value?.abnormalSummary) ||
      Boolean(record.value?.exception)
    ))

    const load = async () => {
      if (!canView.value || !queryContextReady.value || loading.value) return
      const version = ++requestVersion
      loading.value = true
      errorMessage.value = ''
      fallbackNotice.value = ''
      try {
        const result = await getEquipmentRoutineRecord(
          recordId.value,
          requestParams(),
          { showLoading: false, silentError: true }
        )
        if (version !== requestVersion) return
        const nextRecord = result?.record || result
        const actualEquipmentId = String(nextRecord?.equipmentId?._id || nextRecord?.equipmentId || nextRecord?.equipment?._id || '')
        if (!nextRecord?._id || (equipmentId.value && actualEquipmentId && actualEquipmentId !== equipmentId.value)) {
          throw new TypeError('执行记录详情响应不完整')
        }
        record.value = nextRecord
      } catch (error) {
        if (version !== requestVersion) return
        const routeUnavailable = [404, 405].includes(Number(error?.statusCode)) &&
          !String(error?.code || '').trim()
        const cached = routeUnavailable
          ? readCachedRoutineRecord(recordId.value, {
              teamId: cacheScopeTeamId(),
              cacheIdentity: userStore.cacheIdentity
            })
          : null
        if (cached) {
          record.value = cached
          fallbackNotice.value = '当前显示刚才列表中的记录；服务更新完成后可刷新获取最新详情。'
        } else {
          record.value = null
          errorMessage.value = requestErrorMessage(error, '执行记录详情暂时无法加载')
        }
      } finally {
        if (version === requestVersion) loading.value = false
      }
    }

    const displayTime = (value) => formatDate(value, 'YYYY-MM-DD HH:mm') || '-'
    const resultLabel = (value) => ({ NORMAL: '正常', COMPLETED: '已完成', ABNORMAL: '异常' }[value] || value || '-')
    const resultTone = (value) => value === 'ABNORMAL' ? 'danger' : 'success'
    const itemResultLabel = (value) => ({
      NORMAL: '正常',
      COMPLETED: '已完成',
      ABNORMAL: '异常',
      SKIPPED: '不适用',
      UNRECORDED: '未记录'
    }[value] || value || '-')
    const itemResultTone = (value) => ({
      ABNORMAL: 'danger',
      SKIPPED: 'muted',
      UNRECORDED: 'muted'
    }[value] || 'success')
    const itemDescription = (item) => rule.value.checklistItems?.find((entry) => (
      entry?.key === item?.itemKey
    ))?.description || ''
    const runtimeHoursLabel = (value) => value === null || value === undefined ? '-' : `${value} h`
    const exceptionStatusLabel = (value) => ({
      OPEN: '处理中',
      RESOLVED: '已解决',
      CLOSED: '已关闭'
    }[value] || value || '无异常流程')
    const exceptionStageLabel = (value) => ({
      TEAM_LEADER: '班组长处理',
      SUB_DEPARTMENT_MANAGER: '分部负责人处理',
      ASSET_ADMIN: '设备管理员处理',
      RESOLVED: '已解决'
    }[value] || value || '-')
    const locationStatusLabel = (value) => ({
      GRANTED: '已定位',
      DENIED: '未授权定位',
      UNAVAILABLE: '定位不可用',
      PENDING_CONFIRMATION: '待确认'
    }[value] || value || '未记录')

    const previewPhoto = async (photo) => {
      if (!photo?.fileId || previewingFileId.value) return
      previewingFileId.value = photo.fileId
      try {
        let tempFilePath = downloadedPhotos.value[photo.fileId]
        if (!tempFilePath) {
          const result = await downloadPrivateFile(
            photo.fileId,
            requestParams(),
            { showLoading: false, silentError: true }
          )
          tempFilePath = result.tempFilePath
          downloadedPhotos.value = { ...downloadedPhotos.value, [photo.fileId]: tempFilePath }
        }
        uni.previewImage({ current: tempFilePath, urls: [tempFilePath] })
      } catch (error) {
        uni.showToast({ title: requestErrorMessage(error, '现场照片暂时无法打开'), icon: 'none' })
      } finally {
        previewingFileId.value = ''
      }
    }

    onLoad((options) => {
      recordId.value = String(options.recordId || '')
      equipmentId.value = String(options.equipmentId || '')
      teamId.value = String(options.teamId || '')
      load()
    })
    onUnload(() => { requestVersion += 1 })

    return {
      canView,
      queryContextReady,
      record,
      loading,
      errorMessage,
      fallbackNotice,
      previewingFileId,
      equipment,
      ruleSchedule,
      itemResults,
      photos,
      showAbnormalSection,
      load,
      previewPhoto,
      displayTime,
      resultLabel,
      resultTone,
      itemResultLabel,
      itemResultTone,
      itemDescription,
      runtimeHoursLabel,
      exceptionStatusLabel,
      exceptionStageLabel,
      locationStatusLabel,
      routineTypeLabel,
      routineRecordRuleName,
      routineRecordPlateNumber,
      routineRecordOperatorName,
      routineRecordPlanStart,
      routineRecordPlanDue,
      routineRecordAbnormalCount,
      routineRecordItemName
    }
  }
}
</script>

<style scoped lang="scss">
.record-detail-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.summary-band, .section-band, .state-band, .notice-band { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.notice-band { margin-bottom: 20rpx; padding: 18rpx 22rpx; color: #7a4b00; background: #fff8e6; border-color: #efd493; font-size: 22rpx; line-height: 1.55; }
.summary-band { padding: 24rpx; border-top: 6rpx solid #1677ff; }
.summary-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.summary-copy { min-width: 0; flex: 1; }
.summary-type, .summary-name, .summary-code { display: block; overflow-wrap: anywhere; }
.summary-type { color: #1d5fa7; font-size: 21rpx; font-weight: 600; }
.summary-name { margin-top: 6rpx; color: #1f2733; font-size: 33rpx; font-weight: 700; }
.summary-code { margin-top: 6rpx; color: #64748b; font-size: 23rpx; }
.result-tag { flex: 0 0 auto; padding: 8rpx 13rpx; border-radius: 8rpx; font-size: 21rpx; }
.result-success { color: #245d3f; background: #eaf7ef; }
.result-danger { color: #b42318; background: #feeceb; }
.summary-grid, .plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx 26rpx; }
.summary-grid { margin-top: 22rpx; padding-top: 20rpx; border-top: 1px solid #e8edf3; }
.summary-grid text, .summary-grid strong, .plan-grid text, .plan-grid strong, .abnormal-band text, .abnormal-band strong, .rule-description text, .rule-description strong { display: block; overflow-wrap: anywhere; }
.summary-grid text, .plan-grid text, .abnormal-band text, .rule-description text { color: #64748b; font-size: 21rpx; }
.summary-grid strong, .plan-grid strong, .abnormal-band strong, .rule-description strong { margin-top: 6rpx; color: #1f2733; font-size: 24rpx; font-weight: 600; }
.rule-description { margin-top: 20rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; margin: 30rpx 0 14rpx; color: #1f2733; font-size: 29rpx; font-weight: 600; }
.section-count { color: #64748b; font-size: 22rpx; font-weight: 400; }
.section-band { overflow: hidden; }
.plan-grid { padding: 24rpx; }
.item-row, .photo-row { padding: 22rpx 24rpx; border-bottom: 1px solid #e8edf3; }
.item-row:last-child, .photo-row:last-child { border-bottom: 0; }
.item-heading, .photo-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.item-name { min-width: 0; flex: 1; color: #1f2733; font-size: 27rpx; font-weight: 600; overflow-wrap: anywhere; }
.item-result { flex: 0 0 auto; padding: 6rpx 11rpx; border-radius: 8rpx; font-size: 20rpx; }
.item-success { color: #245d3f; background: #eaf7ef; }
.item-danger { color: #b42318; background: #feeceb; }
.item-muted { color: #52606d; background: #edf2f7; }
.item-description { display: block; margin-top: 9rpx; color: #64748b; font-size: 22rpx; line-height: 1.55; }
.item-note { margin-top: 14rpx; padding: 14rpx 16rpx; background: #f7f9fc; border-radius: 8rpx; }
.item-note text, .item-note strong { display: block; overflow-wrap: anywhere; }
.item-note text { color: #64748b; font-size: 20rpx; }
.item-note strong { margin-top: 4rpx; color: #1f2733; font-size: 23rpx; font-weight: 500; }
.abnormal-band { padding: 22rpx 24rpx; border-left: 6rpx solid #d92d20; }
.abnormal-band > view + view { margin-top: 18rpx; padding-top: 16rpx; border-top: 1px solid #f0d5d2; }
.photo-copy { min-width: 0; flex: 1; }
.photo-name, .photo-meta { display: block; overflow-wrap: anywhere; }
.photo-name { color: #1f2733; font-size: 26rpx; font-weight: 600; }
.photo-meta { margin-top: 6rpx; color: #64748b; font-size: 21rpx; }
.preview-button { flex: 0 0 130rpx; height: 62rpx; line-height: 62rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #1d5fa7; background: #eaf3ff; font-size: 22rpx; }
.watermark-copy { display: block; margin-top: 14rpx; padding: 12rpx 14rpx; color: #52606d; background: #f7f9fc; border-radius: 8rpx; font-size: 20rpx; line-height: 1.5; overflow-wrap: anywhere; }
.empty-section { padding: 54rpx 24rpx; color: #909399; text-align: center; font-size: 23rpx; }
.state-band { padding: 120rpx 36rpx; text-align: center; }
.state-title, .state-copy { display: block; }
.state-title { color: #1f2733; font-size: 30rpx; font-weight: 600; }
.state-copy { margin-top: 12rpx; color: #64748b; font-size: 23rpx; line-height: 1.6; }
.error-state { border-color: #efc4c0; background: #fffafa; }
.retry-button { width: 220rpx; height: 70rpx; line-height: 70rpx; margin: 24rpx auto 0; border-radius: 8rpx; color: #b42318; background: #fff; border: 1px solid #efc4c0; font-size: 24rpx; }
</style>
