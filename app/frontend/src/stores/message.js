import { defineStore } from 'pinia'
import { getUnreadCount } from '@/api/message'

export const useMessageStore = defineStore('message', {
  state: () => ({
    unreadCount: 0
  }),

  actions: {
    // 获取未读消息数量
    async fetchUnreadCount() {
      try {
        const result = await getUnreadCount()
        this.unreadCount = result.count
      } catch (error) {
        console.error('获取未读消息数量失败:', error)
      }
    },

    // 减少未读数量
    decreaseUnreadCount(count = 1) {
      this.unreadCount = Math.max(0, this.unreadCount - count)
    },

    // 增加未读数量
    increaseUnreadCount(count = 1) {
      this.unreadCount += count
    },

    // 清空未读数量
    clearUnreadCount() {
      this.unreadCount = 0
    }
  }
})

