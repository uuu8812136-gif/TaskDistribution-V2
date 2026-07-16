<template>
  <div class="my-tasks">
    <el-card>
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="我执行的" name="executor">
          <TaskTable :tasks="tasks" :loading="loading" @view="handleView" />
        </el-tab-pane>
        <el-tab-pane label="抄送我的" name="cc">
          <TaskTable :tasks="tasks" :loading="loading" @view="handleView" />
        </el-tab-pane>
        <el-tab-pane label="我创建的" name="created">
          <TaskTable :tasks="tasks" :loading="loading" @view="handleView" />
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getMyTasks } from '@/api/task'
import TaskTable from './components/TaskTable.vue'

const router = useRouter()
const activeTab = ref('executor')
const loading = ref(false)
const tasks = ref([])

const fetchData = async () => {
  loading.value = true
  try {
    const result = await getMyTasks({ type: activeTab.value })
    tasks.value = result.tasks
  } catch (error) {
    console.error('获取任务失败:', error)
  } finally {
    loading.value = false
  }
}

const handleTabChange = () => {
  fetchData()
}

const handleView = (row) => {
  router.push(`/tasks/${row._id}`)
}

onMounted(() => {
  fetchData()
})
</script>

