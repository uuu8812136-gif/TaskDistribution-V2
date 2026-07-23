<template>
  <div class="repair-detail">
    <header class="detail-heading">
      <div class="heading-copy">
        <el-button circle aria-label="返回维修列表" @click="router.back()">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ repair?.equipmentSnapshot?.name || '设备维修单' }}</h1>
          <p>{{ repair?.equipmentSnapshot?.assetCode || '-' }} · {{ repairTypeLabel(repair?.type) }}</p>
        </div>
      </div>
      <el-tag v-if="repair" :type="repairStatusTone(repair.status)" size="large">
        {{ repairStatusLabel(repair.status) }}
      </el-tag>
    </header>

    <div v-loading="loading" class="detail-body">
      <template v-if="repair">
        <section class="info-band">
          <h2>设备归属</h2>
          <el-descriptions :column="3" border>
            <el-descriptions-item label="部门">{{ repair.equipmentSnapshot?.departmentName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="分部">{{ repair.equipmentSnapshot?.orgUnitName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="设备编码">{{ repair.equipmentSnapshot?.assetCode || '-' }}</el-descriptions-item>
            <el-descriptions-item label="设备名称">{{ repair.equipmentSnapshot?.name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="存放地点">{{ repair.equipmentSnapshot?.location || '-' }}</el-descriptions-item>
            <el-descriptions-item label="车牌号">{{ repair.equipmentSnapshot?.plateNumber || '-' }}</el-descriptions-item>
          </el-descriptions>
        </section>

        <section class="info-band">
          <h2>{{ repair.type === 'FAULT_REPORT' ? '故障报修信息' : '维修信息' }}</h2>
          <el-descriptions v-if="repair.type === 'FAULT_REPORT'" :column="3" border>
            <el-descriptions-item label="报修时间">{{ displayTime(repair.reportTime) }}</el-descriptions-item>
            <el-descriptions-item label="报修地点">{{ repair.reportLocation || '-' }}</el-descriptions-item>
            <el-descriptions-item label="车牌号">{{ repair.plateNumber || '-' }}</el-descriptions-item>
            <el-descriptions-item label="联系人">{{ repair.contactName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="联系电话">{{ repair.contactPhone || '-' }}</el-descriptions-item>
            <el-descriptions-item label="故障描述" :span="3">{{ repair.faultDescription || '-' }}</el-descriptions-item>
          </el-descriptions>
          <el-descriptions v-else :column="3" border>
            <el-descriptions-item label="维修日期">{{ displayDate(repair.repairDate) }}</el-descriptions-item>
            <el-descriptions-item label="维修人">{{ repair.repairerName || '-' }}</el-descriptions-item>
            <el-descriptions-item label="维修说明" :span="3">{{ repair.repairDescription || '-' }}</el-descriptions-item>
          </el-descriptions>
        </section>

        <section v-if="repair.type === 'FAULT_REPORT'" class="info-band">
          <h2>现场照片（{{ repair.photoAttachments.length }}）</h2>
          <AuthenticatedAttachments :attachments="repair.photoAttachments" :team-id="teamId" />
        </section>

        <section v-if="repair.type === 'PARTS_REPAIR'" class="info-band">
          <div class="section-heading">
            <h2>配件明细</h2>
            <strong>合计 ¥{{ repair.totalAmount.toFixed(2) }}</strong>
          </div>
          <el-table :data="repair.partItems" row-key="itemKey" border>
            <el-table-column prop="name" label="配件名称" min-width="160" />
            <el-table-column prop="specification" label="规格型号" min-width="150" />
            <el-table-column prop="remark" label="备注" min-width="160" />
            <el-table-column label="数量" width="100" align="right">
              <template #default="{ row }">{{ row.quantity ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="单价" width="120" align="right">
              <template #default="{ row }">{{ row.unitPrice == null ? '-' : `¥${row.unitPrice.toFixed(2)}` }}</template>
            </el-table-column>
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">{{ row.amount == null ? '-' : `¥${row.amount.toFixed(2)}` }}</template>
            </el-table-column>
          </el-table>
        </section>

        <section v-if="repair.availableActions.length" class="action-band">
          <h2>当前可处理</h2>
          <div class="action-buttons">
            <el-button
              v-for="action in repair.availableActions"
              :key="action"
              :type="REPAIR_ACTION_TONES[action] || 'primary'"
              :plain="Boolean(REPAIR_ACTION_TONES[action])"
              @click="openAction(action)"
            >
              {{ repairActionLabel(action) }}
            </el-button>
          </div>
        </section>

        <section class="info-band">
          <h2>流程记录</h2>
          <el-timeline>
            <el-timeline-item
              v-for="item in [...repair.actionLogs].reverse()"
              :key="item._id"
              :timestamp="displayTime(item.actedAt)"
              placement="top"
            >
              <div class="timeline-content">
                <strong>{{ repairActionLabel(item.action) }}</strong>
                <span>{{ repairStatusLabel(item.fromStatus) }} → {{ repairStatusLabel(item.toStatus) }}</span>
                <p v-if="item.note">{{ item.note }}</p>
                <small>{{ item.actorPositionKey || '用户' }} · {{ shortId(item.actorId) }}</small>
              </div>
            </el-timeline-item>
          </el-timeline>
        </section>
      </template>
    </div>

    <el-dialog
      v-model="actionVisible"
      :title="repairActionLabel(selectedAction)"
      width="min(820px, 96vw)"
      destroy-on-close
      append-to-body
    >
      <el-form label-position="top">
        <template v-if="showRepairCorrections">
          <div class="form-grid">
            <el-form-item label="维修日期" required>
              <el-date-picker v-model="actionForm.repairDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
            </el-form-item>
            <el-form-item label="维修人" required>
              <el-input v-model="actionForm.repairerName" maxlength="200" />
            </el-form-item>
          </div>
          <el-form-item label="维修说明">
            <el-input v-model="actionForm.repairDescription" type="textarea" :rows="3" maxlength="5000" show-word-limit />
          </el-form-item>
          <section v-if="repair.type === 'PARTS_REPAIR'" class="parts-editor">
            <div class="section-heading">
              <h3>配件明细</h3>
              <el-button type="primary" plain @click="addCorrectionPart">
                <el-icon><Plus /></el-icon>
                添加配件
              </el-button>
            </div>
            <el-table :data="actionForm.partItems" row-key="itemKey" border>
              <el-table-column label="配件名称" min-width="160">
                <template #default="{ row }"><el-input v-model="row.name" /></template>
              </el-table-column>
              <el-table-column label="规格型号" min-width="140">
                <template #default="{ row }"><el-input v-model="row.specification" /></template>
              </el-table-column>
              <el-table-column label="备注" min-width="140">
                <template #default="{ row }"><el-input v-model="row.remark" /></template>
              </el-table-column>
              <el-table-column label="操作" width="66" align="center">
                <template #default="{ $index }">
                  <el-button text type="danger" :disabled="actionForm.partItems.length <= 1" @click="removeCorrectionPart($index)">
                    <el-icon><Delete /></el-icon>
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>

        <template v-if="showFaultResubmit">
          <div class="form-grid">
            <el-form-item label="报修时间" required>
              <el-date-picker v-model="actionForm.reportTime" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" class="full-width" />
            </el-form-item>
            <el-form-item label="报修地点" required><el-input v-model="actionForm.reportLocation" /></el-form-item>
            <el-form-item label="车牌号"><el-input v-model="actionForm.plateNumber" /></el-form-item>
            <el-form-item label="联系人" required><el-input v-model="actionForm.contactName" /></el-form-item>
            <el-form-item label="联系电话" required><el-input v-model="actionForm.contactPhone" /></el-form-item>
          </div>
          <el-form-item label="故障描述" required>
            <el-input v-model="actionForm.faultDescription" type="textarea" :rows="4" maxlength="5000" />
          </el-form-item>
          <el-alert title="重新提交时保留原现场照片" type="info" :closable="false" show-icon />
        </template>

        <template v-if="showPricing">
          <el-table :data="actionForm.partItems" row-key="itemKey" border>
            <el-table-column prop="name" label="配件名称" min-width="160" />
            <el-table-column prop="specification" label="规格型号" min-width="140" />
            <el-table-column label="数量" min-width="140">
              <template #default="{ row }">
                <el-input-number v-model="row.quantity" :min="0.000001" :max="1000000000" :precision="3" controls-position="right" class="full-width" />
              </template>
            </el-table-column>
            <el-table-column label="单价（元）" min-width="150">
              <template #default="{ row }">
                <el-input-number v-model="row.unitPrice" :min="0" :precision="2" controls-position="right" class="full-width" />
              </template>
            </el-table-column>
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">¥{{ lineAmount(row).toFixed(2) }}</template>
            </el-table-column>
          </el-table>
          <div class="pricing-total">合计 ¥{{ pricingTotal.toFixed(2) }}</div>
        </template>

        <el-form-item :label="noteLabel" :required="noteRequired" class="action-note">
          <el-input v-model="actionForm.note" type="textarea" :rows="3" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionVisible = false">取消</el-button>
        <el-button
          :type="REPAIR_ACTION_TONES[selectedAction] || 'primary'"
          :loading="submitting"
          @click="submitAction"
        >
          确认
        </el-button>
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
import { requestErrorMessage } from '@/utils/request'
import { getEquipmentRepair, transitionEquipmentRepair } from '@/api/equipment'
import {
  REPAIR_ACTION_TONES,
  emptyRepairPart,
  repairActionLabel,
  repairStatusLabel,
  repairStatusTone,
  repairTypeLabel
} from '@/utils/equipmentRepair'

const route = useRoute()
const router = useRouter()
const repair = ref(null)
const loading = ref(false)
const submitting = ref(false)
const actionVisible = ref(false)
const selectedAction = ref('')
const actionForm = reactive(emptyActionForm())
const teamId = computed(() => String(route.query.teamId || ''))
const showPricing = computed(() => selectedAction.value === 'CONFIRM_PRICING')
const showRepairCorrections = computed(() => (
  repair.value?.type !== 'FAULT_REPORT' &&
  (selectedAction.value === 'SUB_DEPARTMENT_APPROVE' || selectedAction.value === 'RESUBMIT')
))
const showFaultResubmit = computed(() => (
  repair.value?.type === 'FAULT_REPORT' && selectedAction.value === 'RESUBMIT'
))
const noteRequired = computed(() => [
  'DEPUTY_APPROVE',
  'MANAGER_APPROVE',
  'REJECT_TO_CREATOR',
  'REJECT_TO_PREVIOUS',
  'VOID'
].includes(selectedAction.value))
const noteLabel = computed(() => (
  selectedAction.value === 'DEPUTY_APPROVE' || selectedAction.value === 'MANAGER_APPROVE'
    ? '审批意见'
    : '处理说明'
))
const pricingTotal = computed(() => actionForm.partItems.reduce((sum, item) => sum + lineAmount(item), 0))

function emptyActionForm() {
  return {
    note: '',
    reportTime: '',
    reportLocation: '',
    plateNumber: '',
    contactName: '',
    contactPhone: '',
    faultDescription: '',
    repairDate: '',
    repairerName: '',
    repairDescription: '',
    partItems: []
  }
}

const displayDate = (value) => value ? dayjs(value).format('YYYY-MM-DD') : '-'
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const shortId = (value) => value ? `用户 ${String(value).slice(-6)}` : '-'
const lineAmount = (row) => Math.round((Number(row.quantity) || 0) * (Number(row.unitPrice) || 0) * 100) / 100

async function loadRepair() {
  loading.value = true
  try {
    const result = await getEquipmentRepair(route.params.repairId, teamId.value ? { teamId: teamId.value } : {})
    repair.value = result.repair
  } finally {
    loading.value = false
  }
}

function openAction(action) {
  selectedAction.value = action
  Object.assign(actionForm, emptyActionForm(), {
    reportTime: repair.value.reportTime ? dayjs(repair.value.reportTime).format('YYYY-MM-DDTHH:mm:ssZ') : '',
    reportLocation: repair.value.reportLocation,
    plateNumber: repair.value.plateNumber,
    contactName: repair.value.contactName,
    contactPhone: repair.value.contactPhone,
    faultDescription: repair.value.faultDescription,
    repairDate: repair.value.repairDate ? dayjs(repair.value.repairDate).format('YYYY-MM-DD') : '',
    repairerName: repair.value.repairerName,
    repairDescription: repair.value.repairDescription,
    partItems: repair.value.partItems.map((item) => ({
      ...item,
      quantity: item.quantity ?? 1,
      unitPrice: item.unitPrice ?? 0
    }))
  })
  actionVisible.value = true
}

function addCorrectionPart() {
  if (actionForm.partItems.length >= 100) return ElMessage.warning('最多添加100条配件明细')
  actionForm.partItems.push(emptyRepairPart(actionForm.partItems.length))
}

function removeCorrectionPart(index) {
  if (actionForm.partItems.length > 1) actionForm.partItems.splice(index, 1)
}

function validateAction() {
  if (noteRequired.value && !actionForm.note.trim()) return '请填写处理意见'
  if (showPricing.value && actionForm.partItems.some((item) => !(Number(item.quantity) > 0) || Number(item.unitPrice) < 0)) {
    return '请填写每条配件的有效数量和单价'
  }
  if (showRepairCorrections.value) {
    if (!actionForm.repairDate || !actionForm.repairerName.trim()) return '请填写维修日期和维修人'
    if (repair.value.type === 'PARTS_REPAIR' && actionForm.partItems.some((item) => !item.name.trim())) {
      return '请填写每条配件名称'
    }
  }
  if (showFaultResubmit.value && (!actionForm.reportTime || !actionForm.reportLocation.trim() ||
      !actionForm.contactName.trim() || !actionForm.contactPhone.trim() || !actionForm.faultDescription.trim())) {
    return '请完整填写故障报修信息'
  }
  return ''
}

function actionPayload() {
  const payload = {
    action: selectedAction.value,
    revision: repair.value.revision,
    note: actionForm.note
  }
  if (showPricing.value) {
    payload.partItems = actionForm.partItems.map((item) => ({
      itemKey: item.itemKey,
      quantity: item.quantity,
      unitPrice: item.unitPrice
    }))
  }
  if (showRepairCorrections.value) {
    payload.corrections = {
      repairDate: actionForm.repairDate,
      repairerName: actionForm.repairerName,
      repairDescription: actionForm.repairDescription,
      ...(repair.value.type === 'PARTS_REPAIR'
        ? {
            partItems: actionForm.partItems.map((item) => ({
              itemKey: item.itemKey,
              name: item.name,
              specification: item.specification,
              remark: item.remark
            }))
          }
        : {})
    }
  }
  if (showFaultResubmit.value) {
    payload.corrections = {
      reportTime: actionForm.reportTime,
      reportLocation: actionForm.reportLocation,
      plateNumber: actionForm.plateNumber,
      contactName: actionForm.contactName,
      contactPhone: actionForm.contactPhone,
      faultDescription: actionForm.faultDescription
    }
  }
  return payload
}

async function submitAction() {
  const validationMessage = validateAction()
  if (validationMessage) return ElMessage.warning(validationMessage)
  submitting.value = true
  try {
    const result = await transitionEquipmentRepair(repair.value._id, actionPayload())
    repair.value = result.repair
    actionVisible.value = false
    ElMessage.success('维修流程已更新')
  } catch (error) {
    if (error.code === 'EQUIPMENT_REPAIR_CONFLICT') await loadRepair()
    console.error('维修流程处理失败:', error)
    ElMessage.error(requestErrorMessage(error, '维修流程处理失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

onMounted(loadRepair)
</script>

<style scoped>
.repair-detail { display: grid; gap: 18px; }
.detail-heading, .heading-copy, .section-heading, .action-buttons { display: flex; align-items: center; gap: 12px; }
.detail-heading { justify-content: space-between; }
.heading-copy { min-width: 0; }
.heading-copy h1 { margin: 0; color: #1f2733; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.heading-copy p { margin: 5px 0 0; color: #667085; overflow-wrap: anywhere; }
.detail-body { display: grid; gap: 22px; min-height: 240px; }
.info-band, .action-band { padding-top: 18px; border-top: 1px solid #dce4ee; }
.info-band h2, .action-band h2 { margin: 0 0 12px; color: #1f2733; font-size: 17px; letter-spacing: 0; }
.section-heading { justify-content: space-between; }
.section-heading strong { color: #245d3f; }
.action-band { border-top-color: #9cc7ad; }
.action-buttons { flex-wrap: wrap; }
.timeline-content { display: grid; gap: 5px; color: #344054; }
.timeline-content span, .timeline-content small { color: #667085; }
.timeline-content p { margin: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.full-width { width: 100%; }
.parts-editor { margin-bottom: 16px; }
.parts-editor .section-heading { margin-bottom: 10px; }
.parts-editor h3 { margin: 0; font-size: 15px; letter-spacing: 0; }
.pricing-total { padding: 12px 0 0; color: #245d3f; text-align: right; font-size: 17px; font-weight: 700; }
.action-note { margin-top: 16px; }
@media (max-width: 768px) {
  .detail-heading { align-items: flex-start; flex-direction: column; }
  .form-grid { grid-template-columns: 1fr; }
  :deep(.el-descriptions__body) { overflow-x: auto; }
}
</style>
