<template>
  <div class="inventory-detail-page">
    <header class="page-heading">
      <div class="heading-copy">
        <el-button text aria-label="返回盘点列表" @click="goBack">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ inventorySession?.name || '盘点批次详情' }}</h1>
          <p>{{ inventorySession?.orgUnitNameSnapshot || '-' }}</p>
        </div>
      </div>
      <div class="heading-actions">
        <el-button :loading="exporting" @click="handleExport">
          <el-icon><Download /></el-icon>
          导出明细
        </el-button>
        <el-button
          v-if="inventorySession?.canInventory"
          type="primary"
          :disabled="inventorySession.checkedCount !== inventorySession.itemCount"
          :loading="transitioning"
          @click="submitBatch"
        >
          <el-icon><Promotion /></el-icon>
          {{ inventorySession.status === 'RETURNED' ? '修订后重新提交' : '提交审核' }}
        </el-button>
        <el-button v-if="inventorySession?.canApprove" type="primary" @click="openReview">
          <el-icon><CircleCheck /></el-icon>
          审核
        </el-button>
      </div>
    </header>

    <section v-if="inventorySession" class="summary-band">
      <div>
        <span>流程状态</span>
        <el-tag :type="statusOption.type" effect="plain">{{ statusOption.label }}</el-tag>
      </div>
      <div>
        <span>审批轮次</span>
        <strong>第 {{ inventorySession.reviewRound }} 轮</strong>
      </div>
      <div>
        <span>盘点进度</span>
        <strong>{{ inventorySession.checkedCount }}/{{ inventorySession.itemCount }}</strong>
      </div>
      <div>
        <span>差异项</span>
        <strong :class="{ danger: inventorySession.differenceCount > 0 }">{{ inventorySession.differenceCount }}</strong>
      </div>
    </section>

    <el-alert
      v-if="inventorySession?.status === 'RETURNED'"
      type="warning"
      :closable="false"
      show-icon
      title="该批次已退回。盘点人需要修改明细后重新提交，新的审批轮次会从分部经理重新开始。"
    />

    <section class="table-shell">
      <div class="section-heading">
        <div>
          <h2>盘点明细</h2>
          <p>账面数据来自创建批次时的设备快照</p>
        </div>
        <el-button circle aria-label="刷新" :loading="loading" @click="loadDetail">
          <el-icon><Refresh /></el-icon>
        </el-button>
      </div>
      <el-table v-loading="loading" :data="items" row-key="_id" stripe empty-text="暂无盘点项">
        <el-table-column prop="assetCodeSnapshot" label="资产编码" min-width="140" fixed="left" />
        <el-table-column prop="equipmentNameSnapshot" label="设备名称" min-width="170" show-overflow-tooltip />
        <el-table-column prop="bookStatus" label="账面状态" width="100">
          <template #default="{ row }">{{ equipmentStatusLabel(row.bookStatus) }}</template>
        </el-table-column>
        <el-table-column label="实盘结果" min-width="130">
          <template #default="{ row }">
            <span v-if="row.actualPresent === null" class="muted">未盘点</span>
            <span v-else-if="row.actualPresent">存在 · {{ equipmentStatusLabel(row.actualStatus) }}</span>
            <el-tag v-else type="danger" effect="plain">未找到</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="账面/实盘数量" min-width="130" align="center">
          <template #default="{ row }">{{ row.bookQuantity ?? '-' }} / {{ row.actualQuantity ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="差异" min-width="190">
          <template #default="{ row }">
            <el-tag v-if="row.differenceTypes.length" type="danger" effect="plain">
              {{ inventoryDifferenceText(row.differenceTypes) }}
            </el-tag>
            <span v-else-if="row.checkedAt">账实一致</span>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="differenceNote" label="差异说明" min-width="180" show-overflow-tooltip />
        <el-table-column label="照片" width="80" align="center">
          <template #default="{ row }">{{ row.photoFileIds.length }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right" align="center">
          <template #default="{ row }">
            <el-button v-if="inventorySession?.canInventory" text type="primary" @click="openItem(row)">
              {{ row.checkedAt ? '修改' : '盘点' }}
            </el-button>
            <span v-else class="muted">已锁定</span>
          </template>
        </el-table-column>
      </el-table>
      <footer class="pagination-row">
        <span>共 {{ total }} 项</span>
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          layout="prev, pager, next, sizes"
          :page-sizes="[20, 50, 100, 200]"
          :total="total"
          @change="loadDetail"
        />
      </footer>
    </section>

    <section class="approval-section">
      <div class="section-heading">
        <div>
          <h2>审批记录</h2>
          <p>退回后保留旧轮次记录，新轮次重新走完整流程</p>
        </div>
      </div>
      <el-empty v-if="approvals.length === 0" description="尚未提交审批" :image-size="64" />
      <el-timeline v-else>
        <el-timeline-item
          v-for="approval in approvals"
          :key="approval._id"
          :type="approval.decision === 'RETURN' ? 'danger' : 'success'"
          :timestamp="displayTime(approval.createdAt)"
        >
          <strong>第{{ approval.reviewRound }}轮 · {{ stageLabel(approval.stage) }}</strong>
          <p>{{ approval.decision === 'RETURN' ? '退回修改' : approval.decision === 'SUBMIT' ? '提交审核' : '审核通过' }}</p>
          <p v-if="approval.comment" class="approval-comment">{{ approval.comment }}</p>
        </el-timeline-item>
      </el-timeline>
    </section>

    <el-dialog v-model="itemVisible" :title="itemForm.assetCode ? `盘点 ${itemForm.assetCode}` : '记录盘点结果'" width="min(680px, 94vw)">
      <el-form ref="itemFormRef" :model="itemForm" :rules="itemRules" label-width="110px">
        <el-form-item label="现场是否存在" prop="actualPresent">
          <el-segmented v-model="itemForm.actualPresent" :options="presenceOptions" block />
        </el-form-item>
        <template v-if="itemForm.actualPresent">
          <el-form-item label="实盘状态" prop="actualStatus">
            <el-select v-model="itemForm.actualStatus">
              <el-option v-for="item in EQUIPMENT_STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="实盘数量" prop="actualQuantity">
            <el-input-number v-model="itemForm.actualQuantity" :min="0" :precision="0" controls-position="right" />
          </el-form-item>
          <el-form-item label="实盘位置">
            <el-input v-model="itemForm.actualLocation" maxlength="500" />
          </el-form-item>
        </template>
        <el-form-item label="差异说明">
          <el-input v-model="itemForm.differenceNote" type="textarea" :rows="3" maxlength="5000" show-word-limit />
        </el-form-item>
        <el-form-item label="现场照片">
          <el-upload
            v-model:file-list="photoFileList"
            action="#"
            list-type="picture-card"
            accept="image/jpeg,image/png"
            :auto-upload="false"
            :limit="10"
            :on-exceed="handlePhotoExceed"
          >
            <el-icon><Plus /></el-icon>
          </el-upload>
          <p class="field-hint">存在差异时至少上传1张照片，最多10张。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="itemVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingItem" @click="saveItem">保存盘点结果</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reviewVisible" title="盘点审批" width="min(520px, 92vw)">
      <el-form label-width="88px">
        <el-form-item label="处理结果">
          <el-segmented v-model="reviewForm.decision" :options="reviewOptions" block />
        </el-form-item>
        <el-form-item label="审批意见">
          <el-input v-model="reviewForm.comment" type="textarea" :rows="4" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :loading="transitioning" @click="submitReview">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  exportEquipmentInventorySession,
  getEquipmentInventorySession,
  reviewEquipmentInventorySession,
  submitEquipmentInventorySession,
  updateEquipmentInventoryItem
} from '@/api/equipment'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { cleanupTemporaryFiles, prepareAttachmentReferences } from '@/utils/attachments'
import {
  EQUIPMENT_STATUS_OPTIONS,
  INVENTORY_STAGE_LABELS,
  buildInventoryItemPayload,
  equipmentStatusLabel,
  inventoryDifferenceText,
  inventoryStatusOption,
  saveInventoryWorkbook
} from '@/utils/equipmentInventory'

const route = useRoute()
const router = useRouter()
const inventorySession = ref(null)
const items = ref([])
const approvals = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(100)
const loading = ref(false)
const exporting = ref(false)
const savingItem = ref(false)
const transitioning = ref(false)
const itemVisible = ref(false)
const reviewVisible = ref(false)
const itemFormRef = ref(null)
const photoFileList = ref([])
const itemForm = reactive(emptyItemForm())
const reviewForm = reactive({ decision: 'APPROVE', comment: '' })
const requestTeamParams = computed(() => route.query.teamId ? { teamId: String(route.query.teamId) } : {})
const statusOption = computed(() => inventoryStatusOption(inventorySession.value?.status))
const presenceOptions = [
  { label: '现场存在', value: true },
  { label: '现场未找到', value: false }
]
const reviewOptions = [
  { label: '审核通过', value: 'APPROVE' },
  { label: '退回修改', value: 'RETURN' }
]
const itemRules = {
  actualPresent: [{ required: true, message: '请选择现场是否存在', trigger: 'change' }],
  actualStatus: [{ required: true, message: '请选择实盘状态', trigger: 'change' }],
  actualQuantity: [{ required: true, message: '请输入实盘数量', trigger: 'change' }]
}

function emptyItemForm() {
  return {
    _id: '',
    assetCode: '',
    actualPresent: true,
    actualStatus: 'IN_USE',
    actualQuantity: 1,
    actualLocation: '',
    differenceNote: '',
    expectedVersion: 0
  }
}

const displayTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-'
const stageLabel = (value) => INVENTORY_STAGE_LABELS[value] || value || '-'

async function loadDetail() {
  loading.value = true
  try {
    const result = await getEquipmentInventorySession(route.params.inventorySessionId, {
      ...requestTeamParams.value,
      page: page.value,
      pageSize: pageSize.value
    })
    inventorySession.value = result.inventorySession
    items.value = result.items || []
    approvals.value = result.approvals || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

function goBack() {
  router.push({ name: 'EquipmentInventories', query: requestTeamParams.value })
}

function openItem(item) {
  Object.assign(itemForm, {
    _id: item._id,
    assetCode: item.assetCodeSnapshot,
    actualPresent: item.actualPresent ?? true,
    actualStatus: item.actualStatus || item.bookStatus,
    actualQuantity: item.actualQuantity ?? item.bookQuantity ?? 1,
    actualLocation: item.actualLocation || item.bookLocation || '',
    differenceNote: item.differenceNote || '',
    expectedVersion: item.version
  })
  photoFileList.value = item.photoFileIds.map((fileId, index) => ({
    uid: fileId,
    fileId,
    name: `现场照片${index + 1}`,
    status: 'success'
  }))
  itemVisible.value = true
}

function handlePhotoExceed() {
  ElMessage.warning('现场照片最多10张')
}

async function saveItem() {
  const valid = await itemFormRef.value?.validate().catch(() => false)
  if (!valid) return
  savingItem.value = true
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(photoFileList.value, uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    await updateEquipmentInventoryItem(
      inventorySession.value._id,
      itemForm._id,
      buildInventoryItemPayload(itemForm, prepared.references.map(({ fileId }) => fileId))
    )
    uploadedFileIds = []
    ElMessage.success('盘点结果已保存')
    itemVisible.value = false
    await loadDetail()
  } catch (error) {
    await cleanupTemporaryFiles(
      [...uploadedFileIds, ...(error.uploadedFileIds || [])],
      deleteFile
    )
    ElMessage.error(error.response?.data?.message || error.message || '盘点结果保存失败')
  } finally {
    savingItem.value = false
  }
}

async function submitBatch() {
  let promptResult
  try {
    promptResult = await ElMessageBox.prompt(
      inventorySession.value.status === 'RETURNED' ? '确认修订内容并重新提交完整审批流程。' : '提交后盘点明细将锁定。',
      '提交盘点批次',
      { inputType: 'textarea', inputPlaceholder: '提交说明（可选）', confirmButtonText: '确认提交' }
    )
  } catch {
    return
  }
  const value = promptResult.value || ''
  transitioning.value = true
  try {
    await submitEquipmentInventorySession(inventorySession.value._id, {
      expectedVersion: inventorySession.value.version,
      comment: value.trim()
    })
    ElMessage.success('已提交审核')
    await loadDetail()
  } finally {
    transitioning.value = false
  }
}

function openReview() {
  Object.assign(reviewForm, { decision: 'APPROVE', comment: '' })
  reviewVisible.value = true
}

async function submitReview() {
  if (reviewForm.decision === 'RETURN' && !reviewForm.comment.trim()) {
    return ElMessage.warning('退回修改必须填写意见')
  }
  transitioning.value = true
  try {
    await reviewEquipmentInventorySession(inventorySession.value._id, {
      decision: reviewForm.decision,
      comment: reviewForm.comment.trim(),
      expectedVersion: inventorySession.value.version
    })
    ElMessage.success(reviewForm.decision === 'RETURN' ? '已退回盘点人修改' : '审核已通过')
    reviewVisible.value = false
    await loadDetail()
  } finally {
    transitioning.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const blob = await exportEquipmentInventorySession(inventorySession.value._id, requestTeamParams.value)
    saveInventoryWorkbook(blob, `${inventorySession.value.name}-盘点明细.xlsx`)
  } finally {
    exporting.value = false
  }
}

onMounted(loadDetail)
</script>

<style scoped>
.inventory-detail-page { min-width: 0; }
.page-heading, .heading-copy, .heading-actions, .section-heading, .pagination-row { display: flex; align-items: center; }
.page-heading { align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
.heading-copy { gap: 8px; }
.heading-copy h1, .section-heading h2 { margin: 0; color: #1f2733; letter-spacing: 0; }
.heading-copy h1 { font-size: 24px; }
.heading-copy p, .section-heading p { margin: 5px 0 0; color: #64748b; }
.heading-actions { flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.summary-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #dce4ee; border-bottom: 1px solid #dce4ee; margin-bottom: 16px; }
.summary-band > div { min-width: 0; padding: 16px; border-right: 1px solid #e8edf3; }
.summary-band > div:last-child { border-right: 0; }
.summary-band span, .summary-band strong { display: block; }
.summary-band span { margin-bottom: 8px; color: #64748b; font-size: 13px; }
.summary-band strong { color: #1f2733; font-size: 18px; }
.summary-band .danger { color: #b42318; }
.table-shell, .approval-section { padding-top: 18px; }
.section-heading { justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.section-heading h2 { font-size: 18px; }
.section-heading p { font-size: 13px; }
.pagination-row { justify-content: space-between; gap: 16px; margin-top: 16px; color: #64748b; }
.approval-section { margin-top: 12px; border-top: 1px solid #dce4ee; }
.approval-comment { color: #52606d; white-space: pre-wrap; }
.muted { color: #94a3b8; }
.field-hint { flex-basis: 100%; margin: 8px 0 0; color: #64748b; font-size: 12px; }
:deep(.el-select) { width: 100%; }
@media (max-width: 760px) {
  .page-heading, .pagination-row { align-items: stretch; flex-direction: column; }
  .heading-actions { justify-content: stretch; }
  .heading-actions > * { flex: 1; }
  .summary-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-band > div:nth-child(2) { border-right: 0; }
  .summary-band > div:nth-child(-n + 2) { border-bottom: 1px solid #e8edf3; }
}
</style>
