<template>
  <div class="task-board">
    <el-card>
      <div class="board-container">
        <div class="board-column" v-for="status in statusList" :key="status.value">
          <div class="column-header">
            <span class="column-title">{{ status.label }}</span>
            <el-badge :value="getTaskCount(status.value)" type="primary" />
          </div>
          <div class="column-content">
            <div
              v-for="task in getTasksByStatus(status.value)"
              :key="task._id"
              class="task-card"
              @click="handleView(task)"
            >
              <div class="task-title">{{ task.taskName }}</div>
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
            </div>
            <el-empty v-if="getTaskCount(status.value) === 0" description="暂无任务" :image-size="60" />
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getTaskList } from '@/api/task'
import { formatDate, priorityMap, priorityType } from '@/utils/format'

const router = useRouter()
const tasks = ref([])

const statusList = [
  { label: '待开始', value: 'pending' },
  { label: '进行中', value: 'in_progress' },
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
  router.push(`/tasks/${task._id}`)
}

const fetchData = async () => {
  try {
    const result = await getTaskList({ limit: 100 })
    tasks.value = result.tasks
  } catch (error) {
    console.error('获取任务失败:', error)
  }
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped lang="scss">
.task-board {
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
      background: white;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      cursor: pointer;
      transition: all 0.3s;
      border: 1px solid #e4e7ed;

      &:hover {
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
        transform: translateY(-2px);
      }

      .task-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

