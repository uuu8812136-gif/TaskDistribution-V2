<template>
  <div class="main-layout">
    <el-header class="layout-header">
      <div class="header-left">
        <el-button text class="menu-button" :aria-label="isCollapse ? '展开菜单' : '收起菜单'" @click="toggleCollapse">
          <el-icon><Expand v-if="isCollapse" /><Fold v-else /></el-icon>
        </el-button>
        <span class="logo-title">Horselink 公司管理系统</span>
      </div>

      <div class="header-right">
        <TeamSwitcher />
        <el-badge
          :value="messageStore.unreadCount"
          :max="99"
          :hidden="messageStore.unreadCount === 0"
          class="message-badge"
        >
          <el-button circle aria-label="消息中心" @click="goToMessages">
            <el-icon><Bell /></el-icon>
          </el-button>
        </el-badge>

        <el-dropdown @command="handleCommand">
          <div class="user-info">
            <el-avatar :size="32">{{ session.user?.name?.substring(0, 1) || '用' }}</el-avatar>
            <span class="username">{{ session.user?.name }}</span>
            <el-icon><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">
                <el-icon><User /></el-icon>
                个人中心
              </el-dropdown-item>
              <el-dropdown-item command="changePassword">
                <el-icon><Lock /></el-icon>
                修改密码
              </el-dropdown-item>
              <el-dropdown-item divided command="logout">
                <el-icon><SwitchButton /></el-icon>
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </el-header>

    <GlobalReadOnlyBanner />

    <el-container class="layout-container">
      <div
        v-if="isMobile && !isCollapse"
        class="mobile-menu-mask"
        aria-hidden="true"
        @click="isCollapse = true"
      />

      <el-aside
        :width="isMobile ? '220px' : (isCollapse ? '64px' : '200px')"
        class="layout-aside"
        :aria-hidden="isMobile && isCollapse"
        :inert="isMobile && isCollapse"
        :class="{
          'is-mobile': isMobile,
          'is-mobile-open': isMobile && !isCollapse
        }"
      >
        <el-menu
          :default-active="activeMenu"
          :collapse="isCollapse"
          :collapse-transition="false"
          :router="true"
        >
          <el-menu-item index="/dashboard">
            <el-icon><DataAnalysis /></el-icon>
            <template #title>统计看板</template>
          </el-menu-item>

          <el-sub-menu
            v-if="session.isTeamMode && (session.hasPermission('member.view') || canManageOrganization)"
            index="/team-management"
          >
            <template #title>
              <el-icon><OfficeBuilding /></el-icon>
              <span>团队管理</span>
            </template>
            <el-menu-item v-if="session.hasPermission('member.view')" index="/users">
              团队成员
            </el-menu-item>
            <el-menu-item v-if="canManageOrganization" index="/organization">
              组织架构
            </el-menu-item>
          </el-sub-menu>

          <el-menu-item v-if="session.isSuperAdmin" index="/team-control">
            <el-icon><Setting /></el-icon>
            <template #title>项目团队控制</template>
          </el-menu-item>

          <el-sub-menu v-if="session.hasPermission('equipment.view')" index="/equipment-module">
            <template #title>
              <el-icon><Tools /></el-icon>
              <span>设备管理</span>
            </template>
            <el-menu-item index="/equipment">设备台账</el-menu-item>
            <el-menu-item index="/equipment/categories">设备分类</el-menu-item>
          </el-sub-menu>

          <el-sub-menu v-if="session.hasPermission('report.view')" index="/reporting-module">
            <template #title>
              <el-icon><Tickets /></el-icon>
              <span>数据提报</span>
            </template>
            <el-menu-item index="/reporting/transport">运输提报</el-menu-item>
            <el-menu-item index="/reporting/production">生产排产</el-menu-item>
          </el-sub-menu>

          <el-sub-menu v-if="session.hasPermission('task.view')" index="/tasks">
            <template #title>
              <el-icon><Document /></el-icon>
              <span>任务管理</span>
            </template>
            <el-menu-item index="/tasks">全部任务</el-menu-item>
            <el-menu-item index="/tasks/my">我的任务</el-menu-item>
            <el-menu-item index="/tasks/board">任务看板</el-menu-item>
          </el-sub-menu>

          <el-menu-item
            v-if="session.can('task.review', { write: true, teamRequired: true })"
            index="/extensions"
          >
            <el-icon><Clock /></el-icon>
            <template #title>延期管理</template>
          </el-menu-item>

          <el-menu-item index="/messages">
            <el-badge
              :value="messageStore.unreadCount"
              :max="99"
              :hidden="messageStore.unreadCount === 0"
            >
              <el-icon><Bell /></el-icon>
            </el-badge>
            <template #title>消息中心</template>
          </el-menu-item>

          <el-menu-item index="/profile">
            <el-icon><User /></el-icon>
            <template #title>个人中心</template>
          </el-menu-item>
        </el-menu>
      </el-aside>

      <el-main class="layout-main">
        <div class="main-content">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" :key="`${route.fullPath}:${session.contextEpoch}`" />
            </transition>
          </router-view>
        </div>
      </el-main>
    </el-container>

    <el-dialog v-model="passwordDialogVisible" title="修改密码" width="min(500px, 92vw)">
      <el-form
        ref="passwordFormRef"
        :model="passwordForm"
        :rules="passwordRules"
        label-width="88px"
      >
        <el-form-item label="旧密码" prop="oldPassword">
          <el-input v-model="passwordForm.oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="passwordForm.newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input v-model="passwordForm.confirmPassword" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="passwordSubmitting" @click="handleChangePassword">
          确定
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import GlobalReadOnlyBanner from '@/components/GlobalReadOnlyBanner.vue'
import TeamSwitcher from '@/components/TeamSwitcher.vue'
import { changePassword } from '@/api/auth'
import { useMessageStore } from '@/stores/message'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const messageStore = useMessageStore()
const canManageOrganization = computed(() => (
  session.isTeamMode &&
  session.hasPermission('org.manage') &&
  (session.isSuperAdmin || session.context.membership?.role === 'PROJECT_ADMIN')
))
const isCollapse = ref(false)
const isMobile = ref(false)
const passwordDialogVisible = ref(false)
const passwordSubmitting = ref(false)
const passwordFormRef = ref(null)
const passwordForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
let messagePollTimer = null

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入旧密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== passwordForm.newPassword) callback(new Error('两次输入的密码不一致'))
        else callback()
      },
      trigger: 'blur'
    }
  ]
}

const activeMenu = computed(() => route.meta.activeMenu || route.path)
const toggleCollapse = () => { isCollapse.value = !isCollapse.value }
const goToMessages = () => router.push({ name: 'Messages' })

const syncResponsiveLayout = () => {
  const mobile = window.matchMedia('(max-width: 768px)').matches
  if (mobile === isMobile.value) return

  isMobile.value = mobile
  isCollapse.value = mobile
}

const stopMessagePolling = () => {
  if (messagePollTimer) clearInterval(messagePollTimer)
  messagePollTimer = null
}

const startMessagePolling = () => {
  stopMessagePolling()
  if (!session.canAccessBusiness) return
  messageStore.fetchUnreadCount()
  messagePollTimer = setInterval(() => messageStore.fetchUnreadCount(), 30000)
}

const handleCommand = (command) => {
  if (command === 'profile') router.push({ name: 'Profile' })
  if (command === 'changePassword') passwordDialogVisible.value = true
  if (command === 'logout') handleLogout()
}

const handleChangePassword = async () => {
  const valid = await passwordFormRef.value?.validate().catch(() => false)
  if (!valid) return

  passwordSubmitting.value = true
  try {
    await changePassword({
      oldPassword: passwordForm.oldPassword,
      newPassword: passwordForm.newPassword
    })
    ElMessage.success('密码修改成功，请重新登录')
    passwordDialogVisible.value = false
    session.clearLocalSession('password-changed')
    await router.replace({ name: 'Login' })
  } catch {
    // 请求层统一展示错误。
  } finally {
    passwordSubmitting.value = false
  }
}

const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
  }

  try {
    await session.logout()
  } catch {
    // 本地会话会在 store 的 finally 中清理，仍需回到登录页。
  } finally {
    await router.replace({ name: 'Login' })
  }
}

watch(() => session.contextEpoch, startMessagePolling)
watch(() => route.fullPath, () => {
  if (isMobile.value) isCollapse.value = true
})
onMounted(startMessagePolling)
onMounted(() => {
  syncResponsiveLayout()
  window.addEventListener('resize', syncResponsiveLayout)
})
onUnmounted(() => {
  stopMessagePolling()
  window.removeEventListener('resize', syncResponsiveLayout)
})
</script>

<style scoped lang="scss">
.main-layout {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.layout-header {
  flex: 0 0 60px;
  height: 60px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}

.header-left,
.header-right,
.user-info {
  display: flex;
  align-items: center;
}

.header-left {
  min-width: 0;
  gap: 10px;
}

.header-right {
  gap: 14px;
}

.menu-button {
  width: 34px;
  height: 34px;
  margin: 0;
  font-size: 19px;
}

.logo-title {
  overflow: hidden;
  color: #303133;
  font-size: 17px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-badge :deep(.el-badge__content) {
  top: 8px;
  right: 18px;
}

.user-info {
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: #f5f7fa;
  }
}

.username {
  max-width: 100px;
  overflow: hidden;
  color: #606266;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout-container {
  position: relative;
  min-height: 0;
  flex: 1;
}

.mobile-menu-mask {
  position: fixed;
  inset: 60px 0 0;
  z-index: 1090;
  background: rgb(0 0 0 / 32%);
}

.layout-aside {
  overflow-x: hidden;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  transition: width 0.2s;

  &.is-mobile {
    position: fixed;
    top: 60px;
    bottom: 0;
    left: 0;
    z-index: 1100;
    width: 220px !important;
    overflow-y: auto;
    box-shadow: 8px 0 24px rgb(0 0 0 / 12%);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }

  &.is-mobile-open {
    transform: translateX(0);
  }

  .el-menu {
    height: 100%;
    border-right: 0;
  }
}

.layout-main {
  min-width: 0;
  padding: 0;
  overflow-y: auto;
  background: #f5f7fa;
}

.main-content {
  min-height: 100%;
  padding: 20px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 900px) {
  .logo-title,
  .username {
    display: none;
  }

  .layout-header {
    padding-inline: 10px;
  }

  .header-right {
    gap: 8px;
  }
}

@media (max-width: 600px) {
  .layout-header {
    padding-inline: 8px;
    gap: 6px;
  }

  .header-right {
    gap: 6px;
  }

  .user-info {
    gap: 3px;
    padding-inline: 2px;
  }

  .user-info :deep(.el-avatar) {
    width: 28px;
    height: 28px;
  }

  .main-content {
    padding: 12px;
  }
}
</style>
