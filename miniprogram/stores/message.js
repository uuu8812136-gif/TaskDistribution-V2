import { defineStore } from 'pinia'
import { getUnreadCount } from '@/api/index.js'
import {
  getScopedCache,
  readSessionSnapshot,
  setScopedCache,
  toCacheIdentity
} from '@/utils/sessionRuntime.js'

const UNREAD_CACHE_NAMESPACE = 'messages:unread-count'

function currentIdentity() {
  const snapshot = readSessionSnapshot()
  return toCacheIdentity(snapshot?.user?._id, snapshot?.activeTeamId, snapshot?.mode)
}

function readInitialUnreadCount() {
  const value = getScopedCache(UNREAD_CACHE_NAMESPACE, currentIdentity(), 0)
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

export const useMessageStore = defineStore('message', {
  state: () => ({
    unreadCount: readInitialUnreadCount()
  }),

  actions: {
    updateBadge() {
      // The project uses a custom tab bar, whose badge reads this store directly.
      uni.$emit('message-unread-changed', this.unreadCount)
    },

    persistUnreadCount() {
      setScopedCache(UNREAD_CACHE_NAMESPACE, currentIdentity(), this.unreadCount)
    },

    async fetchUnreadCount() {
      try {
        const response = await getUnreadCount()
        this.unreadCount = Number(response.count) || 0
        this.persistUnreadCount()
        this.updateBadge()
        return this.unreadCount
      } catch (error) {
        console.error('获取未读消息数量失败:', error)
        return 0
      }
    },

    decreaseUnreadCount(count = 1) {
      this.unreadCount = Math.max(0, this.unreadCount - count)
      this.persistUnreadCount()
      this.updateBadge()
    },

    clearUnreadCount() {
      this.unreadCount = 0
      this.persistUnreadCount()
      this.updateBadge()
    },

    resetContext() {
      this.unreadCount = 0
      uni.$emit('message-unread-changed', 0)
    }
  }
})
