/**
 * 用户状态管理 - Pinia Store
 */
import { defineStore } from 'pinia'
import { getCurrentUser } from '@/api/index.js'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: uni.getStorageSync('token') || '',
    userInfo: uni.getStorageSync('userInfo') || null
  }),
  
  getters: {
    // 是否已登录
    isLogin: (state) => !!state.token,
    
    // 是否是管理员
    isAdmin: (state) => {
      return state.userInfo && state.userInfo.roles && state.userInfo.roles.includes('admin')
    },
    
    // 是否是执行人
    isExecutor: (state) => {
      return state.userInfo && state.userInfo.roles && state.userInfo.roles.includes('executor')
    },
    
    // 是否是抄送人
    isCc: (state) => {
      return state.userInfo && state.userInfo.roles && state.userInfo.roles.includes('cc')
    }
  },
  
  actions: {
    // 登录
    setToken(token) {
      this.token = token
      uni.setStorageSync('token', token)
    },
    
    // 设置用户信息
    setUserInfo(userInfo) {
      this.userInfo = userInfo
      uni.setStorageSync('userInfo', userInfo)
    },
    
    // 获取当前用户信息
    async fetchUserInfo() {
      try {
        const res = await getCurrentUser()
        this.setUserInfo(res.user)
        return res.user
      } catch (error) {
        console.error('获取用户信息失败:', error)
        throw error
      }
    },
    
    // 退出登录
    logout() {
      this.token = ''
      this.userInfo = null
      uni.removeStorageSync('token')
      uni.removeStorageSync('userInfo')
      uni.removeStorageSync('rememberPassword')
      uni.removeStorageSync('savedUsername')
      uni.removeStorageSync('savedPassword')
      
      // 跳转到登录页
      uni.reLaunch({
        url: '/pages/login/index'
      })
    }
  }
})

