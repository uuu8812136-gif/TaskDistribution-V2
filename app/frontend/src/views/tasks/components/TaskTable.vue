<template>
  <el-table :data="tasks" v-loading="loading" border>
    <el-table-column prop="taskName" label="任务名称" min-width="200" show-overflow-tooltip />
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
    <el-table-column label="操作" width="100">
      <template #default="{ row }">
        <el-button type="primary" size="small" text @click="$emit('view', row)">查看</el-button>
      </template>
    </el-table-column>
  </el-table>
  <el-empty v-if="tasks.length === 0 && !loading" description="暂无任务" />
</template>

<script setup>
import { taskStatusMap, taskStatusType, priorityMap, priorityType, formatDate } from '@/utils/format'

defineProps({
  tasks: Array,
  loading: Boolean
})

defineEmits(['view'])
</script>

