<template>
  <div class="dashboard">
    <header class="dashboard-heading">
      <span class="heading-icon" aria-hidden="true">
        <el-icon><DataAnalysis /></el-icon>
      </span>
      <div>
        <h1>统计看板</h1>
        <p>任务执行概览</p>
      </div>
    </header>

    <section class="stats-grid" aria-label="任务统计概览">
      <el-card
        v-for="card in dataCards"
        :key="card.key"
        class="stat-card"
        shadow="never"
        :style="{ '--stat-color': card.color, '--stat-tint': card.tint }"
      >
        <div class="card-content">
          <div class="card-icon">
            <el-icon :size="24">
              <component :is="card.icon" />
            </el-icon>
          </div>
          <div class="card-data">
            <div class="card-value">{{ card.value }}</div>
            <div class="card-label">{{ card.label }}</div>
          </div>
        </div>
      </el-card>
    </section>

    <section class="dashboard-grid chart-grid">
      <el-card class="dashboard-card chart-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon><TrendCharts /></el-icon>
              <span>任务状态分布</span>
            </div>
          </div>
        </template>
        <div class="chart-container">
          <v-chart
            :option="pieChartOption"
            class="chart-canvas"
            autoresize
            role="img"
            aria-label="任务状态分布图"
          />
        </div>
      </el-card>

      <el-card class="dashboard-card chart-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon><Histogram /></el-icon>
              <span>任务优先级统计</span>
            </div>
          </div>
        </template>
        <div class="chart-container">
          <v-chart
            :option="barChartOption"
            class="chart-canvas"
            autoresize
            role="img"
            aria-label="任务优先级统计图"
          />
        </div>
      </el-card>
    </section>

    <section class="dashboard-grid activity-grid">
      <el-card class="dashboard-card activity-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon><List /></el-icon>
              <span>待处理任务</span>
            </div>
            <el-button text type="primary" class="card-link" @click="goToTasks">
              查看更多
              <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </template>
        <div v-if="pendingTasks.length" class="table-scroll">
          <el-table :data="pendingTasks" class="pending-table" max-height="300">
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
        </div>
        <el-empty v-else description="暂无待处理任务" />
      </el-card>

      <el-card class="dashboard-card activity-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div class="card-title">
              <el-icon><Bell /></el-icon>
              <span>最新消息</span>
            </div>
            <el-button text type="primary" class="card-link" @click="goToMessages">
              查看更多
              <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </template>
        <el-timeline v-if="recentMessages.length" class="message-timeline">
          <el-timeline-item
            v-for="message in recentMessages"
            :key="message._id"
            :timestamp="fromNow(message.createdAt)"
            placement="top"
          >
            <button
              type="button"
              class="message-item"
              :class="{ 'is-static': !message.relatedTask }"
              :disabled="!message.relatedTask"
              @click="handleMessageClick(message)"
            >
              <div class="message-title">{{ message.title }}</div>
              <div class="message-content">{{ message.content }}</div>
            </button>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无新消息" />
      </el-card>
    </section>
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
const prefersReducedMotion = typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const dataCards = computed(() => [
  {
    key: 'total',
    label: '任务总数',
    value: overview.value.totalTasks || 0,
    icon: 'Document',
    color: '#1677ff',
    tint: 'rgb(22 119 255 / 11%)'
  },
  {
    key: 'inProgress',
    label: '进行中',
    value: overview.value.inProgressTasks || 0,
    icon: 'Loading',
    color: '#7c5cff',
    tint: 'rgb(124 92 255 / 11%)'
  },
  {
    key: 'finished',
    label: '已完成',
    value: overview.value.finishedTasks || 0,
    icon: 'CircleCheck',
    color: '#389e0d',
    tint: 'rgb(82 196 26 / 12%)'
  },
  {
    key: 'delayed',
    label: '延期任务',
    value: overview.value.delayedTasks || 0,
    icon: 'Clock',
    color: '#d48806',
    tint: 'rgb(250 173 20 / 13%)'
  }
])

const pieChartOption = computed(() => ({
  animation: !prefersReducedMotion,
  color: ['#4096ff', '#52c41a', '#faad14', '#7c5cff'],
  tooltip: {
    trigger: 'item',
    formatter: '{b}: {c} ({d}%)',
    borderColor: '#dce6f4'
  },
  legend: {
    bottom: '0',
    left: 'center',
    textStyle: {
      color: '#64748b'
    }
  },
  series: [
    {
      name: '任务状态',
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '43%'],
      avoidLabelOverlap: false,
      itemStyle: {
        borderRadius: 6,
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
  animation: !prefersReducedMotion,
  tooltip: {
    trigger: 'axis',
    borderColor: '#dce6f4',
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
    axisLabel: {
      color: '#64748b'
    },
    axisLine: {
      lineStyle: { color: '#dce6f4' }
    },
    axisTick: {
      alignWithLabel: true
    }
  },
  yAxis: {
    type: 'value',
    axisLabel: {
      color: '#64748b'
    },
    splitLine: {
      lineStyle: { color: '#e8eef7' }
    }
  },
  series: [
    {
      name: '任务数量',
      type: 'bar',
      barMaxWidth: 42,
      data: [
        overview.value.priorityStats?.low || 0,
        overview.value.priorityStats?.normal || 0,
        overview.value.priorityStats?.high || 0,
        overview.value.priorityStats?.urgent || 0
      ],
      itemStyle: {
        color: '#4096ff',
        borderRadius: [6, 6, 0, 0]
      }
    }
  ]
}))

const fetchData = async () => {
  try {
    // 获取统计概览
    const overviewData = await getStatisticsOverview()
    // 后端返回的数据在 overview 对象里
    overview.value = overviewData.overview || overviewData

    // 获取待处理任务
    const tasksRes = await getMyTasks({ type: 'executor', status: 'in_progress' })
    pendingTasks.value = tasksRes.tasks?.slice(0, 5) || []

    // 获取最新消息
    const messagesRes = await getMessageList({ page: 1, limit: 5 })
    recentMessages.value = messagesRes.messages || []
  } catch {
    console.error('获取看板数据失败')
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
  min-width: 0;
  animation: dashboard-rise 0.5s var(--zl-easing) both;
}

.dashboard-heading {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;

  h1 {
    margin: 0 0 3px;
    color: var(--zl-text);
    font-size: 24px;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: var(--zl-muted);
    font-size: 13px;
    line-height: 1.5;
  }
}

.heading-icon {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 44px;
  color: var(--zl-primary-deep);
  background: rgb(64 150 255 / 11%);
  border: 1px solid rgb(64 150 255 / 16%);
  border-radius: 14px;
  font-size: 22px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.stat-card {
  position: relative;
  min-width: 0;
  border-color: rgb(220 230 244 / 82%);
  box-shadow: 0 5px 18px rgb(30 64 175 / 7%);
  transition: transform 0.3s var(--zl-easing), box-shadow 0.3s var(--zl-easing);

  &::before {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    background: var(--stat-color);
    content: '';
  }

  &:hover {
    box-shadow: 0 10px 28px rgb(30 64 175 / 12%);
    transform: translateY(-2px);
  }

  :deep(.el-card__body) {
    height: 100%;
    padding: 18px;
  }
}

.card-content {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.card-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 48px;
  color: var(--stat-color);
  background: var(--stat-tint);
  border-radius: 14px;
}

.card-data {
  min-width: 0;
  flex: 1;
}

.card-value {
  overflow: hidden;
  margin-bottom: 3px;
  color: var(--zl-text);
  font-size: 27px;
  font-weight: 700;
  line-height: 1.2;
  text-overflow: ellipsis;
}

.card-label {
  overflow: hidden;
  color: var(--zl-muted);
  font-size: 13px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-grid {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-top: 20px;
}

.dashboard-card {
  min-width: 0;
  height: 100%;
  border-color: rgb(220 230 244 / 82%);
  box-shadow: 0 5px 18px rgb(30 64 175 / 6%);

  :deep(.el-card__header) {
    min-height: 58px;
    padding: 14px 18px;
    border-bottom-color: rgb(220 230 244 / 76%);
  }

  :deep(.el-card__body) {
    min-width: 0;
    padding: 18px;
  }
}

.card-header {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}

.card-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  color: #27364d;
  font-size: 15px;
  line-height: 22px;

  .el-icon {
    flex: 0 0 auto;
    color: var(--zl-primary-deep);
    font-size: 18px;
  }
}

.card-link {
  min-height: 32px !important;
  padding-inline: 6px;
  gap: 4px;
  flex: 0 0 auto;
}

.chart-container {
  min-width: 0;
}

.chart-canvas {
  width: 100%;
  height: 300px;
}

.table-scroll {
  width: 100%;
  overflow-x: auto;
}

.pending-table {
  width: 100%;
  min-width: 520px;
}

.message-timeline {
  margin-top: 3px;
  padding-left: 3px;
}

.message-item {
  width: 100%;
  padding: 9px 10px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.2s var(--zl-easing);

  &:hover,
  &:focus-visible {
    background: rgb(64 150 255 / 8%);
  }

  &:focus-visible {
    outline: 2px solid var(--zl-primary);
    outline-offset: 2px;
  }

  &.is-static {
    cursor: default;
  }
}

.message-title {
  overflow: hidden;
  margin-bottom: 4px;
  color: var(--zl-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-content {
  display: -webkit-box;
  overflow: hidden;
  color: #526176;
  font-size: 13px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

@keyframes dashboard-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 1100px) {
  .stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .dashboard-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    margin-top: 12px;
  }

  .stats-grid {
    gap: 12px;
    margin-bottom: 12px;
  }

  .chart-canvas {
    height: 270px;
  }
}

@media (max-width: 420px) {
  .dashboard-heading {
    margin-bottom: 16px;

    h1 {
      font-size: 21px;
    }
  }

  .heading-icon {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
    font-size: 20px;
  }

  .stat-card {
    :deep(.el-card__body) {
      padding: 13px;
    }
  }

  .card-content {
    gap: 10px;
  }

  .card-icon {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
    border-radius: 12px;
  }

  .card-value {
    font-size: 23px;
  }

  .dashboard-card {
    :deep(.el-card__header),
    :deep(.el-card__body) {
      padding: 14px;
    }
  }

  .card-link {
    font-size: 13px;
  }

  .chart-canvas {
    height: 250px;
  }
}

@media (max-width: 340px) {
  .stats-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dashboard {
    animation: none;
  }

  .stat-card,
  .message-item {
    transition: none;
  }

  .stat-card:hover {
    transform: none;
  }
}
</style>

