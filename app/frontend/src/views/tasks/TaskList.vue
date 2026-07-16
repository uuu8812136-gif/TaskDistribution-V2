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
        <el-table-column label="操作" :width="canEdit ? 170 : 86" fixed="right" align="center">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button type="primary" size="small" text @click="handleView(row)">查看</el-button>
              <el-button v-if="canEdit" type="primary" size="small" text @click="handleEdit(row)">编辑</el-button>
              <el-button v-if="canEdit" type="danger" size="small" text @click="handleDelete(row)">删除</el-button>
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
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="val => { pagination.limit = val; pagination.page = 1; fetchData(); }"
        @current-change="val => { pagination.page = val; fetchData(); }"
        class="pagination"
      />
    </el-card>
  </div>
</template>

<script setup>
import { computed, ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { getTaskList, deleteTask, batchExportTasks } from '@/api/task'
import { formatDate, taskStatusMap, taskStatusType, priorityMap, priorityType } from '@/utils/format'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download } from '@element-plus/icons-vue'

const router = useRouter()
const session = useSessionStore()
const canCreate = computed(() => session.can('task.create', { write: true, teamRequired: true }))
const canEdit = computed(() => session.can('task.edit', { write: true, teamRequired: true }))
const canExport = computed(() => session.hasPermission('task.export'))

const loading = ref(false)
const exportLoading = ref(false)

const searchForm = reactive({
  keyword: '',
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

const fetchData = async () => {
  loading.value = true
  try {
    const result = await getTaskList({
      page: pagination.page,
      limit: pagination.limit,
      keyword: searchForm.keyword,
      status: searchForm.status,
      priority: searchForm.priority,
      startDate: searchForm.startDate,
      endDate: searchForm.endDate
    })
    taskList.value = result.tasks
    pagination.total = result.pagination.total
  } catch (error) {
    console.error('获取任务列表失败:', error)
  } finally {
    loading.value = false
  }
}

const handleSearch = () => {
  pagination.page = 1
  fetchData()
}

const handleReset = () => {
  Object.assign(searchForm, {
    keyword: '',
    status: '',
    priority: '',
    startDate: '',
    endDate: ''
  })
  handleSearch()
}

const handleCreate = () => {
  router.push('/tasks/create')
}

const handleView = (row) => {
  router.push(`/tasks/${row._id}`)
}

const handleEdit = (row) => {
  router.push(`/tasks/${row._id}/edit`)
}

const handleDelete = (row) => {
  ElMessageBox.confirm('确定要删除该任务吗？删除后无法恢复！', '提示', {
    confirmButtonText: '确定',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    try {
      await deleteTask(row._id)
      ElMessage.success('删除成功')
      fetchData()
    } catch (error) {
      console.error('删除失败:', error)
    }
  }).catch(() => {})
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
    if (searchForm.status) exportParams.status = searchForm.status
    if (searchForm.priority) exportParams.priority = searchForm.priority
    
    // 如果选择了时间范围，则添加到参数中
    if (startDate && endDate) {
      exportParams.startDate = startDate
      exportParams.endDate = endDate
    }
    
    console.log('=== 导出参数 ===')
    console.log('exportParams:', exportParams)
    
    // 使用当前搜索条件导出
    const blob = await batchExportTasks(exportParams)
    
    console.log('=== 导出响应 ===')
    console.log('blob:', blob)
    console.log('blob type:', blob.type)
    console.log('blob size:', blob.size)
    
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
    ElMessage.error(`导出失败: ${error.message || '未知错误'}`)
  } finally {
    exportLoading.value = false
  }
}

onMounted(() => {
  fetchData()
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
      justify-content: flex-start;
      padding-bottom: 4px;
    }

    .pagination :deep(.el-pagination__jump) {
      display: none;
    }
  }
}
</style>

