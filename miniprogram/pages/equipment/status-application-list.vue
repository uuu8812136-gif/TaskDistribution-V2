<template>
  <view class="page">
    <view class="toolbar">
      <view class="mode-switch">
        <button :class="{ active: !todoOnly }" @click="setTodo(false)">全部申请</button>
        <button :class="{ active: todoOnly }" @click="setTodo(true)">我的待办</button>
      </view>
      <button v-if="canCreate" class="create-button" @click="openCreate">发起申请</button>
    </view>

    <view v-if="!canCreate" class="access-note">
      <text class="access-note-title">{{ canHandleTodo ? '当前不能发起，可处理待办' : '当前仅可查看' }}</text>
      <text>{{ STATUS_APPLICATION_CREATE_REQUIREMENT }}</text>
    </view>

    <view v-if="loadError" class="error-state">
      <text>{{ loadError }}</text>
      <button :loading="loading" @click="retryLoad">重新加载</button>
    </view>

    <view class="list">
      <view v-for="item in applications" :key="item._id" class="row" @click="openDetail(item._id)">
        <view class="row-heading">
          <view class="equipment-copy">
            <text class="name">{{ item.equipmentSnapshot?.name || '-' }}</text>
            <text class="code">{{ item.equipmentSnapshot?.assetCode || '-' }}</text>
          </view>
          <text :class="['status', `tone-${statusTone(item.workflowStatus)}`]">{{ workflowLabel(item.workflowStatus) }}</text>
        </view>
        <view class="row-meta">
          <text>{{ typeLabel(item.applicationType) }}</text>
          <text>{{ formatTime(item.createdAt) }}</text>
        </view>
        <text class="reason">{{ item.reason }}</text>
        <text v-if="item.availableActions?.length" class="todo-mark">待您处理</text>
      </view>
    </view>
    <view v-if="!loading && !loadError && applications.length === 0" class="empty">{{ emptyText }}</view>
    <button v-if="applications.length < total" class="load-more" :loading="loading" @click="loadMore">加载更多</button>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app'
import { getEquipmentStatusApplications } from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import {
  STATUS_APPLICATION_CREATE_REQUIREMENT,
  statusApplicationEmptyText,
  statusTone,
  typeLabel,
  workflowLabel
} from '@/utils/equipmentStatusApplication.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'

export default {
  name: 'EquipmentStatusApplicationList',
  setup() {
    const userStore = useUserStore()
    const applications = ref([])
    const total = ref(0)
    const page = ref(1)
    const loading = ref(false)
    const loadError = ref('')
    const failedLoadKind = ref('')
    const todoOnly = ref(false)
    const teamId = ref('')
    let requestVersion = 0
    const canCreate = computed(() => (
      userStore.can('equipment.status.apply', { write: true, teamRequired: true }) &&
      userStore.context.membership?.functionalRoleKeys?.includes('ASSET_ADMIN')
    ))
    const canHandleTodo = computed(() => (
      userStore.isTeamMode &&
      userStore.hasPermission('equipment.status.approve') &&
      ['DEPARTMENT_DEPUTY_MANAGER', 'DEPARTMENT_MANAGER_ASSISTANT', 'DEPARTMENT_MANAGER'].includes(
        userStore.context.membership?.positionKey
      )
    ))
    const emptyText = computed(() => statusApplicationEmptyText(todoOnly.value))

    const load = async (reset = true) => {
      if (!reset && loading.value) return false
      if (reset) page.value = 1
      const version = ++requestVersion
      const requestedTodo = todoOnly.value
      loading.value = true
      loadError.value = ''
      failedLoadKind.value = ''
      try {
        const result = await getEquipmentStatusApplications({
          page: page.value,
          pageSize: 20,
          ...(teamId.value ? { teamId: teamId.value } : {}),
          ...(requestedTodo ? { todo: true } : {})
        })
        if (version !== requestVersion || requestedTodo !== todoOnly.value) return false
        const rows = result.applications || []
        applications.value = reset ? rows : [...applications.value, ...rows]
        total.value = Number(result.total || rows.length)
        return true
      } catch (error) {
        if (version !== requestVersion || requestedTodo !== todoOnly.value) return false
        failedLoadKind.value = reset ? 'reset' : 'more'
        loadError.value = reset
          ? requestErrorMessage(error, '状态申请暂时无法加载，请重试')
          : requestErrorMessage(error, '后续状态申请加载失败，已有列表已保留，请重试')
        return false
      } finally {
        if (version === requestVersion) loading.value = false
        uni.stopPullDownRefresh()
      }
    }
    const setTodo = (value) => {
      if (todoOnly.value === value && !loadError.value) return
      todoOnly.value = value
      applications.value = []
      total.value = 0
      page.value = 1
      load(true)
    }
    const loadMore = async () => {
      if (loading.value || applications.value.length >= total.value) return
      const previousPage = page.value
      page.value = previousPage + 1
      const succeeded = await load(false)
      if (!succeeded && page.value === previousPage + 1) page.value = previousPage
    }
    const retryLoad = () => failedLoadKind.value === 'more' ? loadMore() : load(true)
    const openCreate = () => uni.navigateTo({ url: '/pages/equipment/status-application-form' })
    const openDetail = (applicationId) => uni.navigateTo({ url: `/pages/equipment/status-application-detail?applicationId=${applicationId}${teamId.value ? `&teamId=${teamId.value}` : ''}` })
    const formatTime = (value) => value ? String(value).replace('T', ' ').slice(0, 16) : '-'

    onLoad((options) => { teamId.value = options.teamId || '' })
    onShow(() => load(true))
    onPullDownRefresh(() => load(true))
    return {
      STATUS_APPLICATION_CREATE_REQUIREMENT,
      applications,
      total,
      loading,
      loadError,
      todoOnly,
      canCreate,
      canHandleTodo,
      emptyText,
      setTodo,
      loadMore,
      retryLoad,
      openCreate,
      openDetail,
      formatTime,
      statusTone,
      typeLabel,
      workflowLabel
    }
  }
}
</script>

<style scoped lang="scss">
.page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.toolbar, .row { border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; padding: 16rpx; }
.access-note, .error-state { margin-top: 16rpx; padding: 18rpx 20rpx; border-left: 6rpx solid #d0a02f; color: #5f4b17; background: #fff8df; font-size: 22rpx; line-height: 1.55; }
.access-note text, .error-state text { display: block; overflow-wrap: anywhere; }
.access-note-title { margin-bottom: 4rpx; color: #3f3210; font-size: 24rpx; font-weight: 650; }
.error-state { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; border-left-color: #d14343; color: #8f2626; background: #fff0f0; }
.error-state text { min-width: 0; flex: 1; }
.error-state button { width: 150rpx; height: 60rpx; margin: 0; color: #b42318; background: #fff; font-size: 21rpx; line-height: 60rpx; }
.mode-switch { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; flex: 1; border: 1px solid #cfd8e3; border-radius: 8rpx; overflow: hidden; }
.mode-switch button { min-width: 0; height: 66rpx; margin: 0; border-radius: 0; color: #52606d; background: #fff; font-size: 23rpx; line-height: 66rpx; }
.mode-switch button.active { color: #fff; background: #4096ff; }
.create-button { width: 150rpx; height: 68rpx; margin: 0; color: #fff; background: #2f855a; font-size: 23rpx; line-height: 68rpx; }
.list { display: grid; gap: 16rpx; margin-top: 18rpx; }
.row { padding: 22rpx; }
.row-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16rpx; }
.equipment-copy { min-width: 0; flex: 1; }
.name, .code, .reason, .todo-mark { display: block; overflow-wrap: anywhere; }
.name { color: #1f2733; font-size: 28rpx; font-weight: 650; }
.code { margin-top: 5rpx; color: #667085; font-size: 22rpx; }
.status { flex: 0 0 auto; max-width: 260rpx; padding: 7rpx 11rpx; border-radius: 7rpx; font-size: 20rpx; text-align: center; overflow-wrap: anywhere; }
.tone-info { color: #1d5fa7; background: #edf5ff; }.tone-success { color: #245d3f; background: #eaf7ef; }.tone-warning { color: #8a4b08; background: #fff5e6; }.tone-danger { color: #b42318; background: #feeceb; }
.row-meta { display: flex; gap: 24rpx; margin-top: 16rpx; color: #667085; font-size: 22rpx; }
.reason { margin-top: 12rpx; color: #344054; font-size: 23rpx; line-height: 1.55; }
.todo-mark { margin-top: 12rpx; color: #1677ff; font-size: 21rpx; }
.empty { padding: 160rpx 0; color: #909399; text-align: center; font-size: 25rpx; }
.load-more { height: 70rpx; margin: 20rpx 0 0; color: #1677ff; background: #fff; font-size: 24rpx; line-height: 70rpx; }
</style>
