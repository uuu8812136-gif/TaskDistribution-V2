<template>
  <div class="dashboard">
    <el-row :gutter="20">
      <!-- 数据卡片 -->
      <el-col :xs="24" :sm="12" :md="6" v-for="card in dataCards" :key="card.key">
        <el-card class="stat-card" shadow="hover">
          <div class="card-content">
            <div class="card-icon" :style="{ background: card.color }">
              <el-icon :size="28">
                <component :is="card.icon" />
              </el-icon>
            </div>
            <div class="card-data">
              <div class="card-value">{{ card.value }}</div>
              <div class="card-label">{{ card.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-top: 20px">
      <!-- 任务状态分布 -->
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>任务状态分布</span>
            </div>
          </template>
          <div class="chart-container">
            <v-chart :option="pieChartOption" style="height: 300px" />
          </div>
        </el-card>
      </el-col>

      <!-- 任务优先级统计 -->
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>任务优先级统计</span>
            </div>
          </template>
          <div class="chart-container">
            <v-chart :option="barChartOption" style="height: 300px" />
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="20" style="margin-top: 20px">
      <!-- 待处理任务 -->
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>待处理任务</span>
              <el-button text type="primary" @click="goToTasks">查看更多</el-button>
            </div>
          </template>
          <el-table :data="pendingTasks" style="width: 100%" max-height="300">
            <el-table-column prop="taskName" label="任务名称" min-width="200" show-overflow-tooltip />
            <el-table-column prop="priority" label="优先级" width="100">
              <template #default="{ row }">
                <el-tag :type="priorityType[row.priority]" size="small">
                  {{ priorityMap[row.priority] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="plannedCompletionTime" label="截止时间" width="180">
              <template #default="{ row }">
                {{ formatDate(row.plannedCompletionTime, 'YYYY-MM-DD') }}
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="pendingTasks.length === 0" description="暂无待处理任务" />
        </el-card>
      </el-col>

      <!-- 最新消息 -->
      <el-col :xs="24" :md="12">
        <el-card>
          <template #header>
            <div class="card-header">
              <span>最新消息</span>
              <el-button text type="primary" @click="goToMessages">查看更多</el-button>
            </div>
          </template>
          <el-timeline>
            <el-timeline-item
              v-for="message in recentMessages"
              :key="message._id"
              :timestamp="fromNow(message.createdAt)"
              placement="top"
            >
              <div class="message-item" @click="handleMessageClick(message)">
                <div class="message-title">{{ message.title }}</div>
                <div class="message-content">{{ message.content }}</div>
              </div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-if="recentMessages.length === 0" description="暂无新消息" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { getStatisticsOverview } from '@/api/statistics'
import { getMyTasks } from '@/api/task'
import { getMessageList } from '@/api/message'
import { formatDate, fromNow, priorityMap, priorityType } from '@/utils/format'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart, BarChart } from 'echarts/charts'
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent
} from 'echarts/components'

use([
  CanvasRenderer,
  PieChart,
  BarChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent
])

const router = useRouter()

const overview = ref({})
const pendingTasks = ref([])
const recentMessages = ref([])

const dataCards = computed(() => [
  {
    key: 'total',
    label: '任务总数',
    value: overview.value.totalTasks || 0,
    icon: 'Document',
    color: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
  },
  {
    key: 'inProgress',
    label: '进行中',
    value: overview.value.inProgressTasks || 0,
    icon: 'Loading',
    color: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
  },
  {
    key: 'finished',
    label: '已完成',
    value: overview.value.finishedTasks || 0,
    icon: 'CircleCheck',
    color: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
  },
  {
    key: 'delayed',
    label: '延期任务',
    value: overview.value.delayedTasks || 0,
    icon: 'Clock',
    color: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)'
  }
])

const pieChartOption = computed(() => ({
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} ({d}%)'
  },
  legend: {
    bottom: '0',
    left: 'center'
  },
  series: [
    {
      name: '任务状态',
      type: 'pie',
      radius: ['40%', '70%'],
      avoidLabelOverlap: false,
      itemStyle: {
        borderRadius: 10,
        borderColor: '#fff',
        borderWidth: 2
      },
      label: {
        show: false,
        position: 'center'
      },
      emphasis: {
        label: {
          show: true,
          fontSize: 20,
          fontWeight: 'bold'
        }
      },
      labelLine: {
        show: false
      },
      data: [
        { value: overview.value.inProgressTasks || 0, name: '进行中' },
        { value: overview.value.finishedTasks || 0, name: '已完成' },
        { value: overview.value.pendingReviewTasks || 0, name: '待审核' },
        { value: overview.value.pendingConfirmTasks || 0, name: '待确认' }
      ]
    }
  ]
}))

const barChartOption = computed(() => ({
  tooltip: {
    trigger: 'axis',
    axisPointer: {
      type: 'shadow'
    }
  },
  grid: {
    left: '3%',
    right: '4%',
    bottom: '3%',
    containLabel: true
  },
  xAxis: {
    type: 'category',
    data: ['低', '普通', '高', '紧急'],
    axisTick: {
      alignWithLabel: true
    }
  },
  yAxis: {
    type: 'value'
  },
  series: [
    {
      name: '任务数量',
      type: 'bar',
      barWidth: '60%',
      data: [
        overview.value.priorityStats?.low || 0,
        overview.value.priorityStats?.normal || 0,
        overview.value.priorityStats?.high || 0,
        overview.value.priorityStats?.urgent || 0
      ],
      itemStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: '#83bff6' },
            { offset: 1, color: '#188df0' }
          ]
        }
      }
    }
  ]
}))

const fetchData = async () => {
  try {
    console.log('📊 开始获取统计数据...')
    
    // 获取统计概览
    const overviewData = await getStatisticsOverview()
    console.log('📊 统计概览返回:', overviewData)
    // 后端返回的数据在 overview 对象里
    overview.value = overviewData.overview || overviewData

    // 获取待处理任务
    const tasksRes = await getMyTasks({ type: 'executor', status: 'in_progress' })
    console.log('📋 任务列表返回:', tasksRes)
    pendingTasks.value = tasksRes.tasks?.slice(0, 5) || []

    // 获取最新消息
    const messagesRes = await getMessageList({ page: 1, limit: 5 })
    console.log('📬 消息列表返回:', messagesRes)
    recentMessages.value = messagesRes.messages || []
  } catch (error) {
    console.error('❌ 获取数据失败:', error)
  }
}

const goToTasks = () => {
  router.push('/tasks/my')
}

const goToMessages = () => {
  router.push('/messages')
}

const handleMessageClick = (message) => {
  if (message.relatedTask) {
    router.push(`/tasks/${message.relatedTask._id}`)
  }
}

onMounted(() => {
  fetchData()
})
</script>

<style scoped lang="scss">
.dashboard {
  .stat-card {
    margin-bottom: 20px;

    .card-content {
      display: flex;
      align-items: center;
      gap: 16px;

      .card-icon {
        width: 60px;
        height: 60px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
      }

      .card-data {
        flex: 1;

        .card-value {
          font-size: 28px;
          font-weight: bold;
          color: #303133;
          margin-bottom: 4px;
        }

        .card-label {
          font-size: 14px;
          color: #909399;
        }
      }
    }
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
  }

  .chart-container {
    padding: 10px;
  }

  .message-item {
    cursor: pointer;
    padding: 8px;
    border-radius: 4px;
    transition: all 0.3s;

    &:hover {
      background: #f5f7fa;
    }

    .message-title {
      font-weight: 600;
      margin-bottom: 4px;
      color: #303133;
    }

    .message-content {
      font-size: 13px;
      color: #606266;
      line-height: 1.5;
    }
  }
}
</style>

