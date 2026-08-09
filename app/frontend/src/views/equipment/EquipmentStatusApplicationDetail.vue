<template>
  <div class="status-application-detail">
    <header class="page-heading">
      <div class="heading-copy">
        <el-button circle aria-label="返回申请列表" @click="router.back()">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ application?.equipmentSnapshot?.name || '设备状态申请' }}</h1>
          <p>{{ application?.equipmentSnapshot?.assetCode || '-' }} · {{ statusApplicationTypeLabel(application?.applicationType) }}</p>
        </div>
      </div>
      <el-tag v-if="application" :type="statusApplicationWorkflowTone(application.workflowStatus)" size="large">
        {{ statusApplicationWorkflowLabel(application.workflowStatus) }}
      </el-tag>
    </header>

    <div v-loading="loading" class="detail-body">
      <template v-if="application">
        <section class="info-band">
          <h2>设备与状态快照</h2>
          <el-descriptions :column="3" border>
            <el-descriptions-item label="设备编号">{{ application.equipmentSnapshot?.assetCode || '-' }}</el-descriptions-item>
            <el-descriptions-item label="设备名称">{{ application.equipmentSnapshot?.name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="所属分部">{{ application.equipmentSnapshot?.orgUnitName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="原状态">{{ equipmentStatusLabel(application.sourceStatus) }}</el-descriptions-item>
            <el-descriptions-item label="目标状态">{{ equipmentStatusLabel(application.targetStatus) }}</el-descriptions-item>
            <el-descriptions-item label="申请版本">{{ application.revision }}</el-descriptions-item>
            <el-descriptions-item label="申请原因" :span="3">{{ application.reason }}</el-descriptions-item>
          </el-descriptions>
        </section>

        <el-alert
          class="retention-notice"
          title="申请不支持删除；填写有误时，原发起设备管理员可在申请结束前选择“作废申请”。"
          type="info"
          :closable="false"
          show-icon
        />

        <section v-if="application.attachments.length" class="info-band">
          <h2>申请附件（{{ application.attachments.length }}）</h2>
          <AuthenticatedAttachments :attachments="application.attachments" :team-id="teamId" />
        </section>

        <section v-if="application.availableActions.length" class="action-band">
          <h2>当前可处理</h2>
          <div class="action-buttons">
            <el-button
              v-for="action in application.availableActions"
              :key="action"
              :type="statusApplicationActionTone(action)"
              :plain="action !== 'REJECT' && action !== 'VOID'"
              @click="openAction(action)"
            >
              {{ statusApplicationActionLabel(action) }}
            </el-button>
          </div>
        </section>

        <section class="info-band">
          <h2>审批历史</h2>
          <el-timeline>
            <el-timeline-item
              v-for="item in [...approvals].reverse()"
              :key="item._id"
              :timestamp="displayTime(item.actedAt)"
              placement="top"
            >
              <div class="timeline-content">
                <strong>{{ statusApplicationActionLabel(item.action) }}</strong>
                <span>{{ statusApplicationWorkflowLabel(item.fromStatus) }} → {{ statusApplicationWorkflowLabel(item.toStatus) }}</span>
                <p v-if="item.opinion">{{ item.opinion }}</p>
                <small>{{ positionLabel(item.actorPositionKey) }} · 用户 {{ String(item.actorId).slice(-6) }} · 版本 {{ item.applicationRevision }}</small>
              </div>
            </el-timeline-item>
          </el-timeline>
        </section>
      </template>
      <el-result
        v-else-if="loadError"
        icon="error"
        title="状态申请加载失败"
        :sub-title="loadError"
      >
        <template #extra><el-button type="primary" @click="load">重新加载</el-button></template>
      </el-result>
      <el-empty v-else-if="!loading" description="状态申请不存在或当前账号无权查看" :image-size="88">
        <el-button @click="router.back()">返回申请列表</el-button>
      </el-empty>
    </div>

    <el-dialog v-model="actionVisible" :title="statusApplicationActionLabel(selectedAction)" width="min(680px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <template v-if="selectedAction === 'RESUBMIT'">
          <el-form-item label="申请原因" required>
            <el-input v-model="actionForm.reason" type="textarea" :rows="5" maxlength="5000" show-word-limit />
          </el-form-item>
          <el-form-item label="附件（最多10个，支持 JPG、PNG、PDF）">
            <el-upload v-model:file-list="actionForm.files" :auto-upload="false" multiple :limit="10">
              <el-button>选择附件</el-button>
            </el-upload>
          </el-form-item>
        </template>
        <el-form-item :label="selectedAction === 'RESUBMIT' ? '重提说明（选填）' : '处理意见'" :required="selectedAction !== 'RESUBMIT'">
          <el-input v-model="actionForm.opinion" type="textarea" :rows="4" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionVisible = false">取消</el-button>
        <el-button :type="statusApplicationActionTone(selectedAction)" :loading="submitting" @click="submitAction">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import AuthenticatedAttachments from '@/components/AuthenticatedAttachments.vue'
import { getEquipmentStatusApplication, transitionEquipmentStatusApplication } from '@/api/equipment'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { cleanupTemporaryFiles, existingAttachmentFileList, prepareAttachmentReferences } from '@/utils/attachments'
import { requestErrorMessage } from '@/utils/request'
import {
  statusApplicationActionLabel,
  statusApplicationActionTone,
  statusApplicationTypeLabel,
  statusApplicationWorkflowLabel,
  statusApplicationWorkflowTone
} from '@/utils/equipmentStatusApplication'

const route = useRoute()
const router = useRouter()
const application = ref(null)
const approvals = ref([])
const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const actionVisible = ref(false)
const selectedAction = ref('')
const actionForm = reactive({ opinion: '', reason: '', files: [] })
const teamId = computed(() => String(route.query.teamId || ''))

const equipmentStatusLabel = (value) => ({ IN_USE: '在用', IDLE: '闲置', STOPPED: '停用', SCRAPPED: '报废' }[value] || value || '-')
const positionLabel = (value) => ({
  DEPARTMENT_DEPUTY_MANAGER: '部门副经理',
  DEPARTMENT_MANAGER_ASSISTANT: '部门经理助理',
  DEPARTMENT_MANAGER: '部门经理',
  EMPLOYEE: '设备管理员'
}[value] || value || '用户')
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

async function load() {
  loadError.value = ''
  loading.value = true
  try {
    const result = await getEquipmentStatusApplication(
      route.params.applicationId,
      teamId.value ? { teamId: teamId.value } : {}
    )
    application.value = result.application
    approvals.value = result.approvals || []
  } catch (error) {
    application.value = null
    approvals.value = []
    loadError.value = requestErrorMessage(error, '状态申请加载失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

function openAction(action) {
  selectedAction.value = action
  actionForm.opinion = ''
  actionForm.reason = application.value.reason
  actionForm.files = existingAttachmentFileList(application.value.attachments)
  actionVisible.value = true
}

async function submitAction() {
  if (selectedAction.value !== 'RESUBMIT' && !actionForm.opinion.trim()) {
    return ElMessage.warning('请填写处理意见')
  }
  if (selectedAction.value === 'RESUBMIT' && !actionForm.reason.trim()) {
    return ElMessage.warning('请填写申请原因')
  }
  submitting.value = true
  let uploadedFileIds = []
  try {
    const payload = {
      action: selectedAction.value,
      revision: application.value.revision,
      opinion: actionForm.opinion
    }
    if (selectedAction.value === 'RESUBMIT') {
      const prepared = await prepareAttachmentReferences(actionForm.files, uploadTemporaryFile)
      uploadedFileIds = prepared.uploadedFileIds
      payload.corrections = {
        reason: actionForm.reason,
        attachments: prepared.references
      }
    }
    const result = await transitionEquipmentStatusApplication(application.value._id, payload)
    uploadedFileIds = []
    application.value = result.application
    actionVisible.value = false
    await load()
    ElMessage.success('流程已更新')
  } catch (error) {
    await cleanupTemporaryFiles(uploadedFileIds, deleteFile)
    if (error.code === 'EQUIPMENT_STATUS_APPLICATION_CONFLICT') await load()
    console.error('设备状态申请处理失败:', error)
    ElMessage.error(requestErrorMessage(error, '设备状态申请处理失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.status-application-detail { display: grid; gap: 18px; }
.page-heading, .heading-copy, .action-buttons { display: flex; align-items: center; gap: 12px; }
.page-heading { justify-content: space-between; }
.heading-copy { min-width: 0; }
.heading-copy h1 { margin: 0; color: #1f2733; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.heading-copy p { margin: 5px 0 0; color: #667085; }
.detail-body { display: grid; gap: 22px; min-height: 240px; }
.retention-notice { margin-top: 14px; }
.info-band, .action-band { padding-top: 18px; border-top: 1px solid #dce4ee; }
.info-band h2, .action-band h2 { margin: 0 0 12px; color: #1f2733; font-size: 17px; letter-spacing: 0; }
.action-band { border-top-color: #9cc7ad; }
.action-buttons { flex-wrap: wrap; }
.timeline-content { display: grid; gap: 4px; }
.timeline-content strong { color: #1f2733; }
.timeline-content span, .timeline-content small { color: #667085; }
.timeline-content p { margin: 4px 0; white-space: pre-wrap; }
@media (max-width: 720px) {
  .page-heading { align-items: flex-start; }
  :deep(.el-descriptions__body .el-descriptions__table) { display: block; overflow-x: auto; }
}
</style>
