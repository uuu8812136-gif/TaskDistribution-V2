import { defineStore } from 'pinia'
import { login, getCurrentUser } from '@/api/auth'
import { ElMessage } from 'element-plus'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('token') || '',
    userInfo: null
  }),

  getters: {
    isLoggedIn: (state) => !!state.token,
    isAdmin: (state) => state.userInfo?.roles?.includes('admin') || false,
    isExecutor: (state) => state.userInfo?.roles?.includes('executor') || false,
    isCCUser: (state) => state.userInfo?.roles?.includes('cc') || false
  },

  actions: {
    // 登录
    async login(credentials) {
      try {
        const response = await login(credentials)
        this.token = response.token
        this.userInfo = response.user
        localStorage.setItem('token', response.token)
        ElMessage.success('登录成功')
        return response
      } catch (error) {
        ElMessage.error(error.response?.data?.message || '登录失败')
        throw error
      }
    },

    // 获取当前用户信息
    async fetchUserInfo() {
      try {
        const response = await getCurrentUser()
        this.userInfo = response.user
        return response
      } catch (error) {
        console.error('获取用户信息失败:', error)
        this.logout()
        throw error
      }
    },

    // 退出登录
    logout() {
      this.token = ''
      this.userInfo = null
      localStorage.removeItem('token')
      location.href = '/login'
    }
  }
})

