<template>
  <view class="exception-page">
    <view v-if="exception" class="asset-band">
      <view class="heading-row">
        <view><strong>{{ exception.equipment?.name || '-' }}</strong><text>{{ exception.equipment?.assetCode || '-' }}</text></view>
        <text :class="exception.status === 'RESOLVED' ? 'success-tag' : 'danger-tag'">
          {{ exception.status === 'RESOLVED' ? '已解决' : '处理中' }}
        </text>
      </view>
      <text class="summary">{{ exception.summary }}</text>
      <text class="stage">当前：{{ stageLabel(exception.currentStage) }}</text>
    </view>

    <view v-if="exception" class="history-band">
      <text class="section-title">处理记录</text>
      <view v-for="(item, index) in exception.history" :key="`${item.actedAt}-${index}`" class="history-row">
        <strong>{{ stageLabel(item.stage) }} · {{ actionLabel(item.action) }}</strong>
        <text v-if="item.opinion">{{ item.opinion }}</text>
        <small>{{ formatTime(item.actedAt) }}</small>
      </view>
    </view>

    <view v-if="canHandle" class="action-band">
      <text class="section-title">当前处理</text>
      <view class="action-options">
        <button :class="{ active: action === 'RESOLVE' }" @click="action = 'RESOLVE'">本级解决</button>
        <button v-if="exception.currentStage !== 'ASSET_ADMIN'" :class="{ active: action === 'ESCALATE' }" @click="action = 'ESCALATE'">无法解决，升级</button>
      </view>
      <textarea v-model="opinion" maxlength="3000" placeholder="填写处理意见（必填）" />
      <button class="submit-button" :loading="submitting" :disabled="submitting" @click="submit">提交处理</button>
    </view>

    <view v-else-if="exception?.status === 'OPEN'" class="permission-band">
      当前账号不是本阶段处理岗位，仅可查看处理进度。
    </view>
  </view>
</template>

<script>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import {
  getEquipmentRoutineException,
  transitionEquipmentRoutineException
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'

export default {
  name: 'EquipmentRoutineException',
  setup() {
    const userStore = useUserStore()
    const exceptionId = ref('')
    const teamId = ref('')
    const exception = ref(null)
    const action = ref('RESOLVE')
    const opinion = ref('')
    const submitting = ref(false)
    const canHandle = computed(() => {
      if (!userStore.isTeamMode || exception.value?.status !== 'OPEN') return false
      const membership = userStore.context.membership || {}
      if (exception.value.currentStage === 'TEAM_LEADER') return membership.positionKey === 'TEAM_LEADER'
      if (exception.value.currentStage === 'SUB_DEPARTMENT_MANAGER') {
        return membership.positionKey === 'SUB_DEPARTMENT_MANAGER'
      }
      return exception.value.currentStage === 'ASSET_ADMIN' &&
        membership.functionalRoleKeys?.includes('ASSET_ADMIN')
    })
    const load = async () => {
      if (!exceptionId.value) return
      const result = await getEquipmentRoutineException(
        exceptionId.value,
        teamId.value ? { teamId: teamId.value } : {}
      )
      exception.value = result.exception
      if (exception.value.currentStage === 'ASSET_ADMIN') action.value = 'RESOLVE'
    }
    const submit = async () => {
      if (!canHandle.value) return uni.showToast({ title: '没有本阶段处理权限', icon: 'none' })
      if (!opinion.value.trim()) return uni.showToast({ title: '请填写处理意见', icon: 'none' })
      submitting.value = true
      try {
        const result = await transitionEquipmentRoutineException(exception.value._id, {
          action: action.value,
          opinion: opinion.value.trim(),
          expectedRevision: exception.value.revision
        })
        exception.value = result.exception
        opinion.value = ''
        uni.showToast({ title: action.value === 'RESOLVE' ? '异常已解决' : '异常已升级', icon: 'success' })
      } catch (error) {
        if (error.code === 'EQUIPMENT_ROUTINE_REVISION_CONFLICT') await load()
      } finally {
        submitting.value = false
      }
    }
    const stageLabel = (value) => ({
      TEAM_LEADER: '班组长处理',
      SUB_DEPARTMENT_MANAGER: '分部经理处理',
      ASSET_ADMIN: '设备管理员处理',
      RESOLVED: '已解决'
    }[value] || value || '-')
    const actionLabel = (value) => ({ SUBMITTED: '提交异常', RESOLVE: '解决', ESCALATE: '升级' }[value] || value)
    const formatTime = (value) => value ? String(value).replace('T', ' ').slice(0, 16) : '-'
    onLoad((options) => {
      exceptionId.value = options.exceptionId || ''
      teamId.value = options.teamId || ''
    })
    onShow(load)
    return { exception, action, opinion, submitting, canHandle, submit, stageLabel, actionLabel, formatTime }
  }
}
</script>

<style scoped lang="scss">
.exception-page { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #eef3fb; }
.asset-band, .history-band, .action-band, .permission-band { border: 1px solid #dce4ee; border-radius: 8rpx; background: #fff; }
.asset-band, .history-band, .action-band { padding: 24rpx; }
.history-band, .action-band, .permission-band { margin-top: 20rpx; }
.heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16rpx; }
.heading-row > view { display: grid; gap: 6rpx; min-width: 0; }
.heading-row strong { color: #1f2733; font-size: 31rpx; overflow-wrap: anywhere; }
.heading-row view text, .stage { color: #64748b; font-size: 23rpx; }
.summary, .stage { display: block; margin-top: 18rpx; overflow-wrap: anywhere; }
.summary { color: #344054; font-size: 26rpx; line-height: 1.6; }
.danger-tag, .success-tag { flex: 0 0 auto; padding: 6rpx 10rpx; border-radius: 6rpx; font-size: 21rpx; }
.danger-tag { color: #b42318; background: #feeceb; }
.success-tag { color: #245d3f; background: #eaf7ef; }
.section-title { display: block; margin-bottom: 16rpx; color: #1f2733; font-size: 27rpx; font-weight: 700; }
.history-row { display: grid; gap: 7rpx; padding: 18rpx 0; border-top: 1px solid #e8edf3; }
.history-row strong { color: #344054; font-size: 25rpx; }
.history-row text { color: #52606d; font-size: 24rpx; overflow-wrap: anywhere; }
.history-row small { color: #94a3b8; font-size: 21rpx; }
.action-options { display: grid; grid-template-columns: 1fr 1fr; gap: 12rpx; }
.action-options button { height: 70rpx; line-height: 70rpx; margin: 0; padding: 0; border-radius: 8rpx; font-size: 24rpx; }
.action-options button.active { color: #fff; background: #1677ff; }
.action-band textarea { width: 100%; min-height: 180rpx; margin-top: 16rpx; padding: 16rpx; box-sizing: border-box; border: 1px solid #dce4ee; border-radius: 8rpx; background: #f7f9fb; font-size: 25rpx; }
.submit-button { height: 80rpx; line-height: 80rpx; margin: 18rpx 0 0; border-radius: 8rpx; color: #fff; background: #1677ff; font-size: 26rpx; }
.permission-band { padding: 22rpx 24rpx; color: #8a5a00; background: #fff8e6; font-size: 24rpx; line-height: 1.6; }
</style>
