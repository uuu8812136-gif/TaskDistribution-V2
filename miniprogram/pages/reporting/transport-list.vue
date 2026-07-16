<template>
  <view class="transport-page">
    <view class="filter-panel">
      <view class="search-row">
        <input
          v-model="keyword"
          class="search-input"
          placeholder="车牌、司机、路线或车次"
          confirm-type="search"
          @confirm="applyFilters"
        />
        <button class="search-button" @click="applyFilters">查询</button>
      </view>
      <view class="filter-row">
        <picker mode="date" :value="date" @change="onDateChange">
          <view class="date-filter">{{ date || '全部日期' }}</view>
        </picker>
        <button v-if="date || keyword" class="reset-button" @click="resetFilters">重置</button>
      </view>
    </view>

    <view v-if="records.length" class="record-list">
      <view
        v-for="record in records"
        :key="record._id"
        class="record-card"
        @click="openDetail(record._id)"
      >
        <view class="record-header">
          <text class="record-date">{{ record.reportDate }}</text>
          <text class="record-shift">{{ record.shift }} · {{ record.tripLabel }}</text>
        </view>
        <text class="record-route">{{ record.route }}</text>
        <view class="record-grid">
          <view class="record-cell">
            <text class="cell-label">车牌</text>
            <text class="cell-value">{{ record.vehiclePlate }}</text>
          </view>
          <view class="record-cell">
            <text class="cell-label">司机</text>
            <text class="cell-value">{{ record.driverName }}</text>
          </view>
          <view class="record-cell">
            <text class="cell-label">组织</text>
            <text class="cell-value">{{ displayOrg(record.orgUnitId) }}</text>
          </view>
          <view class="record-cell">
            <text class="cell-label">装载合计</text>
            <text class="cell-value">{{ record.loadTotal || 0 }}</text>
          </view>
        </view>
        <view class="record-footer">
          <text>{{ record.dispatchType }}</text>
          <text>{{ formatDate(record.submittedAt, 'MM-DD HH:mm') }}</text>
        </view>
      </view>
    </view>

    <view v-else-if="!loading" class="empty-state">
      <text>暂无运输记录</text>
    </view>
    <view v-if="loading || records.length" class="load-state">
      <text>{{ loading ? '加载中...' : hasMore ? '上拉加载更多' : '已加载全部' }}</text>
    </view>

    <button v-if="canSubmit" class="create-button" title="新增运输记录" @click="openCreate">
      <text>+</text>
    </button>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onReachBottom, onShow } from '@dcloudio/uni-app'
import { getOrgUnits, getTransportRecords, getUsers } from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import { formatDate } from '@/utils/format.js'
import {
  buildOrgUnitOptions,
  orgUnitLabel,
  scopedReportingParams
} from '@/utils/reporting.js'

export default {
  name: 'TransportRecordList',
  setup() {
    const userStore = useUserStore()
    const selectedTeamId = ref('')
    const records = ref([])
    const total = ref(0)
    const page = ref(1)
    const pageSize = 10
    const keyword = ref('')
    const date = ref('')
    const loading = ref(false)
    const orgUnits = ref([])
    const orgUsers = ref([])
    let hasShown = false
    const orgOptions = computed(() => buildOrgUnitOptions(orgUnits.value, orgUsers.value))
    const hasMore = computed(() => records.value.length < total.value)
    const canSubmit = computed(() => userStore.can('report.submit', {
      write: true,
      teamRequired: true
    }))

    const readParams = (extra = {}) => scopedReportingParams(
      userStore.mode,
      selectedTeamId.value,
      extra
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

    const loadRecords = async ({ reset = false } = {}) => {
      if (loading.value) return
      loading.value = true
      if (reset) page.value = 1
      try {
        const response = await getTransportRecords(readParams({
          page: page.value,
          pageSize,
          keyword: keyword.value.trim(),
          date: date.value
        }))
        const incoming = response.transportRecords || []
        records.value = reset ? incoming : [...records.value, ...incoming]
        total.value = Number(response.total) || 0
      } catch (error) {
        console.error('加载运输记录失败:', error)
      } finally {
        loading.value = false
        uni.stopPullDownRefresh()
      }
    }

    onLoad((options) => {
      selectedTeamId.value = options?.teamId || ''
      if (!userStore.can('report.view')) {
        uni.showToast({ title: '无权限查看运输记录', icon: 'none' })
        setTimeout(() => uni.navigateBack(), 300)
        return
      }
      loadOrgLabels()
      loadRecords({ reset: true })
    })

    onPullDownRefresh(() => loadRecords({ reset: true }))
    onShow(() => {
      if (hasShown) loadRecords({ reset: true })
      else hasShown = true
    })
    onReachBottom(() => {
      if (loading.value || !hasMore.value) return
      page.value += 1
      loadRecords()
    })

    const onDateChange = (event) => {
      date.value = event.detail.value
      loadRecords({ reset: true })
    }
    const applyFilters = () => loadRecords({ reset: true })
    const resetFilters = () => {
      keyword.value = ''
      date.value = ''
      loadRecords({ reset: true })
    }
    const displayOrg = (orgUnitId) => orgUnitLabel(
      orgUnitId,
      orgOptions.value,
      userStore.context?.orgUnit
    )
    const openDetail = (recordId) => {
      const teamQuery = userStore.isGlobalReadOnly
        ? `&teamId=${encodeURIComponent(selectedTeamId.value)}`
        : ''
      uni.navigateTo({
        url: `/pages/reporting/transport-detail?id=${encodeURIComponent(recordId)}${teamQuery}`
      })
    }
    const openCreate = () => uni.navigateTo({ url: '/pages/reporting/transport-form' })

    return {
      records,
      keyword,
      date,
      loading,
      hasMore,
      canSubmit,
      formatDate,
      displayOrg,
      onDateChange,
      applyFilters,
      resetFilters,
      openDetail,
      openCreate
    }
  }
}
</script>

<style scoped lang="scss">
.transport-page { min-height: 100vh; box-sizing: border-box; padding: 20rpx 24rpx 160rpx; background: #f5f7fa; }
.filter-panel { padding: 20rpx; margin-bottom: 20rpx; background: #ffffff; border-radius: 8rpx; }
.search-row { display: flex; align-items: center; gap: 16rpx; }
.search-input { flex: 1; min-width: 0; height: 68rpx; box-sizing: border-box; padding: 0 20rpx; background: #f5f7fa; border-radius: 6rpx; font-size: 26rpx; }
.search-button { width: 120rpx; height: 68rpx; line-height: 68rpx; margin: 0; padding: 0; border-radius: 6rpx; background: #409eff; color: #ffffff; font-size: 26rpx; }
.search-button::after, .reset-button::after, .create-button::after { border: none; }
.filter-row { display: flex; align-items: center; margin-top: 16rpx; }
.filter-row picker { flex: 1; }
.date-filter { height: 64rpx; line-height: 64rpx; padding: 0 20rpx; background: #f5f7fa; border-radius: 6rpx; color: #606266; font-size: 25rpx; }
.reset-button { width: 112rpx; height: 64rpx; line-height: 64rpx; margin: 0 0 0 16rpx; padding: 0; background: #ffffff; border: 1px solid #dcdfe6; border-radius: 6rpx; color: #606266; font-size: 24rpx; }
.record-card { padding: 24rpx; margin-bottom: 20rpx; background: #ffffff; border-radius: 8rpx; border-left: 6rpx solid #409eff; }
.record-header { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.record-date { font-size: 30rpx; color: #303133; font-weight: 600; }
.record-shift { flex-shrink: 0; font-size: 24rpx; color: #409eff; }
.record-route { display: block; margin-top: 14rpx; font-size: 27rpx; color: #606266; word-break: break-all; }
.record-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx 24rpx; margin-top: 24rpx; }
.record-cell { min-width: 0; }
.cell-label { display: block; font-size: 22rpx; color: #909399; }
.cell-value { display: block; margin-top: 4rpx; font-size: 25rpx; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-footer { display: flex; justify-content: space-between; padding-top: 18rpx; margin-top: 20rpx; border-top: 1px solid #ebeef5; color: #909399; font-size: 22rpx; }
.empty-state { padding: 160rpx 0; text-align: center; color: #909399; font-size: 28rpx; }
.load-state { padding: 28rpx 0; text-align: center; color: #909399; font-size: 23rpx; }
.create-button { position: fixed; right: 36rpx; bottom: calc(36rpx + env(safe-area-inset-bottom)); width: 96rpx; height: 96rpx; line-height: 86rpx; padding: 0; border-radius: 50%; background: #409eff; color: #ffffff; box-shadow: 0 8rpx 24rpx rgba(64, 158, 255, 0.35); font-size: 58rpx; font-weight: 300; }
</style>
