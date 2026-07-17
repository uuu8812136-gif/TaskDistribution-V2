<template>
  <div class="report-page attendance-page">
    <header class="page-heading">
      <div>
        <h1>出勤日报</h1>
        <p>{{ session.activeTeam?.name || '跨团队只读查询' }}</p>
      </div>
      <el-button v-if="canSubmit" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        新建日报
      </el-button>
    </header>

    <section class="view-switcher" aria-label="出勤数据视图">
      <el-segmented v-model="viewMode" :options="viewOptions" @change="loadActiveView" />
    </section>

    <section class="toolbar">
      <el-select
        v-if="session.isGlobalReadOnly"
        v-model="selectedTeamId"
        class="team-select"
        placeholder="选择项目团队"
        @change="handleTeamChange"
      >
        <el-option
          v-for="team in session.teams"
          :key="team._id"
          :label="team.name"
          :value="team._id"
        />
      </el-select>

      <template v-if="viewMode === 'records'">
        <el-date-picker
          v-model="filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          range-separator="至"
          class="date-range"
        />
        <el-select v-model="filters.orgUnitId" clearable filterable placeholder="所属分部">
          <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
        </el-select>
        <el-select v-model="filters.dataQualityStatus" clearable placeholder="数据状态">
          <el-option label="已确认" value="CONFIRMED" />
          <el-option label="待确认" value="PENDING_CONFIRMATION" />
        </el-select>
      </template>

      <template v-else-if="viewMode === 'daily'">
        <el-date-picker
          v-model="dailyDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="汇总日期"
        />
      </template>

      <template v-else>
        <el-date-picker
          v-model="summaryMonth"
          type="month"
          value-format="YYYY-MM"
          placeholder="汇总月份"
        />
      </template>

      <el-button type="primary" @click="applyFilters">查询</el-button>
      <el-button v-if="viewMode === 'records'" @click="resetFilters">重置</el-button>
      <el-button
        v-if="viewMode === 'monthly' && canExportMonthly"
        :loading="exporting"
        @click="exportMonthly"
      >
        导出 A:R 月报
      </el-button>
      <span class="toolbar-spacer" />
      <el-button :loading="activeLoading" circle aria-label="刷新出勤数据" @click="loadActiveView">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </section>

    <template v-if="viewMode === 'records'">
      <section class="table-shell">
        <el-table
          v-loading="loading"
          :data="records"
          row-key="_id"
          stripe
          empty-text="暂无出勤日报"
        >
          <el-table-column prop="reportDate" label="日期" width="112" fixed="left" />
          <el-table-column label="所属分部" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ orgName(row.orgUnitId) }}</template>
          </el-table-column>
          <el-table-column prop="authorizedHeadcount" label="编制" width="78" align="right" />
          <el-table-column prop="registeredHeadcount" label="在册" width="78" align="right" />
          <el-table-column label="白班实到" width="92" align="right">
            <template #default="{ row }">{{ row.dayShift.actualAttendanceCount }}</template>
          </el-table-column>
          <el-table-column label="夜班实到" width="92" align="right">
            <template #default="{ row }">{{ row.nightShift.actualAttendanceCount }}</template>
          </el-table-column>
          <el-table-column prop="pendingDepartureCount" label="待离职" width="86" align="right" />
          <el-table-column label="帮产人员" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              {{ supportText(row.support) }}
            </template>
          </el-table-column>
          <el-table-column label="数据状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag
                :type="row.dataQualityStatus === 'PENDING_CONFIRMATION' ? 'warning' : 'success'"
                effect="light"
              >
                {{ row.dataQualityStatus === 'PENDING_CONFIRMATION' ? '待确认' : '已确认' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="审核状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="row.reviewStatus === 'REVIEWED' ? 'success' : 'info'" effect="plain">
                {{ row.reviewStatus === 'REVIEWED' ? '已审核' : '待审核' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="142" fixed="right" align="center">
            <template #default="{ row }">
              <div class="table-actions">
                <el-button text type="primary" @click="openDetail(row._id)">详情</el-button>
                <el-button
                  v-if="canSubmitPermission && row.accessPolicy?.editable"
                  text
                  type="primary"
                  @click="openEdit(row._id)"
                >
                  编辑
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <footer class="pagination-row">
        <span>共 {{ total }} 条</span>
        <el-pagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="sizes, prev, pager, next"
          @change="loadRecords"
        />
      </footer>
    </template>

    <template v-else-if="viewMode === 'daily'">
      <el-alert
        v-if="dailySummary.dataQuality?.status === 'PENDING_CONFIRMATION'"
        title="客户原始分部数据与部门汇总模板存在矛盾，当前按七个分部原始行计算"
        type="warning"
        :closable="false"
        show-icon
        class="quality-alert"
      />
      <el-alert
        v-if="dailySummary.missingOrgUnits?.length"
        :title="`缺报分部：${dailySummary.missingOrgUnits.map((item) => item.name).join('、')}`"
        description="七个分部未全部提交时禁止生成和审核；考勤员点击下方按钮后会向缺报提报人和考勤员发送站内提醒。"
        type="error"
        :closable="false"
        show-icon
        class="quality-alert"
      />

      <section class="metric-band" v-loading="dailyLoading">
        <div class="metric-item">
          <span>已提报分部</span>
          <strong>{{ dailySummary.submissionCount || 0 }}</strong>
        </div>
        <div class="metric-item">
          <span>编制人数</span>
          <strong>{{ dailySummary.authorizedHeadcount || 0 }}</strong>
        </div>
        <div class="metric-item">
          <span>在册人数</span>
          <strong>{{ dailySummary.registeredHeadcount || 0 }}</strong>
        </div>
        <div class="metric-item">
          <span>白班实际出勤</span>
          <strong>{{ dailySummary.dayShift?.actualAttendanceCount || 0 }}</strong>
        </div>
        <div class="metric-item">
          <span>夜班实际出勤</span>
          <strong>{{ dailySummary.nightShift?.actualAttendanceCount || 0 }}</strong>
        </div>
        <div class="metric-item">
          <span>待离职</span>
          <strong>{{ dailySummary.pendingDepartureCount || 0 }}</strong>
        </div>
      </section>

      <section v-if="canReview || dailySummary.review" class="review-panel">
        <div class="section-heading">
          <div>
            <h2>部门考勤员审核</h2>
            <span v-if="dailySummary.review">
              已于 {{ formatDateTime(dailySummary.review.reviewedAt) }} 永久锁定
            </span>
            <span v-else>
              {{ dailySummary.isComplete ? '七个分部已齐，可审核确认' : '日报未齐，仅可发送缺报提醒' }}
            </span>
          </div>
          <el-tag v-if="dailySummary.review" type="success">已审核</el-tag>
        </div>
        <template v-if="canReview && !dailySummary.review">
          <el-input
            v-model="reviewReason"
            type="textarea"
            :rows="2"
            maxlength="2000"
            show-word-limit
            placeholder="审核说明（选填）"
          />
          <div class="review-actions">
            <el-button
              :type="dailySummary.isComplete ? 'primary' : 'danger'"
              :loading="reviewing"
              @click="handleReview"
            >
              <el-icon><CircleCheck v-if="dailySummary.isComplete" /><Bell v-else /></el-icon>
              {{ dailySummary.isComplete ? '审核确认并永久锁定' : '检查缺报并发送提醒' }}
            </el-button>
          </div>
        </template>
      </section>

      <section v-if="dailySummary.review?.finalText" class="final-text-panel">
        <div class="section-heading">
          <h2>最终汇报文字</h2>
          <el-button type="primary" plain @click="copyFinalText">
            <el-icon><CopyDocument /></el-icon>
            复制文字
          </el-button>
        </div>
        <el-input :model-value="dailySummary.review.finalText" type="textarea" :rows="14" readonly />
      </section>

      <section class="summary-grid">
        <div class="summary-panel">
          <div class="section-heading">
            <h2>白班汇总</h2>
            <span>{{ dailyDate }}</span>
          </div>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="实际出勤">{{ dailySummary.dayShift?.actualAttendanceCount || 0 }}</el-descriptions-item>
            <el-descriptions-item label="请假（含病假）">{{ dailySummary.dayShift?.leaveWithSickCount || 0 }}</el-descriptions-item>
            <el-descriptions-item
              v-for="item in ATTENDANCE_NAMED_FIELDS"
              :key="`day-${item.key}`"
              :label="item.label"
            >
              {{ dailySummary.dayShift?.[item.key]?.count || 0 }}
              <span v-if="dailySummary.dayShift?.[item.key]?.names?.length" class="names-inline">
                （{{ attendanceNamesText(dailySummary.dayShift[item.key].names) }}）
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </div>

        <div class="summary-panel">
          <div class="section-heading">
            <h2>夜班汇总</h2>
            <span>{{ dailyDate }}</span>
          </div>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="实际出勤">{{ dailySummary.nightShift?.actualAttendanceCount || 0 }}</el-descriptions-item>
            <el-descriptions-item label="请假（含病假）">{{ dailySummary.nightShift?.leaveWithSickCount || 0 }}</el-descriptions-item>
            <el-descriptions-item
              v-for="item in ATTENDANCE_NAMED_FIELDS"
              :key="`night-${item.key}`"
              :label="item.label"
            >
              {{ dailySummary.nightShift?.[item.key]?.count || 0 }}
              <span v-if="dailySummary.nightShift?.[item.key]?.names?.length" class="names-inline">
                （{{ attendanceNamesText(dailySummary.nightShift[item.key].names) }}）
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </section>

      <section v-if="dailySummary.support?.length" class="summary-panel support-panel">
        <div class="section-heading"><h2>帮产情况</h2></div>
        <div v-for="item in dailySummary.support" :key="item.destination" class="support-row">
          <strong>{{ item.destination }}</strong>
          <span>{{ item.count }} 人</span>
          <span>{{ attendanceNamesText(item.names) }}</span>
        </div>
      </section>

      <section v-if="dailySummary.dataQuality?.issues?.length" class="quality-issues">
        <div class="section-heading"><h2>数据质量异常</h2><span>需客户确认</span></div>
        <div v-for="issue in dailySummary.dataQuality.issues" :key="issue.code" class="quality-issue-row">
          <el-icon><Warning /></el-icon>
          <div>
            <strong>{{ issue.message }}</strong>
            <span>模板值 {{ issue.sourceValue }}，按分部原始行计算 {{ issue.calculatedValue }} · {{ issue.sourceReference }}</span>
          </div>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="table-shell">
        <el-table
          v-loading="monthlyLoading"
          :data="monthlySummaries"
          row-key="reportDate"
          stripe
          empty-text="该月暂无出勤日报"
        >
          <el-table-column prop="reportDate" label="日期" width="112" fixed="left" />
          <el-table-column prop="authorizedHeadcount" label="编制" width="78" align="right" />
          <el-table-column prop="registeredHeadcount" label="在册" width="78" align="right" />
          <el-table-column label="白班实到" width="92" align="right">
            <template #default="{ row }">{{ row.dayShift.actualAttendanceCount }}</template>
          </el-table-column>
          <el-table-column label="白班休班" width="92" align="right">
            <template #default="{ row }">{{ row.dayShift.rest.count }}</template>
          </el-table-column>
          <el-table-column label="白班请假" width="92" align="right">
            <template #default="{ row }">{{ row.dayShift.leaveWithSickCount }}</template>
          </el-table-column>
          <el-table-column label="白班未入职" width="106" align="right">
            <template #default="{ row }">{{ row.dayShift.notYetEmployed.count }}</template>
          </el-table-column>
          <el-table-column label="白班待离职" width="106" align="right">
            <template #default="{ row }">{{ row.dayShift.pendingDeparture.count }}</template>
          </el-table-column>
          <el-table-column label="白班旷工" width="92" align="right">
            <template #default="{ row }">{{ row.dayShift.absenteeism.count }}</template>
          </el-table-column>
          <el-table-column label="夜班实到" width="92" align="right">
            <template #default="{ row }">{{ row.nightShift.actualAttendanceCount }}</template>
          </el-table-column>
          <el-table-column label="帮产人员" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ supportSummaryText(row.support) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90" fixed="right" align="center">
            <template #default="{ row }">
              <el-tag :type="row.dataQuality.status === 'PENDING_CONFIRMATION' ? 'warning' : 'success'">
                {{ row.dataQuality.status === 'PENDING_CONFIRMATION' ? '待确认' : '已确认' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>

    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑出勤日报' : '新建出勤日报'"
      width="min(1080px, 96vw)"
      destroy-on-close
      append-to-body
      @closed="resetForm"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
        <div class="form-grid four-columns">
          <el-form-item label="所属分部" prop="orgUnitId">
            <el-select
              v-model="form.orgUnitId"
              filterable
              :disabled="attendancePolicy.isReporter && !attendancePolicy.isOfficer"
              class="full-width"
            >
              <el-option v-for="item in orgUnits" :key="item._id" :label="item.name" :value="item._id" />
            </el-select>
          </el-form-item>
          <el-form-item label="提报日期" prop="reportDate">
            <el-date-picker v-model="form.reportDate" type="date" value-format="YYYY-MM-DD" class="full-width" />
          </el-form-item>
          <el-form-item label="编制人数">
            <el-input-number v-model="form.authorizedHeadcount" :min="0" :precision="0" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="在册人数">
            <el-input-number v-model="form.registeredHeadcount" :min="0" :precision="0" controls-position="right" class="full-width" />
          </el-form-item>
        </div>

        <div class="shift-form-grid">
          <fieldset v-for="shift in shiftForms" :key="shift.key" class="shift-fieldset">
            <legend>{{ shift.label }}</legend>
            <el-form-item label="实际出勤人数">
              <el-input-number
                v-model="form[shift.key].actualAttendanceCount"
                :min="0"
                :precision="0"
                controls-position="right"
                class="full-width"
              />
            </el-form-item>
            <div v-for="item in ATTENDANCE_NAMED_FIELDS" :key="item.key" class="named-input-row">
              <el-form-item :label="`${item.label}人数`">
                <el-input-number
                  v-model="form[shift.key][item.key].count"
                  :min="0"
                  :precision="0"
                  controls-position="right"
                  class="full-width"
                />
              </el-form-item>
              <el-form-item :label="`${item.label}姓名`">
                <el-input
                  v-model="form[shift.key][item.key].names"
                  maxlength="1000"
                  :placeholder="`${item.label}为0时可留空，多个姓名用顿号分隔`"
                />
              </el-form-item>
            </div>
          </fieldset>
        </div>

        <div class="form-section-heading"><h3>其他情况</h3></div>
        <div class="form-grid three-columns">
          <el-form-item label="帮产去向">
            <el-input v-model="form.support.destination" maxlength="200" placeholder="例如：物流技术部" />
          </el-form-item>
          <el-form-item label="帮产人数">
            <el-input-number v-model="form.support.count" :min="0" :precision="0" controls-position="right" class="full-width" />
          </el-form-item>
          <el-form-item label="帮产姓名">
            <el-input v-model="form.support.names" maxlength="1000" placeholder="多个姓名用顿号分隔" />
          </el-form-item>
        </div>
        <el-form-item label="其他情况备注">
          <el-input v-model="form.otherRemark" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
        <el-form-item
          v-if="editingId || attendancePolicy.isOfficer"
          :label="attendancePolicy.lateReasonRequired ? '补报/修正原因（必填）' : '修改说明'"
        >
          <el-input v-model="form.reason" type="textarea" :rows="2" maxlength="2000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="出勤日报详情" size="min(760px, 94vw)" append-to-body>
      <div v-loading="detailLoading" class="detail-content">
        <el-alert
          v-if="detail.dataQualityStatus === 'PENDING_CONFIRMATION'"
          title="该记录来自客户原始资料，汇总值存在待确认差异"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-descriptions :column="2" border class="detail-descriptions">
          <el-descriptions-item label="日期">{{ detail.reportDate || '-' }}</el-descriptions-item>
          <el-descriptions-item label="分部">{{ orgName(detail.orgUnitId) }}</el-descriptions-item>
          <el-descriptions-item label="编制">{{ detail.authorizedHeadcount ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="在册">{{ detail.registeredHeadcount ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="白班实际出勤">{{ detail.dayShift?.actualAttendanceCount ?? '-' }}</el-descriptions-item>
          <el-descriptions-item label="夜班实际出勤">{{ detail.nightShift?.actualAttendanceCount ?? '-' }}</el-descriptions-item>
        </el-descriptions>
        <div v-for="shift in shiftForms" :key="`detail-${shift.key}`" class="detail-section">
          <div class="section-heading"><h2>{{ shift.label }}</h2></div>
          <el-descriptions :column="2" border>
            <el-descriptions-item v-for="item in ATTENDANCE_NAMED_FIELDS" :key="item.key" :label="item.label">
              {{ detail[shift.key]?.[item.key]?.count || 0 }} 人
              <span v-if="detail[shift.key]?.[item.key]?.names?.length">
                （{{ attendanceNamesText(detail[shift.key][item.key].names) }}）
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </div>
        <div v-if="detail.dataQualityIssues?.length" class="detail-section">
          <div class="section-heading"><h2>数据质量异常</h2></div>
          <div v-for="issue in detail.dataQualityIssues" :key="issue.code" class="quality-issue-row">
            <el-icon><Warning /></el-icon>
            <div><strong>{{ issue.message }}</strong><span>{{ issue.sourceReference }}</span></div>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import dayjs from 'dayjs'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createAttendanceSubmission,
  exportAttendanceMonthlySummary,
  getAttendanceDailySummary,
  getAttendanceMonthlySummary,
  getAttendanceOptions,
  getAttendanceSubmission,
  getAttendanceSubmissions,
  reviewAttendanceDailySummary,
  updateAttendanceSubmission
} from '@/api/reporting'
import { useSessionStore } from '@/stores/session'
import {
  ATTENDANCE_NAMED_FIELDS,
  attendanceNamesText,
  buildAttendancePayload,
  emptyAttendanceForm,
  entityName,
  saveBlob
} from '@/utils/reporting'

const session = useSessionStore()
const viewMode = ref('records')
const viewOptions = [
  { label: '日报明细', value: 'records' },
  { label: '部门日汇总', value: 'daily' },
  { label: '月汇总', value: 'monthly' }
]
const shiftForms = [
  { key: 'dayShift', label: '白班' },
  { key: 'nightShift', label: '夜班' }
]
const selectedTeamId = ref('')
const orgUnits = ref([])
const records = ref([])
const total = ref(0)
const loading = ref(false)
const dailyLoading = ref(false)
const monthlyLoading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const reviewing = ref(false)
const formVisible = ref(false)
const editingId = ref('')
const formRef = ref(null)
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref({})
const dailyDate = ref('2026-07-14')
const summaryMonth = ref('2026-07')
const dailySummary = ref({})
const attendancePolicy = ref({})
const reviewReason = ref('')
const monthlySummaries = ref([])
const form = reactive(emptyAttendanceForm(dayjs().format('YYYY-MM-DD')))
const filters = reactive({
  dateRange: [],
  orgUnitId: '',
  dataQualityStatus: '',
  page: 1,
  pageSize: 20
})

const canSubmitPermission = computed(() => session.can('report.submit', {
  write: true,
  teamRequired: true
}))
const canSubmit = computed(() => canSubmitPermission.value && attendancePolicy.value.canCreate === true)
const canReview = computed(() => (
  session.can('report.review', { write: true, teamRequired: true }) &&
  attendancePolicy.value.isOfficer === true
))
const canExportMonthly = computed(() => (
  session.hasPermission('report.export') &&
  (!session.isGlobalReadOnly || Boolean(selectedTeamId.value)) &&
  (session.isGlobalReadOnly || session.moduleDataScopes['report.attendance'] === 'TEAM')
))
const requestTeamParams = computed(() => (
  session.isGlobalReadOnly && selectedTeamId.value ? { teamId: selectedTeamId.value } : {}
))
const activeLoading = computed(() => (
  viewMode.value === 'records' ? loading.value :
    viewMode.value === 'daily' ? dailyLoading.value : monthlyLoading.value
))
const rules = {
  orgUnitId: [{ required: true, message: '请选择所属分部', trigger: 'change' }],
  reportDate: [{ required: true, message: '请选择提报日期', trigger: 'change' }]
}

const orgName = (id) => entityName(orgUnits.value, id, id ? `组织 ${id.slice(-6)}` : '-')

function supportText(support = {}) {
  if (!support.count && !support.names?.length) return '-'
  const destination = support.destination || '未填写去向'
  return `${destination} ${support.count || 0}人（${attendanceNamesText(support.names)}）`
}

function supportSummaryText(groups = []) {
  return groups.map((item) => supportText(item)).join('；') || '-'
}

function recordParams() {
  return {
    ...requestTeamParams.value,
    dateFrom: filters.dateRange?.[0] || undefined,
    dateTo: filters.dateRange?.[1] || undefined,
    orgUnitId: filters.orgUnitId || undefined,
    dataQualityStatus: filters.dataQualityStatus || undefined,
    page: filters.page,
    pageSize: filters.pageSize
  }
}

async function loadOptions() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  const result = await getAttendanceOptions(requestTeamParams.value)
  orgUnits.value = result.orgUnits || []
  attendancePolicy.value = result.attendancePolicy || {}
}

async function loadRecords() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  loading.value = true
  try {
    const result = await getAttendanceSubmissions(recordParams())
    records.value = result.attendanceSubmissions || []
    total.value = result.total || 0
  } finally {
    loading.value = false
  }
}

async function loadDailySummary() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  dailyLoading.value = true
  try {
    const result = await getAttendanceDailySummary({
      ...requestTeamParams.value,
      date: dailyDate.value
    })
    dailySummary.value = result.attendanceSummary || {}
  } finally {
    dailyLoading.value = false
  }
}

async function loadMonthlySummary() {
  if (session.isGlobalReadOnly && !selectedTeamId.value) return
  monthlyLoading.value = true
  try {
    const result = await getAttendanceMonthlySummary({
      ...requestTeamParams.value,
      month: summaryMonth.value
    })
    monthlySummaries.value = result.attendanceSummaries || []
  } finally {
    monthlyLoading.value = false
  }
}

async function exportMonthly() {
  if (!summaryMonth.value || !canExportMonthly.value || exporting.value) return
  exporting.value = true
  try {
    const blob = await exportAttendanceMonthlySummary({
      ...requestTeamParams.value,
      month: summaryMonth.value
    })
    saveBlob(blob, `出勤月报-${summaryMonth.value}.xlsx`)
    ElMessage.success('出勤月报已导出，仅包含已审核日报')
  } finally {
    exporting.value = false
  }
}

async function loadActiveView() {
  if (viewMode.value === 'records') return loadRecords()
  if (viewMode.value === 'daily') return loadDailySummary()
  return loadMonthlySummary()
}

async function applyFilters() {
  if (viewMode.value === 'records') filters.page = 1
  await loadActiveView()
}

async function resetFilters() {
  Object.assign(filters, {
    dateRange: [],
    orgUnitId: '',
    dataQualityStatus: '',
    page: 1,
    pageSize: 20
  })
  await loadRecords()
}

async function handleTeamChange() {
  orgUnits.value = []
  records.value = []
  dailySummary.value = {}
  attendancePolicy.value = {}
  monthlySummaries.value = []
  await loadOptions()
  await loadActiveView()
}

function resetForm() {
  editingId.value = ''
  Object.assign(form, emptyAttendanceForm(dayjs().format('YYYY-MM-DD')))
}

function openCreate() {
  resetForm()
  form.reportDate = attendancePolicy.value.currentBusinessDate || dayjs().format('YYYY-MM-DD')
  if (attendancePolicy.value.reporterOrgUnitId) {
    form.orgUnitId = attendancePolicy.value.reporterOrgUnitId
  } else if (orgUnits.value.length === 1) {
    form.orgUnitId = orgUnits.value[0]._id
  }
  formVisible.value = true
}

function namesToInput(value) {
  return (value || []).join('、')
}

function toEditableShift(shift = {}) {
  return {
    actualAttendanceCount: shift.actualAttendanceCount || 0,
    ...Object.fromEntries(ATTENDANCE_NAMED_FIELDS.map(({ key }) => [
      key,
      { count: shift[key]?.count || 0, names: namesToInput(shift[key]?.names) }
    ]))
  }
}

function fillForm(record) {
  Object.assign(form, {
    orgUnitId: record.orgUnitId,
    reportDate: record.reportDate,
    authorizedHeadcount: record.authorizedHeadcount,
    registeredHeadcount: record.registeredHeadcount,
    dayShift: toEditableShift(record.dayShift),
    nightShift: toEditableShift(record.nightShift),
    support: {
      destination: record.support?.destination || '',
      count: record.support?.count || 0,
      names: namesToInput(record.support?.names)
    },
    otherRemark: record.otherRemark || '',
    reason: ''
  })
}

async function openEdit(id) {
  const result = await getAttendanceSubmission(id, requestTeamParams.value)
  editingId.value = id
  fillForm(result.attendanceSubmission)
  formVisible.value = true
}

async function openDetail(id) {
  detailVisible.value = true
  detailLoading.value = true
  try {
    const result = await getAttendanceSubmission(id, requestTeamParams.value)
    detail.value = result.attendanceSubmission || {}
  } finally {
    detailLoading.value = false
  }
}

async function submitForm() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const payload = buildAttendancePayload(form)
    if (editingId.value) await updateAttendanceSubmission(editingId.value, payload)
    else await createAttendanceSubmission(payload)
    ElMessage.success(editingId.value ? '出勤日报已更新' : '出勤日报已创建')
    formVisible.value = false
    await loadRecords()
    if (form.reportDate === dailyDate.value) await loadDailySummary()
  } finally {
    submitting.value = false
  }
}

function formatDateTime(value) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'
}

async function handleReview() {
  const complete = dailySummary.value.isComplete === true
  const message = complete
    ? '审核后七个分部当日数据将永久锁定，不能退回、重开或再次修改。确认继续？'
    : '当前日报不完整。系统将阻止审核，并向缺报分部提报人及部门考勤员发送站内提醒。确认继续？'
  await ElMessageBox.confirm(message, complete ? '审核确认' : '缺报提醒', {
    type: complete ? 'warning' : 'error',
    confirmButtonText: complete ? '确认审核' : '发送提醒',
    cancelButtonText: '取消'
  })
  reviewing.value = true
  try {
    const result = await reviewAttendanceDailySummary(dailyDate.value, {
      reason: reviewReason.value.trim() || null
    })
    ElMessage.success(result.idempotent ? '该日报已审核' : '审核完成，数据已永久锁定')
    reviewReason.value = ''
  } finally {
    reviewing.value = false
    await Promise.allSettled([loadDailySummary(), loadRecords()])
  }
}

async function copyFinalText() {
  const text = dailySummary.value.review?.finalText || ''
  if (!text) return
  if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text)
  else {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  ElMessage.success('最终汇报文字已复制')
}

onMounted(async () => {
  if (session.isGlobalReadOnly && !selectedTeamId.value) {
    selectedTeamId.value = session.teams?.[0]?._id || ''
  }
  if (!session.isGlobalReadOnly || selectedTeamId.value) {
    await loadOptions()
    await loadRecords()
  }
})
</script>

<style scoped lang="scss">
.attendance-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.view-switcher {
  display: flex;
  justify-content: flex-start;
}

.quality-alert {
  margin-bottom: 0;
}

.metric-band {
  display: grid;
  grid-template-columns: repeat(6, minmax(110px, 1fr));
  min-height: 94px;
  overflow: hidden;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
}

.metric-item {
  min-width: 0;
  padding: 18px;
  border-right: 1px solid var(--el-border-color-light);

  &:last-child {
    border-right: 0;
  }

  span,
  strong {
    display: block;
  }

  span {
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }

  strong {
    margin-top: 8px;
    color: var(--el-text-color-primary);
    font-size: 25px;
    line-height: 1;
  }
}

.summary-grid,
.shift-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.summary-panel,
.quality-issues,
.review-panel,
.final-text-panel {
  padding: 18px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
}

.review-panel .section-heading > div {
  min-width: 0;
}

.review-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.final-text-panel :deep(textarea) {
  line-height: 1.75;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;

  h2 {
    margin: 0;
    font-size: 16px;
    letter-spacing: 0;
  }

  span {
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }
}

.names-inline {
  color: var(--el-text-color-secondary);
}

.support-panel {
  padding-bottom: 10px;
}

.support-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 80px minmax(180px, 2fr);
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.quality-issue-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 10px;
  padding: 12px 0;
  color: var(--el-color-warning-dark-2);
  border-top: 1px solid var(--el-border-color-lighter);

  &:first-of-type {
    border-top: 0;
  }

  strong,
  span {
    display: block;
  }

  strong {
    font-size: 14px;
  }

  span {
    margin-top: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
}

.four-columns {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.three-columns {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.shift-fieldset {
  min-width: 0;
  margin: 0;
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;

  legend {
    padding: 0 8px;
    color: var(--el-text-color-primary);
    font-size: 16px;
    font-weight: 600;
  }
}

.named-input-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.7fr) minmax(180px, 1.3fr);
  gap: 10px;
}

.detail-content {
  min-height: 240px;
}

.detail-descriptions,
.detail-section {
  margin-top: 18px;
}

@media (max-width: 1000px) {
  .metric-band {
    grid-template-columns: repeat(3, minmax(110px, 1fr));
  }

  .metric-item:nth-child(3) {
    border-right: 0;
  }

  .metric-item:nth-child(-n + 3) {
    border-bottom: 1px solid var(--el-border-color-light);
  }

  .four-columns,
  .three-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .summary-grid,
  .shift-form-grid,
  .four-columns,
  .three-columns,
  .named-input-row {
    grid-template-columns: 1fr;
  }

  .metric-band {
    grid-template-columns: repeat(2, minmax(100px, 1fr));
  }

  .metric-item:nth-child(3) {
    border-right: 1px solid var(--el-border-color-light);
  }

  .metric-item:nth-child(even) {
    border-right: 0;
  }

  .metric-item:nth-child(-n + 4) {
    border-bottom: 1px solid var(--el-border-color-light);
  }

  .support-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>
