<template>
  <el-table :data="tasks" v-loading="loading" border>
    <el-table-column prop="taskName" label="任务名称" min-width="200" show-overflow-tooltip />
    <el-table-column v-if="showTeam" label="项目团队" min-width="150">
      <template #default="{ row }">
        <el-tag type="info" size="small">{{ resolveTeamName(row) }}</el-tag>
      </template>
    </el-table-column>
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
    <el-table-column label="计划完成" width="110">
      <template #default="{ row }">
        {{ formatDate(row.plannedCompletionTime, 'YYYY-MM-DD') }}
      </template>
    </el-table-column>
    <el-table-column label="操作" width="100" align="center">
      <template #default="{ row }">
        <div class="table-actions">
          <el-button type="primary" size="small" text @click="$emit('view', row)">查看</el-button>
        </div>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup>
import {
  taskStatusMap,
  taskStatusType,
  priorityMap,
  priorityType,
  formatDate,
  getTaskOverdueDays,
  isTaskOverdue
} from '@/utils/format'

const props = defineProps({
  tasks: Array,
  loading: Boolean,
  showTeam: Boolean,
  teams: {
    type: Array,
    default: () => []
  }
})

const resolveTeamName = (task) => {
  const value = task?.teamId
  const teamId = String(value?._id || value || '')
  return value?.name || props.teams.find((team) => String(team._id) === teamId)?.name || '未知团队'
}

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

defineEmits(['view'])
</script>

<style scoped>
.table-actions {
  justify-content: center;
}
</style>

