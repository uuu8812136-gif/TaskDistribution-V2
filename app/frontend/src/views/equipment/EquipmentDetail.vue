<template>
  <div class="detail-page">
    <header class="page-heading">
      <div class="heading-main">
        <el-button circle aria-label="返回" @click="router.back()">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ equipment?.name || '设备详情' }}</h1>
          <p>{{ equipment?.assetCode || '' }}</p>
        </div>
      </div>
      <div class="heading-actions">
        <el-button v-if="canQr && equipment" @click="showQrCode">
          <el-icon><FullScreen /></el-icon>
          二维码
        </el-button>
        <el-button v-if="canEdit && equipment" type="primary" @click="editEquipment">
          <el-icon><Edit /></el-icon>
          编辑
        </el-button>
      </div>
    </header>

    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="equipment">
      <section class="summary-band">
        <div>
          <span>设备状态</span>
          <el-tag :type="statusOption.type" effect="plain">{{ statusOption.label }}</el-tag>
        </div>
        <div><span>所属组织</span><strong>{{ orgUnitName }}</strong></div>
        <div><span>设备分类</span><strong>{{ categoryName }}</strong></div>
        <div><span>保管人</span><strong>{{ custodianName }}</strong></div>
      </section>

      <section class="detail-section">
        <h2>台账信息</h2>
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="资产编号">{{ equipment.assetCode }}</el-descriptions-item>
          <el-descriptions-item label="设备名称">{{ equipment.name }}</el-descriptions-item>
          <el-descriptions-item label="规格型号">{{ equipment.specification || '-' }}</el-descriptions-item>
          <el-descriptions-item label="生产厂家">{{ equipment.manufacturer || '-' }}</el-descriptions-item>
          <el-descriptions-item label="数量">{{ equipment.quantity }} {{ equipment.unit }}</el-descriptions-item>
          <el-descriptions-item label="购置日期">{{ displayDate(equipment.acquisitionDate) }}</el-descriptions-item>
          <el-descriptions-item label="原值">{{ displayMoney(equipment.originalValue) }}</el-descriptions-item>
          <el-descriptions-item label="存放地点">{{ equipment.location || '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="descriptionColumns">{{ equipment.remark || '-' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ displayTime(equipment.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ displayTime(equipment.updatedAt) }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="detail-section">
        <div class="section-heading">
          <h2>变更记录</h2>
          <el-button :loading="historyLoading" circle aria-label="刷新变更记录" @click="loadHistory">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
        <div class="table-shell">
          <el-table :data="changes" row-key="_id" empty-text="暂无变更记录">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ displayTime(row.occurredAt) }}</template>
            </el-table-column>
            <el-table-column label="类型" width="110">
              <template #default="{ row }">{{ changeTypeLabel(row.changeType) }}</template>
            </el-table-column>
            <el-table-column label="操作人" min-width="120">
              <template #default="{ row }">{{ operatorName(row.operatorId) }}</template>
            </el-table-column>
            <el-table-column prop="reason" label="说明" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.reason || '-' }}</template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination
          v-if="historyTotal > historyPageSize"
          v-model:current-page="historyPage"
          :page-size="historyPageSize"
          :total="historyTotal"
          layout="prev, pager, next"
          class="history-pagination"
          @current-change="loadHistory"
        />
      </section>
    </template>

    <el-dialog v-model="qrVisible" title="设备二维码" width="min(430px, 92vw)" append-to-body>
      <div class="qr-sheet">
        <strong>{{ equipment?.name }}</strong>
        <span>{{ equipment?.assetCode }}</span>
        <img v-if="qrImage" :src="qrImage" alt="设备二维码" />
      </div>
      <template #footer>
        <el-button @click="qrVisible = false">关闭</el-button>
        <el-button type="primary" :disabled="!qrImage" @click="printQr">
          <el-icon><Printer /></el-icon>
          打印
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import QRCode from 'qrcode'
import {
  generateEquipmentQrCode,
  getEquipmentCategories,
  getEquipmentDetail,
  getEquipmentHistory,
  getEquipmentOptions
} from '@/api/equipment'
import { useSessionStore } from '@/stores/session'
import { EQUIPMENT_STATUS_OPTIONS, entityName, optionForValue } from '@/utils/equipment'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const equipment = ref(null)
const categories = ref([])
const options = ref({ orgUnits: [], custodians: [] })
const changes = ref([])
const loading = ref(true)
const historyLoading = ref(false)
const historyPage = ref(1)
const historyPageSize = 20
const historyTotal = ref(0)
const qrVisible = ref(false)
const qrImage = ref('')

const requestParams = computed(() => (
  route.query.teamId ? { teamId: String(route.query.teamId) } : {}
))
const canEdit = computed(() => session.can('equipment.edit', { write: true, teamRequired: true }))
const canQr = computed(() => session.can('equipment.qrcode', { write: true, teamRequired: true }))
const statusOption = computed(() => optionForValue(EQUIPMENT_STATUS_OPTIONS, equipment.value?.status))
const orgUnitName = computed(() => entityName(options.value.orgUnits, equipment.value?.orgUnitId))
const categoryName = computed(() => entityName(categories.value, equipment.value?.categoryId))
const custodianName = computed(() => (
  equipment.value?.custodianUserId
    ? entityName(options.value.custodians, equipment.value.custodianUserId)
    : '-'
))
const descriptionColumns = computed(() => window.innerWidth < 720 ? 1 : 2)

const displayDate = (value) => value ? dayjs(value).format('YYYY-MM-DD') : '-'
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
const displayMoney = (value) => value === null || value === undefined
  ? '-'
  : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value)
const changeTypeLabel = (value) => ({ CREATE: '创建', UPDATE: '编辑', STATUS_CHANGE: '状态变更' }[value] || value)
const operatorName = (id) => entityName(options.value.custodians, id, id ? `用户 ${id.slice(-6)}` : '-')

async function loadHistory() {
  historyLoading.value = true
  try {
    const result = await getEquipmentHistory(route.params.id, {
      ...requestParams.value,
      page: historyPage.value,
      pageSize: historyPageSize
    })
    changes.value = result.changes || []
    historyTotal.value = result.total || 0
  } finally {
    historyLoading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !route.query.teamId) {
    await router.replace({ name: 'Equipment' })
    return
  }
  loading.value = true
  try {
    const [detailResult, categoryResult, optionResult] = await Promise.all([
      getEquipmentDetail(route.params.id, requestParams.value),
      getEquipmentCategories({ ...requestParams.value, pageSize: 200 }),
      getEquipmentOptions(requestParams.value)
    ])
    equipment.value = detailResult.equipment
    categories.value = categoryResult.categories || []
    options.value = optionResult
    await loadHistory()
  } finally {
    loading.value = false
  }
}

function editEquipment() {
  router.push({
    name: 'Equipment',
    query: { ...requestParams.value, edit: equipment.value._id }
  })
}

async function showQrCode() {
  const result = await generateEquipmentQrCode(equipment.value._id)
  qrImage.value = await QRCode.toDataURL(result.qrCode.payload, {
    width: 360,
    margin: 2,
    errorCorrectionLevel: 'M'
  })
  qrVisible.value = true
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]))
}

function printQr() {
  const printWindow = window.open('', '_blank', 'width=520,height=640')
  if (!printWindow) return
  printWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(equipment.value.assetCode)}</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:32px}h1{font-size:22px;margin:0 0 8px}p{font-size:16px;margin:0 0 18px}img{width:360px;height:360px}</style></head><body><h1>${escapeHtml(equipment.value.name)}</h1><p>${escapeHtml(equipment.value.assetCode)}</p><img src="${qrImage.value}" onload="window.print();window.close()"></body></html>`)
  printWindow.document.close()
}

onMounted(initialize)
</script>

<style scoped lang="scss">
.detail-page { min-width: 0; }
.page-heading, .heading-main, .heading-actions, .section-heading { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.heading-main { min-width: 0; gap: 12px; }
.heading-main h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.heading-main p { margin: 0; color: #909399; }
.heading-actions { gap: 10px; }
.summary-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: #fff; border-block: 1px solid #e4e7ed; }
.summary-band > div { min-width: 0; padding: 16px 18px; border-right: 1px solid #ebeef5; }
.summary-band > div:last-child { border-right: 0; }
.summary-band span { display: block; margin-bottom: 7px; color: #909399; font-size: 12px; }
.summary-band strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-section { margin-top: 24px; }
.detail-section h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
.section-heading { justify-content: space-between; }
.table-shell { overflow: hidden; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px; }
.history-pagination { justify-content: flex-end; margin-top: 14px; }
.qr-sheet { display: flex; flex-direction: column; align-items: center; }
.qr-sheet strong { font-size: 18px; }
.qr-sheet span { margin-top: 4px; color: #606266; }
.qr-sheet img { width: min(360px, 100%); aspect-ratio: 1; margin-top: 14px; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-actions { flex-direction: column; align-items: stretch; }
  .summary-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-band > div:nth-child(2) { border-right: 0; }
  .summary-band > div:nth-child(-n+2) { border-bottom: 1px solid #ebeef5; }
}
</style>
