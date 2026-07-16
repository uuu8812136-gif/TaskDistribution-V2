<template>
	<view class="complete-container">
		<!-- 顶部导航栏 -->
		<view class="navbar">
			<view class="nav-left" @click="handleBack">
				<text class="back-icon">←</text>
			</view>
			<view class="nav-title">提交完成</view>
			<view class="nav-right"></view>
		</view>
		
		<view class="content">
			<!-- 任务基本信息 -->
			<view class="task-info-card">
				<view class="task-name">{{ taskName }}</view>
				<view class="task-id">任务编号：{{ taskId }}</view>
			</view>
			
			<!-- 完成说明 -->
			<view class="section">
				<view class="section-title">
					<text class="required">*</text>
					<text>完成说明</text>
				</view>
				<textarea 
					v-model="form.completionNote" 
					class="textarea"
					placeholder="请详细描述任务的完成情况..."
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
			<button class="btn-submit" @click="handleSubmit">提交完成</button>
		</view>
	</view>
</template>

<script>
import { ref, onMounted } from 'vue'
import { completeTask } from '@/api/index.js'
import config from '@/config/index.js'

export default {
	name: 'TaskComplete',
	setup() {
		const taskId = ref('')
		const taskName = ref('')
		
		const form = ref({
			completionNote: ''
		})
		
		const fileList = ref([])
		
		// 获取页面参数
		onMounted(() => {
			const pages = getCurrentPages()
			const currentPage = pages[pages.length - 1]
			taskId.value = currentPage.options.id || ''
			taskName.value = decodeURIComponent(currentPage.options.name || '')
		})
		
	// 格式化文件大小
	const formatFileSize = (bytes) => {
		if (!bytes || bytes === 0) return '0 B'
		const k = 1024
		const sizes = ['B', 'KB', 'MB', 'GB']
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]
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
			if (!form.value.completionNote) {
				uni.showToast({
					title: '请填写完成说明',
					icon: 'none'
				})
				return
			}
			
			// 上传附件
			let attachments = []
			if (fileList.value.length > 0) {
				uni.showLoading({
					title: '上传附件中...',
					mask: true
				})
				
				try {
					for (const file of fileList.value) {
						const token = uni.getStorageSync('token')
						
						const uploadRes = await new Promise((resolve, reject) => {
							uni.uploadFile({
								url: config.baseURL + '/upload',
								filePath: file.path,
								name: 'file',
								header: {
									Authorization: `Bearer ${token}`
								},
								formData: {
									friendlyName: file.name  // 传递友好的文件名
								},
								success: (res) => {
									if (res.statusCode === 200) {
										const data = JSON.parse(res.data)
										resolve({
											path: data.filePath,
											originalName: data.originalName,
											mimetype: data.mimetype,
											size: data.size
										})
									} else {
										reject(new Error('上传失败'))
									}
								},
								fail: reject
							})
						})
						
						attachments.push(uploadRes)
					}
					
					uni.hideLoading()
				} catch (error) {
					uni.hideLoading()
					console.error('上传附件失败:', error)
					uni.showToast({
						title: '附件上传失败',
						icon: 'none'
					})
					return
				}
			}
			
			// 提交完成
			uni.showLoading({
				title: '提交中...',
				mask: true
			})
			
			try {
				await completeTask(taskId.value, {
					completionNote: form.value.completionNote,
					attachments
				})
				
				uni.hideLoading()
				uni.showToast({
					title: '提交成功',
					icon: 'success'
				})
				
				setTimeout(() => {
					uni.navigateBack()
				}, 1500)
			} catch (error) {
				uni.hideLoading()
				console.error('提交失败:', error)
				uni.showToast({
					title: error.message || '提交失败',
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
.complete-container {
	min-height: 100vh;
	background: #F5F7FA;
	display: flex;
	flex-direction: column;
}

.navbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 88rpx;
	background: #4A90E2;
	color: #FFFFFF;
	padding: 0 24rpx;
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
	padding: 24rpx;
	padding-bottom: 120rpx;
}

.task-info-card {
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
	padding: 24rpx;
	background: #FFFFFF;
	box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.05);
	z-index: 999;
	
	button {
		flex: 1;
		height: 88rpx;
		border-radius: 44rpx;
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
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: #FFFFFF;
	}
}
</style>

