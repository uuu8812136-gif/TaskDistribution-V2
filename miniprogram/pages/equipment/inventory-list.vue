<template>
  <view class="inventory-list-page">
    <view class="filter-band">
      <view class="filter-tabs">
        <view :class="['filter-tab', { active: !pendingOnly }]" @click="setPending(false)">全部批次</view>
        <view :class="['filter-tab', { active: pendingOnly }]" @click="setPending(true)">我的待审</view>
      </view>
      <view class="search-row">
        <input v-model="keyword" class="search-input" placeholder="请输入盘点批次名称后点击搜索" confirm-type="search" @confirm="refresh" />
        <button class="search-button" :loading="loading" :disabled="loading" @click="refresh">搜索</button>
      </view>
    </view>

    <view class="batch-list">
      <view v-for="item in sessions" :key="item._id" class="batch-row" @click="openDetail(item)">
        <view class="batch-heading">
          <text class="batch-name">{{ item.name }}</text>
          <text :class="['status-label', `status-${inventoryStatusTone(item.status)}`]">
            {{ inventoryStatusLabel(item.status) }}
          </text>
        </view>
        <text class="batch-org">{{ item.orgUnitNameSnapshot }}</text>
        <view class="batch-stats">
          <text>进度 {{ item.checkedCount }}/{{ item.itemCount }}</text>
          <text :class="{ danger: item.differenceCount > 0 }">差异 {{ item.differenceCount }}</text>
          <text>第{{ item.reviewRound }}轮</text>
        </view>
      </view>
    </view>
    <view v-if="!loading && sessions.length === 0" class="empty-state">暂无盘点批次</view>
    <button v-if="hasMore" class="load-more" :loading="loading" @click="loadMore">加载更多</button>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import { getEquipmentInventorySessions } from '@/api/index.js'
import { inventoryStatusLabel, inventoryStatusTone } from '@/utils/equipmentInventory.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentInventoryList',
  setup() {
    const userStore = useUserStore()
    const sessions = ref([])
    const keyword = ref('')
    const pendingOnly = ref(false)
    const page = ref(1)
    const pageSize = 20
    const total = ref(0)
    const loading = ref(false)
    const teamId = ref('')
    let requestVersion = 0
    const hasMore = computed(() => sessions.value.length < total.value)

    const load = async ({ reset = false } = {}) => {
      if (loading.value) return
      if (reset) page.value = 1
      const version = ++requestVersion
      loading.value = true
      try {
        const response = await getEquipmentInventorySessions({
          page: page.value,
          pageSize,
          keyword: keyword.value.trim() || undefined,
          pendingOnly: pendingOnly.value || undefined,
          ...(teamId.value ? { teamId: teamId.value } : {})
        })
        if (version !== requestVersion) return
        const rows = response.inventorySessions || []
        sessions.value = reset ? rows : [...sessions.value, ...rows]
        total.value = Number(response.total || 0)
      } finally {
        if (version === requestVersion) loading.value = false
        uni.stopPullDownRefresh()
      }
    }
    const refresh = () => load({ reset: true })
    const setPending = (value) => {
      pendingOnly.value = value
      refresh()
    }
    const loadMore = async () => {
      if (!hasMore.value || loading.value) return
      page.value += 1
      await load()
    }
    const openDetail = (item) => uni.navigateTo({
      url: `/pages/equipment/inventory-detail?id=${item._id}${teamId.value ? `&teamId=${teamId.value}` : ''}`
    })

    onLoad((options) => { teamId.value = options.teamId || '' })
    onShow(() => {
      if (!userStore.hasPermission('equipment.inventory')) return
      refresh()
    })
    onPullDownRefresh(refresh)
    return {
      sessions,
      keyword,
      pendingOnly,
      loading,
      hasMore,
      refresh,
      setPending,
      loadMore,
      openDetail,
      inventoryStatusLabel,
      inventoryStatusTone
    }
  }
}
</script>

<style scoped lang="scss">
.inventory-list-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.filter-band, .batch-list { overflow: hidden; border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.filter-band { padding: 18rpx; margin-bottom: 20rpx; }
.filter-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8rpx; padding: 6rpx; border-radius: 8rpx; background: #edf1f5; }
.filter-tab { height: 62rpx; line-height: 62rpx; border-radius: 6rpx; color: #64748b; text-align: center; font-size: 24rpx; }
.filter-tab.active { color: #1d5fa7; background: #fff; font-weight: 600; }
.search-row { display: grid; grid-template-columns: minmax(0, 1fr) 112rpx; gap: 12rpx; margin-top: 16rpx; }
.search-input { min-width: 0; height: 72rpx; padding: 0 20rpx; box-sizing: border-box; border-radius: 8rpx; background: #f4f7fa; font-size: 25rpx; }
.search-button { height: 72rpx; line-height: 72rpx; margin: 0; padding: 0; border-radius: 8rpx; color: #1d5fa7; background: #eaf3ff; font-size: 24rpx; }
.batch-row { padding: 24rpx; border-bottom: 1px solid #e8edf3; }
.batch-row:last-child { border-bottom: 0; }
.batch-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16rpx; }
.batch-name { min-width: 0; flex: 1; color: #1f2733; font-size: 29rpx; font-weight: 600; overflow-wrap: anywhere; }
.status-label { flex: 0 0 auto; padding: 6rpx 10rpx; border: 1px solid; border-radius: 6rpx; font-size: 20rpx; }
.status-neutral { color: #52606d; border-color: #cbd5e1; background: #f8fafc; }
.status-warning { color: #8a4b08; border-color: #f5c98b; background: #fff8e8; }
.status-danger { color: #b42318; border-color: #f2c1bd; background: #fff3f2; }
.status-success { color: #245d3f; border-color: #b7dfc8; background: #edf9f2; }
.batch-org { display: block; margin-top: 8rpx; color: #64748b; font-size: 23rpx; }
.batch-stats { display: flex; gap: 24rpx; margin-top: 18rpx; color: #52606d; font-size: 23rpx; }
.batch-stats .danger { color: #b42318; }
.empty-state { padding: 180rpx 0; color: #909399; text-align: center; font-size: 26rpx; }
.load-more { height: 72rpx; line-height: 72rpx; margin: 20rpx 0 0; border-radius: 8rpx; color: #4096ff; background: #fff; font-size: 25rpx; }
</style>
