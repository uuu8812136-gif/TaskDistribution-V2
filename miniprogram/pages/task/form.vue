<template>
	<view class="task-form-container">
		<scroll-view class="form-content" scroll-y>
			<!-- 基本信息 -->
			<view class="form-section">
				<view class="section-title">基本信息</view>

				<view v-if="isTeamTaskScope" class="form-item">
					<text class="form-label"><text class="required">*</text> 任务所属组织</text>
					<picker
						mode="selector"
						:range="orgUnitOptions"
						range-key="label"
						:value="orgUnitIndex"
						:disabled="isEdit"
						@change="onOrgUnitChange"
					>
						<view class="picker-input">
							<text>{{ selectedOrgUnitLabel || '请选择任务归属的分部或组织' }}</text>
						</view>
					</picker>
					<text class="form-hint">普通参与人须属于该组织，创建后不能修改归属</text>
				</view>
				
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 任务名称</text>
					<input 
						class="form-input" 
						v-model="form.taskName" 
						placeholder="请输入任务名称"
						:maxlength="100"
					/>
				</view>
				
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 任务类型</text>
					<input 
						class="form-input" 
						v-model="form.taskType" 
						placeholder="如:重汽任务、公司任务、部门任务等"
						:maxlength="50"
					/>
				</view>
				
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 任务来源</text>
					<input 
						class="form-input" 
						v-model="form.taskSource" 
						placeholder="如:会议纪要、现场检查等"
						:maxlength="50"
					/>
				</view>
				
				<view class="form-item">
					<text class="form-label">任务描述</text>
					<textarea 
						class="form-textarea" 
						v-model="form.description" 
						placeholder="请输入任务描述..."
						:maxlength="1000"
					></textarea>
				</view>
				
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 优先级</text>
					<picker mode="selector" :range="priorityOptions" range-key="label" @change="onPriorityChange" :value="priorityIndex">
						<view class="picker-input">
							<text>{{ getPriorityLabel }}</text>
						</view>
					</picker>
				</view>
				
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 计划完成时间</text>
					<picker 
						mode="date" 
						:value="form.plannedDate"
						@change="onDateChange"
					>
						<view class="picker-input">
							<text>{{ form.plannedDate || '请选择日期' }}</text>
						</view>
					</picker>
					<picker 
						mode="time" 
						:value="form.plannedTime"
						@change="onTimeChange"
					>
						<view class="picker-input">
							<text>{{ form.plannedTime || '请选择时间' }}</text>
						</view>
					</picker>
				</view>
				
				<view class="form-item">
					<text class="form-label">备注</text>
					<textarea 
						class="form-textarea" 
						v-model="form.remarks" 
						placeholder="选填，其他补充说明..."
						:maxlength="500"
					></textarea>
				</view>
			</view>
			
			<!-- 人员分配 -->
			<view class="form-section">
				<view class="section-title">人员分配</view>
				
				<!-- 执行人多选 -->
				<view class="form-item">
					<text class="form-label"><text class="required">*</text> 执行人</text>
					<view class="multi-select-box" @click="showExecutorPicker = true">
						<view v-if="selectedExecutors.length > 0" class="selected-tags">
							<view v-for="(user, index) in selectedExecutors" :key="user._id" class="tag">
								<text>{{ user.name }}</text>
								<text class="tag-close" @click.stop="removeExecutor(index)">✕</text>
							</view>
						</view>
						<text v-else class="placeholder">请选择执行人</text>
					</view>
				</view>
				
				<!-- 主执行人单选 -->
				<view class="form-item" v-if="selectedExecutors.length > 0">
					<text class="form-label"><text class="required">*</text> 主执行人</text>
					<picker mode="selector" :range="selectedExecutors" range-key="name" @change="onMainExecutorChange" :value="mainExecutorIndex">
						<view class="picker-input">
							<text>{{ mainExecutorName || '请选择主执行人' }}</text>
						</view>
					</picker>
					<text class="form-hint">从执行人中选择一人作为主负责人</text>
				</view>
				
				<!-- 抄送人多选 -->
				<view class="form-item">
					<text class="form-label">抄送人</text>
					<view class="multi-select-box" @click="showCcUserPicker = true">
						<view v-if="selectedCcUsers.length > 0" class="selected-tags">
							<view v-for="(user, index) in selectedCcUsers" :key="user._id" class="tag">
								<text>{{ user.name }}</text>
								<text class="tag-close" @click.stop="removeCcUser(index)">✕</text>
							</view>
						</view>
						<text v-else class="placeholder">请选择抄送人（可选）</text>
					</view>
				</view>
			</view>
			
			<!-- 执行人选择弹窗 -->
			<view v-if="showExecutorPicker" class="picker-mask" @click="showExecutorPicker = false" catchtouchmove="true">
				<view class="picker-content" @click.stop>
					<view class="picker-header">
						<text class="picker-title">选择执行人</text>
						<text class="picker-close" @click="showExecutorPicker = false">✕</text>
					</view>
					<scroll-view class="picker-list" scroll-y="true">
						<view 
							v-for="user in assignableUsers"
							:key="user._id"
							class="picker-item"
							:class="{ selected: isExecutorSelected(user._id) }"
							@click="toggleExecutor(user)"
						>
							<text>{{ user.department ? user.name + ' · ' + user.department : user.name }}</text>
							<text v-if="isExecutorSelected(user._id)" class="check-icon">✓</text>
						</view>
					</scroll-view>
					<view class="picker-footer">
						<button class="picker-btn confirm" @click="showExecutorPicker = false">确定</button>
					</view>
				</view>
			</view>
			
			<!-- 抄送人选择弹窗 -->
			<view v-if="showCcUserPicker" class="picker-mask" @click="showCcUserPicker = false" catchtouchmove="true">
				<view class="picker-content" @click.stop>
					<view class="picker-header">
						<text class="picker-title">选择抄送人</text>
						<text class="picker-close" @click="showCcUserPicker = false">✕</text>
					</view>
					<scroll-view class="picker-list" scroll-y="true">
						<view 
							v-for="user in assignableUsers"
							:key="user._id"
							class="picker-item"
							:class="{ selected: isCcUserSelected(user._id) }"
							@click="toggleCcUser(user)"
						>
							<text>{{ user.department ? user.name + ' · ' + user.department : user.name }}</text>
							<text v-if="isCcUserSelected(user._id)" class="check-icon">✓</text>
						</view>
					</scroll-view>
					<view class="picker-footer">
						<button class="picker-btn confirm" @click="showCcUserPicker = false">确定</button>
					</view>
				</view>
			</view>
			
		<!-- 附件上传 -->
		<view class="form-section">
			<view class="section-title">附件上传</view>
			
			<view class="upload-area" @click="showUploadMenu">
				<text class="upload-icon">📎</text>
				<text class="upload-text">点击选择文件上传</text>
				<text class="upload-hint">支持拍照、图片、PDF、Word、Excel等</text>
			</view>
			
			<view v-if="fileList.length > 0" class="file-list">
				<view v-for="(file, index) in fileList" :key="index" class="file-item">
					<!-- 如果是图片，显示缩略图 -->
					<image 
						v-if="isImage(file)" 
						:src="file.path" 
						class="file-thumbnail"
						mode="aspectFill"
						@click="previewImage(index)"
					></image>
					<text v-else class="file-icon">📄</text>
					<view class="file-info">
						<text class="file-name">{{ file.name }}</text>
						<text class="file-size">{{ formatFileSize(file.size) }}</text>
					</view>
					<text class="file-remove" @click.stop="removeFile(index)">✕</text>
				</view>
			</view>
		</view>
			
			<!-- 底部占位 -->
			<view class="bottom-placeholder"></view>
		</scroll-view>
		
		<!-- 底部按钮 -->
		<view class="action-bar">
			<button class="action-btn cancel" @click="handleCancel">取消</button>
			<button class="action-btn submit" @click="handleSubmit" :loading="loading">
				{{ loading ? '提交中...' : '提交' }}
			</button>
		</view>
	</view>
</template>

<script>
import { ref, computed, onMounted } from 'vue'
import { createTask, updateTask, getTaskDetail, getUsers, uploadTaskAttachment } from '@/api/index.js'
import { getPriorityText } from '@/utils/format.js'
import { managedFileId } from '@/utils/attachments.js'
import { useUserStore } from '@/stores/user.js'
import {
	buildTaskOrgUnitOptions,
	filterTaskParticipants
} from '@/utils/taskAssignment.js'

export default {
	name: 'TaskForm',
	setup() {
		const userStore = useUserStore()
		const taskId = ref('')
		const isEdit = ref(false)
		const orgUnitId = ref(userStore.context.membership?.orgUnitId || '')
		
		const form = ref({
			taskName: '',
			taskType: '',
			taskSource: '',
			description: '',
			priority: 'normal',
			plannedDate: '',
			plannedTime: '',
			remarks: ''
		})
		
		// 用户数据
		const allUsers = ref([])  // 所有用户列表
		const selectedExecutors = ref([])  // 已选执行人
		const selectedCcUsers = ref([])  // 已选抄送人
		const mainExecutor = ref(null)  // 主执行人
		const showExecutorPicker = ref(false)  // 执行人选择器显示状态
		const showCcUserPicker = ref(false)  // 抄送人选择器显示状态
		const isTeamTaskScope = computed(() => userStore.moduleDataScopes.task === 'TEAM')
		const orgUnitOptions = computed(() => buildTaskOrgUnitOptions(allUsers.value))
		const orgUnitIndex = computed(() => {
			const index = orgUnitOptions.value.findIndex((item) => item.value === orgUnitId.value)
			return index < 0 ? 0 : index
		})
		const selectedOrgUnitLabel = computed(() => (
			orgUnitOptions.value.find((item) => item.value === orgUnitId.value)?.label || ''
		))
		const assignableUsers = computed(() => filterTaskParticipants(
			allUsers.value,
			orgUnitId.value,
			isTeamTaskScope.value
		))
		
		const priorityOptions = [
			{ label: '低', value: 'low' },
			{ label: '普通', value: 'normal' },
			{ label: '高', value: 'high' },
			{ label: '紧急', value: 'urgent' }
		]
		
		const priorityIndex = computed(() => {
			return priorityOptions.findIndex(item => item.value === form.value.priority)
		})
		
		const getPriorityLabel = computed(() => {
			const option = priorityOptions.find(item => item.value === form.value.priority)
			return option ? option.label : '请选择'
		})
		
		// 主执行人相关
		const mainExecutorIndex = computed(() => {
			if (!mainExecutor.value) return 0
			return selectedExecutors.value.findIndex(u => u._id === mainExecutor.value._id)
		})
		
		const mainExecutorName = computed(() => {
			return mainExecutor.value ? mainExecutor.value.name : ''
		})
		
		const fileList = ref([])
		const existingAttachments = ref([])
		const loading = ref(false)
		
		onMounted(() => {
			// 获取页面参数
			const pages = getCurrentPages()
			const currentPage = pages[pages.length - 1]
			taskId.value = currentPage.options.id
			const requiredPermissions = taskId.value
				? ['task.edit', 'task.assign']
				: ['task.create', 'task.assign']
			if (!userStore.can(requiredPermissions, { write: true, teamRequired: true })) {
				uni.showToast({ title: '无权限执行该操作', icon: 'none' })
				setTimeout(() => uni.navigateBack(), 300)
				return
			}
			
			// 加载用户列表
			loadUsers()
			
			if (taskId.value) {
				isEdit.value = true
				uni.setNavigationBarTitle({
					title: '编辑任务'
				})
				loadTaskDetail()
			}
		})
		
		// 加载用户列表
		const loadUsers = async () => {
			try {
				// 传入 limit: 1000 以获取所有用户（避免分页限制）
				const res = await getUsers({ limit: 1000 })
				allUsers.value = res.users || []
				if (!isEdit.value && isTeamTaskScope.value && orgUnitOptions.value.length === 1) {
					orgUnitId.value = orgUnitOptions.value[0].value
				}
			} catch (error) {
				console.error('加载用户列表失败:', error)
				uni.showToast({
					title: '加载用户列表失败',
					icon: 'none'
				})
			}
		}
		
		// 加载任务详情（编辑时）
		const loadTaskDetail = async () => {
			try {
				const res = await getTaskDetail(taskId.value)
				const task = res.task
				orgUnitId.value = typeof task.orgUnitId === 'string'
					? task.orgUnitId
					: task.orgUnitId?._id || ''
				
				// 填充表单
				form.value.taskName = task.taskName
				form.value.taskType = task.taskType
				form.value.taskSource = task.taskSource
				form.value.description = task.description || ''
				form.value.priority = task.priority
				form.value.remarks = task.remarks || ''
				existingAttachments.value = (task.attachments || [])
					.map((attachment) => managedFileId(attachment))
					.filter(Boolean)
					.map((fileId) => ({ fileId }))
				
				// 处理时间
				if (task.plannedCompletionTime) {
					const date = new Date(task.plannedCompletionTime)
					form.value.plannedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
					form.value.plannedTime = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
				}
				
				// 处理人员 - 等待用户列表加载完成后设置
				setTimeout(() => {
					if (task.executor && task.executor.length > 0) {
						selectedExecutors.value = task.executor
					}
					if (task.mainExecutor) {
						mainExecutor.value = task.mainExecutor
					}
					if (task.ccUsers && task.ccUsers.length > 0) {
						selectedCcUsers.value = task.ccUsers
					}
				}, 500)
				
			} catch (error) {
				console.error('加载任务详情失败:', error)
			}
		}
		
		// 执行人相关操作
		const isExecutorSelected = (userId) => {
			return selectedExecutors.value.some(u => u._id === userId)
		}
		
		const toggleExecutor = (user) => {
			const index = selectedExecutors.value.findIndex(u => u._id === user._id)
			if (index > -1) {
				// 取消选择
				selectedExecutors.value.splice(index, 1)
				// 如果取消的是主执行人，清空主执行人
				if (mainExecutor.value && mainExecutor.value._id === user._id) {
					mainExecutor.value = null
				}
			} else {
				// 添加选择
				selectedExecutors.value.push(user)
			}
		}
		
		const removeExecutor = (index) => {
			const removed = selectedExecutors.value[index]
			selectedExecutors.value.splice(index, 1)
			// 如果删除的是主执行人，清空主执行人
			if (mainExecutor.value && mainExecutor.value._id === removed._id) {
				mainExecutor.value = null
			}
		}
		
		// 主执行人选择
		const onMainExecutorChange = (e) => {
			const index = e.detail.value
			mainExecutor.value = selectedExecutors.value[index]
		}
		
		// 抄送人相关操作
		const isCcUserSelected = (userId) => {
			return selectedCcUsers.value.some(u => u._id === userId)
		}
		
		const toggleCcUser = (user) => {
			const index = selectedCcUsers.value.findIndex(u => u._id === user._id)
			if (index > -1) {
				selectedCcUsers.value.splice(index, 1)
			} else {
				selectedCcUsers.value.push(user)
			}
		}
		
		const removeCcUser = (index) => {
			selectedCcUsers.value.splice(index, 1)
		}

		const onOrgUnitChange = (event) => {
			const selected = orgUnitOptions.value[Number(event.detail.value)]
			orgUnitId.value = selected?.value || ''
			selectedExecutors.value = []
			selectedCcUsers.value = []
			mainExecutor.value = null
		}
		
		// 优先级选择
		const onPriorityChange = (e) => {
			const index = e.detail.value
			form.value.priority = priorityOptions[index].value
		}
		
		// 日期选择
		const onDateChange = (e) => {
			form.value.plannedDate = e.detail.value
		}
		
		// 时间选择
		const onTimeChange = (e) => {
			form.value.plannedTime = e.detail.value
		}
		
	// 显示上传菜单
	const showUploadMenu = () => {
		uni.showActionSheet({
			itemList: ['拍照', '从相册选择', '选择文件'],
			success: (res) => {
				if (res.tapIndex === 0) {
					// 拍照
					takePhoto()
				} else if (res.tapIndex === 1) {
					// 从相册选择
					chooseFromAlbum()
				} else if (res.tapIndex === 2) {
					// 选择文件
					chooseFile()
				}
			}
		})
	}
	
	// 拍照
	const takePhoto = () => {
		uni.chooseImage({
			count: 1,
			sourceType: ['camera'],
			success: (res) => {
				const tempFile = res.tempFiles[0]
				fileList.value.push({
					path: tempFile.path,
					name: `照片_${Date.now()}.jpg`,
					size: tempFile.size
				})
			},
			fail: (err) => {
				console.error('拍照失败:', err)
				uni.showToast({
					title: '拍照失败',
					icon: 'none'
				})
			}
		})
	}
	
	// 从相册选择
	const chooseFromAlbum = () => {
		uni.chooseImage({
			count: 9,
			sourceType: ['album'],
			success: (res) => {
				const tempFiles = res.tempFiles.map(file => ({
					path: file.path,
					name: `图片_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`,
					size: file.size
				}))
				fileList.value = [...fileList.value, ...tempFiles]
			},
			fail: (err) => {
				console.error('选择图片失败:', err)
				uni.showToast({
					title: '选择图片失败',
					icon: 'none'
				})
			}
		})
	}
	
	// 选择文件
	const chooseFile = () => {
		// #ifdef MP-WEIXIN
		uni.chooseMessageFile({
			count: 10,
			type: 'all',
			success: (res) => {
				const tempFiles = res.tempFiles.map(file => ({
					path: file.path,
					name: file.name,
					size: file.size
				}))
				fileList.value = [...fileList.value, ...tempFiles]
			},
			fail: (err) => {
				console.error('选择文件失败:', err)
				uni.showToast({
					title: '选择文件失败',
					icon: 'none'
				})
			}
		})
		// #endif
		
		// #ifndef MP-WEIXIN
		uni.showToast({
			title: '该平台暂不支持文件选择',
			icon: 'none'
		})
		// #endif
	}
	
	// 判断是否是图片
	const isImage = (file) => {
		if (!file || !file.name) return false
		const ext = file.name.split('.').pop().toLowerCase()
		return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
	}
	
	// 格式化文件大小
	const formatFileSize = (bytes) => {
		if (!bytes || bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
	}
	
	// 预览图片
	const previewImage = (index) => {
		const images = fileList.value.filter(file => isImage(file))
		const urls = images.map(img => img.path)
		const currentIndex = images.findIndex(img => img === fileList.value[index])
		
		uni.previewImage({
			urls: urls,
			current: currentIndex >= 0 ? currentIndex : 0
		})
	}
		
		// 移除文件
		const removeFile = (index) => {
			fileList.value.splice(index, 1)
		}
		
		// 取消
		const handleCancel = () => {
			uni.navigateBack()
		}
		
		// 提交
		const handleSubmit = async () => {
			// 表单验证
			if (!form.value.taskName) {
				uni.showToast({ title: '请输入任务名称', icon: 'none' })
				return
			}

			if (isTeamTaskScope.value && !orgUnitId.value) {
				uni.showToast({ title: '请选择任务所属组织', icon: 'none' })
				return
			}
			
			if (!form.value.taskType) {
				uni.showToast({ title: '请输入任务类型', icon: 'none' })
				return
			}
			
			if (!form.value.taskSource) {
				uni.showToast({ title: '请输入任务来源', icon: 'none' })
				return
			}
			
			if (!form.value.plannedDate || !form.value.plannedTime) {
				uni.showToast({ title: '请选择计划完成时间', icon: 'none' })
				return
			}
			
			if (selectedExecutors.value.length === 0) {
				uni.showToast({ title: '请选择执行人', icon: 'none' })
				return
			}
			
			if (!mainExecutor.value) {
				uni.showToast({ title: '请选择主执行人', icon: 'none' })
				return
			}
			
			loading.value = true
			
			try {
				// 构建请求数据
				const data = {
					orgUnitId: orgUnitId.value,
					taskName: form.value.taskName,
					taskType: form.value.taskType,
					taskSource: form.value.taskSource,
					description: form.value.description,
					priority: form.value.priority,
					plannedCompletionTime: `${form.value.plannedDate} ${form.value.plannedTime}:00`,
					remarks: form.value.remarks,
					executor: selectedExecutors.value.map(u => u._id),
					mainExecutor: mainExecutor.value._id,
					ccUsers: selectedCcUsers.value.map(u => u._id)
				}
				
				// Existing managed references are retained while newly selected files are added.
				{
					const attachments = [...existingAttachments.value]
					for (const file of fileList.value) {
						const uploadRes = await uploadTaskAttachment(file)
						attachments.push(uploadRes)
					}
					data.attachments = attachments
				}
				
				// 提交
				if (isEdit.value) {
					await updateTask(taskId.value, data)
				} else {
					await createTask(data)
				}
				
				uni.showToast({
					title: isEdit.value ? '更新成功' : '创建成功',
					icon: 'success'
				})
				
				setTimeout(() => {
					uni.navigateBack()
				}, 1500)
				
			} catch (error) {
				console.error('提交失败:', error)
			} finally {
				loading.value = false
			}
		}
		
	return {
		form,
		priorityOptions,
		priorityIndex,
		getPriorityLabel,
		fileList,
		loading,
		allUsers,
		assignableUsers,
		isTeamTaskScope,
		orgUnitOptions,
		orgUnitIndex,
		selectedOrgUnitLabel,
		selectedExecutors,
		selectedCcUsers,
		mainExecutor,
		mainExecutorIndex,
		mainExecutorName,
		showExecutorPicker,
		showCcUserPicker,
		isExecutorSelected,
		toggleExecutor,
		removeExecutor,
		onMainExecutorChange,
		onOrgUnitChange,
		isCcUserSelected,
		toggleCcUser,
		removeCcUser,
		onPriorityChange,
		onDateChange,
		onTimeChange,
		showUploadMenu,
		takePhoto,
		chooseFromAlbum,
		chooseFile,
		isImage,
		formatFileSize,
		previewImage,
		removeFile,
		handleCancel,
		handleSubmit
	}
	}
}
</script>

<style scoped lang="scss">
.task-form-container {
	min-height: 100vh;
	background: var(--zl-page-bg, #eef3fb);
	display: flex;
	flex-direction: column;
	padding: 24rpx 24rpx calc(144rpx + constant(safe-area-inset-bottom));
	padding: 24rpx 24rpx calc(144rpx + env(safe-area-inset-bottom));
}

.form-content {
	flex: 1;
	
}

.form-section {
	background: #ffffff;
	border-radius: 16rpx;
	padding: 32rpx;
	margin-bottom: 24rpx;
	
	.section-title {
		font-size: 32rpx;
		font-weight: bold;
		color: #303133;
		margin-bottom: 32rpx;
	}
	
	.form-item {
		margin-bottom: 32rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		.form-label {
			display: block;
			font-size: 28rpx;
			color: #606266;
			margin-bottom: 16rpx;
			
			.required {
				color: #F56C6C;
				margin-right: 4rpx;
			}
		}
		
		.form-input {
			height: 72rpx;
			padding: 0 24rpx;
			background: #F5F7FA;
			border-radius: 12rpx;
			font-size: 28rpx;
			color: #303133;
		}
		
		.form-textarea {
			min-height: 200rpx;
			padding: 16rpx 24rpx;
			background: #F5F7FA;
			border-radius: 12rpx;
			font-size: 28rpx;
			color: #303133;
		}
		
		.picker-input {
			height: 72rpx;
			line-height: 72rpx;
			padding: 0 24rpx;
			background: #F5F7FA;
			border-radius: 12rpx;
			font-size: 28rpx;
			color: #303133;
			margin-bottom: 16rpx;
			
			&:last-child {
				margin-bottom: 0;
			}
		}
		
		.form-hint {
			display: block;
			font-size: 22rpx;
			color: #909399;
			margin-top: 8rpx;
		}
	}
}

.upload-area {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	height: 240rpx;
	background: #F5F7FA;
	border: 2rpx dashed #DCDFE6;
	border-radius: 12rpx;
	margin-bottom: 24rpx;
	
	.upload-icon {
		font-size: 64rpx;
		margin-bottom: 16rpx;
	}
	
	.upload-text {
		font-size: 28rpx;
		color: #606266;
		margin-bottom: 8rpx;
	}
	
	.upload-hint {
		font-size: 22rpx;
		color: #909399;
	}
}

.file-list {
	.file-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 20rpx;
		background: #F5F7FA;
		border-radius: 12rpx;
		margin-bottom: 16rpx;
		
		&:last-child {
			margin-bottom: 0;
		}
		
		.file-thumbnail {
			width: 80rpx;
			height: 80rpx;
			border-radius: 8rpx;
			margin-right: 16rpx;
		}
		
		.file-icon {
			font-size: 48rpx;
			margin-right: 16rpx;
		}
		
		.file-info {
			flex: 1;
			display: flex;
			flex-direction: column;
			
			.file-name {
				font-size: 26rpx;
				color: #606266;
				margin-bottom: 6rpx;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			
			.file-size {
				font-size: 22rpx;
				color: #909399;
			}
		}
		
		.file-remove {
			font-size: 32rpx;
			color: #F56C6C;
			padding: 0 16rpx;
		}
	}
}

// 多选框样式
.multi-select-box {
	min-height: 80rpx;
	padding: 16rpx;
	background: #F5F7FA;
	border-radius: 8rpx;
	
	.selected-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 12rpx;
		
		.tag {
			display: inline-flex;
			align-items: center;
			padding: 8rpx 16rpx;
			background: var(--zl-primary, #4096ff);
			color: #ffffff;
			border-radius: 32rpx;
			font-size: 24rpx;
			
			.tag-close {
				margin-left: 8rpx;
				font-size: 28rpx;
				font-weight: bold;
			}
		}
	}
	
	.placeholder {
		font-size: 28rpx;
		color: #C0C4CC;
	}
}

// 选择器弹窗样式
.picker-mask {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	align-items: flex-end;
	z-index: 9999;
	
	.picker-content {
		width: 100%;
		height: 70vh;
		background: #ffffff;
		border-radius: 32rpx 32rpx 0 0;
		display: flex;
		flex-direction: column;
		
		.picker-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 32rpx;
			border-bottom: 1px solid #EBEEF5;
			flex-shrink: 0;
			
			.picker-title {
				font-size: 32rpx;
				font-weight: bold;
				color: #303133;
			}
			
			.picker-close {
				font-size: 48rpx;
				color: #909399;
				line-height: 1;
			}
		}
		
		.picker-list {
			flex: 1;
			height: 0;
			
			.picker-item {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 24rpx 32rpx;
				font-size: 28rpx;
				color: #303133;
				border-bottom: 1px solid #F5F7FA;
				
				&.selected {
					background: #ECF5FF;
					color: var(--zl-primary, #4096ff);
				}
				
				.check-icon {
					font-size: 36rpx;
					font-weight: bold;
					color: var(--zl-primary, #4096ff);
				}
			}
		}
		
		.picker-footer {
			padding: 24rpx 32rpx calc(24rpx + constant(safe-area-inset-bottom));
			padding: 24rpx 32rpx calc(24rpx + env(safe-area-inset-bottom));
			border-top: 1px solid #EBEEF5;
			flex-shrink: 0;
			
			.picker-btn {
				width: 100%;
				height: 72rpx;
				line-height: 72rpx;
				border-radius: 12rpx;
				border: none;
				font-size: 28rpx;
				
				&::after {
					border: none;
				}
				
				&.confirm {
					background: var(--zl-primary, #4096ff);
					color: #ffffff;
				}
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
		margin: 0;
		padding: 0;
		font-size: 28rpx;
		border-radius: var(--zl-control-radius, 20rpx);
		border: none;
		
		&::after {
			border: none;
		}
		
		&.cancel {
			background: #F5F7FA;
			color: #606266;
			margin-right: 16rpx;
		}
		
		&.submit {
			background: var(--zl-primary, #4096ff);
			color: #ffffff;
		}
	}
}
</style>

