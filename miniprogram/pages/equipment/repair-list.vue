<template>
  <view class="repair-list-page">
    <view class="top-actions">
      <view class="mode-segment">
        <button :class="{ active: mode === 'todo' }" @click="setMode('todo')">我的待办</button>
        <button :class="{ active: mode === 'all' }" @click="setMode('all')">全部记录</button>
      </view>
      <button v-if="canCreate" class="scan-button" @click="scanToCreate">扫码发起</button>
    </view>

    <view class="search-band">
      <input v-model="keyword" maxlength="100" confirm-type="search" placeholder="设备编码、名称、联系人或维修人" @confirm="applySearch" />
      <button @click="applySearch">查询</button>
    </view>

    <view class="repair-list">
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

    <view v-if="!loading && repairs.length === 0" class="empty-state">
      {{ mode === 'todo' ? '当前没有维修待办' : '暂无维修记录' }}
    </view>
    <button v-if="hasMore" class="load-more" :loading="loading" @click="loadMore">
      {{ loading ? '加载中' : '加载更多' }}
    </button>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import {
  getEquipmentByQrToken,
  getEquipmentRepairs,
  getEquipmentRoutineSchedule
} from '@/api/index.js'
import { classifyEquipmentScanFailure, lookupEquipmentFromQr } from '@/utils/equipment.js'
import {
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel
} from '@/utils/equipmentRepair.js'
import { formatDate } from '@/utils/format.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRepairList',
  setup() {
    const userStore = useUserStore()
    const mode = ref('todo')
    const keyword = ref('')
    const repairs = ref([])
    const page = ref(1)
    const pageSize = 20
    const total = ref(0)
    const loading = ref(false)
    const hasMore = computed(() => repairs.value.length < total.value)
    const canCreate = computed(() => userStore.can('equipment.repair', {
      write: true,
      teamRequired: true
    }))

    const load = async ({ append = false } = {}) => {
      if (loading.value) return
      loading.value = true
      try {
        const result = await getEquipmentRepairs({
          todo: mode.value === 'todo' ? true : undefined,
          keyword: keyword.value.trim() || undefined,
          page: page.value,
          pageSize
        })
        repairs.value = append ? [...repairs.value, ...(result.repairs || [])] : (result.repairs || [])
        total.value = Number(result.total) || 0
      } finally {
        loading.value = false
      }
    }

    const refresh = async () => {
      page.value = 1
      await load()
    }
    const setMode = (value) => {
      if (mode.value === value) return
      mode.value = value
      refresh()
    }
    const applySearch = () => refresh()
    const loadMore = async () => {
      if (!hasMore.value) return
      page.value += 1
      await load({ append: true })
    }
    const openDetail = (item) => uni.navigateTo({
      url: `/pages/equipment/repair-detail?repairId=${item._id}`
    })

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
            uni.showToast({ title: error.message || '无法识别设备二维码', icon: 'none' })
          }
        },
        fail: (error) => {
          const result = classifyEquipmentScanFailure(error)
          if (result.status !== 'cancelled') uni.showToast({ title: result.message, icon: 'none' })
        }
      })
    }

    onLoad((options) => {
      if (options.mode === 'all') mode.value = 'all'
    })
    onShow(refresh)
    onPullDownRefresh(async () => {
      try { await refresh() } finally { uni.stopPullDownRefresh() }
    })

    return {
      mode,
      keyword,
      repairs,
      loading,
      hasMore,
      canCreate,
      setMode,
      applySearch,
      loadMore,
      openDetail,
      scanToCreate,
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
.top-actions { display: flex; align-items: center; gap: 16rpx; }
.mode-segment { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); flex: 1; border: 1px solid #cfd8e3; border-radius: 8rpx; overflow: hidden; }
.mode-segment button { height: 68rpx; padding: 0; border-radius: 0; color: #52606d; background: #fff; font-size: 24rpx; line-height: 68rpx; }
.mode-segment button + button { border-left: 1px solid #cfd8e3; }
.mode-segment button.active { color: #fff; background: #4096ff; }
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
.empty-state { padding: 180rpx 20rpx; color: #909399; text-align: center; font-size: 25rpx; }
.load-more { height: 72rpx; margin: 22rpx 0; border-radius: 8rpx; color: #52606d; background: #fff; font-size: 24rpx; line-height: 72rpx; }
</style>
