<template>
  <div class="task-detail" v-loading="loading">
    <el-page-header @back="goBack" title="返回">
      <template #content>
        <span class="page-title">任务详情</span>
      </template>
    </el-page-header>

    <el-card style="margin-top: 20px" v-if="task">
      <template #header>
        <div class="card-header">
          <span class="task-name">{{ task.taskName }}</span>
        </div>
      </template>

      <!-- 逾期醒目提示横幅 -->
      <el-alert
        v-if="isOverdue"
        title="⚠️ 该任务已逾期！"
        :description="`计划完成时间：${formatDate(task.plannedCompletionTime)}，已超期 ${overdueDays} 天，请尽快处理。`"
        type="error"
        show-icon
        :closable="false"
        style="margin-bottom: 16px; font-size: 14px;"
      />

      <el-descriptions :column="descriptionColumns" border>
        <el-descriptions-item label="任务状态">
          <el-tag :type="taskStatusType[task.status]">
            {{ taskStatusMap[task.status] }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="优先级">
          <el-tag :type="priorityType[task.priority]">
            {{ priorityMap[task.priority] }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="任务类型">{{ task.taskType }}</el-descriptions-item>
        <el-descriptions-item label="任务来源">{{ task.taskSource }}</el-descriptions-item>
        <el-descriptions-item label="计划完成时间">
          <span :class="{ 'overdue-time': isOverdue }">
            {{ formatDate(task.plannedCompletionTime) }}
          </span>
          <el-tag
            v-if="isOverdue"
            type="danger"
            size="small"
            effect="dark"
            style="margin-left: 8px;"
          >已逾期 {{ overdueDays }} 天</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="实际完成时间">
          {{ formatDate(task.actualCompletionTime) || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="创建人">{{ task.creator?.name }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDate(task.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="主负责人">{{ task.mainExecutor?.name }}</el-descriptions-item>
        <el-descriptions-item label="执行人">
          <el-tag v-for="executor in task.executor" :key="executor._id" size="small" style="margin-right: 5px">
            {{ executor.name }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="抄送人" :span="2">
          <el-tag v-for="cc in task.ccUsers" :key="cc._id" size="small" type="info" style="margin-right: 5px">
            {{ cc.name }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="任务描述" :span="2">
          {{ task.description || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="备注" :span="2">
          {{ task.remarks || '-' }}
        </el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 任务附件卡片 -->
    <el-card style="margin-top: 20px" v-if="task && task.attachments && task.attachments.length > 0">
      <template #header>
        <div class="card-header">
          <span>任务附件 ({{ task.attachments.length }})</span>
        </div>
      </template>
      
      <AuthenticatedAttachments :attachments="task.attachments" :team-id="route.query.teamId || ''" />
    </el-card>

    <!-- 子任务列表卡片 -->
    <el-card style="margin-top: 20px" v-if="task && task.subTasks && task.subTasks.length > 0">
      <template #header>
        <div class="card-header">
          <span>子任务列表 ({{ task.subTasks.length }})</span>
        </div>
      </template>
      
      <el-table :data="task.subTasks" style="width: 100%">
        <el-table-column prop="taskName" label="任务名称" min-width="200" />
        <el-table-column label="状态" width="120">
          <template #default="scope">
            <el-tag :type="taskStatusType[scope.row.status]" size="small">
              {{ taskStatusMap[scope.row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="执行人" width="120">
          <template #default="scope">
            <span>{{ scope.row.executor?.map(e => e.name).join('、') || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="计划完成时间" width="160">
          <template #default="scope">
            {{ formatDate(scope.row.plannedCompletionTime, 'MM-DD HH:mm') }}
          </template>
        </el-table-column>
        <el-table-column prop="description" label="任务描述" min-width="200" show-overflow-tooltip />
      </el-table>
    </el-card>

    <!-- 延期记录卡片 -->
    <el-card style="margin-top: 20px" v-if="extensionHistory && extensionHistory.length > 0">
      <template #header>
        <div class="card-header">
          <span>延期记录 ({{ extensionHistory.length }})</span>
        </div>
      </template>
      
      <el-timeline>
        <el-timeline-item
          v-for="ext in extensionHistory"
          :key="ext._id"
          :timestamp="formatDate(ext.createdAt)"
          placement="top"
        >
          <el-card>
            <div class="extension-header">
              <span class="extension-applicant">{{ ext.applicant?.name }}</span>
              <el-tag :type="getExtensionStatusType(ext.status)" size="small">
                {{ getExtensionStatusText(ext.status) }}
              </el-tag>
            </div>
            <el-descriptions :column="descriptionColumns" size="small" style="margin-top: 12px">
              <el-descriptions-item label="原时间">
                {{ formatDate(ext.originalCompletionTime) }}
              </el-descriptions-item>
              <el-descriptions-item label="新时间">
                {{ formatDate(ext.newCompletionTime) }}
              </el-descriptions-item>
              <el-descriptions-item label="延期天数">
                {{ ext.requestedDays }} 天
              </el-descriptions-item>
              <el-descriptions-item label="审批人">
                {{ ext.approver?.name || '待审批' }}
              </el-descriptions-item>
              <el-descriptions-item label="延期理由" :span="2">
                {{ ext.reason }}
              </el-descriptions-item>
              <el-descriptions-item v-if="ext.approver" label="审批时间" :span="2">
                {{ formatDate(ext.approvalTime) }}
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <!-- 执行完成记录卡片 - 支持多执行人 -->
    <el-card style="margin-top: 20px" v-if="task && sortedExecutorCompletions.length > 0">
      <template #header>
        <div class="card-header">
          <span>执行完成记录 ({{ completedExecutorCount }}/{{ sortedExecutorCompletions.length }})</span>
        </div>
      </template>
      
      <el-timeline>
        <el-timeline-item
          v-for="(completion, index) in sortedExecutorCompletions"
          :key="index"
          :timestamp="completion.completedAt ? formatDate(completion.completedAt) : '待提交'"
          placement="top"
          :type="completion.status === 'completed' ? 'success' : 'info'"
        >
          <el-card :class="completion.status === 'pending' ? 'pending-completion' : ''">
            <div class="completion-header">
              <span class="executor-name">{{ completion.executor?.name || '执行人' }}</span>
              <el-tag :type="completion.status === 'completed' ? 'success' : 'warning'" size="small">
                {{ completion.status === 'completed' ? '已完成' : '待提交' }}
              </el-tag>
            </div>
            
            <!-- 已提交的内容 -->
            <div v-if="completion.status === 'completed'">
              <el-descriptions :column="1" size="small" border style="margin-top: 12px">
                <el-descriptions-item label="完成说明">
                  {{ completion.content || '未填写备注' }}
                </el-descriptions-item>
              </el-descriptions>
              
              <!-- 完成附件 -->
              <div v-if="completion.attachments && completion.attachments.length > 0" class="completion-attachments">
                <el-divider content-position="left">完成附件 ({{ completion.attachments.length }})</el-divider>
                <AuthenticatedAttachments
                  :attachments="completion.attachments"
                  :team-id="route.query.teamId || ''"
                />
              </div>
            </div>
            
            <!-- 未提交的提示 -->
            <div v-else class="pending-tip">
              <el-empty description="该执行人尚未提交完成记录" :image-size="60" />
            </div>
          </el-card>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <!-- 审核记录卡片 -->
    <el-card style="margin-top: 20px" v-if="reviewRecords && reviewRecords.length > 0">
      <template #header>
        <div class="card-header">
          <span>审核记录 ({{ reviewRecords.length }})</span>
        </div>
      </template>
      
      <el-timeline>
        <el-timeline-item
          v-for="review in reviewRecords"
          :key="review._id"
          :timestamp="formatDate(review.reviewTime)"
          placement="top"
        >
          <el-card>
            <div class="review-header">
              <span class="reviewer-name">{{ review.reviewer?.name }}</span>
              <el-tag :type="review.result === 'approved' ? 'success' : 'danger'" size="small">
                {{ review.result === 'approved' ? '通过' : '拒绝' }}
              </el-tag>
            </div>
            <div class="review-content">
              <p>{{ review.content }}</p>
            </div>
            <div v-if="review.rating" class="review-rating">
              <span>评分：</span>
              <el-rate v-model="review.rating" disabled />
            </div>
            
            <!-- 审核附件 -->
            <div v-if="review.attachments && review.attachments.length > 0" class="review-attachments">
              <el-divider content-position="left">审核附件</el-divider>
              <AuthenticatedAttachments
                :attachments="review.attachments"
                :team-id="route.query.teamId || ''"
              />
            </div>
          </el-card>
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <!-- 管理员确认状态卡片 -->
    <el-card style="margin-top: 20px" v-if="task && (task.status === 'finished' || task.status === 'pending_confirm')">
      <template #header>
        <div class="card-header">
          <span>管理员审核</span>
        </div>
      </template>
      
      <el-result
        v-if="task.status === 'finished'"
        icon="success"
        title="任务已确认完成"
        :sub-title="`管理员 ${task.confirmedBy?.name || task.creator?.name || ''} 已确认任务完成`"
      />
      
      <el-result
        v-else-if="task.status === 'pending_confirm'"
        icon="info"
        title="等待管理员确认"
        sub-title="任务已完成，等待管理员确认"
      />
    </el-card>

    <!-- 操作按钮区域 -->
    <el-card style="margin-top: 20px" v-if="task && (canComplete || canReview || canConfirm || canApplyExtension || canApproveExtension)">
      <template #header>
        <div class="card-header">
          <span>操作</span>
        </div>
      </template>
      
      <div class="action-buttons">
        <el-button v-if="canComplete" type="primary" @click="handleCompleteClick" :icon="Upload">
          提交完成
        </el-button>
        <el-button v-if="canApplyExtension" type="warning" @click="handleExtensionClick">
          申请延期
        </el-button>
        <el-button v-if="canReview && isCCUser" type="success" @click="handleReviewClick">
          抄送者确认任务
        </el-button>
        <!-- <el-button v-if="canReview && !isCCUser" type="success" @click="handleReviewClick">
          审批人审核任务
        </el-button> -->
        <el-button v-if="canConfirm" type="primary" @click="handleConfirmClick">
          管理者审核任务
        </el-button>
        <el-button v-if="canApproveExtension" type="warning" @click="handleApproveExtensionClick">
          审批延期
        </el-button>
      </div>
    </el-card>

    <!-- 提交完成弹窗 -->
    <el-dialog v-model="completeDialogVisible" title="提交完成" width="min(600px, 94vw)">
      <el-form :model="completeForm" label-position="top">
        <el-form-item label="完成说明" required>
          <el-input
            v-model="completeForm.completionNote"
            type="textarea"
            :rows="4"
            placeholder="请输入完成说明"
          />
        </el-form-item>
        <el-form-item label="完成附件">
          <el-upload
            action="#"
            :auto-upload="false"
            :file-list="completeForm.attachments"
            :on-change="handleCompleteFileChange"
            multiple
          >
            <el-button type="primary">选择文件</el-button>
            <template #tip>
              <div class="el-upload__tip">支持上传图片、文档等文件</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="completeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleCompleteSubmit">提交</el-button>
      </template>
    </el-dialog>

    <!-- 审核评论弹窗 -->
    <el-dialog v-model="reviewDialogVisible" :title="reviewDialogTitle" width="min(600px, 94vw)">
      <el-form :model="reviewForm" label-position="top">
        <el-form-item label="审核意见" required>
          <el-input
            v-model="reviewForm.content"
            type="textarea"
            :rows="4"
            placeholder="请输入审核意见"
          />
        </el-form-item>
        <el-form-item label="评分">
          <el-rate v-model="reviewForm.rating" />
        </el-form-item>
        <el-form-item label="审核附件">
          <el-upload
            action="#"
            :auto-upload="false"
            :file-list="reviewForm.attachments"
            :on-change="handleReviewFileChange"
            multiple
          >
            <el-button type="primary">选择文件</el-button>
            <template #tip>
              <div class="el-upload__tip">支持上传图片、文档等文件</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleReviewSubmit">提交</el-button>
      </template>
    </el-dialog>

    <!-- 管理者审核任务弹窗 -->
    <el-dialog v-model="confirmDialogVisible" title="管理者审核任务" width="min(600px, 94vw)">
      <el-form :model="confirmForm" label-position="top">
        <el-form-item label="审核意见" required>
          <el-input
            v-model="confirmForm.content"
            type="textarea"
            :rows="4"
            placeholder="请输入审核意见（必填）"
          />
        </el-form-item>
        <el-form-item label="任务评分">
          <el-rate v-model="confirmForm.rating" :texts="['很差', '较差', '一般', '较好', '很好']" show-text />
        </el-form-item>
        <el-form-item label="附件">
          <el-upload
            action="#"
            :auto-upload="false"
            :file-list="confirmForm.attachments"
            :on-change="handleConfirmFileChange"
            multiple
          >
            <el-button type="primary">选择文件</el-button>
            <template #tip>
              <div class="el-upload__tip">支持上传图片、文档等文件</div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="confirmSubmitting" @click="handleConfirmSubmit">确认完成</el-button>
      </template>
    </el-dialog>

    <!-- 申请延期弹窗 -->
    <el-dialog v-model="extensionDialogVisible" title="申请延期" width="min(500px, 94vw)">
      <el-form :model="extensionForm" label-position="top">
        <el-form-item label="延期理由" required>
          <el-input
            v-model="extensionForm.reason"
            type="textarea"
            :rows="4"
            placeholder="请输入延期理由"
          />
        </el-form-item>
        <el-form-item label="延期天数" required>
          <el-input-number
            v-model="extensionForm.requestedDays"
            :min="1"
            :max="30"
            placeholder="请输入延期天数"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="extensionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleExtensionSubmit">提交</el-button>
      </template>
    </el-dialog>

    <!-- 审批延期弹窗 -->
    <el-dialog v-model="approveExtensionDialogVisible" title="审批延期申请" width="min(600px, 94vw)">
      <el-form :model="approveExtensionForm" label-position="top">
        <el-form-item label="审批决定" required>
          <el-radio-group v-model="approveExtensionForm.status">
            <el-radio label="approved">批准</el-radio>
            <el-radio label="rejected">拒绝</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="approveExtensionForm.status === 'approved'" label="批准天数" required>
          <el-input-number
            v-model="approveExtensionForm.approvedDays"
            :min="1"
            :max="30"
            placeholder="请输入批准的延期天数"
          />
        </el-form-item>
        <el-form-item label="审批意见" required>
          <el-input
            v-model="approveExtensionForm.approvalNote"
            type="textarea"
            :rows="4"
            placeholder="请输入审批意见"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="approveExtensionDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleApproveExtensionSubmit">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getTaskDetail, getTaskReviews, completeTask, reviewTask, confirmTask } from '@/api/task'
import { applyExtension, approveExtension } from '@/api/extension'
import { deleteFile, uploadTemporaryFile } from '@/api/file'
import { formatDate, taskStatusMap, taskStatusType, priorityMap, priorityType } from '@/utils/format'
import {
  cleanupTemporaryFiles,
  prepareAttachmentReferences
} from '@/utils/attachments'
import AuthenticatedAttachments from '@/components/AuthenticatedAttachments.vue'
import { Upload } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useSessionStore } from '@/stores/session'
import request from '@/utils/request'

const route = useRoute()
const router = useRouter()
const descriptionColumns = ref(2)

const syncResponsiveLayout = () => {
  descriptionColumns.value = window.matchMedia('(max-width: 760px)').matches ? 1 : 2
}
const userStore = useUserStore()
const session = useSessionStore()

const loading = ref(false)
const task = ref(null)
const reviewRecords = ref([])
const extensionHistory = ref([])

// 弹窗状态
const completeDialogVisible = ref(false)
const reviewDialogVisible = ref(false)
const extensionDialogVisible = ref(false)
const approveExtensionDialogVisible = ref(false)
const confirmDialogVisible = ref(false)
const confirmSubmitting = ref(false)

// 表单数据
const completeForm = ref({
  completionNote: '',
  attachments: []
})

const reviewForm = ref({
  content: '',
  rating: 5,
  attachments: []
})

const extensionForm = ref({
  reason: '',
  requestedDays: 1
})

const approveExtensionForm = ref({
  status: 'approved',
  approvedDays: null,
  approvalNote: ''
})

const confirmForm = ref({
  content: '',
  rating: 5,
  attachments: []
})

const fetchData = async () => {
  loading.value = true
  try {
    const result = await getTaskDetail(route.params.id)
    task.value = result.task
    
    // 获取审核记录
    const reviewResult = await getTaskReviews(route.params.id)
    reviewRecords.value = reviewResult.reviews || []
    
    // 获取延期历史
    try {
      const extensionResult = await request({
        url: `/extensions/history/${route.params.id}`,
        method: 'get'
      })
      extensionHistory.value = extensionResult.history || []
    } catch (error) {
      console.error('获取延期历史失败:', error)
      extensionHistory.value = []
    }
  } catch (error) {
    console.error('获取任务详情失败:', error)
  } finally {
    loading.value = false
  }
}

// 获取延期状态文本
const getExtensionStatusText = (status) => {
  const statusMap = {
    'pending': '待审批',
    'approved': '已批准',
    'rejected': '已拒绝'
  }
  return statusMap[status] || status
}

// 获取延期状态类型
const getExtensionStatusType = (status) => {
  const typeMap = {
    'pending': 'warning',
    'approved': 'success',
    'rejected': 'danger'
  }
  return typeMap[status] || 'info'
}

const goBack = () => {
  router.back()
}

// 权限判断
const isTaskOverdue = (plannedCompletionTime, status) => {
  if (status === 'finished' || status === 'pending_confirm') {
    return false
  }
  if (!plannedCompletionTime) return false
  const plannedTime = new Date(plannedCompletionTime)
  const now = new Date()
  return now.getTime() > plannedTime.getTime()
}

const isOverdue = computed(() => {
  if (!task.value) return false
  return isTaskOverdue(task.value.plannedCompletionTime, task.value.status)
})

// 计算逾期天数
const overdueDays = computed(() => {
  if (!task.value || !isOverdue.value) return 0
  const now = new Date()
  const planned = new Date(task.value.plannedCompletionTime)
  return Math.ceil((now.getTime() - planned.getTime()) / (1000 * 60 * 60 * 24))
})

// 处理执行人完成记录：按提交时间排序
const sortedExecutorCompletions = computed(() => {
  if (!task.value || !task.value.executorCompletions || task.value.executorCompletions.length === 0) {
    return []
  }
  
  // 复制数组以避免修改原数据，并过滤掉无效数据
  const completions = task.value.executorCompletions.filter(c => c && c.executor)
  
  if (completions.length === 0) {
    return []
  }
  
  // 排序：已完成的在前（按完成时间倒序），未完成的在后
  return completions.sort((a, b) => {
    // 如果都已完成，按完成时间倒序
    if (a.status === 'completed' && b.status === 'completed') {
      return new Date(b.completedAt) - new Date(a.completedAt)
    }
    // 已完成的排在前面
    if (a.status === 'completed') return -1
    if (b.status === 'completed') return 1
    // 都未完成，保持原顺序
    return 0
  })
})

// 统计已完成的执行人数量
const completedExecutorCount = computed(() => {
  if (!task.value || !task.value.executorCompletions) return 0
  return task.value.executorCompletions.filter(ec => ec.status === 'completed').length
})

const isExecutor = computed(() => {
  if (!task.value || !userStore.userInfo) return false
  return task.value.executor?.some(e => e._id === userStore.userInfo._id)
})

const isCCUser = computed(() => {
  if (!task.value || !userStore.userInfo) return false
  return task.value.ccUsers?.some(u => u._id === userStore.userInfo._id)
})

const isCreator = computed(() => {
  if (!task.value || !userStore.userInfo) return false
  return task.value.creator?._id === userStore.userInfo._id
})

// 判断是否可以完成任务（执行人 && 进行中状态 && 未过期）
const canComplete = computed(() => {
  if (!task.value) return false
  if (!session.isTeamMode || session.isReadOnly) return false
  if (isOverdue.value) return false
  return isExecutor.value && task.value.status === 'in_progress'
})

// 判断是否可以审核（抄送人或管理员，但每人只能审核一次）
const canReview = computed(() => {
  if (!task.value) return false
  if (!session.isTeamMode || session.isReadOnly) return false
  if (task.value.status === 'finished') return false
  
  // 检查当前用户是否已经审核过
  const hasReviewed = reviewRecords.value?.some(
    review => review.reviewer?._id === userStore.userInfo?._id
  )
  
  if (hasReviewed) return false
  
  // 管理员或抄送人可以审核
  return isCCUser.value || session.can('task.review', { write: true, teamRequired: true })
})

// 判断是否可以确认（管理员 && 待确认状态）
const canConfirm = computed(() => {
  if (!task.value) return false
  return session.can('task.review', { write: true, teamRequired: true }) && task.value.status === 'pending_confirm'
})

// 判断是否可以申请延期（执行人 && 进行中状态 && 未申请过）
const canApplyExtension = computed(() => {
  if (!task.value) return false
  if (!session.isTeamMode || session.isReadOnly) return false
  return isExecutor.value && task.value.status === 'in_progress' && !task.value.hasExtensionRequest
})

// 判断是否可以审批延期（管理员 && 延期待审批状态）
const canApproveExtension = computed(() => {
  if (!task.value) return false
  return session.can('task.review', { write: true, teamRequired: true }) && task.value.status === 'extension_pending'
})

// 审核弹窗标题（区分抄送者和管理者）
const reviewDialogTitle = computed(() => {
  if (isCCUser.value) {
    return '抄送者确认任务'
  } else {
    return '管理者审核任务'
  }
})

// 提交完成处理
const handleCompleteClick = () => {
  completeForm.value = {
    completionNote: '',
    attachments: []
  }
  completeDialogVisible.value = true
}

const handleCompleteFileChange = (file, fileList) => {
  completeForm.value.attachments = fileList
}

const submitWithAttachments = async (fileList, submit) => {
  let uploadedFileIds = []
  try {
    const prepared = await prepareAttachmentReferences(fileList || [], uploadTemporaryFile)
    uploadedFileIds = prepared.uploadedFileIds
    return await submit(prepared.references)
  } catch (error) {
    await cleanupTemporaryFiles(error.uploadedFileIds || uploadedFileIds, deleteFile)
    throw error
  }
}

const handleCompleteSubmit = async () => {
  if (!completeForm.value.completionNote) {
    ElMessage.warning('请填写完成说明')
    return
  }
  
  try {
    await submitWithAttachments(completeForm.value.attachments, (attachments) => (
      completeTask(route.params.id, {
        completionNote: completeForm.value.completionNote,
        attachments
      })
    ))
    
    ElMessage.success('提交成功')
    completeDialogVisible.value = false
    fetchData()
  } catch (error) {
    console.error('提交完成失败:', error)
    ElMessage.error('提交失败')
  }
}

// 审核评论处理
const handleReviewClick = () => {
  reviewForm.value = {
    content: '',
    rating: 5,
    attachments: []
  }
  reviewDialogVisible.value = true
}

const handleReviewFileChange = (file, fileList) => {
  reviewForm.value.attachments = fileList
}

const handleReviewSubmit = async () => {
  if (!reviewForm.value.content) {
    ElMessage.warning('请填写审核意见')
    return
  }
  
  try {
    await submitWithAttachments(reviewForm.value.attachments, (attachments) => (
      reviewTask(route.params.id, {
        content: reviewForm.value.content,
        rating: reviewForm.value.rating,
        attachments
      })
    ))
    
    ElMessage.success('审核成功')
    reviewDialogVisible.value = false
    fetchData()
  } catch (error) {
    console.error('审核失败:', error)
    ElMessage.error('审核失败')
  }
}

// 确认任务处理
const handleConfirmClick = () => {
  confirmForm.value = {
    content: '',
    rating: 5,
    attachments: []
  }
  confirmDialogVisible.value = true
}

const handleConfirmFileChange = (file, fileList) => {
  confirmForm.value.attachments = fileList
}

const handleConfirmSubmit = async () => {
  if (!confirmForm.value.content) {
    ElMessage.warning('请填写审核意见')
    return
  }

  confirmSubmitting.value = true
  try {
    await submitWithAttachments(confirmForm.value.attachments, (attachments) => (
      confirmTask(route.params.id, {
        content: confirmForm.value.content,
        rating: confirmForm.value.rating,
        attachments
      })
    ))

    ElMessage.success('审核成功，任务已完结')
    confirmDialogVisible.value = false
    fetchData()
  } catch (error) {
    console.error('确认失败:', error)
    ElMessage.error('确认失败')
  } finally {
    confirmSubmitting.value = false
  }
}

// 申请延期处理
const handleExtensionClick = () => {
  extensionForm.value = {
    reason: '',
    requestedDays: 1
  }
  extensionDialogVisible.value = true
}

const handleExtensionSubmit = async () => {
  if (!extensionForm.value.reason) {
    ElMessage.warning('请填写延期理由')
    return
  }
  if (extensionForm.value.requestedDays < 1) {
    ElMessage.warning('延期天数至少为1天')
    return
  }
  
  try {
    await applyExtension(route.params.id, extensionForm.value)
    ElMessage.success('申请成功')
    extensionDialogVisible.value = false
    fetchData()
  } catch (error) {
    console.error('申请延期失败:', error)
    ElMessage.error('申请失败')
  }
}

// 审批延期处理
const handleApproveExtensionClick = () => {
  // 从延期历史中查找待审批的申请
  const pendingExtension = extensionHistory.value?.find(ext => ext.status === 'pending')
  if (!pendingExtension) {
    ElMessage.warning('未找到待审批的延期申请')
    return
  }
  
  approveExtensionForm.value = {
    status: 'approved',
    approvedDays: pendingExtension.requestedDays,
    approvalNote: '',
    extensionId: pendingExtension._id  // 保存延期申请ID
  }
  approveExtensionDialogVisible.value = true
}

const handleApproveExtensionSubmit = async () => {
  if (!approveExtensionForm.value.approvalNote) {
    ElMessage.warning('请填写审批意见')
    return
  }
  
  if (approveExtensionForm.value.status === 'approved' && !approveExtensionForm.value.approvedDays) {
    ElMessage.warning('请填写批准延期天数')
    return
  }
  
  try {
    if (!approveExtensionForm.value.extensionId) {
      ElMessage.warning('延期申请ID丢失')
      return
    }
    
    await approveExtension(approveExtensionForm.value.extensionId, {
      status: approveExtensionForm.value.status,
      approvedDays: approveExtensionForm.value.approvedDays,
      approvalNote: approveExtensionForm.value.approvalNote
    })
    
    ElMessage.success('审批成功')
    approveExtensionDialogVisible.value = false
    fetchData()
  } catch (error) {
    console.error('审批失败:', error)
    ElMessage.error('审批失败')
  }
}

onMounted(() => {
  syncResponsiveLayout()
  window.addEventListener('resize', syncResponsiveLayout)
  fetchData()
})

onUnmounted(() => {
  window.removeEventListener('resize', syncResponsiveLayout)
})
</script>

<style scoped lang="scss">
.task-detail {
  min-width: 0;

  :deep(.el-page-header) {
    margin-bottom: 20px;
  }

  .page-title {
    font-size: 18px;
    font-weight: 600;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .task-name {
      font-size: 18px;
      font-weight: 600;
    }
  }

  .overdue-time {
    color: #f56c6c;
    font-weight: 600;
  }
  
  // 附件展示样式
  .attachment-list {
    .attachment-section {
      margin-bottom: 24px;
      
      &:last-child {
        margin-bottom: 0;
      }
      
      .attachment-section-title {
        font-size: 14px;
        font-weight: 600;
        color: #606266;
        margin-bottom: 12px;
      }
    }
    
    .image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 12px;
      
      .attachment-img {
        width: 100%;
        height: 120px;
        border-radius: 8px;
        cursor: pointer;

        img {
          width: 100px;
        }
      }
    }
    
    .file-list {
      .file-item {
        display: flex;
        align-items: center;
        padding: 12px;
        background: #f5f7fa;
        border-radius: 8px;
        margin-bottom: 8px;
        
        &:last-child {
          margin-bottom: 0;
        }
        
        .file-icon {
          font-size: 24px;
          color: #409eff;
          margin-right: 12px;
        }
        
        .file-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
          
          .file-size {
            font-size: 12px;
            color: #909399;
          }
        }
      }
    }
  }
  
  // 延期记录样式
  .extension-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    
    .extension-applicant {
      font-size: 16px;
      font-weight: 600;
      color: #303133;
    }
  }
  
  // 完成记录样式
  .completion-record {
    .completion-attachments {
      margin-top: 20px;
    }
  }
  
  .completion-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    
    .executor-name {
      font-size: 16px;
      font-weight: 600;
      color: #303133;
    }
  }
  
  .pending-completion {
    background-color: #f5f7fa;
    opacity: 0.85;
  }
  
  .pending-tip {
    padding: 20px 0;
  }
  
  // 审核记录样式
  .review-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    
    .reviewer-name {
      font-size: 16px;
      font-weight: 600;
      color: #303133;
    }
  }
  
  .review-content {
    margin-bottom: 12px;
    line-height: 1.6;
    color: #606266;
  }
  
  .review-rating {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
    
    span {
      margin-right: 8px;
      color: #606266;
    }
  }
  
  .review-attachments {
    .review-images {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 12px;
      
      .review-img {
        width: 120px;
        height: 120px;
        border-radius: 8px;
        cursor: pointer;
      }
    }
    
    .review-files {
      .review-file-item {
        padding: 8px 0;
        
        .el-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
      }
    }
  }
  
  // 操作按钮区域
  .action-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
}

@media (max-width: 760px) {
  .task-detail {
    :deep(.el-card__body) {
      padding: 16px;
    }

    .action-buttons .el-button {
      flex: 1 1 150px;
    }
  }
}
</style>

