<template>
  <view class="repair-list-page">
    <view v-if="userStore.isGlobalReadOnly" class="team-band">
      <text>项目团队</text>
      <picker :range="teamOptions" range-key="name" :value="teamIndex" @change="onTeamChange">
        <view class="team-picker">{{ selectedTeamName || '请选择团队' }} 〉</view>
      </picker>
    </view>

    <view class="top-actions">
      <view class="mode-segment" :class="{ single: !canViewTodos }">
        <button v-if="canViewTodos" :class="{ active: mode === 'todo' }" @click="setMode('todo')">我的待办</button>
        <button :class="{ active: mode === 'all' }" @click="setMode('all')">全部记录</button>
      </view>
      <button v-if="canCreate" class="scan-button" @click="scanToCreate">扫码发起</button>
    </view>

    <view v-if="mode === 'all'" class="search-band">
      <input v-model="keyword" maxlength="100" confirm-type="search" placeholder="设备编码、名称、联系人或维修人" @confirm="applySearch" />
      <button @click="applySearch">查询</button>
    </view>

    <view v-if="!loadError && repairs.length" class="repair-list">
      <view v-for="item in repairs" :key="item._id" class="repair-row" @click="openDetail(item)">
        <view class="row-heading">
          <view class="asset-copy">
            <text class="asset-name">{{ item.equipmentSnapshot?.name || '-' }}</text>
            <text class="asset-code">{{ item.equipmentSnapshot?.assetCode || '-' }}</text>
          </view>
          <text class="status-tag" :class="`tone-${repairStatusTone(item.status)}`">
            {{ repairStatusLabel(item.status) }}
          </text>
        </view>
        <view class="row-meta">
          <text>{{ repairTypeLabel(item.type) }}</text>
          <text>{{ item.equipmentSnapshot?.orgUnitName || '-' }}</text>
          <text>{{ formatDate(item.reportTime || item.repairDate, 'YYYY-MM-DD') || '-' }}</text>
        </view>
        <view class="row-footer">
          <text v-if="item.type === 'PARTS_REPAIR'">金额 ¥{{ Number(item.totalAmount || 0).toFixed(2) }}</text>
          <text v-else>{{ item.type === 'FAULT_REPORT' ? `${item.photoAttachments?.length || 0} 张现场照片` : '无需配件' }}</text>
          <text class="detail-link">{{ item.availableActions?.length ? '去处理' : '查看详情' }} 〉</text>
        </view>
      </view>
    </view>

    <view v-if="!loading && loadError" class="empty-state error-state">
      <text class="empty-icon error-icon">!</text>
      <text class="empty-title">维修记录加载失败</text>
      <text class="empty-description">{{ loadError }}</text>
      <button class="retry-button" @click="refresh">重新加载</button>
    </view>
    <view v-else-if="!loading && repairs.length === 0" class="empty-state">
      <text class="empty-icon">修</text>
      <text class="empty-title">
        {{ keyword.trim() ? '未找到匹配记录' : (mode === 'todo' ? '当前没有维修待办' : '暂无维修记录') }}
      </text>
      <text class="empty-description">
        {{ keyword.trim() ? '请更换关键词后重新查询' : (mode === 'todo' ? '新的审批任务会显示在这里' : '可调整查询条件或扫码发起维修') }}
      </text>
    </view>
    <button v-if="hasMore" class="load-more" :loading="loading" @click="loadMore">
      {{ loading ? '加载中' : '加载更多' }}
    </button>
  </view>
</template>

<script>
import { computed, onUnmounted, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import {
  getEquipmentByQrToken,
  getEquipmentRepairs,
  getEquipmentRoutineSchedule
} from '@/api/index.js'
import { classifyEquipmentScanFailure, lookupEquipmentFromQr } from '@/utils/equipment.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import {
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel
} from '@/utils/equipmentRepair.js'
import { formatDate } from '@/utils/format.js'
import { createLatestRequestGate } from '@/utils/latestRequest.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRepairList',
  setup() {
    const userStore = useUserStore()
    const canViewTodos = computed(() => (
      userStore.isTeamMode &&
      userStore.can('equipment.repair', { teamRequired: true })
    ))
    const mode = ref(canViewTodos.value ? 'todo' : 'all')
    const keyword = ref('')
    const repairs = ref([])
    const page = ref(1)
    const pageSize = 20
    const total = ref(0)
    const loading = ref(false)
    const loadError = ref('')
    const requestGate = createLatestRequestGate()
    const teamId = ref('')
    const teamOptions = computed(() => userStore.teams || [])
    const teamIndex = computed(() => Math.max(
      0,
      teamOptions.value.findIndex((team) => team._id === teamId.value)
    ))
    const selectedTeamName = computed(() => (
      teamOptions.value.find((team) => team._id === teamId.value)?.name || ''
    ))
    const hasMore = computed(() => repairs.value.length < total.value)
    const canCreate = computed(() => userStore.can('equipment.repair', {
      write: true,
      teamRequired: true
    }))
    let activeContextSignature = ''
    let modeSelectedByUser = false

    const currentContextSignature = () => [
      userStore.contextEpoch,
      userStore.mode || '',
      userStore.activeTeamId || '',
      userStore.isSuperAdmin ? 'super' : 'member',
      [...userStore.permissionKeys].sort().join(',')
    ].join('|')

    const syncModeWithContext = () => {
      const signature = currentContextSignature()
      if (signature === activeContextSignature) return

      const isFirstContext = !activeContextSignature
      activeContextSignature = signature
      if (!isFirstContext) modeSelectedByUser = false

      if (!modeSelectedByUser || !canViewTodos.value) {
        mode.value = canViewTodos.value ? 'todo' : 'all'
        keyword.value = ''
      }
    }

    const load = async ({ append = false } = {}) => {
      syncModeWithContext()
      if (userStore.isGlobalReadOnly && !teamId.value) {
        requestGate.invalidate()
        repairs.value = []
        total.value = 0
        loading.value = false
        uni.stopPullDownRefresh()
        return
      }
      const request = requestGate.begin({
        append,
        page: page.value,
        mode: canViewTodos.value ? mode.value : 'all',
        keyword: keyword.value.trim(),
        teamId: teamId.value,
        contextSignature: currentContextSignature()
      })
      loading.value = true
      loadError.value = ''
      try {
        const result = await getEquipmentRepairs({
          todo: request.mode === 'todo' ? true : undefined,
          keyword: request.mode === 'all' ? request.keyword || undefined : undefined,
          page: request.page,
          pageSize,
          ...(userStore.isGlobalReadOnly ? { teamId: request.teamId } : {})
        })
        if (
          !requestGate.isCurrent(request) ||
          request.contextSignature !== currentContextSignature()
        ) return
        repairs.value = request.append
          ? [...repairs.value, ...(result.repairs || [])]
          : (result.repairs || [])
        total.value = Number(result.total) || 0
      } catch (error) {
        if (requestGate.isCurrent(request)) {
          if (request.append && page.value === request.page) {
            page.value = Math.max(1, request.page - 1)
          }
          loadError.value = requestErrorMessage(error, '无法加载维修记录')
        }
      } finally {
        if (requestGate.isCurrent(request)) loading.value = false
      }
    }

    const refresh = async () => {
      page.value = 1
      await load()
    }
    const setMode = (value) => {
      if (value === 'todo' && !canViewTodos.value) return
      if (mode.value === value) return
      modeSelectedByUser = true
      mode.value = value
      if (value === 'todo') keyword.value = ''
      refresh()
    }
    const applySearch = () => refresh()
    const loadMore = async () => {
      if (loading.value || !hasMore.value) return
      page.value += 1
      await load({ append: true })
    }
    const openDetail = (item) => uni.navigateTo({
      url: `/pages/equipment/repair-detail?repairId=${encodeURIComponent(item._id)}` +
        `${userStore.isGlobalReadOnly ? `&teamId=${encodeURIComponent(teamId.value)}` : ''}`
    })

    const onTeamChange = (event) => {
      teamId.value = teamOptions.value[Number(event.detail.value)]?._id || ''
      repairs.value = []
      total.value = 0
      page.value = 1
      refresh()
    }

    const scanToCreate = () => {
      uni.scanCode({
        onlyFromCamera: true,
        scanType: ['qrCode'],
        success: async ({ result }) => {
          try {
            const lookup = await lookupEquipmentFromQr(result, {
              fetchEquipment: getEquipmentByQrToken,
              fetchSchedule: getEquipmentRoutineSchedule
            })
            uni.navigateTo({
              url: `/pages/equipment/repair-form?equipmentId=${lookup.equipment._id}`
            })
          } catch (error) {
            uni.showToast({
              title: requestErrorMessage(error, '无法识别设备二维码'),
              icon: 'none'
            })
          }
        },
        fail: (error) => {
          const result = classifyEquipmentScanFailure(error)
          if (result.status !== 'cancelled') uni.showToast({ title: result.message, icon: 'none' })
        }
      })
    }

    onLoad((options) => {
      teamId.value = options.teamId || ''
      if (options.mode === 'all') {
        mode.value = 'all'
        modeSelectedByUser = true
      } else if (!canViewTodos.value) {
        mode.value = 'all'
      }
    })
    onShow(refresh)
    onPullDownRefresh(async () => {
      try { await refresh() } finally { uni.stopPullDownRefresh() }
    })
    onUnmounted(() => requestGate.invalidate())

    return {
      userStore,
      mode,
      keyword,
      repairs,
      loading,
      loadError,
      hasMore,
      canViewTodos,
      canCreate,
      teamOptions,
      teamIndex,
      selectedTeamName,
      setMode,
      applySearch,
      loadMore,
      openDetail,
      onTeamChange,
      scanToCreate,
      refresh,
      repairStatusLabel,
      repairStatusTone,
      repairTypeLabel,
      formatDate
    }
  }
}
</script>

<style scoped lang="scss">
.repair-list-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.team-band { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; min-height: 82rpx; padding: 0 22rpx; margin-bottom: 18rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-left: 6rpx solid #4096ff; border-radius: 8rpx; background: #fff; color: #344054; font-size: 24rpx; }
.team-band picker { min-width: 0; flex: 1; }
.team-picker { color: #1677ff; text-align: right; overflow-wrap: anywhere; }
.top-actions { display: flex; align-items: center; gap: 16rpx; }
.mode-segment { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); flex: 1; gap: 12rpx; }
.mode-segment.single { grid-template-columns: minmax(0, 1fr); }
.mode-segment button { height: 68rpx; margin: 0; padding: 0; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 10rpx; color: #344054; background: #fff; font-size: 24rpx; font-weight: 600; line-height: 66rpx; letter-spacing: 0; }
.mode-segment button::after { border: 0; }
.mode-segment button.active { border-color: #1677ff; color: #fff; background: #1677ff; box-shadow: 0 4rpx 10rpx rgba(22, 119, 255, .22), inset 0 0 0 1px rgba(255, 255, 255, .18); }
.scan-button { flex: 0 0 164rpx; height: 68rpx; margin: 0; border-radius: 8rpx; color: #fff; background: #245d3f; font-size: 24rpx; line-height: 68rpx; }
.search-band { display: grid; grid-template-columns: minmax(0, 1fr) 110rpx; gap: 12rpx; margin: 18rpx 0; }
.search-band input { height: 70rpx; padding: 0 20rpx; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; font-size: 24rpx; }
.search-band button { height: 70rpx; margin: 0; border-radius: 8rpx; color: #245d3f; background: #eaf7ef; font-size: 24rpx; line-height: 70rpx; }
.repair-list { overflow: hidden; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.repair-row { padding: 24rpx; border-bottom: 1px solid #e8edf3; }
.repair-row:last-child { border-bottom: 0; }
.row-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18rpx; }
.asset-copy { min-width: 0; flex: 1; }
.asset-name, .asset-code { display: block; overflow-wrap: anywhere; }
.asset-name { color: #1f2733; font-size: 28rpx; font-weight: 600; }
.asset-code { margin-top: 5rpx; color: #667085; font-size: 22rpx; }
.status-tag { flex: 0 0 auto; max-width: 250rpx; padding: 7rpx 11rpx; border-radius: 6rpx; font-size: 20rpx; line-height: 1.35; text-align: center; overflow-wrap: anywhere; }
.tone-success { color: #245d3f; background: #eaf7ef; }
.tone-warning { color: #9a6700; background: #fff4cc; }
.tone-danger { color: #b42318; background: #feeceb; }
.row-meta { display: flex; flex-wrap: wrap; gap: 10rpx 24rpx; margin-top: 16rpx; color: #52606d; font-size: 22rpx; }
.row-footer { display: flex; align-items: center; justify-content: space-between; gap: 18rpx; margin-top: 16rpx; padding-top: 14rpx; border-top: 1px dashed #dce4ee; color: #667085; font-size: 22rpx; }
.detail-link { color: #1677ff; }
.empty-state { display: flex; flex-direction: column; align-items: center; padding: 88rpx 20rpx 96rpx; text-align: center; }
.empty-icon { display: flex; align-items: center; justify-content: center; width: 76rpx; height: 76rpx; border: 1px solid #c9d7e8; border-radius: 50%; color: #356a55; background: #f2f8f5; font-size: 30rpx; font-weight: 600; line-height: 76rpx; }
.empty-title { margin-top: 22rpx; color: #344054; font-size: 27rpx; font-weight: 600; }
.empty-description { margin-top: 10rpx; color: #7b8794; font-size: 23rpx; line-height: 1.55; }
.error-icon { color: #b42318; border-color: #f2c2bd; background: #fff5f4; }
.retry-button { width: 180rpx; height: 64rpx; margin: 24rpx 0 0; border: 1px solid #b8c7d9; border-radius: 8rpx; color: #245d3f; background: #fff; font-size: 23rpx; line-height: 62rpx; }
.load-more { height: 72rpx; margin: 22rpx 0; border-radius: 8rpx; color: #52606d; background: #fff; font-size: 24rpx; line-height: 72rpx; }
</style>
