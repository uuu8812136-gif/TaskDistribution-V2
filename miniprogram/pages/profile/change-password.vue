<template>
	<view class="change-password-container">
		<view class="form-card">
			<view class="form-item">
				<text class="form-label">旧密码</text>
				<input 
					class="form-input" 
					v-model="form.oldPassword" 
					type="password"
					placeholder="请输入旧密码"
					:maxlength="20"
				/>
			</view>
			
			<view class="form-item">
				<text class="form-label">新密码</text>
				<input 
					class="form-input" 
					v-model="form.newPassword" 
					type="password"
					placeholder="请输入新密码"
					:maxlength="20"
				/>
			</view>
			
			<view class="form-item">
				<text class="form-label">确认密码</text>
				<input 
					class="form-input" 
					v-model="form.confirmPassword" 
					type="password"
					placeholder="请再次输入新密码"
					:maxlength="20"
				/>
			</view>
			
			<button class="submit-btn" @click="handleSubmit" :loading="loading">
				{{ loading ? '提交中...' : '确认修改' }}
			</button>
		</view>
		
		<view class="tips-card">
			<text class="tips-title">💡 密码要求</text>
			<text class="tips-item">• 密码长度为 6-20 个字符</text>
			<text class="tips-item">• 建议包含字母、数字和特殊字符</text>
			<text class="tips-item">• 不要使用过于简单的密码</text>
		</view>
	</view>
</template>

<script>
import { ref } from 'vue'
import { changePassword } from '@/api/index.js'
import { useUserStore } from '@/stores/user.js'

export default {
	name: 'ChangePassword',
	setup() {
		const userStore = useUserStore()
		const form = ref({
			oldPassword: '',
			newPassword: '',
			confirmPassword: ''
		})
		
		const loading = ref(false)
		
		// 提交修改
		const handleSubmit = async () => {
			// 表单验证
			if (!form.value.oldPassword) {
				uni.showToast({
					title: '请输入旧密码',
					icon: 'none'
				})
				return
			}
			
			if (!form.value.newPassword) {
				uni.showToast({
					title: '请输入新密码',
					icon: 'none'
				})
				return
			}
			
			if (form.value.newPassword.length < 6) {
				uni.showToast({
					title: '密码长度不能少于6位',
					icon: 'none'
				})
				return
			}
			
			if (form.value.newPassword !== form.value.confirmPassword) {
				uni.showToast({
					title: '两次输入的密码不一致',
					icon: 'none'
				})
				return
			}
			
			if (form.value.oldPassword === form.value.newPassword) {
				uni.showToast({
					title: '新密码不能与旧密码相同',
					icon: 'none'
				})
				return
			}
			
			loading.value = true
			
			try {
				await changePassword({
					oldPassword: form.value.oldPassword,
					newPassword: form.value.newPassword
				})
				
				uni.showToast({
					title: '修改成功',
					icon: 'success',
					duration: 2000
				})
				
				form.value.oldPassword = ''
				form.value.newPassword = ''
				form.value.confirmPassword = ''
				userStore.clearLocalSession('password-changed')
				setTimeout(() => {
					uni.reLaunch({ url: '/pages/login/index' })
				}, 800)
				
			} catch (error) {
				console.error('修改密码失败:', error)
			} finally {
				loading.value = false
			}
		}
		
		return {
			form,
			loading,
			handleSubmit
		}
	}
}
</script>

<style scoped lang="scss">
.change-password-container {
	min-height: 100vh;
	background: #F5F7FA;
	padding: 24rpx;
}

.form-card {
	background: #ffffff;
	border-radius: 16rpx;
	padding: 32rpx;
	margin-bottom: 24rpx;
	
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
		
		.form-input {
			width: 100%;
			height: 88rpx;
			padding: 0 24rpx;
			background: #F5F7FA;
			border-radius: 12rpx;
			font-size: 28rpx;
			color: #303133;
		}
	}
	
	.submit-btn {
		width: 100%;
		height: 88rpx;
		line-height: 88rpx;
		background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
		color: #ffffff;
		font-size: 32rpx;
		font-weight: bold;
		border-radius: 12rpx;
		border: none;
		margin-top: 48rpx;
		
		&::after {
			border: none;
		}
	}
}

.tips-card {
	background: #FFF7E6;
	border-radius: 16rpx;
	padding: 32rpx;
	
	.tips-title {
		display: block;
		font-size: 28rpx;
		font-weight: bold;
		color: #E6A23C;
		margin-bottom: 16rpx;
	}
	
	.tips-item {
		display: block;
		font-size: 24rpx;
		color: #606266;
		line-height: 2;
	}
}
</style>

