<template>
  <div class="task-board">
    <el-card>
      <div class="board-toolbar">
        <span class="board-summary">共 {{ tasks.length }} 项任务</span>
        <el-button :icon="Refresh" :loading="loading" @click="fetchData">刷新</el-button>
      </div>

      <el-skeleton v-if="loading && tasks.length === 0" :rows="8" animated />

      <el-result
        v-else-if="loadError"
        icon="error"
        title="任务看板加载失败"
        :sub-title="loadError"
      >
        <template #extra>
          <el-button type="primary" :loading="loading" @click="fetchData">重新加载</el-button>
        </template>
      </el-result>

      <div v-else v-loading="loading" class="board-container">
        <div class="board-column" v-for="status in statusList" :key="status.value">
          <div class="column-header">
            <span class="column-title">{{ status.label }}</span>
            <el-badge :value="getTaskCount(status.value)" type="primary" />
          </div>
          <div class="column-content">
            <button
              v-for="task in getTasksByStatus(status.value)"
              :key="task._id"
              type="button"
              class="task-card"
              @click="handleView(task)"
            >
              <div class="task-title">{{ task.taskName }}</div>
              <el-tag v-if="session.isGlobalReadOnly" class="task-team" type="info" size="small">
                {{ getTaskTeamName(task) }}
              </el-tag>
              <div class="task-meta">
                <el-tag :type="priorityType[task.priority]" size="small">
                  {{ priorityMap[task.priority] }}
                </el-tag>
                <span class="task-time">{{ formatDate(task.plannedCompletionTime, 'MM-DD') }}</span>
              </div>
              <div class="task-executor">
                <el-avatar :size="24">{{ task.mainExecutor?.name?.substring(0, 1) }}</el-avatar>
                <span>{{ task.mainExecutor?.name }}</span>
              </div>
            </button>
            <el-empty v-if="getTaskCount(status.value) === 0" description="暂无任务" :image-size="60" />
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Refresh } from '@element-plus/icons-vue'
import { getTaskList } from '@/api/task'
import { useSessionStore } from '@/stores/session'
import { formatDate, priorityMap, priorityType } from '@/utils/format'
import { taskDetailLocation, taskEntityId, taskTeamId } from '@/utils/taskPolicy'
import { requestErrorMessage } from '@/utils/request'

const router = useRouter()
const session = useSessionStore()
const tasks = ref([])
const loading = ref(false)
const loadError = ref('')
let latestRequestId = 0

const TASK_PAGE_SIZE = 500

const statusList = [
  { label: '待开始', value: 'pending' },
  { label: '进行中', value: 'in_progress' },
  { label: '部分完成', value: 'partial_completed' },
  { label: '延期待审批', value: 'extension_pending' },
  { label: '延期通过', value: 'extension_approved' },
  { label: '执行已完成', value: 'completed' },
  { label: '待审核', value: 'pending_review' },
  { label: '待确认', value: 'pending_confirm' },
  { label: '已完结', value: 'finished' }
]

const getTasksByStatus = (status) => {
  return tasks.value.filter(task => task.status === status)
}

const getTaskCount = (status) => {
  return getTasksByStatus(status).length
}

const handleView = (task) => {
  router.push(taskDetailLocation(task, { includeTeamId: session.isGlobalReadOnly }))
}

const getTaskTeamName = (task) => {
  const directName = task?.team?.name || task?.teamId?.name || task?.teamName
  if (directName) return directName
  const teamId = taskTeamId(task)
  const matchedTeam = session.teams.find((team) => taskEntityId(team) === teamId)
  return matchedTeam?.name || '未识别团队'
}

const loadAllTaskPages = async () => {
  const firstResult = await getTaskList({ page: 1, limit: TASK_PAGE_SIZE })
  const firstPage = Array.isArray(firstResult?.tasks) ? firstResult.tasks : []
  const reportedTotal = Number(firstResult?.pagination?.total)
  const expectedTotal = Number.isFinite(reportedTotal) && reportedTotal >= 0
    ? reportedTotal
    : firstPage.length
  const reportedPages = Number(firstResult?.pagination?.pages)
  const totalPages = Math.max(
    1,
    Number.isInteger(reportedPages) && reportedPages > 0 ? reportedPages : 1,
    Math.ceil(expectedTotal / TASK_PAGE_SIZE)
  )
  const collected = [...firstPage]

  for (let page = 2; page <= totalPages; page += 1) {
    const result = await getTaskList({ page, limit: TASK_PAGE_SIZE })
    const pageTasks = Array.isArray(result?.tasks) ? result.tasks : []
    if (pageTasks.length === 0 && collected.length < expectedTotal) {
      throw new Error('任务分页结果不完整，请重新加载')
    }
    collected.push(...pageTasks)
  }

  const uniqueTasks = [...new Map(
    collected.map((task, index) => [taskEntityId(task) || `task-${index}`, task])
  ).values()]
  if (uniqueTasks.length < expectedTotal) {
    throw new Error('任务分页结果发生变化，请重新加载')
  }
  return uniqueTasks
}

const fetchData = async () => {
  const requestId = ++latestRequestId
  loading.value = true
  loadError.value = ''
  tasks.value = []
  try {
    const loadedTasks = await loadAllTaskPages()
    if (requestId !== latestRequestId) return
    tasks.value = loadedTasks
  } catch (error) {
    console.error('获取任务失败:', error)
    if (requestId !== latestRequestId) return
    tasks.value = []
    loadError.value = requestErrorMessage(error, '任务看板加载失败，请检查网络连接后重试。')
  } finally {
    if (requestId === latestRequestId) loading.value = false
  }
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped lang="scss">
.task-board {
  .board-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;

    .board-summary {
      color: #606266;
      font-size: 14px;
    }
  }

  .board-container {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    padding: 10px 0;
  }

  .board-column {
    flex: 0 0 280px;
    background: #f5f7fa;
    border-radius: 8px;
    padding: 12px;

    .column-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e4e7ed;

      .column-title {
        font-weight: 600;
        font-size: 14px;
      }
    }

    .column-content {
      min-height: 400px;
      max-height: 70vh;
      overflow-y: auto;
    }

    .task-card {
      display: block;
      width: 100%;
      background: white;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: all 0.3s;
      border: 1px solid #e4e7ed;

      &:hover,
      &:focus-visible {
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
        transform: translateY(-2px);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 2px;
      }

      .task-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .task-team {
        max-width: 100%;
        margin-bottom: 8px;
      }

      .task-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;

        .task-time {
          font-size: 12px;
          color: #909399;
        }
      }

      .task-executor {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: #606266;
      }
    }
  }
}
</style>

