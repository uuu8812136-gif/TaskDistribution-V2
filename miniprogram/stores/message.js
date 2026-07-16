/**
 * 消息状态管理 - Pinia Store
 */
import { defineStore } from 'pinia'
import { getUnreadCount } from '@/api/index.js'

export const useMessageStore = defineStore('message', {
  state: () => ({
    unreadCount: 0
  }),
  
  actions: {
    // 获取未读消息数量
    async fetchUnreadCount() {
      try {
        const res = await getUnreadCount()
        this.unreadCount = res.count || 0
        
        // 设置tabBar角标
        if (this.unreadCount > 0) {
          uni.setTabBarBadge({
            index: 2, // 消息tab的索引
            text: this.unreadCount > 99 ? '99+' : String(this.unreadCount)
          })
        } else {
          uni.removeTabBarBadge({
            index: 2
          })
        }
        
        return this.unreadCount
      } catch (error) {
        console.error('获取未读消息数量失败:', error)
        return 0
      }
    },
    
    // 减少未读数量
    decreaseUnreadCount(count = 1) {
      this.unreadCount = Math.max(0, this.unreadCount - count)
      
      // 更新tabBar角标
      if (this.unreadCount > 0) {
        uni.setTabBarBadge({
          index: 2,
          text: this.unreadCount > 99 ? '99+' : String(this.unreadCount)
        })
      } else {
        uni.removeTabBarBadge({
          index: 2
        })
      }
    },
    
    // 清空未读数量
    clearUnreadCount() {
      this.unreadCount = 0
      uni.removeTabBarBadge({
        index: 2
      })
    }
  }
})

