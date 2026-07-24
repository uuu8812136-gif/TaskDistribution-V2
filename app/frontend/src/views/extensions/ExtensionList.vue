<template>
  <div class="extension-list">
    <header class="page-heading">
      <div>
        <h1>延期管理</h1>
        <p>查询并处理任务延期申请</p>
      </div>
    </header>

    <el-card>
      <el-form :inline="true" :model="searchForm" class="search-form">
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部" clearable>
            <el-option label="待审批" value="pending" />
            <el-option label="已批准" value="approved" />
            <el-option label="已拒绝" value="rejected" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="fetchData">搜索</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="extensionList" v-loading="loading" border>
        <el-table-column label="任务名称" min-width="200">
          <template #default="{ row }">
            {{ row.task?.taskName }}
          </template>
        </el-table-column>
        <el-table-column label="申请人" width="100">
          <template #default="{ row }">
            {{ row.applicant?.name }}
          </template>
        </el-table-column>
        <el-table-column label="请求天数" width="100">
          <template #default="{ row }">
            {{ row.requestedDays }} 天
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="延期原因" min-width="200" show-overflow-tooltip />
        <el-table-column label="申请时间" width="180">
          <template #default="{ row }">
            {{ formatDate(row.applyTime) }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning'">
              {{ row.status === 'pending' ? '待审批' : row.status === 'approved' ? '已批准' : '已拒绝' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button v-if="canApproveRow(row)" type="primary" size="small" text @click="handleApprove(row)">
                审批
              </el-button>
              <el-button v-else type="primary" size="small" text @click="handleView(row)">查看</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 审批对话框 -->
    <el-dialog
      v-model="approveDialogVisible"
      :title="canApproveCurrent ? '审批延期申请' : '延期申请详情'"
      width="min(500px, 94vw)"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="任务名称">{{ currentExtension?.task?.taskName }}</el-descriptions-item>
        <el-descriptions-item label="申请人">{{ currentExtension?.applicant?.name }}</el-descriptions-item>
        <el-descriptions-item label="请求天数">{{ currentExtension?.requestedDays }} 天</el-descriptions-item>
        <el-descriptions-item label="延期原因">{{ currentExtension?.reason }}</el-descriptions-item>
        <el-descriptions-item v-if="!canApproveCurrent" label="处理状态">
          {{ extensionStatusLabel(currentExtension?.status) }}
        </el-descriptions-item>
        <el-descriptions-item
          v-if="!canApproveCurrent && currentExtension?.status === 'approved'"
          label="批准天数"
        >
          {{ currentExtension?.approvedDays }} 天
        </el-descriptions-item>
        <el-descriptions-item v-if="!canApproveCurrent && currentExtension?.approvalTime" label="审批时间">
          {{ formatDate(currentExtension.approvalTime) }}
        </el-descriptions-item>
        <el-descriptions-item v-if="!canApproveCurrent && currentExtension?.approvalNote" label="审批备注">
          {{ currentExtension.approvalNote }}
        </el-descriptions-item>
      </el-descriptions>

      <el-form v-if="canApproveCurrent" :model="approveForm" label-position="top" class="approve-form">
        <el-form-item label="审批结果">
          <el-radio-group v-model="approveForm.status">
            <el-radio label="approved">批准</el-radio>
            <el-radio label="rejected">拒绝</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="approveForm.status === 'approved'" label="批准天数">
          <el-input-number v-model="approveForm.approvedDays" :min="1" :max="30" />
        </el-form-item>
        <el-form-item label="审批备注">
          <el-input v-model="approveForm.approvalNote" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="approveDialogVisible = false">{{ canApproveCurrent ? '取消' : '关闭' }}</el-button>
        <el-button v-if="canApproveCurrent" type="primary" :loading="submitting" @click="submitApprove">
          提交
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, reactive, onMounted } from 'vue'
import { getExtensionList, approveExtension } from '@/api/extension'
import { formatDate } from '@/utils/format'
import { canApproveExtensionRequest } from '@/utils/taskPolicy'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const submitting = ref(false)
const approveDialogVisible = ref(false)
const currentExtension = ref(null)

const searchForm = reactive({
  status: ''
})

const approveForm = reactive({
  status: 'approved',
  approvedDays: 5,
  approvalNote: ''
})

const extensionList = ref([])
let fetchRequestId = 0

const canApproveRow = (request) => canApproveExtensionRequest({
  request
})

const canApproveCurrent = computed(() => !loading.value && canApproveRow(currentExtension.value))
const extensionStatusLabel = (status) => ({
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝'
}[status] || '-')

const fetchData = async () => {
  const requestId = ++fetchRequestId
  loading.value = true
  extensionList.value = []
  if (currentExtension.value) {
    currentExtension.value = { ...currentExtension.value, capabilities: {} }
  }
  try {
    const result = await getExtensionList(searchForm)
    if (requestId !== fetchRequestId) return
    const requests = Array.isArray(result.requests) ? result.requests : []
    extensionList.value = requests
    if (approveDialogVisible.value && currentExtension.value?._id) {
      const refreshed = requests.find((request) => request._id === currentExtension.value._id)
      currentExtension.value = refreshed || null
      if (!refreshed) approveDialogVisible.value = false
    }
  } catch (error) {
    if (requestId !== fetchRequestId) return
    console.error('获取延期申请列表失败:', error)
    extensionList.value = []
    currentExtension.value = null
    approveDialogVisible.value = false
  } finally {
    if (requestId === fetchRequestId) loading.value = false
  }
}

const handleApprove = (row) => {
  if (!canApproveRow(row)) return
  currentExtension.value = row
  approveForm.status = 'approved'
  approveForm.approvedDays = row.requestedDays
  approveForm.approvalNote = ''
  approveDialogVisible.value = true
}

const handleView = (row) => {
  currentExtension.value = row
  approveForm.status = row.status
  approveForm.approvedDays = row.approvedDays
  approveForm.approvalNote = row.approvalNote
  approveDialogVisible.value = true
}

const submitApprove = async () => {
  if (submitting.value || !canApproveCurrent.value) return
  submitting.value = true
  try {
    await approveExtension(currentExtension.value._id, approveForm)
    ElMessage.success('审批成功')
    approveDialogVisible.value = false
    await fetchData()
  } catch (error) {
    console.error('审批失败:', error)
    await fetchData()
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped lang="scss">
.extension-list {
  min-width: 0;

  .page-heading h1 {
    margin: 0 0 5px;
    font-size: 24px;
  }

  .page-heading p {
    margin: 0;
    color: var(--zl-muted);
  }

  .search-form {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-bottom: 16px;
    padding: 14px;
    background: rgb(245 249 255 / 72%);
    border: 1px solid var(--zl-border-soft);
    border-radius: 14px;
  }

  .search-form :deep(.el-form-item) { margin: 0; }
  .search-form :deep(.el-select) { width: 180px; }
  .table-actions { justify-content: center; }
  .approve-form { margin-top: 20px; }
}

@media (max-width: 760px) {
  .extension-list {
    .search-form,
    .search-form :deep(.el-form-item),
    .search-form :deep(.el-form-item__content),
    .search-form :deep(.el-select) {
      width: 100%;
    }

    .search-form {
      align-items: stretch;
      flex-direction: column;
    }

    .search-form .el-button { width: 100%; }
  }
}
</style>

