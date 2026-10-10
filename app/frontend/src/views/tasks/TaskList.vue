<template>
  <div class="task-list">
    <header class="page-heading">
      <div>
        <h1>全部任务</h1>
        <p>查看、筛选和维护当前权限范围内的任务</p>
      </div>
      <div class="heading-actions">
        <el-button v-if="canExport" :loading="exportLoading" @click="handleBatchExport">
          <el-icon><Download /></el-icon>
          导出 Excel
        </el-button>
        <el-button v-if="canCreate" type="primary" @click="handleCreate">
          <el-icon><Plus /></el-icon>
          创建任务
        </el-button>
      </div>
    </header>

    <el-card class="task-list-card">
      <!-- 搜索栏 -->
      <el-form :inline="true" :model="searchForm" class="search-form" @submit.prevent="handleSearch">
        <el-form-item label="关键词">
          <el-input v-model="searchForm.keyword" placeholder="搜索任务名称" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item v-if="session.isGlobalReadOnly" label="项目团队">
          <el-select v-model="searchForm.teamId" placeholder="全部团队" clearable style="width: 180px">
            <el-option
              v-for="team in session.teams"
              :key="team._id"
              :label="team.name"
              :value="team._id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="(label, value) in taskStatusMap" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="searchForm.priority" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="(label, value) in priorityMap" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="创建时间">
          <el-date-picker
            v-model="searchForm.startDate"
            type="date"
            placeholder="开始日期"
            style="width: 150px"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
        <el-form-item label="至">
          <el-date-picker
            v-model="searchForm.endDate"
            type="date"
            placeholder="结束日期"
            style="width: 150px"
            value-format="YYYY-MM-DD"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit">搜索</el-button>
          <el-button native-type="button" @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <!-- 任务表格 -->
      <el-table :data="taskList" v-loading="loading" border>
        <el-table-column prop="taskName" label="任务名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="是否逾期" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="rowIsOverdue(row) ? 'danger' : 'success'" size="small">
              {{ rowIsOverdue(row) ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="逾期天数" width="90" align="center">
          <template #default="{ row }">{{ rowOverdueDays(row) }}</template>
        </el-table-column>
        <el-table-column v-if="session.isGlobalReadOnly" label="项目团队" min-width="150">
          <template #default="{ row }">
            <el-tag type="info" size="small">{{ resolveTeamName(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="taskType" label="类型" width="120" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="taskStatusType[row.status]" size="small">
              {{ taskStatusMap[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="100">
          <template #default="{ row }">
            <el-tag :type="priorityType[row.priority]" size="small">
              {{ priorityMap[row.priority] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="主负责人" width="120">
          <template #default="{ row }">
            {{ row.mainExecutor?.name }}
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ formatDate(row.createdAt, 'YYYY-MM-DD HH:mm') }}
          </template>
        </el-table-column>
        <el-table-column label="计划完成" width="110">
          <template #default="{ row }">
            {{ formatDate(row.plannedCompletionTime, 'YYYY-MM-DD') }}
          </template>
        </el-table-column>
        <el-table-column label="完成率" width="100" v-if="false">
          <template #default="{ row }">
            <el-progress :percentage="row.completionRate || 0" :stroke-width="6" />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button type="primary" size="small" text @click="handleView(row)">查看</el-button>
              <el-button v-if="canEditRow(row)" type="primary" size="small" text @click="handleEdit(row)">编辑</el-button>
              <el-button v-if="canDeleteRow(row)" type="danger" size="small" text @click="handleDelete(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <el-pagination
        :current-page="pagination.page"
        :page-size="pagination.limit"
        :total="pagination.total"
        :page-sizes="[10, 20, 50]"
        :pager-count="5"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="val => { pagination.limit = val; pagination.page = 1; fetchData(); }"
        @current-change="val => { pagination.page = val; fetchData(); }"
        class="pagination"
      />
    </el-card>
  </div>
</template>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { getTaskList, deleteTask, batchExportTasks } from '@/api/task'
import {
  formatDate,
  getTaskOverdueDays,
  isTaskOverdue,
  taskStatusMap,
  taskStatusType,
  priorityMap,
  priorityType
} from '@/utils/format'
import {
  canCreateTask,
  canDeleteTask,
  canEditTask,
  taskDetailLocation
} from '@/utils/taskPolicy'
import { requestErrorMessage } from '@/utils/request'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { createPageConfirmationGuard, pageRequestContextSnapshot } from '@/utils/pageRequestContext'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download } from '@element-plus/icons-vue'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()
const canCreate = ref(false)
const canExport = computed(() => session.hasPermission('task.export'))

const loading = ref(false)
const exportLoading = ref(false)

const searchForm = reactive({
  keyword: '',
  teamId: '',
  status: '',
  priority: '',
  startDate: '',
  endDate: ''
})

const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const taskList = ref([])
let fetchRequestId = 0
let activationReady = false
let pageActive = true
let deleteRequestId = 0
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.TASKS
})

function currentPageContext() {
  return pageRequestContextSnapshot({ route, session, pageActive })
}

const confirmationGuard = createPageConfirmationGuard(currentPageContext)

function invalidateTaskActions() {
  confirmationGuard.invalidate()
  deleteRequestId += 1
}

const teamNameById = computed(() => new Map(
  session.teams.map((team) => [String(team._id), team.name])
))

const resolveTeamName = (task) => {
  const value = task?.teamId
  const teamId = String(value?._id || value || '')
  return value?.name || teamNameById.value.get(teamId) || '未知团队'
}

const canEditRow = (task) => canEditTask(task)
const canDeleteRow = (task) => canDeleteTask(task)
const rowIsOverdue = (task) => (
  typeof task?.isOverdue === 'boolean'
    ? task.isOverdue
    : isTaskOverdue(task?.plannedCompletionTime, task?.status)
)
const rowOverdueDays = (task) => {
  if (!rowIsOverdue(task)) return 0
  const value = Number(task?.overdueDays)
  return Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : getTaskOverdueDays(task?.plannedCompletionTime, task?.status)
}

const fetchData = async ({ preserveExisting = false } = {}) => {
  const loadStartRevision = mutationRefresh.currentRevision()
  const requestId = ++fetchRequestId
  loading.value = true
  if (!preserveExisting) {
    taskList.value = []
    pagination.total = 0
    canCreate.value = false
  }
  try {
    const result = await getTaskList({
      page: pagination.page,
      limit: pagination.limit,
      keyword: searchForm.keyword,
      teamId: session.isGlobalReadOnly ? searchForm.teamId : undefined,
      status: searchForm.status,
      priority: searchForm.priority,
      startDate: searchForm.startDate,
      endDate: searchForm.endDate
    })
    if (requestId !== fetchRequestId) return
    taskList.value = result.tasks || []
    canCreate.value = canCreateTask(result)
    pagination.total = result.pagination?.total || 0
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } catch (error) {
    if (requestId !== fetchRequestId) return
    if (!preserveExisting) {
      taskList.value = []
      pagination.total = 0
      canCreate.value = false
    }
    console.error('获取任务列表失败:', error)
    return false
  } finally {
    if (requestId === fetchRequestId) loading.value = false
  }
}

const handleSearch = () => {
  pagination.page = 1
  fetchData()
}

const handleReset = () => {
  Object.assign(searchForm, {
    keyword: '',
    teamId: '',
    status: '',
    priority: '',
    startDate: '',
    endDate: ''
  })
  handleSearch()
}

const handleCreate = () => {
  if (!canCreate.value) return
  router.push('/tasks/create')
}

const handleView = (row) => {
  router.push(taskDetailLocation(row, { includeTeamId: session.isGlobalReadOnly }))
}

const handleEdit = (row) => {
  if (!canEditRow(row)) return
  router.push(`/tasks/${row._id}/edit`)
}

const handleDelete = async (row) => {
  if (!canDeleteRow(row)) return
  const confirmation = confirmationGuard.capture()
  try {
    await ElMessageBox.confirm('确定要删除该任务吗？删除后无法恢复！', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  if (!confirmationGuard.isCurrent(confirmation)) return
  const requestId = ++deleteRequestId
  try {
    await deleteTask(row._id)
    if (requestId !== deleteRequestId || !confirmationGuard.isCurrent(confirmation)) return
    ElMessage.success('删除成功')
    await fetchData({ preserveExisting: true })
  } catch (error) {
    if (requestId !== deleteRequestId || !confirmationGuard.isCurrent(confirmation)) return
    console.error('删除失败:', error)
    await fetchData({ preserveExisting: true })
  }
}

const handleBatchExport = async () => {
  const startDate = searchForm.startDate
  const endDate = searchForm.endDate
  
  // 验证：如果选了开始时间或结束时间，必须两个都选
  if ((startDate && !endDate) || (!startDate && endDate)) {
    ElMessage.warning('请同时选择开始时间和结束时间，或都不选')
    return
  }
  
  // 如果都选了，验证时间顺序
  if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
    ElMessage.warning('开始时间不能晚于结束时间')
    return
  }
  
  try {
    exportLoading.value = true
    ElMessage.info('正在导出任务数据...')
    
    // 构建导出参数
    const exportParams = {}
    
    // 只添加有值的参数
    if (searchForm.keyword) exportParams.keyword = searchForm.keyword
    if (session.isGlobalReadOnly && searchForm.teamId) exportParams.teamId = searchForm.teamId
    if (searchForm.status) exportParams.status = searchForm.status
    if (searchForm.priority) exportParams.priority = searchForm.priority
    
    // 如果选择了时间范围，则添加到参数中
    if (startDate && endDate) {
      exportParams.startDate = startDate
      exportParams.endDate = endDate
    }
    
    // 使用当前搜索条件导出
    const blob = await batchExportTasks(exportParams)
    
    // 检查返回的是否为 blob
    if (!(blob instanceof Blob)) {
      console.error('返回的不是 Blob 对象:', blob)
      throw new Error('服务器返回数据格式错误')
    }
    
    // 创建下载链接
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    
    // 根据是否有时间范围生成不同的文件名
    let filename
    if (startDate && endDate) {
      filename = `任务列表_${startDate.substring(0, 10)}_${endDate.substring(0, 10)}_${new Date().getTime()}.xlsx`
    } else {
      filename = `任务列表_全部_${new Date().getTime()}.xlsx`
    }
    
    link.download = filename
    document.body.appendChild(link)
    link.click()
    
    // 清理
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
    
    ElMessage.success('导出成功')
  } catch (error) {
    console.error('=== 导出失败详情 ===')
    console.error('错误对象:', error)
    console.error('错误消息:', error.message)
    console.error('错误响应:', error.response)
    ElMessage.error(requestErrorMessage(error, '任务导出失败，请稍后重试'))
  } finally {
    exportLoading.value = false
  }
}

onMounted(async () => {
  try {
    await fetchData()
  } finally {
    activationReady = true
  }
})
onActivated(() => {
  pageActive = true
  if (!activationReady) return
  void mutationRefresh.refreshIfNeeded(() => fetchData({ preserveExisting: true })).catch(() => {})
})
onDeactivated(() => {
  pageActive = false
  invalidateTaskActions()
  fetchRequestId += 1
  loading.value = false
})
watch(() => session.contextEpoch, invalidateTaskActions)
watch(() => [route.name, route.fullPath], invalidateTaskActions)
onBeforeUnmount(() => {
  pageActive = false
  invalidateTaskActions()
})
</script>

<style scoped lang="scss">
.task-list {
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
    flex-wrap: wrap;
    gap: 12px 16px;
    margin-bottom: 16px;
    padding: 14px;
    background: rgb(245 249 255 / 72%);
    border: 1px solid var(--zl-border-soft);
    border-radius: 14px;
  }

  .search-form :deep(.el-form-item) {
    margin: 0;
  }

  .search-form :deep(.el-form-item:last-child) {
    margin-left: auto;
  }

  .search-form :deep(.el-form-item:last-child .el-form-item__content) {
    display: flex;
    gap: 8px;
  }

  .table-actions {
    justify-content: center;
  }

  .pagination {
    justify-content: flex-end;
    margin-top: 20px;
  }
}

@media (max-width: 760px) {
  .task-list {
    .search-form :deep(.el-form-item),
    .search-form :deep(.el-form-item__content),
    .search-form :deep(.el-input),
    .search-form :deep(.el-select),
    .search-form :deep(.el-date-editor) {
      width: 100% !important;
    }

    .search-form :deep(.el-form-item:last-child .el-form-item__content) {
      display: flex;
      gap: 8px;
    }

    .search-form :deep(.el-form-item:last-child .el-button) {
      flex: 1;
    }

    .pagination {
      width: 100%;
      justify-content: flex-start;
      overflow-x: auto;
      padding-bottom: 4px;
    }

    .pagination :deep(.el-pagination__total),
    .pagination :deep(.el-pagination__sizes),
    .pagination :deep(.el-pagination__jump) {
      display: none;
    }
  }
}
</style>

