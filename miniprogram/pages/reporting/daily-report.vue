<template>
  <view class="daily-report-page">
    <view class="control-panel">
      <picker mode="date" :value="date" @change="onDateChange">
        <view class="date-row">
          <text class="field-label">日报日期</text>
          <text class="field-value">{{ date }} 〉</text>
        </view>
      </picker>
      <picker
        v-if="report && versionOptions.length"
        :range="versionOptions"
        range-key="label"
        :value="versionIndex"
        @change="onVersionChange"
      >
        <view class="date-row version-row">
          <text class="field-label">日报版本</text>
          <text class="field-value">{{ versionOptions[versionIndex]?.label || '-' }} 〉</text>
        </view>
      </picker>
      <view class="action-row">
        <button v-if="canGenerate" class="primary-button" :loading="generating" @click="generate">
          生成日报
        </button>
        <button class="secondary-button" :disabled="!report" @click="copyText">复制文字</button>
      </view>
    </view>

    <view v-if="generationBlock" class="warning-panel">
      <text class="warning-title">暂不能生成</text>
      <text class="warning-text">{{ generationBlock }}</text>
    </view>

    <view v-if="report" class="report-panel">
      <view class="report-heading">
        <text class="version-tag">v{{ report.version }}</text>
        <view class="report-meta">
          <text>{{ report.generatedByName }}</text>
          <text>{{ formatTime(report.generatedAt) }}</text>
        </view>
      </view>
      <text class="final-text" selectable user-select>{{ report.finalText }}</text>
    </view>
    <view v-else-if="!loading" class="empty-state">该日期尚未生成生产日报</view>

    <view v-if="report" class="source-panel">
      <text class="section-title">来源追溯</text>
      <view class="source-row"><text>生成规则</text><text>{{ sourceSummary.ruleVersion }}</text></view>
      <view class="source-row"><text>今日出勤审核</text><text>{{ shortId(sourceSummary.currentReviewId) }}</text></view>
      <view class="source-row"><text>昨日出勤审核</text><text>{{ shortId(sourceSummary.previousReviewId) }}</text></view>
      <view class="source-row"><text>出勤来源</text><text>{{ sourceSummary.attendanceRecordCount }} 条</text></view>
      <view class="source-row"><text>排产来源</text><text>{{ sourceSummary.productionScheduleCount }} 条</text></view>
      <view class="source-row months-row">
        <text>排产月份</text>
        <text>{{ sourceSummary.requiredMonths.join('、') || '-' }}</text>
      </view>
      <view class="fingerprint-row">
        <text>来源指纹</text>
        <text selectable user-select>{{ report.sourceFingerprint }}</text>
      </view>
    </view>

    <view class="history-panel">
      <text class="section-title">生成记录</text>
      <view v-for="item in reports" :key="item._id" class="history-row" @click="openRecord(item)">
        <view>
          <text class="history-date">{{ item.reportDate }}</text>
          <text class="history-meta">{{ item.generatedByName }} · {{ formatTime(item.generatedAt) }}</text>
        </view>
        <text class="history-version">v{{ item.version }} 〉</text>
      </view>
      <text v-if="!reports.length && !loading" class="history-empty">暂无生成记录</text>
    </view>

    <view v-if="loading" class="loading-state">加载中...</view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app'
import {
  generateDailyReport,
  getGeneratedDailyReport,
  getGeneratedDailyReports
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  businessNaturalDate,
  dailyReportSourceSummary,
  scopedReportingParams
} from '@/utils/reporting.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'

export default {
  name: 'GeneratedDailyReport',
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const date = ref(businessNaturalDate())
    const report = ref(null)
    const reports = ref([])
    const selectedVersion = ref(null)
    const loading = ref(false)
    const generating = ref(false)
    const generationBlock = ref('')

    const canGenerate = computed(() => userStore.can('report.daily.generate', {
      write: true,
      teamRequired: true
    }))
    const sourceSummary = computed(() => dailyReportSourceSummary(report.value || {}))
    const versionOptions = computed(() => (report.value?.availableVersions || []).map((item) => ({
      ...item,
      label: `版本 ${item.version}`
    })))
    const versionIndex = computed(() => Math.max(
      0,
      versionOptions.value.findIndex((item) => item.version === selectedVersion.value)
    ))
    const readParams = (extra = {}) => scopedReportingParams(
      userStore.mode,
      selectedTeamId.value,
      extra
    )

    const formatTime = (value) => {
      if (!value) return '-'
      const source = String(value)
      const parsed = new Date(source.includes('T') ? source : source.replace(/-/g, '/'))
      if (Number.isNaN(parsed.getTime())) return '-'
      const pad = (item) => String(item).padStart(2, '0')
      return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
    }
    const shortId = (value) => value ? `…${String(value).slice(-8)}` : '-'
    const blockMessage = (error) => {
      const code = error?.data?.code || error?.response?.data?.code || error?.code
      if (code === 'DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED') return '今日或昨日出勤尚未完成审核。'
      if (code === 'DAILY_REPORT_ATTENDANCE_INCOMPLETE') return '出勤审核未包含完整七个分部。'
      if (code === 'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING') return '已审核出勤来源记录不完整。'
      if (code === 'DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED') return '今日、昨日或累计口径所需排产尚未维护完整。'
      if (code === 'DAILY_REPORT_VERSION_LIMIT_REACHED') return '该日期已达到 50 个版本，已禁止继续生成。'
      return requestErrorMessage(error, '生产日报生成失败。')
    }

    const loadList = async () => {
      const response = await getGeneratedDailyReports(readParams({ page: 1, pageSize: 30 }))
      reports.value = response.dailyReports || []
    }
    const loadDate = async () => {
      generationBlock.value = ''
      selectedVersion.value = null
      const matches = await getGeneratedDailyReports(readParams({
        dateFrom: date.value,
        dateTo: date.value,
        page: 1,
        pageSize: 1
      }))
      if (!matches.dailyReports?.length) {
        report.value = null
        return
      }
      const response = await getGeneratedDailyReport(date.value, readParams())
      report.value = response.dailyReport
      selectedVersion.value = response.dailyReport.version
    }
    const loadData = async () => {
      loading.value = true
      try {
        await Promise.all([loadList(), loadDate()])
      } catch (error) {
        console.error('加载生产日报失败:', error)
      } finally {
        loading.value = false
        uni.stopPullDownRefresh()
      }
    }

    onLoad((options) => {
      selectedTeamId.value = options?.teamId || ''
      if (!userStore.can('report.view')) {
        uni.showToast({ title: '无权限查看生产日报', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadData()
    })
    onPullDownRefresh(loadData)

    const onDateChange = (event) => {
      date.value = event.detail.value
      loadDate()
    }
    const onVersionChange = async (event) => {
      const version = versionOptions.value[Number(event.detail.value)]?.version
      if (!version) return
      loading.value = true
      try {
        const response = await getGeneratedDailyReport(date.value, readParams({ version }))
        report.value = response.dailyReport
        selectedVersion.value = version
      } finally {
        loading.value = false
      }
    }
    const generate = async () => {
      generationBlock.value = ''
      generating.value = true
      try {
        const result = await generateDailyReport(date.value)
        report.value = result.dailyReport
        selectedVersion.value = result.dailyReport.version
        uni.showToast({
          title: result.idempotent ? '来源未变化' : `已生成v${result.dailyReport.version}`,
          icon: 'success'
        })
        await loadList()
      } catch (error) {
        generationBlock.value = blockMessage(error)
      } finally {
        generating.value = false
      }
    }
    const copyText = () => {
      if (!report.value?.finalText) return
      uni.setClipboardData({ data: report.value.finalText })
    }
    const openRecord = (item) => {
      date.value = item.reportDate
      loadDate()
      uni.pageScrollTo({ scrollTop: 0, duration: 200 })
    }

    return {
      date,
      report,
      reports,
      loading,
      generating,
      generationBlock,
      canGenerate,
      sourceSummary,
      versionOptions,
      versionIndex,
      formatTime,
      shortId,
      onDateChange,
      onVersionChange,
      generate,
      copyText,
      openRecord
    }
  }
}
</script>

<style scoped lang="scss">
.daily-report-page { min-height: 100vh; box-sizing: border-box; padding: 20rpx 24rpx 120rpx; background: var(--zl-page-bg, #eef3fb); }
.control-panel, .report-panel, .source-panel, .history-panel, .warning-panel { background: rgba(255,255,255,.97); border: 1px solid var(--zl-border, rgba(100,116,139,.18)); border-radius: 16rpx; box-shadow: 0 8rpx 28rpx rgba(15,23,42,.05); }
.control-panel, .report-panel, .source-panel, .history-panel { padding: 24rpx; margin-bottom: 20rpx; }
.date-row { min-height: 74rpx; display: flex; align-items: center; justify-content: space-between; gap: 20rpx; }
.version-row { border-top: 1px solid #ebeef5; }
.field-label { color: #64748b; font-size: 26rpx; }
.field-value { color: #1f2733; font-size: 28rpx; }
.action-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16rpx; margin-top: 18rpx; }
.action-row button { height: 76rpx; line-height: 76rpx; margin: 0; border-radius: 8rpx; font-size: 28rpx; }
.primary-button { color: #fff; background: var(--zl-primary, #4096ff); }
.secondary-button { color: var(--zl-primary, #4096ff); background: #fff; border: 1px solid var(--zl-primary, #4096ff); }
.warning-panel { padding: 20rpx 24rpx; margin-bottom: 20rpx; border-left: 6rpx solid #e6a23c; }
.warning-title { display: block; color: #b88230; font-size: 28rpx; font-weight: 600; }
.warning-text { display: block; margin-top: 8rpx; color: #7c6845; font-size: 25rpx; line-height: 1.6; }
.report-heading { display: flex; align-items: center; gap: 18rpx; padding-bottom: 18rpx; border-bottom: 1px solid #ebeef5; }
.version-tag { padding: 6rpx 12rpx; color: #1677ff; background: #eaf3ff; border-radius: 6rpx; font-size: 24rpx; }
.report-meta { min-width: 0; display: flex; flex-direction: column; color: #64748b; font-size: 23rpx; line-height: 1.5; }
.final-text { display: block; margin-top: 20rpx; color: #1f2733; font-size: 27rpx; line-height: 1.85; white-space: pre-wrap; word-break: break-word; }
.section-title { display: block; margin-bottom: 16rpx; color: #1f2733; font-size: 30rpx; font-weight: 600; }
.source-row { min-height: 66rpx; display: grid; grid-template-columns: 180rpx minmax(0, 1fr); align-items: center; gap: 12rpx; border-top: 1px solid #ebeef5; font-size: 25rpx; }
.source-row > text:first-child, .fingerprint-row > text:first-child { color: #64748b; }
.source-row > text:last-child { min-width: 0; color: #1f2733; text-align: right; word-break: break-all; }
.months-row { align-items: start; padding: 16rpx 0; }
.fingerprint-row { padding-top: 16rpx; border-top: 1px solid #ebeef5; font-size: 24rpx; }
.fingerprint-row text { display: block; }
.fingerprint-row text:last-child { margin-top: 8rpx; color: #475569; word-break: break-all; }
.history-row { min-height: 94rpx; display: flex; align-items: center; justify-content: space-between; gap: 16rpx; border-top: 1px solid #ebeef5; }
.history-row > view { min-width: 0; }
.history-date { display: block; color: #1f2733; font-size: 27rpx; }
.history-meta { display: block; margin-top: 6rpx; color: #94a3b8; font-size: 22rpx; }
.history-version { flex: 0 0 auto; color: #4096ff; font-size: 25rpx; }
.history-empty, .empty-state, .loading-state { display: block; padding: 100rpx 0; color: #909399; text-align: center; font-size: 26rpx; }
</style>
