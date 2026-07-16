<template>
	<view class="dialog-mask" @click="close">
		<view class="dialog-content" @click.stop>
			<view class="dialog-header">
				<text class="dialog-title">申请延期</text>
				<text class="close-btn" @click="close">✕</text>
			</view>
			
			<view class="dialog-body">
				<view class="form-item">
					<text class="form-label">当前完成时间</text>
					<text class="current-time">{{ formatDate(currentTime, 'YYYY-MM-DD HH:mm') }}</text>
				</view>
				
				<view class="form-item">
					<text class="form-label">新的完成时间</text>
					<picker 
						mode="multiSelector" 
						:value="dateTimeIndex"
						:range="[dateRange, timeRange]"
						@change="onDateTimeChange"
					>
						<view class="picker-input">
							<text>{{ form.newTime || '请选择新的完成时间' }}</text>
						</view>
					</picker>
				</view>
				
				<view class="form-item">
					<text class="form-label">延期理由</text>
					<textarea 
						class="form-textarea" 
						v-model="form.reason"
						placeholder="请说明延期理由..."
						:maxlength="500"
					></textarea>
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
import { ref, computed } from 'vue'
import { formatDate, parseDate } from '@/utils/format.js'

export default {
	name: 'ExtensionDialog',
	props: {
		currentTime: {
			type: String,
			default: ''
		}
	},
	emits: ['close', 'confirm'],
	setup(props, { emit }) {
		const form = ref({
			newTime: '',
			reason: ''
		})
		
		const dateTimeIndex = ref([0, 0])
		
		// 生成未来30天的日期数组
		const dateRange = computed(() => {
			const dates = []
			const now = new Date()
			for (let i = 1; i <= 30; i++) {
				const date = new Date(now.getTime() + i * 24 * 60 * 60 * 1000)
				const year = date.getFullYear()
				const month = String(date.getMonth() + 1).padStart(2, '0')
				const day = String(date.getDate()).padStart(2, '0')
				dates.push(`${year}-${month}-${day}`)
			}
			return dates
		})
		
		// 生成时间数组（每小时）
		const timeRange = computed(() => {
			const times = []
			for (let h = 0; h < 24; h++) {
				for (let m = 0; m < 60; m += 30) {
					const hour = String(h).padStart(2, '0')
					const minute = String(m).padStart(2, '0')
					times.push(`${hour}:${minute}`)
				}
			}
			return times
		})
		
		// 日期时间选择变化
		const onDateTimeChange = (e) => {
			const [dateIndex, timeIndex] = e.detail.value
			dateTimeIndex.value = [dateIndex, timeIndex]
			
			const date = dateRange.value[dateIndex]
			const time = timeRange.value[timeIndex]
			form.value.newTime = `${date} ${time}:00`
		}
		
		// 关闭弹窗
		const close = () => {
			emit('close')
		}
		
		// 确认申请
		const confirm = () => {
			if (!form.value.newTime) {
				uni.showToast({
					title: '请选择新的完成时间',
					icon: 'none'
				})
				return
			}
			
			if (!form.value.reason) {
				uni.showToast({
					title: '请填写延期理由',
					icon: 'none'
				})
				return
			}
			
			// 验证新时间必须晚于当前时间
			const newDate = parseDate(form.value.newTime)
			const currentDate = parseDate(props.currentTime)
			
			if (newDate <= currentDate) {
				uni.showToast({
					title: '新时间必须晚于当前完成时间',
					icon: 'none'
				})
				return
			}
			
			// 计算延期天数
			const timeDiff = newDate.getTime() - currentDate.getTime()
			const requestedDays = Math.ceil(timeDiff / (1000 * 60 * 60 * 24))
			
			emit('confirm', {
				reason: form.value.reason,
				requestedDays: requestedDays
			})
		}
		
		return {
			form,
			dateTimeIndex,
			dateRange,
			timeRange,
			onDateTimeChange,
			close,
			confirm,
			formatDate
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
		
		.current-time {
			display: block;
			padding: 16rpx;
			background: #F5F7FA;
			border-radius: 8rpx;
			font-size: 28rpx;
			color: #303133;
		}
		
		.picker-input {
			padding: 16rpx;
			background: #F5F7FA;
			border-radius: 8rpx;
			font-size: 28rpx;
			color: #303133;
		}
		
		.form-textarea {
			min-height: 200rpx;
			padding: 16rpx;
			background: #F5F7FA;
			border-radius: 8rpx;
			font-size: 28rpx;
			color: #303133;
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

