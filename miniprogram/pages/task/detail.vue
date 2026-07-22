<template>
	<view class="task-detail-container">
		<scroll-view class="detail-content" scroll-y>
			<!-- 任务基本信息 -->
			<view class="section">
				<view class="section-title">
					<text class="title-icon">📋</text>
					<text>基本信息</text>
				</view>
				
				<view class="info-card">
					<view class="card-header">
						<text class="task-name">{{ taskDetail.taskName }}</text>
						<view class="task-priority" :style="{ backgroundColor: getPriorityColor(taskDetail.priority) }">
							<text>{{ getPriorityText(taskDetail.priority) }}</text>
						</view>
					</view>
					
					<view class="info-item">
						<text class="label">任务类型</text>
						<text class="value">{{ taskDetail.taskType }}</text>
					</view>
					
					<view class="info-item">
						<text class="label">任务来源</text>
						<text class="value">{{ taskDetail.taskSource }}</text>
					</view>
					
				<view class="info-item">
					<text class="label">任务状态</text>
					<view class="task-status" :style="{ backgroundColor: getStatusColor(taskDetail.status) }">
						<text>{{ getStatusText(taskDetail.status) }}</text>
					</view>
				</view>
				
				<!-- 过期提示 -->
				<view v-if="isOverdue" class="info-item overdue-warning">
					<text class="label">⚠️ 任务状态</text>
					<text class="value overdue-text">已过期（超过计划完成时间）</text>
				</view>
				
				<view class="info-item">
					<text class="label">任务描述</text>
					<text class="value desc">{{ taskDetail.description || '无' }}</text>
				</view>
				
				<view class="info-item">
					<text class="label">计划完成时间</text>
					<text class="value" :class="{ 'overdue-time': isOverdue }">
						{{ formatDate(taskDetail.plannedCompletionTime, 'YYYY-MM-DD HH:mm') }}
					</text>
				</view>
					
					<view v-if="taskDetail.actualCompletionTime" class="info-item">
						<text class="label">实际完成时间</text>
						<text class="value">{{ formatDate(taskDetail.actualCompletionTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					
					<view class="info-item">
						<text class="label">创建人</text>
						<text class="value">{{ taskDetail.creator?.name || '未知' }}</text>
					</view>
					
					<view class="info-item">
						<text class="label">创建时间</text>
						<text class="value">{{ formatDate(taskDetail.createdAt, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
				</view>
				
				<!-- 任务附件 -->
				<view v-if="taskDetail.attachments && taskDetail.attachments.length > 0" class="attachments-section">
					<view class="attachments-title">
						<text class="title-icon">📎</text>
						<text>任务附件 ({{ taskDetail.attachments.length }})</text>
					</view>
					<view class="attachments-list">
						<view 
							v-for="(file, index) in taskDetail.attachments" 
							:key="index" 
							class="attachment-item"
							@click.stop="previewAttachment(file)"
						>
							<text class="file-icon">{{ getFileIcon(file) }}</text>
							<view class="file-info">
								<text class="file-name">{{ file.originalName }}</text>
								<text class="file-size">{{ formatFileSize(file.size) }}</text>
							</view>
							<text class="view-icon">👁</text>
						</view>
					</view>
				</view>
			</view>
			
			<!-- 执行人信息 -->
			<view class="section">
				<view class="section-title">
					<text class="title-icon">👥</text>
					<text>人员信息</text>
				</view>
				
				<view class="info-card">
					<view class="info-item">
						<text class="label">执行人</text>
						<text class="value">
							{{ taskDetail.executor?.map(e => e.name).join('、') || '未分配' }}
						</text>
					</view>
					
					<view class="info-item">
						<text class="label">主执行人</text>
						<text class="value">{{ taskDetail.mainExecutor?.name || '未指定' }}</text>
					</view>
					
					<view class="info-item">
						<text class="label">抄送人</text>
						<text class="value">
							{{ taskDetail.ccUsers?.map(u => u.name).join('、') || '无' }}
						</text>
					</view>
				</view>
			</view>
			
			<!-- 子任务列表 -->
			<view v-if="taskDetail.subTasks && taskDetail.subTasks.length > 0" class="section">
				<view class="section-title">
					<text class="title-icon">📝</text>
					<text>子任务 ({{ taskDetail.subTasks.length }})</text>
				</view>
				
				<view class="subtask-list">
					<view v-for="(subtask, index) in taskDetail.subTasks" :key="index" class="subtask-item">
						<view class="subtask-header">
							<text class="subtask-name">{{ subtask.taskName }}</text>
							<view class="subtask-status" :style="{ backgroundColor: getStatusColor(subtask.status) }">
								<text>{{ getStatusText(subtask.status) }}</text>
							</view>
						</view>
						<text v-if="subtask.description" class="subtask-desc">{{ subtask.description }}</text>
						<view class="subtask-footer">
							<text class="subtask-executor">执行人: {{ subtask.executor?.name || '未分配' }}</text>
							<text class="subtask-time">{{ formatDate(subtask.plannedCompletionTime, 'MM-DD HH:mm') }}</text>
						</view>
					</view>
				</view>
			</view>
			
			
			<!-- 延期申请记录 -->
			<!-- 当前延期申请状态 -->
			<view v-if="taskDetail.status === 'extension_pending' && extensionHistory.length > 0" class="section">
				<view class="section-title">
					<text class="title-icon">⏰</text>
					<text>延期申请状态</text>
				</view>
				
				<view class="extension-status-card pending">
					<view class="status-header">
						<text class="status-label">待审批</text>
						<text class="status-time">{{ formatDate(extensionHistory[0].applyTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					<view class="status-info">
						<text class="label">申请理由:</text>
						<text class="value">{{ extensionHistory[0].reason }}</text>
					</view>
					<view class="status-info">
						<text class="label">请求延期:</text>
						<text class="value highlight">{{ extensionHistory[0].requestedDays }} 天</text>
					</view>
					<view class="status-info">
						<text class="label">原完成时间:</text>
						<text class="value">{{ formatDate(extensionHistory[0].originalCompletionTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					<view class="status-footer">
						<text>等待管理员审批...</text>
					</view>
				</view>
			</view>
			
			<!-- 延期申请结果（已批准） -->
			<view v-if="extensionHistory.length > 0 && extensionHistory[0].status === 'approved'" class="section">
				<view class="section-title">
					<text class="title-icon">✓</text>
					<text>延期申请结果</text>
				</view>
				
				<view class="extension-status-card approved">
					<view class="status-header">
						<text class="status-label">已批准</text>
						<text class="status-time">{{ formatDate(extensionHistory[0].approvalTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					<view class="status-info">
						<text class="label">审批人:</text>
						<text class="value">{{ extensionHistory[0].approver?.name || '管理员' }}</text>
					</view>
					<view class="status-info">
						<text class="label">批准延期:</text>
						<text class="value highlight">{{ extensionHistory[0].approvedDays }} 天</text>
					</view>
					<view class="status-info">
						<text class="label">新完成时间:</text>
						<text class="value highlight">{{ formatDate(extensionHistory[0].newCompletionTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					<view v-if="extensionHistory[0].approvalNote" class="status-info">
						<text class="label">审批意见:</text>
						<text class="value">{{ extensionHistory[0].approvalNote }}</text>
					</view>
				</view>
			</view>
			
			<!-- 延期申请结果（已拒绝） -->
			<view v-if="extensionHistory.length > 0 && extensionHistory[0].status === 'rejected'" class="section">
				<view class="section-title">
					<text class="title-icon">✕</text>
					<text>延期申请结果</text>
				</view>
				
				<view class="extension-status-card rejected">
					<view class="status-header">
						<text class="status-label">已拒绝</text>
						<text class="status-time">{{ formatDate(extensionHistory[0].approvalTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
					<view class="status-info">
						<text class="label">审批人:</text>
						<text class="value">{{ extensionHistory[0].approver?.name || '管理员' }}</text>
					</view>
					<view v-if="extensionHistory[0].approvalNote" class="status-info alert">
						<text class="label">拒绝理由:</text>
						<text class="value">{{ extensionHistory[0].approvalNote }}</text>
					</view>
					<view class="status-footer">
						<text>延期申请未通过，请按原计划完成时间执行任务</text>
					</view>
				</view>
			</view>
			
			<!-- 延期历史记录 -->
			<view v-if="extensionHistory.length > 1" class="section">
				<view class="section-title">
					<text class="title-icon">📜</text>
					<text>延期历史 ({{ extensionHistory.length }})</text>
				</view>
				
				<view class="extension-list">
					<view v-for="ext in extensionHistory" :key="ext._id" class="extension-item">
						<view class="ext-header">
							<text class="ext-applicant">{{ ext.applicant?.name }}</text>
							<view class="ext-status" :style="{ backgroundColor: getExtStatusColor(ext.status) }">
								<text>{{ getExtStatusText(ext.status) }}</text>
							</view>
						</view>
						<view class="ext-info">
							<text class="label">申请时间:</text>
							<text class="value">{{ formatDate(ext.applyTime, 'YYYY-MM-DD HH:mm') }}</text>
						</view>
						<view class="ext-info">
							<text class="label">请求延期:</text>
							<text class="value">{{ ext.requestedDays }} 天</text>
						</view>
						<view class="ext-info">
							<text class="label">原完成时间:</text>
							<text class="value">{{ formatDate(ext.originalCompletionTime, 'YYYY-MM-DD HH:mm') }}</text>
						</view>
						<view v-if="ext.status !== 'pending'" class="ext-info">
							<text class="label">审批结果:</text>
							<text class="value" :style="{ color: ext.status === 'approved' ? '#67C23A' : '#F56C6C' }">
								{{ ext.status === 'approved' ? '已批准' : '已拒绝' }}
							</text>
						</view>
						<view v-if="ext.approvalNote" class="ext-info">
							<text class="label">审批意见:</text>
							<text class="value">{{ ext.approvalNote }}</text>
						</view>
					</view>
				</view>
			</view>
			
		<!-- 执行完成记录 - 支持多执行人 -->
		<view v-if="sortedExecutorCompletions.length > 0" class="section">
			<view class="section-title">
				<text class="title-icon">✓</text>
				<text>执行完成记录 ({{ completedExecutorCount }}/{{ sortedExecutorCompletions.length }})</text>
			</view>
			
			<!-- 每个执行人的完成记录 -->
			<view 
				v-for="(completion, index) in sortedExecutorCompletions" 
				:key="index" 
				class="completion-card"
				:class="{ 'pending-completion': completion.status === 'pending' }"
			>
				<view class="completion-header">
					<text class="completer-name">
						{{ completion.executor?.name || '执行人' }}
						<text v-if="completion.status === 'pending'" class="pending-badge">待提交</text>
						<text v-else class="completed-badge">已完成</text>
					</text>
					<text v-if="completion.status === 'completed' && completion.completedAt" class="completion-time">
						{{ formatDate(completion.completedAt, 'YYYY-MM-DD HH:mm') }}
					</text>
				</view>
				
				<!-- 已提交的内容 -->
				<view v-if="completion.status === 'completed'">
					<text v-if="completion.content" class="completion-note">{{ completion.content }}</text>
					<text v-else class="completion-note empty">未填写备注</text>
					
					<!-- 完成附件 -->
					<view v-if="completion.attachments && completion.attachments.length > 0" class="completion-attachments">
						<text class="attachments-title">📎 完成附件 ({{ completion.attachments.length }}):</text>
						<view class="attachments-list">
							<view 
								v-for="(file, fileIndex) in completion.attachments" 
								:key="fileIndex" 
								class="attachment-item"
								@click.stop="previewAttachment(file)"
							>
								<text class="file-icon">{{ getFileIcon(file) }}</text>
								<view class="file-info">
									<text class="file-name">{{ file.originalName }}</text>
									<text class="file-size">{{ formatFileSize(file.size) }}</text>
								</view>
								<text class="view-icon">👁</text>
							</view>
						</view>
					</view>
				</view>
				
				<!-- 未提交的提示 -->
				<view v-else class="pending-tip">
					<text>该执行人尚未提交完成记录</text>
				</view>
			</view>
		</view>
			
			<!-- 审核记录 -->
			<view v-if="reviewRecords.length > 0" class="section">
				<view class="section-title">
					<text class="title-icon">✓</text>
					<text>审核记录 ({{ reviewRecords.length }})</text>
				</view>
				
				<view class="review-list">
					<view v-for="review in reviewRecords" :key="review._id" class="review-item">
						<view class="review-header">
							<text class="reviewer-name">
								{{ review.reviewer?.name }} · {{ review.stage === 'confirmation' ? '最终确认' : '抄送审核' }}
							</text>
							<view class="review-result" :style="{ color: review.result === 'approved' ? '#67C23A' : '#F56C6C' }">
								<text>{{ review.result === 'approved' ? '✓ 通过' : '✕ 拒绝' }}</text>
							</view>
						</view>
						<text v-if="review.content" class="review-comment">{{ review.content }}</text>
						
						<!-- 审核附件 -->
						<view v-if="review.attachments && review.attachments.length > 0" class="review-attachments">
							<text class="attachments-title">📎 审核附件:</text>
							<view class="attachments-list">
								<view
									v-for="(file, idx) in review.attachments"
									:key="file.fileId || idx"
									class="attachment-item"
									@click.stop="previewAttachment(file)"
								>
									<text class="file-icon">{{ getFileIcon(file) }}</text>
									<text class="file-name">{{ file.originalName || file.filename || '附件' }}</text>
								</view>
							</view>
						</view>
						
						<text class="review-time">{{ formatDate(review.reviewTime, 'YYYY-MM-DD HH:mm') }}</text>
					</view>
				</view>
			</view>

			<!-- 管理员最终确认 -->
			<view v-if="taskDetail.status === 'finished' || taskDetail.status === 'pending_confirm'" class="section">
				<view class="section-title">
					<text class="title-icon">👑</text>
					<text>最终确认</text>
				</view>
				
				<view class="info-card">
					<view v-if="taskDetail.status === 'finished'" class="admin-review-item">
						<view class="review-header">
							<text class="reviewer-name">{{ taskDetail.confirmedBy?.name || taskDetail.creator?.name || '管理员' }}</text>
							<view class="review-result" style="color: #67C23A;">
								<text>✓ 已确认通过</text>
							</view>
						</view>
						<text class="review-comment">任务已完成，管理员确认通过</text>
					</view>
					
					<view v-else-if="taskDetail.status === 'pending_confirm'" class="admin-review-item pending">
						<view class="review-header">
							<text class="reviewer-name">{{ taskDetail.creator?.name || '管理员' }}</text>
							<view class="review-result" style="color: #E6A23C;">
								<text>⏱ 待确认</text>
							</view>
						</view>
						<text class="review-comment">等待任务创建人或管理员最终确认</text>
					</view>
				</view>
			</view>
			
			<!-- 底部占位 -->
			<view class="bottom-placeholder"></view>
		</scroll-view>
		
		<!-- 底部操作栏 -->
		<view class="action-bar">
			<!-- 执行人：提交完成 -->
			<button 
				v-if="canComplete" 
				class="action-btn primary"
				@click="handleComplete"
			>
				提交完成
			</button>
			
			<!-- 执行人：申请延期 -->
			<button 
				v-if="canApplyExtension"
				class="action-btn warning"
				@click="handleExtension"
			>
				申请延期
			</button>
			
			<!-- 管理员：审批延期 -->
			<button 
				v-if="canApproveExtension"
				class="action-btn success"
				@click="handleShowApproveDialog"
			>
				审批延期
			</button>
			
			<!-- 抄送人：审核任务 -->
			<button 
				v-if="canReview" 
				class="action-btn success"
				@click="handleReview"
			>
				抄送审核
			</button>
			
			<!-- 管理员：最终确认 -->
			<button 
				v-if="canConfirm" 
				class="action-btn success"
				@click="handleConfirm"
			>
				最终确认
			</button>
			
			<!-- 管理员：编辑任务 -->
			<button 
				v-if="canEdit"
				class="action-btn"
				@click="handleEdit"
			>
				编辑任务
			</button>
			
			<!-- 管理员：删除任务 -->
			<button 
				v-if="canEdit"
				class="action-btn danger"
				@click="handleDelete"
			>
				删除任务
			</button>
		</view>
		
		<!-- 延期申请弹窗 -->
		<extension-dialog 
			v-if="showExtensionDialog"
			:current-time="taskDetail.plannedCompletionTime"
			@close="showExtensionDialog = false"
			@confirm="onExtensionConfirm"
		></extension-dialog>
	</view>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { 
	getTaskDetail, 
	getTaskReviews, 
	getExtensionHistory,
	downloadTaskAttachment,
	completeTask,
	reviewTask,
	confirmTask,
	deleteTask,
	applyExtension,
	approveExtension
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import { 
	formatDate, 
	formatFileSize,
	getTaskStatusText, 
	getTaskStatusColor, 
	getPriorityText, 
	getPriorityColor,
	getExtensionStatusText,
	getExtensionStatusColor,
	isTaskOverdue
} from '@/utils/format.js'
import {
	attachmentMimeType,
	attachmentName,
	canOpenDocument,
	isImageAttachment,
	managedFileId
} from '@/utils/attachments.js'
import {
	canApproveTaskExtension,
	canCompleteAssignedTask,
	canConfirmTask,
	canRequestTaskExtension,
	canReviewAssignedTask,
	hasReviewedTaskRound,
	taskEntityId,
	taskReadParams
} from '@/utils/taskPolicy.js'
import ExtensionDialog from './components/ExtensionDialog.vue'

export default {
	name: 'TaskDetail',
	components: {
		ExtensionDialog
	},
	setup() {
		const userStore = useUserStore()
		
		const taskId = ref('')
		const detailTeamId = ref('')
		const taskDetail = ref({})
		const reviewRecords = ref([])
		const extensionHistory = ref([])
		
		const showExtensionDialog = ref(false)
		
		onMounted(() => {
			// 获取页面参数
			const pages = getCurrentPages()
			const currentPage = pages[pages.length - 1]
			taskId.value = currentPage.options.id
			detailTeamId.value = currentPage.options.teamId || ''
			
			if (taskId.value) {
				loadTaskDetail()
				loadReviewRecords()
				loadExtensionHistory()
			}
		})
		
		// 页面显示时刷新数据（从complete/review页面返回时）
		onShow(() => {
			if (taskId.value) {
				loadTaskDetail()
				loadReviewRecords()
				loadExtensionHistory()
			}
		})
		
		// 加载任务详情
		const readParams = () => userStore.isGlobalReadOnly
			? taskReadParams(detailTeamId.value)
			: {}

		const loadTaskDetail = async () => {
			try {
				const res = await getTaskDetail(taskId.value, readParams())
				taskDetail.value = res.task || {}
			} catch (error) {
				console.error('加载任务详情失败:', error)
			}
		}
		
		// 加载审核记录
		const loadReviewRecords = async () => {
			try {
				const res = await getTaskReviews(taskId.value, readParams())
				reviewRecords.value = res.reviews || []
			} catch (error) {
				console.error('加载审核记录失败:', error)
			}
		}
		
		// 加载延期历史
		const loadExtensionHistory = async () => {
			try {
				const res = await getExtensionHistory(taskId.value, readParams())
				extensionHistory.value = res.history || []
			} catch (error) {
				console.error('加载延期历史失败:', error)
			}
		}
		
		// 判断任务是否过期
		const isOverdue = computed(() => {
			if (!taskDetail.value._id) return false
			return isTaskOverdue(taskDetail.value.plannedCompletionTime, taskDetail.value.status)
		})
		
		// 处理执行人完成记录：按提交时间排序
		const sortedExecutorCompletions = computed(() => {
			if (!taskDetail.value.executorCompletions || taskDetail.value.executorCompletions.length === 0) {
				return []
			}
			
			// 复制数组以避免修改原数据，并过滤掉无效数据
			const completions = taskDetail.value.executorCompletions.filter(c => c && c.executor)
			
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
			if (!taskDetail.value.executorCompletions) return 0
			return taskDetail.value.executorCompletions.filter(ec => ec.status === 'completed').length
		})
		
		// 操作权限只依赖任务状态和当前用户身份，不依赖页面入口。
		const canComplete = computed(() => {
			return canCompleteAssignedTask({
				task: taskDetail.value,
				userId: userStore.userInfo?._id,
				isTeamMode: userStore.isTeamMode,
				isReadOnly: userStore.isReadOnly,
				isOverdue: isOverdue.value
			})
		})
		
		// 判断是否可以审核（抄送人 && 待审核状态）
		const canReview = computed(() => {
			const hasReviewed = hasReviewedTaskRound(
				reviewRecords.value,
				userStore.userInfo?._id,
				taskDetail.value.reviewRound
			)
			return canReviewAssignedTask({
				task: taskDetail.value,
				userId: userStore.userInfo?._id,
				isTeamMode: userStore.isTeamMode,
				isReadOnly: userStore.isReadOnly,
				hasReviewPermission: userStore.can('task.review', { write: true, teamRequired: true }),
				hasReviewed
			})
		})
		
		// 最终确认由任务创建人、项目管理员或超级管理员执行。
		const canConfirm = computed(() => {
			return canConfirmTask({
				task: taskDetail.value,
				userId: userStore.userInfo?._id,
				isTeamMode: userStore.isTeamMode,
				isReadOnly: userStore.isReadOnly,
				isSuperAdmin: userStore.isSuperAdmin,
				membershipRole: userStore.context?.membership?.role
			})
		})
		
		// 判断是否可以申请延期（负责人 && 进行中状态 && 未申请过）
		// 注意：即使任务过期，也可以申请延期
		const canApplyExtension = computed(() => {
			return canRequestTaskExtension({
				task: taskDetail.value,
				userId: userStore.userInfo?._id,
				isTeamMode: userStore.isTeamMode,
				isReadOnly: userStore.isReadOnly
			})
		})
		
		// 判断是否可以审批延期（管理员 && 延期待审批状态）
		const canApproveExtension = computed(() => {
			return canApproveTaskExtension({
				task: taskDetail.value,
				userId: userStore.userInfo?._id,
				isTeamMode: userStore.isTeamMode,
				isReadOnly: userStore.isReadOnly,
				hasReviewPermission: userStore.can('task.review', { write: true, teamRequired: true }),
				isSuperAdmin: userStore.isSuperAdmin,
				membershipRole: userStore.context?.membership?.role
			})
		})

		const canEdit = computed(() => userStore.can('task.edit', {
			write: true,
			teamRequired: true
		}))
		
		// 提交完成
		const handleComplete = () => {
			uni.navigateTo({
				url: `/pages/task/complete?id=${taskId.value}&name=${encodeURIComponent(taskDetail.value.taskName)}`
			})
		}
		
		// 审核任务
		const handleReview = () => {
			uni.navigateTo({
				url: `/pages/task/review?id=${taskId.value}&name=${encodeURIComponent(taskDetail.value.taskName)}`
			})
		}
		
		// 确认任务
		const handleConfirm = () => {
			uni.showModal({
				title: '最终确认任务',
				content: '确认该任务已完成？',
				success: async (res) => {
					if (res.confirm) {
						try {
							await confirmTask(taskId.value, { content: '已确认任务完成' })
							uni.showToast({
								title: '确认成功',
								icon: 'success'
							})
							await Promise.all([loadTaskDetail(), loadReviewRecords()])
						} catch (error) {
							console.error('确认失败:', error)
						}
					}
				}
			})
		}
		
		// 编辑任务
		const handleEdit = () => {
			uni.navigateTo({
				url: `/pages/task/form?id=${taskId.value}`
			})
		}
		
		// 删除任务
		const handleDelete = () => {
			uni.showModal({
				title: '删除任务',
				content: '确认删除该任务？删除后无法恢复',
				confirmColor: '#F56C6C',
				success: async (res) => {
					if (res.confirm) {
						try {
							await deleteTask(taskId.value)
							uni.showToast({
								title: '删除成功',
								icon: 'success'
							})
							setTimeout(() => {
								uni.navigateBack()
							}, 1500)
						} catch (error) {
							console.error('删除失败:', error)
						}
					}
				}
			})
		}
		
		// 申请延期
		const handleExtension = () => {
			showExtensionDialog.value = true
		}
		
		const onExtensionConfirm = async (data) => {
			try {
				await applyExtension(taskId.value, data)
				uni.showToast({
					title: '申请成功',
					icon: 'success'
				})
				showExtensionDialog.value = false
				loadTaskDetail()
				loadExtensionHistory()
			} catch (error) {
				console.error('申请延期失败:', error)
			}
		}
		
		// 显示审批弹窗 -> 跳转到审批页面
		const handleShowApproveDialog = () => {
			// 获取最新的延期申请
			if (!extensionHistory.value || extensionHistory.value.length === 0) {
				uni.showToast({
					title: '未找到延期申请',
					icon: 'none'
				})
				return
			}
			
			const latestExtension = extensionHistory.value[0]
			
			if (latestExtension.status !== 'pending') {
				uni.showToast({
					title: '该申请已处理',
					icon: 'none'
				})
				return
			}
			
			// 跳转到审批页面，传递延期申请数据
			uni.navigateTo({
				url: `/pages/task/approve-extension?taskId=${taskId.value}&data=${encodeURIComponent(JSON.stringify(latestExtension))}`
			})
		}
		
		// 获取文件图标
		const getFileIcon = (file) => {
			const mimetype = attachmentMimeType(file)
			if (!mimetype) return '📄'
			if (mimetype.startsWith('image/')) return '🖼'
			if (mimetype.startsWith('video/')) return '🎬'
			if (mimetype.includes('pdf')) return '📕'
			if (mimetype.includes('word') || mimetype.includes('document')) return '📘'
			if (mimetype.includes('excel') || mimetype.includes('spreadsheet')) return '📗'
			if (mimetype.includes('powerpoint') || mimetype.includes('presentation')) return '📙'
			if (mimetype.includes('zip') || mimetype.includes('rar') || mimetype.includes('7z')) return '📦'
			return '📄'
		}
		
		// 格式化文件大小
		const formatFileSize = (bytes) => {
			if (!bytes || bytes === 0) return '0 B'
			const k = 1024
			const sizes = ['B', 'KB', 'MB', 'GB']
			const i = Math.floor(Math.log(bytes) / Math.log(k))
			return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
		}
		
		// 所有远程附件先通过带 Authorization 的 downloadFile 获取临时文件。
		const previewAttachment = async (file) => {
			if (!managedFileId(file)) {
				uni.showToast({ title: '历史附件待迁移', icon: 'none' })
				return
			}
			try {
				const result = await downloadTaskAttachment(file, readParams())
				if (isImageAttachment(file)) {
					uni.previewImage({ urls: [result.tempFilePath], current: 0 })
					return
				}
				if (canOpenDocument(file)) {
					uni.openDocument({
						filePath: result.tempFilePath,
						showMenu: true,
						fail: () => uni.showToast({ title: '文件预览失败', icon: 'none' })
					})
					return
				}
				uni.showModal({
					title: '文件已下载',
					content: `${attachmentName(file)} 暂不支持在线预览`,
					showCancel: false
				})
			} catch (error) {
				console.error('附件下载失败:', error)
			}
		}

		const downloadFile = previewAttachment
		
		// 格式化方法
		const getStatusText = (status) => getTaskStatusText(status)
		const getStatusColor = (status) => getTaskStatusColor(status)
		const getExtStatusText = (status) => getExtensionStatusText(status)
		const getExtStatusColor = (status) => getExtensionStatusColor(status)
		
	return {
		userStore,
		taskDetail,
		reviewRecords,
		extensionHistory,
		showExtensionDialog,
		isOverdue,
		sortedExecutorCompletions,
		completedExecutorCount,
		canComplete,
		canReview,
		canConfirm,
		canApplyExtension,
		canApproveExtension,
		canEdit,
		handleComplete,
		handleReview,
		handleConfirm,
		handleEdit,
		handleDelete,
		handleExtension,
		onExtensionConfirm,
		handleShowApproveDialog,
		getFileIcon,
		previewAttachment,
		downloadFile,
		formatDate,
		formatFileSize,
		getStatusText,
		getStatusColor,
		getPriorityText,
		getPriorityColor,
		getExtStatusText,
		getExtStatusColor
	}
	}
}
</script>

<style scoped lang="scss">
.task-detail-container {
	min-height: 100vh;
	background: var(--zl-page-bg, #eef3fb);
	display: flex;
	flex-direction: column;
	padding: 24rpx 24rpx calc(144rpx + constant(safe-area-inset-bottom));
	padding: 24rpx 24rpx calc(144rpx + env(safe-area-inset-bottom));
}

.detail-content {
	flex: 1;
}

.section {
	margin-bottom: 24rpx;
	
	.section-title {
		display: flex;
		align-items: center;
		margin-bottom: 16rpx;
		font-size: 32rpx;
		font-weight: bold;
		color: #303133;
		
		.title-icon {
			margin-right: 12rpx;
			font-size: 36rpx;
		}
	}
}

.info-card {
	background: #ffffff;
	border-radius: 16rpx;
	padding: 32rpx;
	
	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 32rpx;
		padding-bottom: 24rpx;
		border-bottom: 1px solid #EBEEF5;
		
		.task-name {
			flex: 1;
			font-size: 36rpx;
			font-weight: bold;
			color: #303133;
			margin-right: 16rpx;
		}
		
		.task-priority {
			padding: 8rpx 20rpx;
			border-radius: 24rpx;
			font-size: 24rpx;
			color: #ffffff;
		}
	}
	
	.info-item {
		display: flex;
		margin-bottom: 24rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		&.overdue-warning {
			background: #FEF0F0;
			padding: 16rpx;
			border-radius: 8rpx;
			border-left: 4rpx solid #F56C6C;
		}
		
		.label {
			min-width: 200rpx;
			font-size: 28rpx;
			color: #909399;
		}
		
		.value {
			flex: 1;
			font-size: 28rpx;
			color: #303133;
			
			&.desc {
				line-height: 1.6;
			}
			
			&.overdue-text {
				color: #F56C6C;
				font-weight: bold;
			}
			
			&.overdue-time {
				color: #F56C6C;
			}
		}
		
		.task-status {
			padding: 6rpx 16rpx;
			border-radius: 24rpx;
			font-size: 22rpx;
			color: #ffffff;
		}
	}
}

.subtask-list, .extension-list, .review-list, .attachment-list {
	.subtask-item, .extension-item, .review-item, .attachment-item {
		background: #ffffff;
		border-radius: 16rpx;
		padding: 24rpx;
		margin-bottom: 16rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
	}
}

.subtask-item {
	.subtask-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16rpx;
		
		.subtask-name {
			flex: 1;
			font-size: 28rpx;
			font-weight: bold;
			color: #303133;
			margin-right: 16rpx;
		}
		
		.subtask-status {
			padding: 4rpx 12rpx;
			border-radius: 20rpx;
			font-size: 20rpx;
			color: #ffffff;
		}
	}
	
	.subtask-desc {
		font-size: 24rpx;
		color: #606266;
		line-height: 1.6;
		margin-bottom: 16rpx;
	}
	
	.subtask-footer {
		display: flex;
		justify-content: space-between;
		font-size: 22rpx;
		color: #909399;
	}
}

.attachment-item {
	display: flex;
	align-items: center;
	
	.file-icon {
		font-size: 48rpx;
		margin-right: 16rpx;
	}
	
	.file-info {
		flex: 1;
		
		.file-name {
			display: block;
			font-size: 28rpx;
			color: #303133;
			margin-bottom: 8rpx;
		}
		
		.file-size {
			display: block;
			font-size: 22rpx;
			color: #909399;
		}
	}
	
	.file-arrow {
		font-size: 28rpx;
		color: #C0C4CC;
	}
}

.extension-item, .review-item {
	.ext-header, .review-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16rpx;
		
		.ext-applicant, .reviewer-name {
			font-size: 28rpx;
			font-weight: bold;
			color: #303133;
		}
		
		.ext-status {
			padding: 4rpx 12rpx;
			border-radius: 20rpx;
			font-size: 20rpx;
			color: #ffffff;
		}
		
		.review-result {
			font-size: 26rpx;
			font-weight: bold;
		}
	}
	
	.ext-info {
		display: flex;
		font-size: 24rpx;
		margin-bottom: 8rpx;
		
		.label {
			color: #909399;
			margin-right: 8rpx;
		}
		
		.value {
			flex: 1;
			color: #606266;
		}
	}
	
	.ext-footer, .review-time {
		font-size: 22rpx;
		color: #909399;
		margin-top: 8rpx;
	}
	
	.review-comment {
		display: block;
		font-size: 26rpx;
		color: #606266;
		line-height: 1.6;
		margin-bottom: 8rpx;
	}
	
	.review-attachments {
		margin-top: 16rpx;
		margin-bottom: 16rpx;
		
		.attachments-title {
			display: block;
			font-size: 24rpx;
			color: #909399;
			margin-bottom: 12rpx;
		}
		
		.review-images {
			display: flex;
			flex-wrap: wrap;
			gap: 12rpx;
			margin-bottom: 12rpx;
			
			.review-img {
				width: 160rpx;
				height: 160rpx;
				border-radius: 8rpx;
			}
		}
		
		.review-files {
			.review-file-item {
				display: flex;
				align-items: center;
				padding: 12rpx 16rpx;
				background: #F5F7FA;
				border-radius: 8rpx;
				margin-bottom: 8rpx;
				
				&:last-child {
					margin-bottom: 0;
				}
				
				.file-icon {
					font-size: 32rpx;
					margin-right: 12rpx;
				}
				
				.file-name {
					flex: 1;
					font-size: 24rpx;
					color: #303133;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
			}
		}
	}
}

.admin-review-item {
	padding: 24rpx 0;
	
	&.pending {
		opacity: 0.7;
	}
	
	.review-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16rpx;
		
		.reviewer-name {
			font-size: 28rpx;
			font-weight: bold;
			color: #303133;
		}
		
		.review-result {
			font-size: 26rpx;
			font-weight: bold;
		}
	}
	
	.review-comment {
		display: block;
		font-size: 26rpx;
		color: #606266;
		line-height: 1.6;
		margin-bottom: 16rpx;
	}
	
	.review-time {
		display: block;
		font-size: 24rpx;
		color: #909399;
	}
}

// 延期申请状态卡片
.extension-status-card {
	background: #ffffff;
	border-radius: 12rpx;
	padding: 24rpx;
	border-left: 4rpx solid var(--zl-primary, #4096ff);
	
	&.pending {
		border-left-color: #E6A23C;
		background: #FDF6EC;
	}
	
	&.approved {
		border-left-color: #67C23A;
		background: #F0F9FF;
	}
	
	&.rejected {
		border-left-color: #F56C6C;
		background: #FEF0F0;
	}
	
	.status-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20rpx;
		padding-bottom: 16rpx;
		border-bottom: 1px solid rgba(0, 0, 0, 0.05);
		
		.status-label {
			font-size: 30rpx;
			font-weight: bold;
		}
		
		.status-time {
			font-size: 24rpx;
			color: #909399;
		}
	}
	
	.pending & .status-label {
		color: #E6A23C;
	}
	
	.approved & .status-label {
		color: #67C23A;
	}
	
	.rejected & .status-label {
		color: #F56C6C;
	}
	
	.status-info {
		display: flex;
		margin-bottom: 12rpx;
		font-size: 26rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		&.alert {
			padding: 12rpx;
			background: rgba(245, 108, 108, 0.1);
			border-radius: 8rpx;
			flex-direction: column;
			
			.label {
				margin-bottom: 8rpx;
			}
		}
		
		.label {
			min-width: 180rpx;
			color: #909399;
		}
		
		.value {
			flex: 1;
			color: #606266;
			line-height: 1.6;
			
			&.highlight {
				color: var(--zl-primary, #4096ff);
				font-weight: bold;
			}
		}
	}
	
	.status-footer {
		margin-top: 16rpx;
		padding-top: 16rpx;
		border-top: 1px solid rgba(0, 0, 0, 0.05);
		font-size: 24rpx;
		color: #909399;
		text-align: center;
	}
}

// 延期历史列表
.extension-list {
	.extension-item {
		background: #ffffff;
		border-radius: 12rpx;
		padding: 24rpx;
		margin-bottom: 16rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		.ext-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 16rpx;
			padding-bottom: 12rpx;
			border-bottom: 1px solid #F5F7FA;
			
			.ext-applicant {
				font-size: 28rpx;
				font-weight: bold;
				color: #303133;
			}
			
			.ext-status {
				padding: 4rpx 12rpx;
				border-radius: 12rpx;
				font-size: 22rpx;
				color: #ffffff;
			}
		}
		
		.ext-info {
			display: flex;
			margin-bottom: 8rpx;
			font-size: 26rpx;
			
			&:last-child {
				margin-bottom: 0;
			}
			
			.label {
				min-width: 180rpx;
				color: #909399;
			}
			
			.value {
				flex: 1;
				color: #606266;
				line-height: 1.6;
			}
		}
	}
}

.bottom-placeholder {
	height: 40rpx;
}

.action-bar {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	display: flex;
	align-items: center;
	padding: 16rpx 24rpx calc(16rpx + constant(safe-area-inset-bottom));
	padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
	background: rgba(255, 255, 255, 0.97);
	border-top: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18));
	box-shadow: 0 -8rpx 28rpx rgba(15, 23, 42, 0.06);
	z-index: 100;
	
	.action-btn {
		flex: 1;
		height: var(--zl-control-height, 80rpx);
		line-height: var(--zl-control-height, 80rpx);
		font-size: 28rpx;
		border-radius: var(--zl-control-radius, 20rpx);
		border: 1px solid #DCDFE6;
		background: #ffffff;
		color: #606266;
		margin: 0 8rpx;
		
		&:first-child {
			margin-left: 0;
		}
		
		&:last-child {
			margin-right: 0;
		}
		
		&::after {
			border: none;
		}
		
		&.primary {
			background: var(--zl-primary, #4096ff);
			color: #ffffff;
			border-color: var(--zl-primary, #4096ff);
		}
		
		&.success {
			background: #67C23A;
			color: #ffffff;
			border-color: #67C23A;
		}
		
		&.warning {
			background: #E6A23C;
			color: #ffffff;
			border-color: #E6A23C;
		}
		
		&.danger {
			background: #F56C6C;
			color: #ffffff;
			border-color: #F56C6C;
		}
	}
}

// 任务附件、完成记录样式
.attachments-section, .completion-card {
	background: #F5F7FA;
	border-radius: 12rpx;
	padding: 20rpx;
	margin-top: 16rpx;
	
	.attachments-title {
		display: flex;
		align-items: center;
		font-size: 24rpx;
		color: #606266;
		margin-bottom: 12rpx;
		
		.title-icon {
			margin-right: 8rpx;
		}
	}
}

.attachments-list {
	.attachment-item {
		display: flex;
		align-items: center;
		background: #ffffff;
		border-radius: 8rpx;
		padding: 16rpx;
		margin-bottom: 12rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		.file-icon {
			font-size: 36rpx;
			margin-right: 12rpx;
		}
		
		.file-info {
			flex: 1;
			display: flex;
			flex-direction: column;
			
			.file-name {
				font-size: 26rpx;
				color: #303133;
				margin-bottom: 4rpx;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			
			.file-size {
				font-size: 22rpx;
				color: #909399;
			}
		}
		
		.view-icon {
			font-size: 32rpx;
			color: var(--zl-primary, #4096ff);
			margin-left: 12rpx;
		}
	}
}

.completion-card {
	background: #ffffff;
	border-radius: 12rpx;
	padding: 24rpx;
	margin-bottom: 16rpx;
	
	&:last-child {
		margin-bottom: 0;
	}
	
	&.pending-completion {
		background: #F5F7FA;
		opacity: 0.8;
	}
	
	.completion-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 12rpx;
		
		.completer-name {
			font-size: 28rpx;
			font-weight: bold;
			color: #303133;
			display: flex;
			align-items: center;
			gap: 12rpx;
			
			.completed-badge {
				display: inline-block;
				padding: 4rpx 12rpx;
				background: #67C23A;
				color: #ffffff;
				font-size: 20rpx;
				font-weight: normal;
				border-radius: 12rpx;
			}
			
			.pending-badge {
				display: inline-block;
				padding: 4rpx 12rpx;
				background: #E6A23C;
				color: #ffffff;
				font-size: 20rpx;
				font-weight: normal;
				border-radius: 12rpx;
			}
		}
		
		.completion-time {
			font-size: 22rpx;
			color: #909399;
		}
	}
	
	.completion-note {
		display: block;
		font-size: 26rpx;
		color: #606266;
		line-height: 1.6;
		margin-bottom: 12rpx;
		
		&.empty {
			color: #C0C4CC;
			font-style: italic;
		}
	}
	
	.pending-tip {
		padding: 16rpx 0;
		text-align: center;
		
		text {
			font-size: 24rpx;
			color: #909399;
		}
	}
	
	.completion-attachments {
		margin-top: 16rpx;
		
		.attachments-title {
			display: block;
			font-size: 24rpx;
			color: #606266;
			margin-bottom: 12rpx;
		}
	}
}
</style>

