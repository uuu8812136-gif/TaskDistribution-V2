<template>
  <main class="daily-report-page">
    <header class="page-heading">
      <div>
        <h1>生产日报</h1>
        <p>{{ activeTeamName }}</p>
      </div>
      <el-button :loading="loading" circle aria-label="刷新生产日报" @click="refresh">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </header>

    <section v-if="session.isGlobalReadOnly" class="team-band">
      <el-select v-model="selectedTeamId" placeholder="选择项目团队" @change="handleTeamChange">
        <el-option v-for="team in session.teams" :key="team._id" :label="team.name" :value="team._id" />
      </el-select>
    </section>

    <section class="toolbar">
      <el-date-picker
        v-model="selectedDate"
        type="date"
        value-format="YYYY-MM-DD"
        format="YYYY-MM-DD"
        :clearable="false"
        aria-label="生产日报日期"
        @change="loadSelectedDate"
      />
      <el-button
        v-if="canGenerate"
        type="primary"
        :loading="generating"
        @click="generate"
      >
        <el-icon><DocumentAdd /></el-icon>
        生成日报
      </el-button>
      <el-button :disabled="!report?.finalText" @click="copyReport">
        <el-icon><CopyDocument /></el-icon>
        复制文字
      </el-button>
      <span class="toolbar-spacer" />
      <el-select
        v-if="report?.availableVersions?.length"
        v-model="selectedVersion"
        class="version-select"
        aria-label="日报版本"
        @change="loadVersion"
      >
        <el-option
          v-for="item in report.availableVersions"
          :key="item.version"
          :label="`版本 ${item.version}`"
          :value="item.version"
        />
      </el-select>
    </section>

    <el-alert
      v-if="generationBlock"
      :title="generationBlock"
      type="warning"
      show-icon
      :closable="false"
      class="generation-alert"
    />

    <section v-loading="loading" class="report-workspace">
      <article class="text-panel">
        <div v-if="report" class="report-meta">
          <el-tag effect="plain">版本 {{ report.version }}</el-tag>
          <span>{{ report.generatedByName }}</span>
          <span>{{ formatTime(report.generatedAt) }}</span>
          <span v-if="report.version < report.latestVersion">历史版本</span>
        </div>
        <el-input
          v-if="report"
          :model-value="report.finalText"
          type="textarea"
          :autosize="{ minRows: 16, maxRows: 24 }"
          readonly
          resize="vertical"
          aria-label="生产日报最终文字"
        />
        <el-empty v-else description="该日期尚未生成生产日报" />
      </article>

      <aside v-if="report" class="source-panel">
        <h2>来源追溯</h2>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="生成规则">{{ sourceSummary.ruleVersion }}</el-descriptions-item>
          <el-descriptions-item label="今日出勤审核">
            {{ shortId(sourceSummary.currentReviewId) }} · {{ formatTime(sourceSummary.currentReviewedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="昨日出勤审核">
            {{ shortId(sourceSummary.previousReviewId) }} · {{ formatTime(sourceSummary.previousReviewedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="出勤来源记录">{{ sourceSummary.attendanceRecordCount }} 条</el-descriptions-item>
          <el-descriptions-item label="排产来源记录">{{ sourceSummary.productionScheduleCount }} 条</el-descriptions-item>
          <el-descriptions-item label="排产月份">
            {{ sourceSummary.requiredMonths.join('、') || '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="来源指纹">
            <span class="fingerprint">{{ report.sourceFingerprint }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </aside>
    </section>

    <section class="history-band">
      <div class="section-heading">
        <h2>生成记录</h2>
        <span>共 {{ total }} 天</span>
      </div>
      <el-table :data="reports" row-key="_id" stripe empty-text="暂无生产日报">
        <el-table-column prop="reportDate" label="日期" width="125" />
        <el-table-column label="当前版本" width="100" align="center">
          <template #default="{ row }">v{{ row.version }}</template>
        </el-table-column>
        <el-table-column prop="versionCount" label="版本数" width="90" align="center" />
        <el-table-column prop="generatedByName" label="生成者" min-width="130" />
        <el-table-column label="生成时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.generatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="84" align="center">
          <template #default="{ row }">
            <el-button text type="primary" @click="selectRecord(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
      <footer class="pagination-row">
        <span>第 {{ filters.page }} 页</span>
        <el-pagination
          v-model:current-page="filters.page"
          :page-size="filters.pageSize"
          :total="total"
          layout="prev, pager, next"
          @current-change="loadList"
        />
      </footer>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { CopyDocument, DocumentAdd, Refresh } from '@element-plus/icons-vue'
import {
  generateDailyReport,
  getGeneratedDailyReport,
  getGeneratedDailyReports
} from '@/api/reporting'
import { useSessionStore } from '@/stores/session'
import { copyPlainText, dailyReportSourceSummary } from '@/utils/reporting'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const selectedDate = ref(String(route.query.date || dayjs().format('YYYY-MM-DD')))
const selectedTeamId = ref(String(route.query.teamId || ''))
const selectedVersion = ref(null)
const report = ref(null)
const reports = ref([])
const total = ref(0)
const loading = ref(false)
const generating = ref(false)
const generationBlock = ref('')
const filters = reactive({ page: 1, pageSize: 20 })

const canGenerate = computed(() => session.can('report.daily.generate', {
  write: true,
  teamRequired: true
}))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const activeTeamName = computed(() => {
  if (!session.isGlobalReadOnly) return session.activeTeam?.name || '当前项目团队'
  return session.teams.find(({ _id }) => _id === selectedTeamId.value)?.name || '全局只读'
})
const sourceSummary = computed(() => dailyReportSourceSummary(report.value))

function formatTime(value) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'
}

function shortId(value) {
  return value ? `…${String(value).slice(-8)}` : '-'
}

function blockMessage(error) {
  const code = error?.response?.data?.code || error?.code
  if (code === 'DAILY_REPORT_ATTENDANCE_REVIEW_REQUIRED') return '今日或昨日出勤尚未完成审核，暂不能生成。'
  if (code === 'DAILY_REPORT_ATTENDANCE_INCOMPLETE') return '出勤审核来源未包含完整七个分部，暂不能生成。'
  if (code === 'DAILY_REPORT_ATTENDANCE_SOURCE_MISSING') return '已审核出勤来源记录不完整，暂不能生成。'
  if (code === 'DAILY_REPORT_PRODUCTION_SCHEDULE_REQUIRED') return '今日、昨日或累计口径所需排产尚未维护完整，暂不能生成。'
  if (code === 'DAILY_REPORT_VERSION_LIMIT_REACHED') return '该日期已达到 50 个版本，已禁止继续生成。'
  return error?.response?.data?.message || error?.message || '生产日报生成失败。'
}

async function loadList() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getGeneratedDailyReports({
    ...requestTeamParams.value,
    page: filters.page,
    pageSize: filters.pageSize
  })
  reports.value = result.dailyReports || []
  total.value = result.total || 0
}

async function loadSelectedDate() {
  generationBlock.value = ''
  selectedVersion.value = null
  await router.replace({
    query: {
      ...(selectedTeamId.value ? { teamId: selectedTeamId.value } : {}),
      date: selectedDate.value
    }
  })
  loading.value = true
  try {
    const result = await getGeneratedDailyReports({
      ...requestTeamParams.value,
      dateFrom: selectedDate.value,
      dateTo: selectedDate.value,
      page: 1,
      pageSize: 1
    })
    if (!result.dailyReports?.length) {
      report.value = null
      return
    }
    const detail = await getGeneratedDailyReport(selectedDate.value, requestTeamParams.value)
    report.value = detail.dailyReport
    selectedVersion.value = detail.dailyReport.version
  } finally {
    loading.value = false
  }
}

async function loadVersion(version) {
  loading.value = true
  try {
    const result = await getGeneratedDailyReport(selectedDate.value, {
      ...requestTeamParams.value,
      version
    })
    report.value = result.dailyReport
  } finally {
    loading.value = false
  }
}

async function generate() {
  generationBlock.value = ''
  generating.value = true
  try {
    const result = await generateDailyReport(selectedDate.value)
    report.value = result.dailyReport
    selectedVersion.value = result.dailyReport.version
    ElMessage.success(result.idempotent ? '来源未变化，已保留当前版本' : `已生成版本 ${result.dailyReport.version}`)
    await loadList()
  } catch (error) {
    generationBlock.value = blockMessage(error)
  } finally {
    generating.value = false
  }
}

async function copyReport() {
  try {
    await copyPlainText(report.value?.finalText)
    ElMessage.success('生产日报文字已复制')
  } catch {
    ElMessage.error('复制失败，请使用系统复制功能')
  }
}

async function selectRecord(row) {
  selectedDate.value = row.reportDate
  await loadSelectedDate()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function handleTeamChange(teamId) {
  filters.page = 1
  report.value = null
  await router.replace({ query: { teamId, date: selectedDate.value } })
  await Promise.all([loadList(), loadSelectedDate()])
}

async function refresh() {
  loading.value = true
  try {
    await Promise.all([loadList(), loadSelectedDate()])
  } finally {
    loading.value = false
  }
}

async function initialize() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams[0]?._id || ''
  }
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  await Promise.all([loadList(), loadSelectedDate()])
}

onMounted(initialize)
</script>

<style scoped lang="scss">
.daily-report-page { min-width: 0; }
.page-heading, .toolbar, .report-meta, .section-heading, .pagination-row { display: flex; align-items: center; }
.page-heading { justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.page-heading h1 { margin: 0 0 5px; font-size: 24px; letter-spacing: 0; }
.page-heading p { margin: 0; color: #909399; }
.team-band { padding: 12px 0; border-block: 1px solid var(--zl-border-soft); }
.team-band .el-select { width: min(280px, 100%); }
.toolbar { flex-wrap: wrap; gap: 8px; padding: 14px 0; }
.toolbar-spacer { flex: 1; }
.version-select { width: 130px; }
.generation-alert { margin-bottom: 14px; }
.report-workspace { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(320px, .8fr); gap: 18px; align-items: start; }
.text-panel, .source-panel { min-width: 0; border: 1px solid var(--zl-border-soft); border-radius: 8px; background: var(--zl-surface); }
.text-panel { padding: 16px; }
.report-meta { min-height: 32px; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; color: #606266; font-size: 13px; }
.text-panel :deep(textarea) { line-height: 1.8; font-family: "Microsoft YaHei", sans-serif; letter-spacing: 0; }
.source-panel { padding: 16px; }
.source-panel h2, .section-heading h2 { margin: 0; font-size: 17px; letter-spacing: 0; }
.source-panel h2 { margin-bottom: 12px; }
.fingerprint { overflow-wrap: anywhere; font-family: Consolas, monospace; font-size: 12px; }
.history-band { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--zl-border-soft); }
.section-heading { justify-content: space-between; margin-bottom: 12px; color: #606266; }
.pagination-row { min-height: 52px; justify-content: space-between; gap: 12px; }
@media (max-width: 960px) {
  .report-workspace { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .page-heading { align-items: flex-start; }
  .toolbar > .el-date-editor { width: 100%; }
  .toolbar-spacer { display: none; }
  .version-select { width: 100%; }
  .text-panel, .source-panel { padding: 12px; }
}
</style>
