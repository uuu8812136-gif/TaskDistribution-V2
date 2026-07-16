<template>
	<view class="profile-container">
		<!-- 用户信息卡片 -->
		<view class="user-card">
			<view class="user-avatar">
				<text class="avatar-text">{{ userInfo?.name?.charAt(0) || '用' }}</text>
			</view>
			<view class="user-info">
				<text class="user-name">{{ userInfo?.name }}</text>
				<text class="user-dept">{{ orgUnitName }}</text>
			</view>
		</view>
		
		<!-- 信息列表 -->
		<view class="info-section">
			<view class="info-item">
				<text class="label">项目团队</text>
				<text class="value">{{ activeTeamName }}</text>
			</view>
			<view class="info-item">
				<text class="label">访问模式</text>
				<text class="value">{{ accessModeText }}</text>
			</view>
			<view class="info-item">
				<text class="label">账号</text>
				<text class="value">{{ userInfo?.username }}</text>
			</view>
			<view class="info-item">
				<text class="label">手机号</text>
				<text class="value">{{ userInfo?.phone }}</text>
			</view>
			<view class="info-item">
				<text class="label">邮箱</text>
				<text class="value">{{ userInfo?.email || '未设置' }}</text>
			</view>
			<view class="info-item">
				<text class="label">角色</text>
				<text class="value">{{ getRoleText }}</text>
			</view>
			<view class="info-item">
				<text class="label">状态</text>
				<view class="status" :class="{ active: userInfo?.status === 'active' }">
					<text>{{ userInfo?.status === 'active' ? '正常' : '禁用' }}</text>
				</view>
			</view>
		</view>
		
		<!-- 功能列表 -->
		<view class="menu-section">
			<view class="menu-item" @click="goToTeamSelect">
				<view class="menu-left">
					<text class="menu-icon">⇄</text>
					<text class="menu-text">切换项目团队</text>
				</view>
				<text class="menu-arrow">〉</text>
			</view>

			<view class="menu-item" @click="goToChangePassword">
				<view class="menu-left">
					<text class="menu-icon">🔑</text>
					<text class="menu-text">修改密码</text>
				</view>
				<text class="menu-arrow">〉</text>
			</view>
			
			<view class="menu-item" @click="handleLogout">
				<view class="menu-left">
					<text class="menu-icon">🚪</text>
					<text class="menu-text">退出登录</text>
				</view>
				<text class="menu-arrow">〉</text>
			</view>
		</view>
		
		<!-- 版本信息 -->
		<view class="version-info">
			<text>Horselink（马链）任务管理系统</text>
		</view>
		
		<!-- 自定义 TabBar -->
		<CustomTabbar />
	</view>
</template>

<script>
import { computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useUserStore } from '@/stores/user.js'
import CustomTabbar from '@/components/custom-tab-bar/CustomTabBar.vue'

export default {
	name: 'ProfileIndex',
	components: {
		CustomTabbar
	},
	setup() {
		const userStore = useUserStore()
		
		const userInfo = computed(() => userStore.userInfo)
		const activeTeamName = computed(() => {
			if (userStore.isGlobalReadOnly) return '全部团队'
			return userStore.activeTeam?.name || '未选择'
		})
		const orgUnitName = computed(() => userStore.context?.orgUnit?.name || userInfo.value?.department || '')
		const accessModeText = computed(() => userStore.isGlobalReadOnly ? '跨团队只读' : '团队内访问')
		
		// 页面显示时触发
		onShow(() => {
			// 通知 TabBar 更新选中状态
			uni.$emit('tabbar-update')
		})
		
		// 获取角色文本
		const getRoleText = computed(() => {
			if (userStore.isSuperAdmin) return '超级管理员'
			if (userStore.context?.membership?.role === 'PROJECT_ADMIN') return '项目管理员'
			const roles = userInfo.value?.roles || []
			const roleMap = {
				admin: '管理员',
				executor: '执行人',
				cc: '抄送人'
			}
			return roles.map(role => roleMap[role] || role).join('、')
		})
		
		// 跳转到修改密码
		const goToChangePassword = () => {
			uni.navigateTo({
				url: '/pages/profile/change-password'
			})
		}

		const goToTeamSelect = () => {
			uni.navigateTo({ url: '/pages/team/select?from=profile' })
		}
		
		// 退出登录
		const handleLogout = () => {
			uni.showModal({
				title: '确认退出',
				content: '确认退出登录？',
				success: (res) => {
					if (res.confirm) {
						userStore.logout()
					}
				}
			})
		}
		
		return {
			userInfo,
			activeTeamName,
			orgUnitName,
			accessModeText,
			getRoleText,
			goToTeamSelect,
			goToChangePassword,
			handleLogout
		}
	}
}
</script>

<style scoped lang="scss">
.profile-container {
	min-height: 100vh;
	background: var(--zl-page-bg, #eef3fb);
	padding: 24rpx;
	padding-bottom: calc(136rpx + constant(safe-area-inset-bottom));
	padding-bottom: calc(136rpx + env(safe-area-inset-bottom));
}

.user-card {
	background: var(--zl-primary, #4096ff);
	border-radius: 16rpx;
	padding: 48rpx 32rpx;
	display: flex;
	align-items: center;
	margin-bottom: 24rpx;
	
	.user-avatar {
		width: 120rpx;
		height: 120rpx;
		background: rgba(255, 255, 255, 0.3);
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-right: 32rpx;
		
		.avatar-text {
			font-size: 48rpx;
			font-weight: bold;
			color: #ffffff;
		}
	}
	
	.user-info {
		flex: 1;
		
		.user-name {
			display: block;
			font-size: 36rpx;
			font-weight: bold;
			color: #ffffff;
			margin-bottom: 12rpx;
		}
		
		.user-dept {
			display: block;
			font-size: 24rpx;
			color: rgba(255, 255, 255, 0.8);
		}
	}
}

.info-section, .menu-section {
	background: #ffffff;
	border-radius: 16rpx;
	padding: 32rpx;
	margin-bottom: 24rpx;
}

.info-item {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 24rpx 0;
	border-bottom: 1px solid #EBEEF5;
	
	&:last-child {
		border-bottom: none;
	}
	
	.label {
		font-size: 28rpx;
		color: #909399;
	}
	
	.value {
		max-width: 62%;
		font-size: 28rpx;
		color: #303133;
		text-align: right;
		word-break: break-all;
	}
	
	.status {
		padding: 6rpx 16rpx;
		border-radius: 24rpx;
		font-size: 22rpx;
		background: #F56C6C;
		color: #ffffff;
		
		&.active {
			background: #67C23A;
		}
	}
}

.menu-item {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 24rpx 0;
	border-bottom: 1px solid #EBEEF5;
	
	&:last-child {
		border-bottom: none;
	}
	
	.menu-left {
		display: flex;
		align-items: center;
		
		.menu-icon {
			font-size: 36rpx;
			margin-right: 16rpx;
		}
		
		.menu-text {
			font-size: 28rpx;
			color: #303133;
		}
	}
	
	.menu-arrow {
		font-size: 28rpx;
		color: #C0C4CC;
	}
}

.version-info {
	text-align: center;
	padding: 32rpx 0;
	font-size: 24rpx;
	color: #909399;
}
</style>

