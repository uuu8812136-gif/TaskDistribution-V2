<template>
	<view class="review-container">
		<!-- 顶部导航栏 -->
		<view class="navbar">
			<view class="nav-left" @click="handleBack">
				<text class="back-icon">←</text>
			</view>
			<view class="nav-title">审核任务</view>
			<view class="nav-right"></view>
		</view>
		
		<view class="content">
			<!-- 任务基本信息 -->
			<view class="task-info-card">
				<view class="task-name">{{ taskName }}</view>
				<view class="task-id">任务编号：{{ taskId }}</view>
			</view>
			
			<!-- 审核结果 -->
			<view class="section">
				<view class="section-title">
					<text class="required">*</text>
					<text>审核结果</text>
				</view>
				<radio-group @change="onStatusChange">
					<label class="radio-item" :class="{ active: form.reviewStatus === 'approved' }">
						<radio value="approved" :checked="form.reviewStatus === 'approved'" color="#67C23A" />
						<text>通过</text>
					</label>
					<label class="radio-item" :class="{ active: form.reviewStatus === 'rejected' }">
						<radio value="rejected" :checked="form.reviewStatus === 'rejected'" color="#F56C6C" />
						<text>不通过</text>
					</label>
				</radio-group>
			</view>
			
			<!-- 审核评分 -->
			<view class="section">
				<view class="section-title">
					<text>任务评分</text>
					<text class="subtitle">（可选）</text>
				</view>
				<view class="rating-container">
					<view 
						v-for="star in 5" 
						:key="star" 
						class="star"
						@click="setRating(star)"
					>
						<text :class="star <= form.rating ? 'star-filled' : 'star-empty'">★</text>
					</view>
					<text class="rating-text">{{ form.rating }} 分</text>
				</view>
			</view>
			
			<!-- 审核意见 -->
			<view class="section">
				<view class="section-title">
					<text class="required">*</text>
					<text>审核意见</text>
				</view>
				<textarea 
					v-model="form.reviewComment" 
					class="textarea"
					placeholder="请填写审核意见..."
					maxlength="500"
					:show-count="true"
				></textarea>
			</view>
			
		<!-- 附件上传 -->
		<view class="section">
			<view class="section-title">
				<text>上传附件</text>
				<text class="subtitle">（可选，最多5个）</text>
			</view>
			
			<view class="file-list">
				<view 
					v-for="(file, index) in fileList" 
					:key="index" 
					class="file-item"
				>
					<!-- 如果是图片，显示缩略图 -->
					<image 
						v-if="isImage(file)" 
						:src="file.path" 
						class="file-thumbnail"
						mode="aspectFill"
						@click="previewImage(index)"
					></image>
					<text v-else class="file-icon">📎</text>
					<view class="file-info">
						<text class="file-name">{{ file.name }}</text>
						<text class="file-size">{{ formatFileSize(file.size) }}</text>
					</view>
					<text class="remove-icon" @click="removeFile(index)">✕</text>
				</view>
			</view>
			
			<button 
				v-if="fileList.length < 5" 
				class="upload-btn" 
				@click="showUploadMenu"
			>
				<text class="btn-icon">+</text>
				<text>选择文件</text>
			</button>
		</view>
		</view>
		
		<!-- 底部操作按钮 -->
		<view class="footer">
			<button class="btn-cancel" @click="handleBack">取消</button>
			<button class="btn-submit" @click="handleSubmit">提交审核</button>
		</view>
	</view>
</template>

<script>
import { ref, onMounted } from 'vue'
import {
	getTaskDetail,
	getTaskReviews,
	reviewTask,
	uploadTaskScopedAttachment
} from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'
import { requestErrorMessage } from '@/utils/requestErrorMessages.js'
import {
	canReviewAssignedTask,
	hasReviewedTaskRound
} from '@/utils/taskPolicy.js'

export default {
	name: 'TaskReview',
	setup() {
		const userStore = useUserStore()
		const taskId = ref('')
		const taskName = ref('')
		
		const form = ref({
			reviewStatus: 'approved',
			rating: 5,
			reviewComment: ''
		})
		
		const fileList = ref([])
		
		// 获取页面参数
		onMounted(async () => {
			const pages = getCurrentPages()
			const currentPage = pages[pages.length - 1]
			taskId.value = currentPage.options.id || ''
			taskName.value = decodeURIComponent(currentPage.options.name || '')
			await refreshAuthorizedTask()
		})

		const denyEntry = () => {
			uni.showToast({ title: '当前任务不可审核，请刷新后重试', icon: 'none' })
			setTimeout(() => uni.navigateBack(), 300)
		}

		const refreshAuthorizedTask = async () => {
			if (!taskId.value) {
				denyEntry()
				return false
			}
			try {
				const [detailResponse, reviewResponse] = await Promise.all([
					getTaskDetail(taskId.value),
					getTaskReviews(taskId.value)
				])
				const task = detailResponse.task || {}
				const hasReviewed = hasReviewedTaskRound(
					reviewResponse.reviews,
					userStore.userInfo?._id,
					task.reviewRound
				)
				if (!canReviewAssignedTask({ task, hasReviewed })) {
					denyEntry()
					return false
				}
				taskName.value = task.taskName || taskName.value
				return true
			} catch (error) {
				console.error('校验任务审核权限失败:', error)
				denyEntry()
				return false
			}
		}
		
	// 格式化文件大小
	const formatFileSize = (bytes) => {
		if (!bytes || bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
	}
	
	// 审核结果变化
	const onStatusChange = (e) => {
		form.value.reviewStatus = e.detail.value
	}
	
	// 设置评分
	const setRating = (star) => {
		form.value.rating = star
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
					size: tempFile.size,
					type: 'image/jpeg'
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
			count: 5 - fileList.value.length,
			sourceType: ['album'],
			success: (res) => {
				const tempFiles = res.tempFiles.map(file => ({
					path: file.path,
					name: `图片_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`,
					size: file.size,
					type: 'image/jpeg'
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
			count: 5 - fileList.value.length,
			type: 'all',
			success: (res) => {
				const tempFiles = res.tempFiles.map(file => ({
					path: file.path,
					name: file.name,
					size: file.size,
					type: file.type || 'application/octet-stream'
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
		uni.chooseFile({
			count: 5 - fileList.value.length,
			extension: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.xls', '.xlsx'],
			success: (res) => {
				const tempFiles = res.tempFiles
				fileList.value = [...fileList.value, ...tempFiles]
			}
		})
		// #endif
	}
	
	// 判断是否是图片
	const isImage = (file) => {
		if (!file || !file.name) return false
		const ext = file.name.split('.').pop().toLowerCase()
		return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
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
		
		// 返回
		const handleBack = () => {
			uni.navigateBack()
		}
		
		// 提交
		const handleSubmit = async () => {
			if (!form.value.reviewComment) {
				uni.showToast({
					title: '请填写审核意见',
					icon: 'none'
				})
				return
			}

			if (!await refreshAuthorizedTask()) return
			
			// 上传附件
			let attachments = []
			if (fileList.value.length > 0) {
				try {
					for (const file of fileList.value) {
						const uploadRes = await uploadTaskScopedAttachment(file, {
							taskId: taskId.value
						})
						console.log('uploadRes:', uploadRes)
						attachments.push(uploadRes)
					}
					
					console.log('=== 所有附件上传完成 ===')
					console.log('attachments 数组:', attachments)
					console.log('attachments 数组长度:', attachments.length)
					
				} catch (error) {
					console.error('上传附件失败:', error)
					uni.showToast({
						title: '附件上传失败',
						icon: 'none'
					})
					return
				}
			}
			
			// 提交审核
			console.log('=== 准备提交审核 ===')
			console.log('taskId:', taskId.value)
			console.log('form.reviewStatus:', form.value.reviewStatus)
			console.log('form.reviewComment:', form.value.reviewComment)
			console.log('attachments 参数:', attachments)
			console.log('attachments 长度:', attachments.length)
			
			try {
				const submitData = {
					result: form.value.reviewStatus,
					content: form.value.reviewComment,
					rating: form.value.rating,
					attachments
				}
				
				console.log('=== 提交的完整数据 ===')
				console.log('submitData:', JSON.stringify(submitData, null, 2))
				
				await reviewTask(taskId.value, submitData)
				
				uni.showToast({
					title: '提交成功',
					icon: 'success'
				})
				
				setTimeout(() => {
					uni.navigateBack()
				}, 1500)
			} catch (error) {
				console.error('提交失败:', error)
				uni.showToast({
					title: requestErrorMessage(error, '任务审核提交失败'),
					icon: 'none'
				})
			}
		}
		
	return {
		taskId,
		taskName,
		form,
		fileList,
		formatFileSize,
		onStatusChange,
		setRating,
		showUploadMenu,
		takePhoto,
		chooseFromAlbum,
		chooseFile,
		isImage,
		previewImage,
		removeFile,
		handleBack,
		handleSubmit
	}
	}
}
</script>

<style scoped lang="scss">
.review-container {
	min-height: 100vh;
	background: var(--zl-page-bg, #eef3fb);
	display: flex;
	flex-direction: column;
}

.navbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: calc(88rpx + var(--status-bar-height));
	background: var(--zl-primary, #4096ff);
	color: #FFFFFF;
	padding: var(--status-bar-height) 24rpx 0;
	box-sizing: border-box;
	position: sticky;
	top: 0;
	z-index: 999;
	
	.nav-left, .nav-right {
		width: 80rpx;
	}
	
	.back-icon {
		font-size: 40rpx;
		font-weight: bold;
	}
	
	.nav-title {
		flex: 1;
		text-align: center;
		font-size: 36rpx;
		font-weight: bold;
	}
}

.content {
	flex: 1;
	padding: 24rpx 24rpx calc(168rpx + constant(safe-area-inset-bottom));
	padding: 24rpx 24rpx calc(168rpx + env(safe-area-inset-bottom));
}

.task-info-card {
	background: var(--zl-primary, #4096ff);
	border-radius: 16rpx;
	padding: 32rpx;
	margin-bottom: 24rpx;
	color: #FFFFFF;
	
	.task-name {
		font-size: 36rpx;
		font-weight: bold;
		margin-bottom: 16rpx;
	}
	
	.task-id {
		font-size: 28rpx;
		opacity: 0.9;
	}
}

.section {
	background: #FFFFFF;
	border-radius: 16rpx;
	padding: 32rpx;
	margin-bottom: 24rpx;
	
	.section-title {
		display: flex;
		align-items: center;
		font-size: 32rpx;
		font-weight: bold;
		color: #303133;
		margin-bottom: 24rpx;
		
		.required {
			color: #F56C6C;
			margin-right: 8rpx;
		}
		
		.subtitle {
			font-size: 24rpx;
			font-weight: normal;
			color: #909399;
			margin-left: 8rpx;
		}
	}
	
	.textarea {
		width: 100%;
		min-height: 300rpx;
		padding: 24rpx;
		background: #F5F7FA;
		border-radius: 12rpx;
		font-size: 28rpx;
		color: #303133;
		line-height: 1.6;
		box-sizing: border-box;
	}
}

.radio-item {
	display: flex;
	align-items: center;
	padding: 24rpx;
	background: #F5F7FA;
	border-radius: 12rpx;
	margin-bottom: 16rpx;
	transition: all 0.3s;
	
	&.active {
		background: #ECF5FF;
		border: 2rpx solid var(--zl-primary, #4096ff);
	}
	
	text {
		margin-left: 16rpx;
		font-size: 28rpx;
		color: #303133;
	}
}

.rating-container {
	display: flex;
	align-items: center;
	gap: 16rpx;
	
	.star {
		font-size: 48rpx;
		
		.star-filled {
			color: #FFB800;
		}
		
		.star-empty {
			color: #DCDFE6;
		}
	}
	
	.rating-text {
		margin-left: 16rpx;
		font-size: 28rpx;
		color: #606266;
	}
}

.file-list {
	margin-bottom: 24rpx;
}

.file-item {
	display: flex;
	align-items: center;
	padding: 24rpx;
	background: #F5F7FA;
	border-radius: 12rpx;
	margin-bottom: 16rpx;
	
	.file-thumbnail {
		width: 80rpx;
		height: 80rpx;
		border-radius: 8rpx;
		margin-right: 16rpx;
	}
	
	.file-icon {
		font-size: 36rpx;
		margin-right: 16rpx;
	}
	
	.file-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		
		.file-name {
			font-size: 28rpx;
			color: #303133;
			margin-bottom: 8rpx;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		
		.file-size {
			font-size: 24rpx;
			color: #909399;
		}
	}
	
	.remove-icon {
		font-size: 32rpx;
		color: #F56C6C;
		padding: 0 16rpx;
	}
}

.upload-btn {
	width: 100%;
	height: 88rpx;
	background: #F5F7FA;
	border: 2rpx dashed #DCDFE6;
	border-radius: 12rpx;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 28rpx;
	color: #606266;
	
	.btn-icon {
		font-size: 36rpx;
		margin-right: 12rpx;
	}
}

.footer {
	position: fixed;
	bottom: 0;
	left: 0;
	right: 0;
	display: flex;
	gap: 24rpx;
	align-items: center;
	padding: 24rpx 24rpx calc(24rpx + constant(safe-area-inset-bottom));
	padding: 24rpx 24rpx calc(24rpx + env(safe-area-inset-bottom));
	background: rgba(255, 255, 255, 0.97);
	box-shadow: 0 -8rpx 28rpx rgba(15, 23, 42, 0.06);
	z-index: 999;
	
	button {
		flex: 1;
		height: 88rpx;
		line-height: 88rpx;
		margin: 0;
		padding: 0;
		border-radius: var(--zl-control-radius, 20rpx);
		font-size: 32rpx;
		font-weight: bold;
		border: none;
		
		&::after {
			border: none;
		}
	}
	
	.btn-cancel {
		background: #FFFFFF;
		color: #606266;
		border: 2rpx solid #DCDFE6;
	}
	
	.btn-submit {
		background: var(--zl-primary, #4096ff);
		color: #FFFFFF;
	}
}
</style>

