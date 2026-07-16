<template>
	<view class="dialog-mask" @click="close">
		<view class="dialog-content" @click.stop>
			<view class="dialog-header">
				<text class="dialog-title">审核任务</text>
				<text class="close-btn" @click="close">✕</text>
			</view>
			
			<view class="dialog-body">
				<view class="form-item">
					<text class="form-label">审核结果</text>
					<radio-group @change="onStatusChange">
						<label class="radio-item">
							<radio value="approved" :checked="form.reviewStatus === 'approved'" color="#67C23A" />
							<text>通过</text>
						</label>
						<label class="radio-item">
							<radio value="rejected" :checked="form.reviewStatus === 'rejected'" color="#F56C6C" />
							<text>拒绝</text>
						</label>
					</radio-group>
				</view>
				
				<view class="form-item">
					<text class="form-label">审核评价 <text style="color: #F56C6C;">*</text></text>
					<textarea 
						class="form-textarea" 
						v-model="form.reviewComment"
						placeholder="请描述任务完成情况、监督审核的实际情况..."
						:maxlength="500"
					></textarea>
					<text class="char-count">{{ form.reviewComment.length }}/500</text>
				</view>
				
				<!-- 图片上传 -->
				<view class="form-item">
					<text class="form-label">审核图片（最多9张）</text>
					<view class="upload-area">
						<view 
							v-for="(img, index) in imageList" 
							:key="index"
							class="upload-item"
						>
							<image 
								:src="img.url" 
								mode="aspectFill"
								class="upload-img"
								@click="previewImage(index)"
							></image>
							<text class="delete-btn" @click.stop="removeImage(index)">✕</text>
						</view>
						<view 
							v-if="imageList.length < 9"
							class="upload-btn"
							@click="chooseImage"
						>
							<text class="upload-icon">📷</text>
							<text class="upload-text">上传图片</text>
						</view>
					</view>
				</view>
				
				<!-- 文档上传 -->
				<view class="form-item">
					<text class="form-label">审核文档（最多5个）</text>
					<view class="file-list">
						<view 
							v-for="(file, index) in fileList" 
							:key="index"
							class="file-item"
						>
							<text class="file-icon">📎</text>
							<text class="file-name">{{ file.name }}</text>
							<text class="delete-btn" @click="removeFile(index)">✕</text>
						</view>
					</view>
					<button 
						v-if="fileList.length < 5"
						class="upload-file-btn" 
						@click="chooseFile"
					>
						<text>📄 上传文档</text>
					</button>
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

export default {
	name: 'ReviewDialog',
	emits: ['close', 'confirm'],
	setup(props, { emit }) {
		const form = ref({
			reviewStatus: 'approved',
			reviewComment: ''
		})
		
		const imageList = ref([])  // 图片列表
		const fileList = ref([])   // 文档列表
		
		// 审核结果变化
		const onStatusChange = (e) => {
			form.value.reviewStatus = e.detail.value
		}
		
		// 选择图片
		const chooseImage = () => {
			const maxCount = 9 - imageList.value.length
			
			uni.chooseImage({
				count: maxCount,
				sizeType: ['original', 'compressed'],
				sourceType: ['camera', 'album'],
				success: (res) => {
					res.tempFilePaths.forEach(path => {
						imageList.value.push({
							url: path,
							path: path
						})
					})
				}
			})
		}
		
		// 预览图片
		const previewImage = (index) => {
			uni.previewImage({
				urls: imageList.value.map(img => img.url),
				current: index
			})
		}
		
		// 删除图片
		const removeImage = (index) => {
			imageList.value.splice(index, 1)
		}
		
		// 选择文档
		const chooseFile = () => {
			// #ifdef MP-WEIXIN
			uni.chooseMessageFile({
				count: 5 - fileList.value.length,
				type: 'file',
				success: (res) => {
					res.tempFiles.forEach(file => {
						fileList.value.push({
							path: file.path,
							name: file.name,
							size: file.size
						})
					})
				}
			})
			// #endif
			
			// #ifndef MP-WEIXIN
			uni.showToast({
				title: '该平台暂不支持文档上传',
				icon: 'none'
			})
			// #endif
		}
		
		// 删除文档
		const removeFile = (index) => {
			fileList.value.splice(index, 1)
		}
		
		// 关闭弹窗
		const close = () => {
			emit('close')
		}
		
		// 确认审核
		const confirm = () => {
			if (!form.value.reviewComment.trim()) {
				uni.showToast({
					title: '请填写审核评价',
					icon: 'none'
				})
				return
			}
			
			emit('confirm', {
				reviewStatus: form.value.reviewStatus,
				reviewComment: form.value.reviewComment,
				images: imageList.value,
				files: fileList.value
			})
		}
		
		return {
			form,
			imageList,
			fileList,
			onStatusChange,
			chooseImage,
			previewImage,
			removeImage,
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
	max-height: 800rpx;
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
		
		.radio-item {
			display: inline-flex;
			align-items: center;
			margin-right: 48rpx;
			font-size: 28rpx;
			color: #303133;
			
			radio {
				margin-right: 12rpx;
			}
		}
		
		.form-textarea {
			min-height: 200rpx;
			padding: 16rpx;
			background: #F5F7FA;
			border-radius: 8rpx;
			font-size: 28rpx;
			color: #303133;
			box-sizing: border-box;
		}
		
		.char-count {
			display: block;
			text-align: right;
			font-size: 24rpx;
			color: #909399;
			margin-top: 8rpx;
		}
		
		// 图片上传区域
		.upload-area {
			display: flex;
			flex-wrap: wrap;
			gap: 16rpx;
			
			.upload-item {
				position: relative;
				width: 160rpx;
				height: 160rpx;
				
				.upload-img {
					width: 100%;
					height: 100%;
					border-radius: 8rpx;
				}
				
				.delete-btn {
					position: absolute;
					top: -8rpx;
					right: -8rpx;
					width: 40rpx;
					height: 40rpx;
					background: #F56C6C;
					color: #ffffff;
					border-radius: 50%;
					display: flex;
					align-items: center;
					justify-content: center;
					font-size: 28rpx;
					line-height: 1;
				}
			}
			
			.upload-btn {
				width: 160rpx;
				height: 160rpx;
				border: 2rpx dashed #DCDFE6;
				border-radius: 8rpx;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				background: #F5F7FA;
				
				.upload-icon {
					font-size: 48rpx;
					margin-bottom: 8rpx;
				}
				
				.upload-text {
					font-size: 24rpx;
					color: #909399;
				}
			}
		}
		
		// 文档列表
		.file-list {
			margin-bottom: 16rpx;
			
			.file-item {
				display: flex;
				align-items: center;
				padding: 16rpx;
				background: #F5F7FA;
				border-radius: 8rpx;
				margin-bottom: 12rpx;
				
				&:last-child {
					margin-bottom: 0;
				}
				
				.file-icon {
					font-size: 32rpx;
					margin-right: 12rpx;
				}
				
				.file-name {
					flex: 1;
					font-size: 26rpx;
					color: #303133;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				
				.delete-btn {
					width: 40rpx;
					height: 40rpx;
					background: #F56C6C;
					color: #ffffff;
					border-radius: 50%;
					display: flex;
					align-items: center;
					justify-content: center;
					font-size: 24rpx;
					margin-left: 12rpx;
				}
			}
		}
		
		.upload-file-btn {
			width: 100%;
			height: 72rpx;
			line-height: 72rpx;
			background: #F5F7FA;
			border: 2rpx dashed #DCDFE6;
			border-radius: 8rpx;
			color: #606266;
			font-size: 28rpx;
			
			&::after {
				border: none;
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

