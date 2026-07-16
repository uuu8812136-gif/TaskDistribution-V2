<script>
	import { useUserStore } from '@/stores/user.js'
	import { setUnauthorizedHandler } from '@/utils/request.js'
	import { clearLegacyCredentialCaches } from '@/utils/sessionRuntime.js'

	export default {
		onLaunch: function() {
			clearLegacyCredentialCaches()
			const userStore = useUserStore()
			setUnauthorizedHandler(() => userStore.handleUnauthorized())
		},
		onShow: function() {
			console.log('App Show')
		},
		onHide: function() {
			console.log('App Hide')
		}
	}
</script>

<style>
	page {
		--zl-primary: #4096ff;
		--zl-primary-deep: #1677ff;
		--zl-success: #52c41a;
		--zl-warning: #faad14;
		--zl-danger: #ff4d4f;
		--zl-text: #1f2733;
		--zl-muted: #64748b;
		--zl-page-bg: #eef3fb;
		--zl-surface: #ffffff;
		--zl-surface-soft: #f5f8fc;
		--zl-border: rgba(100, 116, 139, 0.18);
		--zl-card-radius: 16rpx;
		--zl-control-radius: 20rpx;
		--zl-control-height: 80rpx;
		--zl-tabbar-height: 112rpx;
		min-height: 100%;
		background: var(--zl-page-bg);
		color: var(--zl-text);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	}

	view,
	scroll-view,
	button,
	input,
	textarea,
	picker {
		box-sizing: border-box;
	}

	button::after {
		border: none;
	}

	.zl-card {
		background: var(--zl-surface);
		border: 1px solid var(--zl-border);
		border-radius: var(--zl-card-radius);
		box-shadow: 0 8rpx 28rpx rgba(15, 23, 42, 0.06);
	}

	.zl-field {
		height: var(--zl-control-height);
		padding: 0 24rpx;
		background: var(--zl-surface-soft);
		border: 1px solid var(--zl-border);
		border-radius: var(--zl-control-radius);
		color: var(--zl-text);
	}

	.zl-button {
		height: var(--zl-control-height);
		line-height: var(--zl-control-height);
		margin: 0;
		padding: 0 28rpx;
		border-radius: var(--zl-control-radius);
		font-size: 28rpx;
	}

	.zl-button--primary {
		background: var(--zl-primary);
		color: #ffffff;
	}
</style>
