<template>
  <view class="equipment-page">
    <view v-if="userStore.isGlobalReadOnly" class="team-band">
      <text>项目团队</text>
      <picker :range="teamOptions" range-key="name" :value="teamIndex" @change="onTeamChange">
        <view class="team-picker">{{ selectedTeamName || '请选择团队' }} 〉</view>
      </picker>
    </view>

    <view class="toolbar">
      <input v-model="keyword" class="search-input" placeholder="搜索设备名称或编号" confirm-type="search" @confirm="refresh" />
      <button class="search-button" @click="refresh">查询</button>
      <button class="scan-button" @click="scanEquipment">扫码</button>
    </view>

    <view class="equipment-list">
      <view v-for="item in equipment" :key="item._id" class="equipment-row" @click="openEquipment(item._id)">
        <view class="row-main">
          <text class="asset-name">{{ item.name }}</text>
          <text class="asset-code">{{ item.assetCode }}</text>
        </view>
        <view class="row-side">
          <text>{{ item.currentRuntimeHours == null ? '未录入小时' : `${item.currentRuntimeHours} h` }}</text>
          <text class="row-arrow">〉</text>
        </view>
      </view>
    </view>
    <view v-if="!loading && equipment.length === 0" class="empty-state">暂无可查看设备</view>
    <button v-if="hasMore" class="load-more" :loading="loading" @click="loadMore">加载更多</button>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import { getEquipmentByQrToken, getEquipmentList } from '@/api/index.js'
import { parseEquipmentQrPayload, teamQuery } from '@/utils/equipment.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentIndex',
  setup() {
    const userStore = useUserStore()
    const equipment = ref([])
    const keyword = ref('')
    const loading = ref(false)
    const page = ref(1)
    const pageSize = 20
    const total = ref(0)
    const selectedTeamId = ref('')
    let requestVersion = 0
    const teamOptions = computed(() => userStore.teams || [])
    const teamIndex = computed(() => Math.max(0, teamOptions.value.findIndex((team) => team._id === selectedTeamId.value)))
    const selectedTeamName = computed(() => teamOptions.value.find((team) => team._id === selectedTeamId.value)?.name || '')
    const hasMore = computed(() => equipment.value.length < total.value)

    const requestTeam = () => userStore.isGlobalReadOnly ? selectedTeamId.value : ''
    const requireTeam = () => {
      if (!userStore.isGlobalReadOnly || selectedTeamId.value) return true
      uni.showToast({ title: '请先选择项目团队', icon: 'none' })
      return false
    }
    const load = async ({ reset = false } = {}) => {
      if (!requireTeam()) return
      if (reset) page.value = 1
      const version = ++requestVersion
      const requestedPage = page.value
      const requestedTeamId = requestTeam()
      const requestedKeyword = keyword.value.trim()
      loading.value = true
      try {
        const response = await getEquipmentList({
          page: requestedPage,
          pageSize,
          keyword: requestedKeyword,
          ...(requestedTeamId ? { teamId: requestedTeamId } : {})
        })
        if (version !== requestVersion) return
        const rows = response.equipment || response.items || []
        equipment.value = reset ? rows : [...equipment.value, ...rows]
        total.value = Number(response.total ?? rows.length)
      } finally {
        if (version === requestVersion) loading.value = false
        uni.stopPullDownRefresh()
      }
    }
    const refresh = () => load({ reset: true })
    const loadMore = async () => {
      if (!hasMore.value || loading.value) return
      page.value += 1
      await load()
    }
    const openEquipment = (equipmentId) => {
      const query = requestTeam()
      uni.navigateTo({ url: `/pages/equipment/detail?id=${equipmentId}${query ? `&teamId=${query}` : ''}` })
    }
    const scanEquipment = () => {
      if (!requireTeam()) return
      uni.scanCode({
        scanType: ['qrCode'],
        success: async ({ result }) => {
          try {
            const { token } = parseEquipmentQrPayload(result)
            const response = await getEquipmentByQrToken(token, requestTeam() ? { teamId: requestTeam() } : {})
            if (!response.equipment?._id) throw new Error('设备不存在或无权访问')
            openEquipment(response.equipment._id)
          } catch (error) {
            uni.showToast({ title: error.message || '无法识别设备二维码', icon: 'none' })
          }
        }
      })
    }
    const onTeamChange = (event) => {
      selectedTeamId.value = teamOptions.value[Number(event.detail.value)]?._id || ''
      equipment.value = []
      total.value = 0
      refresh()
    }

    onLoad((options) => { selectedTeamId.value = options.teamId || '' })
    onShow(() => {
      if (!userStore.hasPermission('equipment.view')) return
      if (!equipment.value.length && (!userStore.isGlobalReadOnly || selectedTeamId.value)) refresh()
    })
    onPullDownRefresh(refresh)
    return {
      userStore, equipment, keyword, loading, teamOptions, teamIndex, selectedTeamName,
      hasMore, refresh, loadMore, openEquipment, scanEquipment, onTeamChange, teamQuery
    }
  }
}
</script>

<style scoped lang="scss">
.equipment-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.team-band, .toolbar, .equipment-list { background: #fff; border: 1px solid #dce4ee; border-radius: 8rpx; }
.team-band { display: flex; align-items: center; justify-content: space-between; padding: 22rpx 24rpx; margin-bottom: 20rpx; font-size: 26rpx; }
.team-picker { color: #1f2733; }
.toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 116rpx 116rpx; gap: 12rpx; padding: 16rpx; margin-bottom: 20rpx; }
.search-input { min-width: 0; height: 72rpx; padding: 0 20rpx; box-sizing: border-box; background: #f4f7fa; border-radius: 8rpx; font-size: 25rpx; }
.search-button, .scan-button { height: 72rpx; line-height: 72rpx; margin: 0; padding: 0; border-radius: 8rpx; font-size: 25rpx; }
.search-button { color: #fff; background: #4096ff; }
.scan-button { color: #1f2733; background: #e8eef5; }
.equipment-list { overflow: hidden; }
.equipment-row { display: flex; align-items: center; min-height: 112rpx; padding: 20rpx 24rpx; box-sizing: border-box; border-bottom: 1px solid #e8edf3; }
.equipment-row:last-child { border-bottom: 0; }
.row-main { min-width: 0; flex: 1; }
.asset-name, .asset-code { display: block; overflow-wrap: anywhere; }
.asset-name { color: #1f2733; font-size: 29rpx; font-weight: 600; }
.asset-code { margin-top: 6rpx; color: #64748b; font-size: 23rpx; }
.row-side { display: flex; align-items: center; margin-left: 20rpx; color: #64748b; font-size: 23rpx; }
.row-arrow { margin-left: 12rpx; color: #94a3b8; font-size: 31rpx; }
.empty-state { padding: 150rpx 0; color: #909399; text-align: center; font-size: 26rpx; }
.load-more { height: 72rpx; line-height: 72rpx; margin: 20rpx 0 0; border-radius: 8rpx; color: #4096ff; background: #fff; font-size: 25rpx; }
</style>
