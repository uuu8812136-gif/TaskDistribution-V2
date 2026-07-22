<template>
  <view class="attendance-page">
    <view class="top-panel">
      <picker mode="date" :value="date" @change="onDateChange">
        <view class="date-picker">{{ date }} <text>〉</text></view>
      </picker>
      <view class="view-tabs">
        <button :class="['tab-button', { active: viewMode === 'records' }]" @click="viewMode = 'records'">
          分部日报
        </button>
        <button :class="['tab-button', { active: viewMode === 'summary' }]" @click="viewMode = 'summary'">
          部门汇总
        </button>
      </view>
    </view>

    <template v-if="viewMode === 'records'">
      <view v-if="records.length" class="record-list">
        <view v-for="record in records" :key="record._id" class="record-card">
          <view class="record-heading">
            <view>
              <text class="record-title">{{ orgName(record.orgUnitId) }}</text>
              <text class="record-date">{{ record.reportDate }}</text>
            </view>
            <text :class="['status-tag', record.reviewStatus === 'REVIEWED' ? 'reviewed' : 'pending']">
              {{ record.reviewStatus === 'REVIEWED' ? '已审核' : '待审核' }}
            </text>
          </view>
          <view class="metric-grid">
            <view><text>编制</text><strong>{{ record.authorizedHeadcount }}</strong></view>
            <view><text>在册</text><strong>{{ record.registeredHeadcount }}</strong></view>
            <view><text>白班实到</text><strong>{{ record.dayShift.actualAttendanceCount }}</strong></view>
            <view><text>夜班实到</text><strong>{{ record.nightShift.actualAttendanceCount }}</strong></view>
          </view>
          <view class="record-foot">
            <text>{{ attendanceSupportText(record.support) }}</text>
            <button
              v-if="canSubmitPermission && record.accessPolicy && record.accessPolicy.editable"
              class="text-button"
              @click="openForm(record._id)"
            >
              编辑
            </button>
          </view>
        </view>
      </view>
      <view v-else-if="!loading" class="empty-state">暂无当日出勤日报</view>
    </template>

    <template v-else>
      <view v-if="summary.missingOrgUnits && summary.missingOrgUnits.length" class="warning-panel error">
        <text class="warning-title">日报未齐</text>
        <text class="warning-text">{{ summary.missingOrgUnits.map((item) => item.name).join('、') }}</text>
      </view>
      <view v-if="summary.dataQuality && summary.dataQuality.status === 'PENDING_CONFIRMATION'" class="warning-panel">
        <text class="warning-title">数据待确认</text>
        <text class="warning-text">当前按七个分部原始行汇总，保留客户模板差异。</text>
      </view>

      <view class="summary-panel">
        <view class="summary-heading">
          <text>部门日汇总</text>
          <text>{{ summary.submissionCount || 0 }}/{{ summary.expectedOrgUnitCount || 0 }} 个分部</text>
        </view>
        <view class="summary-metrics">
          <view><text>编制</text><strong>{{ summary.authorizedHeadcount || 0 }}</strong></view>
          <view><text>在册</text><strong>{{ summary.registeredHeadcount || 0 }}</strong></view>
          <view><text>白班实到</text><strong>{{ summary.dayShift?.actualAttendanceCount || 0 }}</strong></view>
          <view><text>夜班实到</text><strong>{{ summary.nightShift?.actualAttendanceCount || 0 }}</strong></view>
          <view><text>待离职</text><strong>{{ summary.pendingDepartureCount || 0 }}</strong></view>
          <view><text>请假含病假</text><strong>{{ leaveTotal }}</strong></view>
        </view>
      </view>

      <view v-if="summary.support && summary.support.length" class="summary-panel">
        <text class="section-title">帮产情况</text>
        <text v-for="item in summary.support" :key="item.destination" class="support-line">
          {{ attendanceSupportText(item) }}
        </text>
      </view>

      <view v-if="canReview && !summary.review" class="summary-panel review-panel">
        <text class="section-title">考勤员审核</text>
        <textarea v-model="reviewReason" class="reason-field" maxlength="2000" placeholder="审核说明（选填）" />
        <button
          :class="['primary-button', { danger: !summary.isComplete }]"
          :loading="reviewing"
          @click="confirmReview"
        >
          {{ summary.isComplete ? '审核确认并永久锁定' : '检查缺报并发送提醒' }}
        </button>
      </view>

      <view v-if="summary.review" class="summary-panel reviewed-panel">
        <view class="reviewed-heading">
          <view>
            <text class="section-title">最终汇报文字</text>
            <text class="reviewed-time">已审核，数据永久锁定</text>
          </view>
          <button class="copy-button" @click="copyFinalText">复制</button>
        </view>
        <text class="final-text" selectable>{{ summary.review.finalText }}</text>
      </view>
    </template>

    <view v-if="loading" class="loading-state">加载中...</view>
    <button v-if="canSubmit && viewMode === 'records'" class="create-button" @click="openForm('')">+</button>
  </view>
</template>

<script>
import { computed, onUnmounted, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import {
  getAttendanceDailySummary,
  getAttendanceOptions,
  getAttendanceSubmissions,
  reviewAttendanceDailySummary
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  attendanceSupportText,
  businessNaturalDate,
  scopedReportingParams
} from '@/utils/reporting.js'
import { createLatestRequestGate } from '@/utils/latestRequest.js'

export default {
  name: 'AttendanceReporting',
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const date = ref(businessNaturalDate())
    const viewMode = ref('records')
    const records = ref([])
    const summary = ref({})
    const orgUnits = ref([])
    const policy = ref({})
    const loading = ref(false)
    const reviewing = ref(false)
    const reviewReason = ref('')
    const requestGate = createLatestRequestGate()
    let hasShown = false

    const canSubmitPermission = computed(() => userStore.can('report.submit', {
      write: true,
      teamRequired: true
    }))
    const canSubmit = computed(() => canSubmitPermission.value && policy.value.canCreate === true)
    const canReview = computed(() => (
      userStore.can('report.review', { write: true, teamRequired: true }) &&
      policy.value.isOfficer === true
    ))
    const leaveTotal = computed(() => (
      Number(summary.value.dayShift?.leaveWithSickCount || 0) +
      Number(summary.value.nightShift?.leaveWithSickCount || 0)
    ))

    const orgName = (orgUnitId) => (
      orgUnits.value.find((item) => item._id === orgUnitId)?.name ||
      userStore.context?.orgUnit?.name ||
      `组织 ${String(orgUnitId || '').slice(-6)}`
    )

    const loadData = async () => {
      const request = requestGate.begin({
        teamId: selectedTeamId.value,
        date: date.value
      })
      const params = (extra = {}) => scopedReportingParams(
        userStore.mode,
        request.teamId,
        extra
      )
      loading.value = true
      try {
        const [optionsResponse, recordsResponse, summaryResponse] = await Promise.all([
          getAttendanceOptions(params()),
          getAttendanceSubmissions(params({ date: request.date, page: 1, pageSize: 200 })),
          getAttendanceDailySummary(params({ date: request.date }))
        ])
        if (!requestGate.isCurrent(request)) return
        orgUnits.value = optionsResponse.orgUnits || []
        policy.value = optionsResponse.attendancePolicy || {}
        records.value = recordsResponse.attendanceSubmissions || []
        summary.value = summaryResponse.attendanceSummary || {}
      } catch (error) {
        if (requestGate.isCurrent(request)) console.error('加载出勤日报失败:', error)
      } finally {
        if (requestGate.isCurrent(request)) {
          loading.value = false
          uni.stopPullDownRefresh()
        }
      }
    }

    onLoad((options) => {
      selectedTeamId.value = options?.teamId || ''
      if (/^\d{4}-\d{2}-\d{2}$/.test(options?.reportDate || '')) {
        date.value = options.reportDate
      }
      if (!userStore.can('report.view')) {
        uni.showToast({ title: '无权限查看出勤日报', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadData()
    })
    onPullDownRefresh(loadData)
    onUnmounted(() => requestGate.invalidate())
    onShow(() => {
      if (hasShown) loadData()
      else hasShown = true
    })

    const onDateChange = (event) => {
      date.value = event.detail.value
      loadData()
    }
    const openForm = (id) => {
      const query = id ? `?id=${encodeURIComponent(id)}` : ''
      uni.navigateTo({ url: `/pages/reporting/attendance-form${query}` })
    }
    const showConfirm = (content) => new Promise((resolve) => {
      uni.showModal({
        title: summary.value.isComplete ? '审核确认' : '缺报提醒',
        content,
        confirmText: summary.value.isComplete ? '确认审核' : '发送提醒',
        success: ({ confirm }) => resolve(confirm),
        fail: () => resolve(false)
      })
    })
    const confirmReview = async () => {
      const content = summary.value.isComplete
        ? '审核后七个分部当日数据将永久锁定，不能退回、重开或再次修改。'
        : '日报未齐，系统会阻止审核并向缺报提报人和考勤员发送站内提醒。'
      if (!await showConfirm(content)) return
      reviewing.value = true
      try {
        const result = await reviewAttendanceDailySummary(date.value, {
          reason: reviewReason.value.trim() || null
        })
        uni.showToast({ title: result.idempotent ? '该日报已审核' : '审核完成', icon: 'success' })
        reviewReason.value = ''
      } catch (error) {
        console.error('出勤审核失败:', error)
      } finally {
        reviewing.value = false
        await loadData()
      }
    }
    const copyFinalText = () => {
      const text = summary.value.review?.finalText || ''
      if (!text) return
      uni.setClipboardData({ data: text })
    }

    return {
      date,
      viewMode,
      records,
      summary,
      loading,
      reviewing,
      reviewReason,
      canSubmitPermission,
      canSubmit,
      canReview,
      leaveTotal,
      attendanceSupportText,
      orgName,
      onDateChange,
      openForm,
      confirmReview,
      copyFinalText
    }
  }
}
</script>

<style scoped lang="scss">
.attendance-page { min-height: 100vh; box-sizing: border-box; padding: 20rpx 24rpx 150rpx; background: var(--zl-page-bg, #eef3fb); }
.top-panel, .summary-panel, .record-card, .warning-panel { background: rgba(255,255,255,.97); border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 16rpx; box-shadow: 0 8rpx 28rpx rgba(15,23,42,.05); }
.top-panel { padding: 20rpx; margin-bottom: 20rpx; }
.date-picker { height: 76rpx; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; padding: 0 22rpx; background: #f5f8fc; border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 12rpx; font-size: 27rpx; color: #303133; }
.view-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 12rpx; margin-top: 16rpx; }
.tab-button { height: 72rpx; line-height: 72rpx; margin: 0; padding: 0; border-radius: 10rpx; background: #f5f8fc; color: #64748b; font-size: 25rpx; }
.tab-button::after, .text-button::after, .primary-button::after, .copy-button::after, .create-button::after { border: none; }
.tab-button.active { background: #4096ff; color: #fff; }
.record-card { padding: 24rpx; margin-bottom: 18rpx; border-left: 6rpx solid #4096ff; }
.record-heading, .summary-heading, .reviewed-heading, .record-foot { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.record-title { display: block; font-size: 29rpx; font-weight: 600; color: #303133; }
.record-date, .reviewed-time { display: block; margin-top: 6rpx; font-size: 22rpx; color: #909399; }
.status-tag { flex-shrink: 0; padding: 6rpx 14rpx; border-radius: 8rpx; font-size: 22rpx; }
.status-tag.reviewed { background: #ecf9f0; color: #36a269; }
.status-tag.pending { background: #f3f4f6; color: #64748b; }
.metric-grid, .summary-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16rpx; margin-top: 22rpx; }
.metric-grid view, .summary-metrics view { padding: 16rpx; background: #f5f8fc; border-radius: 10rpx; }
.metric-grid text, .summary-metrics text { display: block; font-size: 22rpx; color: #909399; }
.metric-grid strong, .summary-metrics strong { display: block; margin-top: 6rpx; font-size: 31rpx; color: #303133; }
.record-foot { padding-top: 18rpx; margin-top: 20rpx; border-top: 1px solid #ebeef5; color: #64748b; font-size: 23rpx; }
.text-button, .copy-button { width: auto; height: 60rpx; line-height: 60rpx; margin: 0; padding: 0 20rpx; background: transparent; color: #4096ff; font-size: 24rpx; }
.warning-panel { padding: 20rpx 22rpx; margin-bottom: 18rpx; border-left: 6rpx solid #e6a23c; }
.warning-panel.error { border-left-color: #f56c6c; }
.warning-title, .warning-text { display: block; }
.warning-title { font-size: 26rpx; font-weight: 600; color: #7a4b00; }
.warning-panel.error .warning-title { color: #c45656; }
.warning-text { margin-top: 8rpx; font-size: 23rpx; line-height: 1.55; color: #606266; }
.summary-panel { padding: 24rpx; margin-bottom: 18rpx; }
.summary-heading { font-size: 26rpx; color: #64748b; }
.summary-heading text:first-child, .section-title { font-size: 29rpx; font-weight: 600; color: #303133; }
.support-line { display: block; padding: 14rpx 0; border-bottom: 1px solid #ebeef5; font-size: 25rpx; color: #606266; }
.support-line:last-child { border-bottom: none; }
.reason-field { width: 100%; min-height: 128rpx; box-sizing: border-box; margin-top: 18rpx; padding: 18rpx; background: #f5f8fc; border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 10rpx; font-size: 25rpx; }
.primary-button { height: 80rpx; line-height: 80rpx; margin: 20rpx 0 0; border-radius: 12rpx; background: #4096ff; color: #fff; font-size: 27rpx; }
.primary-button.danger { background: #e5484d; }
.final-text { display: block; margin-top: 20rpx; padding: 20rpx; background: #f5f8fc; border-radius: 10rpx; white-space: pre-wrap; font-size: 25rpx; line-height: 1.75; color: #303133; }
.empty-state, .loading-state { padding: 140rpx 0; text-align: center; color: #909399; font-size: 27rpx; }
.create-button { position: fixed; right: 36rpx; bottom: calc(36rpx + env(safe-area-inset-bottom)); width: 96rpx; height: 96rpx; line-height: 1; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: #4096ff; color: #fff; box-shadow: 0 10rpx 28rpx rgba(64,150,255,.32); font-size: 56rpx; font-weight: 300; }
</style>
