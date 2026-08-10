<template>
  <view class="record-list-page">
    <view v-if="!canView" class="state-band">
      <text class="state-title">无设备查看权限</text>
      <text class="state-copy">请联系当前项目团队管理员开通设备模块权限。</text>
    </view>

    <view v-else-if="!queryContextReady" class="state-band">
      <text class="state-title">缺少查询团队</text>
      <text class="state-copy">请返回设备页面选择项目团队后重新进入。</text>
    </view>

    <template v-else>
      <view class="filter-band">
        <view class="filter-heading">
          <view>
            <text class="filter-title">{{ pageTitle }}</text>
            <text class="filter-hint">{{ selectedTeamName || '当前项目团队' }} · 按计划日期查询</text>
          </view>
          <text class="filter-total">{{ total }} 条</text>
        </view>
        <view class="date-row">
          <picker mode="date" :value="startDate" :disabled="loading" @change="onStartDateChange">
            <view class="date-field">
              <text>开始日期</text>
              <strong>{{ startDate }}</strong>
            </view>
          </picker>
          <text class="date-separator">至</text>
          <picker mode="date" :value="endDate" :disabled="loading" @change="onEndDateChange">
            <view class="date-field">
              <text>结束日期</text>
              <strong>{{ endDate }}</strong>
            </view>
          </picker>
        </view>
        <view class="filter-actions">
          <button class="reset-button" :disabled="loading" @click="resetCurrentMonth">本月</button>
          <button class="query-button" :loading="loading" :disabled="loading" @click="applyFilters">查询</button>
        </view>
      </view>

      <view v-if="errorMessage && records.length === 0" class="state-band error-state">
        <text class="state-title">记录加载失败</text>
        <text class="state-copy">{{ errorMessage }}</text>
        <button class="retry-button" @click="loadRecords(true)">重新加载</button>
      </view>

      <view v-else-if="initialized && !loading && records.length === 0" class="state-band">
        <text class="state-title">暂无{{ pageTitle }}</text>
        <text class="state-copy">当前日期范围内没有该设备的{{ pageTitle }}。</text>
      </view>

      <view v-else class="record-list">
        <view
          v-for="record in records"
          :key="record._id"
          class="record-card"
          @click="openRecord(record)"
        >
          <view class="record-heading">
            <view class="record-copy">
              <text class="record-rule">{{ routineRecordRuleName(record) }}</text>
              <text class="record-equipment">{{ equipmentName(record) }} · {{ equipmentCode(record) }}</text>
            </view>
            <text class="result-tag" :class="`result-${resultTone(record.overallResult)}`">
              {{ resultLabel(record.overallResult) }}
            </text>
          </view>
          <view class="record-grid">
            <view><text>车牌号</text><strong>{{ routineRecordPlateNumber(record) }}</strong></view>
            <view><text>类型</text><strong>{{ routineTypeLabel(record.routineType) }}</strong></view>
            <view><text>计划开始</text><strong>{{ displayTime(routineRecordPlanStart(record)) }}</strong></view>
            <view><text>计划截止</text><strong>{{ displayTime(routineRecordPlanDue(record)) }}</strong></view>
            <view><text>执行时间</text><strong>{{ displayTime(record.performedAt || record.createdAt) }}</strong></view>
            <view><text>异常项目</text><strong>{{ routineRecordAbnormalCount(record) }} 项</strong></view>
          </view>
          <view class="record-footer">
            <text>{{ exceptionLabel(record) }}</text>
            <text class="detail-link">查看逐项结果 〉</text>
          </view>
        </view>
      </view>

      <view v-if="errorMessage && records.length > 0" class="inline-error">
        <text>{{ errorMessage }}</text>
        <button class="inline-retry-button" @click="loadRecords(false)">重试</button>
      </view>

      <view v-if="records.length > 0" class="paging-state">
        <text v-if="loadingMore">正在加载更多记录</text>
        <button v-else-if="hasMore" class="more-button" @click="loadRecords(false)">加载更多</button>
        <text v-else>已显示全部 {{ records.length }} 条</text>
      </view>
    </template>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onReachBottom, onUnload } from '@dcloudio/uni-app'
import { getEquipmentRoutineRecords } from '@/api/index.js'
import { formatDate } from '@/utils/format.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import { routineTypeLabel } from '@/utils/equipment.js'
import {
  cacheRoutineRecord,
  defaultRoutineRecordDateFilters,
  normalizedRoutineType,
  routineRecordAbnormalCount,
  routineRecordDateRange,
  routineRecordEquipment,
  routineRecordPlanDue,
  routineRecordPlanStart,
  routineRecordPlateNumber,
  routineRecordRuleName
} from '@/utils/equipmentRoutineRecords.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRoutineRecordList',
  setup() {
    const userStore = useUserStore()
    const equipmentId = ref('')
    const routineType = ref('')
    const teamId = ref('')
    const startDate = ref('')
    const endDate = ref('')
    const records = ref([])
    const page = ref(0)
    const pageSize = 20
    const total = ref(0)
    const loading = ref(false)
    const loadingMore = ref(false)
    const initialized = ref(false)
    const errorMessage = ref('')
    let requestVersion = 0

    const canView = computed(() => userStore.hasPermission('equipment.view'))
    const queryContextReady = computed(() => (
      Boolean(equipmentId.value && routineType.value) &&
      (!userStore.isGlobalReadOnly || Boolean(teamId.value))
    ))
    const pageTitle = computed(() => routineType.value === 'MAINTENANCE' ? '保养记录' : '点检记录')
    const selectedTeamName = computed(() => (
      userStore.teams?.find((team) => team._id === teamId.value)?.name || ''
    ))
    const hasMore = computed(() => records.value.length < total.value)
    const requestTeamId = () => userStore.isGlobalReadOnly ? teamId.value : ''
    const cacheScopeTeamId = () => requestTeamId() || userStore.activeTeamId || ''
    const requestParams = (targetPage) => ({
      ...(requestTeamId() ? { teamId: requestTeamId() } : {}),
      equipmentId: equipmentId.value,
      routineType: routineType.value,
      dateBasis: 'PLAN',
      ...routineRecordDateRange(startDate.value, endDate.value),
      page: targetPage,
      pageSize
    })

    const loadRecords = async (reset = true) => {
      if (!canView.value || !queryContextReady.value || loading.value || loadingMore.value) return
      const targetPage = reset ? 1 : page.value + 1
      const version = ++requestVersion
      if (reset) {
        loading.value = true
        errorMessage.value = ''
        records.value = []
        page.value = 0
        total.value = 0
      } else {
        if (!hasMore.value) return
        loadingMore.value = true
      }
      try {
        const result = await getEquipmentRoutineRecords(
          requestParams(targetPage),
          { showLoading: false, silentError: true }
        )
        if (version !== requestVersion) return
        const incoming = result?.records || result?.routineRecords || []
        if (reset) {
          records.value = incoming
        } else {
          const byId = new Map(records.value.map((record) => [record._id, record]))
          for (const record of incoming) byId.set(record._id, record)
          records.value = [...byId.values()]
        }
        page.value = Number(result?.page) || targetPage
        total.value = Number(result?.total ?? records.value.length)
        errorMessage.value = ''
      } catch (error) {
        if (version !== requestVersion) return
        errorMessage.value = requestErrorMessage(error, '执行记录暂时无法加载')
      } finally {
        if (version === requestVersion) {
          loading.value = false
          loadingMore.value = false
          initialized.value = true
        }
      }
    }

    const applyFilters = () => {
      try {
        routineRecordDateRange(startDate.value, endDate.value)
        loadRecords(true)
      } catch (error) {
        uni.showToast({ title: error.message, icon: 'none' })
      }
    }
    const resetCurrentMonth = () => {
      const defaults = defaultRoutineRecordDateFilters()
      startDate.value = defaults.startDate
      endDate.value = defaults.endDate
      loadRecords(true)
    }
    const onStartDateChange = (event) => { startDate.value = event.detail.value }
    const onEndDateChange = (event) => { endDate.value = event.detail.value }
    const equipmentName = (record) => routineRecordEquipment(record).name || '设备'
    const equipmentCode = (record) => routineRecordEquipment(record).assetCode || '-'
    const displayTime = (value) => formatDate(value, 'YYYY-MM-DD HH:mm') || '-'
    const resultLabel = (value) => ({
      NORMAL: '正常',
      COMPLETED: '已完成',
      ABNORMAL: '异常'
    }[value] || value || '-')
    const resultTone = (value) => value === 'ABNORMAL' ? 'danger' : 'success'
    const exceptionLabel = (record) => {
      if (record?.exception?.status === 'OPEN') return '异常处理中'
      if (record?.overallResult === 'ABNORMAL') return '异常已记录'
      return '执行完成'
    }
    const openRecord = (record) => {
      const scopedTeamId = requestTeamId()
      cacheRoutineRecord(record, {
        teamId: cacheScopeTeamId(),
        cacheIdentity: userStore.cacheIdentity
      })
      const query = [
        `recordId=${encodeURIComponent(record._id)}`,
        `equipmentId=${encodeURIComponent(equipmentId.value)}`,
        scopedTeamId ? `teamId=${encodeURIComponent(scopedTeamId)}` : ''
      ].filter(Boolean).join('&')
      uni.navigateTo({ url: `/pages/equipment/routine-record-detail?${query}` })
    }

    onLoad((options) => {
      equipmentId.value = String(options.equipmentId || '')
      routineType.value = normalizedRoutineType(options.routineType)
      teamId.value = String(options.teamId || '')
      const defaults = defaultRoutineRecordDateFilters()
      startDate.value = defaults.startDate
      endDate.value = defaults.endDate
      uni.setNavigationBarTitle({ title: pageTitle.value })
      if (!queryContextReady.value) initialized.value = true
      else loadRecords(true)
    })
    onPullDownRefresh(async () => {
      try { await loadRecords(true) } finally { uni.stopPullDownRefresh() }
    })
    onReachBottom(() => loadRecords(false))
    onUnload(() => { requestVersion += 1 })

    return {
      canView,
      queryContextReady,
      pageTitle,
      selectedTeamName,
      startDate,
      endDate,
      records,
      total,
      loading,
      loadingMore,
      initialized,
      errorMessage,
      hasMore,
      loadRecords,
      applyFilters,
      resetCurrentMonth,
      onStartDateChange,
      onEndDateChange,
      openRecord,
      equipmentName,
      equipmentCode,
      displayTime,
      resultLabel,
      resultTone,
      exceptionLabel,
      routineTypeLabel,
      routineRecordRuleName,
      routineRecordPlateNumber,
      routineRecordPlanStart,
      routineRecordPlanDue,
      routineRecordAbnormalCount
    }
  }
}
</script>

<style scoped lang="scss">
.record-list-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.filter-band, .state-band { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.filter-band { padding: 24rpx; border-top: 6rpx solid #1677ff; }
.filter-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.filter-title, .filter-hint { display: block; overflow-wrap: anywhere; }
.filter-title { color: #1f2733; font-size: 32rpx; font-weight: 700; }
.filter-hint { margin-top: 7rpx; color: #64748b; font-size: 22rpx; }
.filter-total { flex: 0 0 auto; color: #1d5fa7; font-size: 24rpx; }
.date-row { display: grid; grid-template-columns: minmax(0, 1fr) 36rpx minmax(0, 1fr); align-items: center; gap: 8rpx; margin-top: 22rpx; }
.date-field { min-width: 0; padding: 16rpx 18rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f7f9fc; }
.date-field text, .date-field strong { display: block; overflow-wrap: anywhere; }
.date-field text { color: #64748b; font-size: 20rpx; }
.date-field strong { margin-top: 5rpx; color: #1f2733; font-size: 23rpx; font-weight: 600; }
.date-separator { color: #64748b; font-size: 22rpx; text-align: center; }
.filter-actions { display: grid; grid-template-columns: 160rpx minmax(0, 1fr); gap: 12rpx; margin-top: 18rpx; }
.reset-button, .query-button, .retry-button, .more-button { height: 70rpx; line-height: 70rpx; margin: 0; border-radius: 8rpx; font-size: 24rpx; }
.reset-button { color: #52606d; background: #f2f4f7; }
.query-button { color: #fff; background: #1677ff; }
.state-band { margin-top: 20rpx; padding: 100rpx 36rpx; text-align: center; }
.state-title, .state-copy { display: block; }
.state-title { color: #1f2733; font-size: 30rpx; font-weight: 600; }
.state-copy { margin-top: 12rpx; color: #64748b; font-size: 23rpx; line-height: 1.6; }
.error-state { border-color: #efc4c0; background: #fffafa; }
.retry-button { width: 220rpx; margin: 24rpx auto 0; color: #b42318; background: #fff; border: 1px solid #efc4c0; }
.record-list { margin-top: 20rpx; }
.record-card { margin-bottom: 16rpx; padding: 22rpx 24rpx; background: #fff; border: 1px solid #dce4ee; border-left: 6rpx solid #4096ff; border-radius: 8rpx; }
.record-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.record-copy { min-width: 0; flex: 1; }
.record-rule, .record-equipment { display: block; overflow-wrap: anywhere; }
.record-rule { color: #1f2733; font-size: 28rpx; font-weight: 700; }
.record-equipment { margin-top: 6rpx; color: #64748b; font-size: 22rpx; }
.result-tag { flex: 0 0 auto; padding: 7rpx 12rpx; border-radius: 8rpx; font-size: 21rpx; }
.result-success { color: #245d3f; background: #eaf7ef; }
.result-danger { color: #b42318; background: #feeceb; }
.record-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16rpx 24rpx; margin-top: 20rpx; padding-top: 18rpx; border-top: 1px solid #e8edf3; }
.record-grid text, .record-grid strong { display: block; overflow-wrap: anywhere; }
.record-grid text { color: #64748b; font-size: 20rpx; }
.record-grid strong { margin-top: 5rpx; color: #1f2733; font-size: 23rpx; font-weight: 600; }
.record-footer { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; margin-top: 18rpx; padding-top: 16rpx; border-top: 1px solid #e8edf3; color: #64748b; font-size: 21rpx; }
.detail-link { color: #1d5fa7; }
.paging-state { padding: 18rpx 20rpx 34rpx; color: #64748b; text-align: center; font-size: 22rpx; }
.more-button { width: 240rpx; margin: 0 auto; color: #1d5fa7; background: #eaf3ff; }
.inline-error { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; margin-top: 16rpx; padding: 16rpx 20rpx; color: #b42318; background: #fff3f2; border: 1px solid #efc4c0; border-radius: 8rpx; font-size: 21rpx; }
.inline-error text { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.inline-retry-button { flex: 0 0 110rpx; height: 56rpx; line-height: 56rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #b42318; background: #fff; font-size: 21rpx; }
</style>
