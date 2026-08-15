<template>
  <div class="scan-landing-page">
    <header class="page-heading">
      <div>
        <h1>扫码查设备</h1>
        <p>正在按当前账号权限识别设备。</p>
      </div>
    </header>

    <section v-if="loading" class="scan-state" aria-live="polite">
      <el-icon class="is-loading" aria-hidden="true"><Loading /></el-icon>
      <div>
        <strong>{{ loadingTitle }}</strong>
        <span>请稍候，不要重复扫描。</span>
      </div>
    </section>

    <section v-else class="scan-state scan-state--error" role="alert">
      <el-icon aria-hidden="true"><WarningFilled /></el-icon>
      <div>
        <strong>{{ errorTitle }}</strong>
        <span>{{ errorMessage }}</span>
        <div class="state-actions">
          <el-button v-if="canSelectTeam" type="primary" @click="openTeamSelection">
            选择项目团队
          </el-button>
          <el-button :loading="retrying" @click="resolveEquipment">重新识别</el-button>
          <el-button @click="router.replace({ name: 'Equipment' })">返回设备台账</el-button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getEquipmentByQrToken } from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import {
  EQUIPMENT_QR_TOKEN_PATTERN,
  EQUIPMENT_SCAN_CONTEXT_STATUS,
  resolveEquipmentScanContext
} from '@/utils/equipmentQr'
import { teamSelectionLocation } from '@/utils/internalRedirect'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loading = ref(true)
const retrying = ref(false)
const loadingTitle = ref('正在识别二维码')
const errorTitle = ref('无法识别设备')
const errorMessage = ref('请重新扫描设备二维码。')
const errorCode = ref('')

const canSelectTeam = computed(() => [
  EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_REQUIRED,
  EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_SELECTION_REQUIRED
].includes(errorCode.value))

function setError(code, title, message) {
  errorCode.value = code
  errorTitle.value = title
  errorMessage.value = message
}

function requestedTeamId() {
  return Object.prototype.hasOwnProperty.call(route.query, 'teamId')
    ? route.query.teamId
    : undefined
}

async function refreshAccessibleTeamsIfNeeded(teamId) {
  if (!teamId || session.teams.some((team) => team._id === teamId)) return
  try {
    await session.refreshTeams()
  } catch {
    // The context resolver below fails closed if accessibility cannot be verified.
  }
}

async function resolveEquipment() {
  if (retrying.value) return
  retrying.value = true
  loading.value = true
  loadingTitle.value = '正在识别二维码'
  errorCode.value = ''

  try {
    const qrToken = typeof route.params.qrToken === 'string' ? route.params.qrToken.trim() : ''
    if (!EQUIPMENT_QR_TOKEN_PATTERN.test(qrToken)) {
      setError('INVALID_QR', '二维码格式无效', '该二维码不是系统生成的设备二维码。')
      return
    }

    const requested = requestedTeamId()
    if (typeof requested === 'string') await refreshAccessibleTeamsIfNeeded(requested.toLowerCase())

    let context = resolveEquipmentScanContext({
      mode: session.mode,
      activeTeamId: session.activeTeamId,
      requestedTeamId: requested,
      accessibleTeamIds: session.teams.map((team) => team._id)
    })

    if (context.status === EQUIPMENT_SCAN_CONTEXT_STATUS.INVALID_TEAM) {
      setError(context.status, '项目团队无效', '二维码中的项目团队信息无效，请重新生成二维码。')
      return
    }
    if (context.status === EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_FORBIDDEN) {
      setError(context.status, '无法进入所属团队', '当前账号没有该项目团队的访问权限。')
      return
    }
    if (context.status === EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_REQUIRED) {
      setError(context.status, '请选择项目团队', '需要先进入二维码所属的项目团队，再查询设备。')
      return
    }
    if (context.status === EQUIPMENT_SCAN_CONTEXT_STATUS.TEAM_SELECTION_REQUIRED) {
      setError(context.status, '请选择项目团队', '需要先选择项目团队，再查询设备。')
      return
    }

    if (context.switchTeamId) {
      loadingTitle.value = '正在进入设备所属团队'
      await session.switchTeam(context.switchTeamId)
      context = resolveEquipmentScanContext({
        mode: session.mode,
        activeTeamId: session.activeTeamId,
        requestedTeamId: context.teamId,
        accessibleTeamIds: session.teams.map((team) => team._id)
      })
      if (context.status !== EQUIPMENT_SCAN_CONTEXT_STATUS.READY) {
        setError('TEAM_SWITCH_FAILED', '无法进入所属团队', '项目团队上下文未能切换，请重新选择团队。')
        return
      }
    }

    loadingTitle.value = '正在加载设备资料'
    const result = await getEquipmentByQrToken(qrToken, context.requestParams)
    const equipmentId = result?.equipment?._id
    if (!equipmentId) {
      setError('EQUIPMENT_NOT_FOUND', '未找到设备', '设备不存在，或当前账号无权查看该设备。')
      return
    }

    await router.replace({
      name: 'EquipmentDetail',
      params: { id: equipmentId },
      ...(session.isGlobalReadOnly ? { query: { teamId: context.teamId } } : {})
    })
  } catch (error) {
    const status = Number(error?.response?.status || error?.statusCode || error?.status)
    if ([403, 404].includes(status)) {
      setError('EQUIPMENT_NOT_FOUND', '未找到设备', '设备不存在，或当前账号无权查看该设备。')
    } else {
      setError('LOOKUP_FAILED', '设备查询失败', '网络或登录状态异常，请稍后重新识别。')
    }
  } finally {
    loading.value = false
    retrying.value = false
  }
}

function openTeamSelection() {
  router.replace(teamSelectionLocation(route.fullPath))
}

onMounted(resolveEquipment)
</script>

<style scoped lang="scss">
.scan-landing-page {
  min-width: 0;
}

.page-heading {
  margin-bottom: 20px;
  border-bottom: 1px solid var(--zl-border-soft);
  padding-bottom: 16px;
}

.page-heading h1 {
  margin: 0 0 6px;
  font-size: 24px;
  letter-spacing: 0;
}

.page-heading p {
  margin: 0;
  color: var(--zl-muted);
}

.scan-state {
  min-height: 132px;
  padding: 22px 0;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  align-items: start;
  gap: 14px;
  border-block: 1px solid var(--zl-border-soft);
}

.scan-state > .el-icon {
  margin-top: 2px;
  color: var(--el-color-primary);
  font-size: 28px;
}

.scan-state--error > .el-icon {
  color: var(--el-color-warning);
}

.scan-state strong,
.scan-state span {
  display: block;
}

.scan-state strong {
  margin-bottom: 8px;
  color: var(--zl-text);
  font-size: 17px;
}

.scan-state span {
  color: var(--zl-muted);
  overflow-wrap: anywhere;
}

.state-actions {
  margin-top: 18px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 560px) {
  .scan-state {
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
  }

  .state-actions .el-button {
    margin-left: 0;
  }
}
</style>
