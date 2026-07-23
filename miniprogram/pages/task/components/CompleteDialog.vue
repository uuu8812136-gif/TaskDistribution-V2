<template>
	<view class="dialog-mask" @click="close">
		<view class="dialog-content" @click.stop>
			<view class="dialog-header">
				<text class="dialog-title">提交完成</text>
				<text class="close-btn" @click="close">✕</text>
			</view>
			
			<view class="dialog-body">
				<view class="form-item">
					<text class="form-label">完成说明</text>
					<textarea 
						class="form-textarea" 
						v-model="form.completionNote"
						placeholder="请简要说明完成情况..."
						:maxlength="500"
					></textarea>
				</view>
				
				<view class="form-item">
					<text class="form-label">上传附件 (可选)</text>
					<view class="upload-area" @click="chooseFile">
						<text class="upload-icon">📎</text>
						<text class="upload-text">点击选择文件</text>
					</view>
					
					<view v-if="fileList.length > 0" class="file-list">
						<view v-for="(file, index) in fileList" :key="index" class="file-item">
							<text class="file-name">{{ file.name }}</text>
							<text class="file-remove" @click="removeFile(index)">✕</text>
						</view>
					</view>
				</view>
			</view>
			
			<view class="dialog-footer">
				<button class="dialog-btn cancel" @click="close">取消</button>
				<button class="dialog-btn confirm" @click="confirm">确定</button>
			</view>
		</view>
	</view>
</template>

<script>
import { ref } from 'vue'
import { uploadTaskAttachment } from '@/api/index.js'

export default {
	name: 'CompleteDialog',
	emits: ['close', 'confirm'],
	setup(props, { emit }) {
		const form = ref({
			completionNote: ''
		})
		
		const fileList = ref([])
		
		// 选择文件
		const chooseFile = () => {
			// #ifdef MP-WEIXIN
			uni.chooseMessageFile({
				count: 5,
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
				count: 5,
				extension: ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.xls', '.xlsx'],
				success: (res) => {
					const tempFiles = res.tempFiles
					fileList.value = [...fileList.value, ...tempFiles]
				}
			})
			// #endif
		}
		
		// 移除文件
		const removeFile = (index) => {
			fileList.value.splice(index, 1)
		}
		
		// 关闭弹窗
		const close = () => {
			emit('close')
		}
		
		// 确认提交
		const confirm = async () => {
			if (!form.value.completionNote) {
				uni.showToast({
					title: '请填写完成说明',
					icon: 'none'
				})
				return
			}
			
			// 如果有附件，先上传附件
			let attachments = []
			if (fileList.value.length > 0) {
				try {
					for (const file of fileList.value) {
						const uploadRes = await uploadTaskAttachment(file)
						attachments.push(uploadRes)
					}
					
				} catch (error) {
					console.error('上传附件失败:', error)
					uni.showToast({
						title: '附件上传失败',
						icon: 'none'
					})
					return
				}
			}
			
			emit('confirm', {
				completionNote: form.value.completionNote,
				attachments
			})
		}
		
		return {
			form,
			fileList,
			chooseFile,
			removeFile,
			close,
			confirm
		}
	}
}
</script>

<style scoped lang="scss">
.dialog-mask {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 9999;
}

.dialog-content {
	width: 600rpx;
	max-height: 80vh;
	background: #ffffff;
	border-radius: 16rpx;
	overflow: hidden;
}

.dialog-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 32rpx;
	border-bottom: 1px solid #EBEEF5;
	
	.dialog-title {
		font-size: 32rpx;
		font-weight: bold;
		color: #303133;
	}
	
	.close-btn {
		font-size: 40rpx;
		color: #909399;
		line-height: 1;
	}
}

.dialog-body {
	padding: 32rpx;
	max-height: 60vh;
	overflow-y: auto;
	
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
		}
		
		.form-textarea {
			min-height: 200rpx;
			padding: 16rpx;
			background: #F5F7FA;
			border-radius: 8rpx;
			font-size: 28rpx;
			color: #303133;
		}
		
		.upload-area {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			height: 200rpx;
			background: #F5F7FA;
			border: 2rpx dashed #DCDFE6;
			border-radius: 8rpx;
			
			.upload-icon {
				font-size: 64rpx;
				margin-bottom: 16rpx;
			}
			
			.upload-text {
				font-size: 26rpx;
				color: #909399;
			}
		}
		
		.file-list {
			margin-top: 16rpx;
			
			.file-item {
				display: flex;
				justify-content: space-between;
				align-items: center;
				padding: 16rpx;
				background: #F5F7FA;
				border-radius: 8rpx;
				margin-bottom: 12rpx;
				
				&:last-child {
					margin-bottom: 0;
				}
				
				.file-name {
					flex: 1;
					font-size: 26rpx;
					color: #606266;
				}
				
				.file-remove {
					font-size: 32rpx;
					color: #F56C6C;
					padding: 0 12rpx;
				}
			}
		}
	}
}

.dialog-footer {
	display: flex;
	padding: 24rpx 32rpx;
	border-top: 1px solid #EBEEF5;
	
	.dialog-btn {
		flex: 1;
		height: 72rpx;
		line-height: 72rpx;
		font-size: 28rpx;
		border-radius: 8rpx;
		border: none;
		
		&::after {
			border: none;
		}
		
		&.cancel {
			background: #F5F7FA;
			color: #606266;
			margin-right: 16rpx;
		}
		
		&.confirm {
			background: #409EFF;
			color: #ffffff;
		}
	}
}
</style>

