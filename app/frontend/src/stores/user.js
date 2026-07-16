import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useSessionStore } from '@/stores/session'

// 兼容旧页面。新代码应直接使用 useSessionStore 和固定 permission key。
export const useUserStore = defineStore('user', () => {
  const session = useSessionStore()
  const token = computed(() => session.token)
  const userInfo = computed(() => session.user)
  const isLoggedIn = computed(() => session.isLoggedIn)

  // 旧的“管理员”按钮仅在团队写上下文中展示，不再读取 user.roles.admin。
  const isAdmin = computed(() => (
    !session.isReadOnly &&
    session.hasPermission([
      'task.create',
      'task.edit',
      'task.assign',
      'task.review',
      'member.manage',
      'org.manage'
    ], 'any')
  ))
  const isExecutor = computed(() => session.user?.roles?.includes('executor') || false)
  const isCCUser = computed(() => session.user?.roles?.includes('cc') || false)

  const login = (credentials) => session.login(credentials)
  const fetchUserInfo = () => session.bootstrap({ force: true })
  const logout = async () => {
    try {
      await session.logout()
    } catch {
      // 兼容旧页面：服务端登出失败也必须离开已清理的本地会话。
    } finally {
      window.location.assign('/login')
    }
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    isAdmin,
    isExecutor,
    isCCUser,
    login,
    fetchUserInfo,
    logout
  }
})
