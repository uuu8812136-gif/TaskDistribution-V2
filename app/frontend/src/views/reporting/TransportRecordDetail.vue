<template>
  <div class="detail-page">
    <header class="page-heading">
      <div class="heading-main">
        <el-button circle aria-label="返回" @click="router.back()">
          <el-icon><ArrowLeft /></el-icon>
        </el-button>
        <div>
          <h1>{{ record ? `${record.driverName} · ${record.reportDate}` : '运输提报详情' }}</h1>
          <p>{{ record ? `${record.vehiclePlate} / ${record.route}` : '' }}</p>
        </div>
      </div>
      <el-button v-if="canSubmit && record" type="primary" @click="editRecord">
        <el-icon><Edit /></el-icon>
        编辑
      </el-button>
    </header>

    <el-skeleton v-if="loading" :rows="9" animated />
    <template v-else-if="record">
      <section class="summary-band">
        <div><span>班次</span><strong>{{ record.shift }}</strong></div>
        <div><span>出车类型</span><strong>{{ record.dispatchType }}</strong></div>
        <div><span>所属组织</span><strong>{{ orgName }}</strong></div>
        <div><span>装载合计</span><strong>{{ record.loadTotal }}</strong></div>
      </section>

      <section class="detail-section">
        <h2>运输信息</h2>
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="提报日期">{{ record.reportDate }}</el-descriptions-item>
          <el-descriptions-item label="趟次">{{ record.tripLabel }}</el-descriptions-item>
          <el-descriptions-item label="司机姓名">{{ record.driverName }}</el-descriptions-item>
          <el-descriptions-item label="车牌号">{{ record.vehiclePlate }}</el-descriptions-item>
          <el-descriptions-item label="车型">{{ record.vehicleType || '-' }}</el-descriptions-item>
          <el-descriptions-item label="路线">{{ record.route }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ displayTime(record.submittedAt) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ displayTime(record.updatedAt) }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="descriptionColumns">{{ record.remark || '-' }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="detail-section">
        <h2>装载明细</h2>
        <div class="quantity-band">
          <div v-for="item in TRANSPORT_LOAD_FIELDS" :key="item.key">
            <span>{{ item.label }}</span>
            <strong>{{ record.loadDetails[item.key] || 0 }}</strong>
          </div>
        </div>
      </section>

      <section class="detail-section">
        <h2>现场照片</h2>
        <div v-if="photos.length" class="photo-grid">
          <button
            v-for="photo in photos"
            :key="photo.fileId"
            type="button"
            class="photo-button"
            :aria-label="`预览 ${photo.name}`"
            @click="previewPhoto(photo)"
          >
            <img v-if="photo.url" :src="photo.url" :alt="photo.name" />
            <span v-else>{{ photo.name }}</span>
          </button>
        </div>
        <el-empty v-else description="暂无现场照片" :image-size="72" />
      </section>

      <section class="detail-section">
        <div class="section-heading">
          <h2>变更历史</h2>
          <el-button :loading="historyLoading" circle aria-label="刷新变更历史" @click="loadHistory">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
        <div class="table-shell">
          <el-table :data="changes" row-key="_id" empty-text="暂无变更历史">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ displayTime(row.occurredAt) }}</template>
            </el-table-column>
            <el-table-column label="类型" width="90">
              <template #default="{ row }">{{ row.changeType === 'CREATE' ? '创建' : '编辑' }}</template>
            </el-table-column>
            <el-table-column label="变更内容" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">{{ transportChangedFields(row).join('、') || '-' }}</template>
            </el-table-column>
            <el-table-column label="操作人" min-width="120">
              <template #default="{ row }">{{ row.operatorId ? `用户 ${row.operatorId.slice(-6)}` : '-' }}</template>
            </el-table-column>
            <el-table-column label="说明" min-width="180" show-overflow-tooltip>
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

    <el-dialog v-model="previewVisible" title="现场照片" width="min(760px, 94vw)" append-to-body>
      <img v-if="activePhoto?.url" :src="activePhoto.url" :alt="activePhoto.name" class="preview-image" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { downloadFileBlob, getFileMetadata } from '@/api/file'
import {
  getTransportHistory,
  getTransportOptions,
  getTransportRecord
} from '@/api/reporting'
import { useSessionStore } from '@/stores/session'
import {
  TRANSPORT_LOAD_FIELDS,
  entityName,
  transportChangedFields
} from '@/utils/reporting'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const record = ref(null)
const orgUnits = ref([])
const photos = ref([])
const loading = ref(true)
const historyLoading = ref(false)
const changes = ref([])
const historyPage = ref(1)
const historyPageSize = 20
const historyTotal = ref(0)
const previewVisible = ref(false)
const activePhoto = ref(null)

const requestParams = computed(() => route.query.teamId ? { teamId: String(route.query.teamId) } : {})
const canSubmit = computed(() => session.can('report.submit', { write: true, teamRequired: true }))
const orgName = computed(() => entityName(
  orgUnits.value,
  record.value?.orgUnitId,
  record.value?.orgUnitId ? `组织 ${record.value.orgUnitId.slice(-6)}` : '-'
))
const descriptionColumns = computed(() => window.innerWidth < 720 ? 1 : 2)
const displayTime = (value) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

async function loadHistory() {
  historyLoading.value = true
  try {
    const result = await getTransportHistory(route.params.id, {
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

async function loadPhotos(fileIds) {
  const items = await Promise.all(fileIds.map(async (fileId) => {
    const metadata = await getFileMetadata(fileId, requestParams.value.teamId)
    const blob = await downloadFileBlob(fileId, requestParams.value.teamId)
    return {
      fileId,
      name: metadata.file.originalName,
      mimeType: metadata.file.mimeType,
      url: URL.createObjectURL(blob)
    }
  }))
  photos.value = items
}

async function initialize() {
  if (session.isGlobalReadOnly && !route.query.teamId) {
    await router.replace({ name: 'TransportRecords' })
    return
  }
  loading.value = true
  try {
    const [recordResult, optionResult] = await Promise.all([
      getTransportRecord(route.params.id, requestParams.value),
      getTransportOptions(requestParams.value)
    ])
    record.value = recordResult.transportRecord
    orgUnits.value = optionResult.orgUnits || []
    await Promise.all([loadHistory(), loadPhotos(record.value.photoFileIds || [])])
  } finally {
    loading.value = false
  }
}

function editRecord() {
  router.push({
    name: 'TransportRecords',
    query: { ...requestParams.value, edit: record.value._id }
  })
}

function previewPhoto(photo) {
  activePhoto.value = photo
  previewVisible.value = true
}

onMounted(initialize)
onBeforeUnmount(() => photos.value.forEach((photo) => photo.url && URL.revokeObjectURL(photo.url)))
</script>

<style scoped lang="scss">
.detail-page { min-width: 0; }
.page-heading, .heading-main, .section-heading { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.heading-main { min-width: 0; gap: 12px; }
.heading-main h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: 0; overflow-wrap: anywhere; }
.heading-main p { margin: 0; color: #909399; }
.summary-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--zl-surface); border-block: 1px solid var(--zl-border-soft); }
.summary-band > div { min-width: 0; padding: 16px 18px; border-right: 1px solid #ebeef5; }
.summary-band > div:last-child { border-right: 0; }
.summary-band span, .quantity-band span { display: block; margin-bottom: 7px; color: #909399; font-size: 12px; }
.summary-band strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-section { margin-top: 24px; }
.detail-section h2 { margin: 0 0 12px; font-size: 17px; letter-spacing: 0; }
.section-heading { justify-content: space-between; }
.quantity-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--zl-border-soft); border-radius: 16px; overflow: hidden; }
.quantity-band > div { min-width: 0; padding: 14px 16px; border-right: 1px solid #ebeef5; border-bottom: 1px solid #ebeef5; }
.quantity-band strong { font-size: 18px; }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
.photo-button { min-width: 0; padding: 0; aspect-ratio: 4 / 3; overflow: hidden; background: #f5f7fa; border: 1px solid #dcdfe6; border-radius: 12px; cursor: pointer; }
.photo-button img { width: 100%; height: 100%; object-fit: cover; }
.photo-button span { display: block; padding: 12px; overflow-wrap: anywhere; }
.table-shell { overflow: hidden; border: 1px solid var(--zl-border-soft); border-radius: 16px; }
.history-pagination { justify-content: flex-end; margin-top: 14px; }
.preview-image { display: block; max-width: 100%; max-height: 72vh; margin: 0 auto; object-fit: contain; }
@media (max-width: 760px) {
  .page-heading { align-items: flex-start; }
  .heading-main { width: 100%; }
  .summary-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-band > div:nth-child(2) { border-right: 0; }
  .quantity-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
