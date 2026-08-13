<template>
  <div class="my-tasks">
    <el-card>
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="我执行的" name="executor">
          <TaskTable
            :tasks="tasks"
            :loading="loading"
            :show-team="session.isGlobalReadOnly"
            :teams="session.teams"
            @view="handleView"
          />
        </el-tab-pane>
        <el-tab-pane label="抄送我的" name="cc">
          <TaskTable
            :tasks="tasks"
            :loading="loading"
            :show-team="session.isGlobalReadOnly"
            :teams="session.teams"
            @view="handleView"
          />
        </el-tab-pane>
        <el-tab-pane label="我创建的" name="created">
          <TaskTable
            :tasks="tasks"
            :loading="loading"
            :show-team="session.isGlobalReadOnly"
            :teams="session.teams"
            @view="handleView"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { getMyTasks } from '@/api/task'
import { useSessionStore } from '@/stores/session'
import { taskDetailLocation } from '@/utils/taskPolicy'
import { createMutationAwareListRefreshTracker } from '@/utils/mutationAwareListRefresh'
import { SUCCESSFUL_MUTATION_SCOPES } from '@/utils/successfulMutationRevision'
import TaskTable from './components/TaskTable.vue'

const router = useRouter()
const session = useSessionStore()
const activeTab = ref('executor')
const loading = ref(false)
const tasks = ref([])
let fetchRequestId = 0
let activationReady = false
const mutationRefresh = createMutationAwareListRefreshTracker({
  scopes: SUCCESSFUL_MUTATION_SCOPES.TASKS
})

const fetchData = async ({ preserveExisting = false } = {}) => {
  const loadStartRevision = mutationRefresh.currentRevision()
  const requestId = ++fetchRequestId
  loading.value = true
  if (!preserveExisting) tasks.value = []
  try {
    const result = await getMyTasks({ type: activeTab.value })
    if (requestId !== fetchRequestId) return
    tasks.value = result.tasks || []
    mutationRefresh.markThrough(loadStartRevision)
    return true
  } catch (error) {
    if (requestId !== fetchRequestId) return
    if (!preserveExisting) tasks.value = []
    console.error('获取任务失败:', error)
    return false
  } finally {
    if (requestId === fetchRequestId) loading.value = false
  }
}

const handleTabChange = () => {
  fetchData()
}

const handleView = (row) => {
  router.push(taskDetailLocation(row, { includeTeamId: session.isGlobalReadOnly }))
}

onMounted(async () => {
  try {
    await fetchData()
  } finally {
    activationReady = true
  }
})
onActivated(() => {
  if (!activationReady) return
  void mutationRefresh.refreshIfNeeded(() => fetchData({ preserveExisting: true })).catch(() => {})
})
</script>

