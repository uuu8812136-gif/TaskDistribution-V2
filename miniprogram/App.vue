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
	/*每个页面公共css */
</style>
