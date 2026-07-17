<template>
  <view class="custom-tabbar">
    <view class="tabbar-container">
      <view 
        class="tabbar-item"
        v-for="(item, index) in tabbarList"
        :key="'tab-' + index"
        @click="switchTab(index)"
      >
        <view class="tabbar-icon">
          <text 
            class="icon-text"
            :style="{ color: current === index ? '#4096ff' : '#64748b', fontSize: (item.size || 40) + 'rpx' }"
          >
            {{ item.icon }}
          </text>
          <text
            v-if="item.pagePath === '/pages/message/index' && messageStore.unreadCount > 0"
            class="unread-count"
          >{{ messageStore.unreadCount > 99 ? '99+' : messageStore.unreadCount }}</text>
        </view>
        <view 
          class="tabbar-text"
          :style="{ color: current === index ? '#4096ff' : '#64748b' }"
        >
          {{ item.text }}
        </view>
      </view>
    </view>
  </view>
</template>

<script>
import { useMessageStore } from '@/stores/message.js'

export default {
  name: 'CustomTabbar',
  
  data() {
    return {
      tabbarList: [
        {
          text: '我的任务',
          icon: '☰',
          pagePath: '/pages/task/received'
        },
        {
          text: '任务管理',
          icon: '⚙',
          pagePath: '/pages/task/manage',
          size: 48
        },
        {
          text: '工作台',
          icon: '▤',
          pagePath: '/pages/workbench/index',
          size: 46
        },
        {
          text: '消息',
          icon: '✉',
          pagePath: '/pages/message/index',
          size: 48
        },
        {
          text: '我的',
          icon: '👤',
          pagePath: '/pages/profile/index'
        }
      ],
      current: 0,
      tabbarUpdateHandler: null
    }
  },

  setup() {
    return { messageStore: useMessageStore() }
  },
  
  mounted() {
    // 根据当前页面路径设置选中项
    this.updateCurrent()
    
    // 监听页面显示事件
    this.tabbarUpdateHandler = () => {
      this.updateCurrent()
    }
    uni.$on('tabbar-update', this.tabbarUpdateHandler)
  },
  
  beforeUnmount() {
    if (this.tabbarUpdateHandler) {
      uni.$off('tabbar-update', this.tabbarUpdateHandler)
    }
  },
  
  methods: {
    /**
     * 更新当前选中项
     */
    updateCurrent() {
      try {
        const pages = getCurrentPages()
        if (!pages || pages.length === 0) {
          return
        }
        const currentPage = pages[pages.length - 1]
        const route = '/' + currentPage.route
        
        const index = this.tabbarList.findIndex(item => item.pagePath === route)
        if (index !== -1) {
          this.current = index
        }
      } catch (error) {
        console.error('Error in updateCurrent:', error)
      }
    },
    
    /**
     * TabBar 切换
     */
    switchTab(index) {
      // 先更新当前选中项（立即响应点击）
      this.current = index
      
      const item = this.tabbarList[index]
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1]
      const currentRoute = '/' + currentPage.route
      
      // 如果点击的不是当前页面，才切换
      if (item.pagePath !== currentRoute) {
        uni.switchTab({
          url: item.pagePath
        })
      }
    }
  }
}
</script>

<style lang="scss" scoped>
.custom-tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 999;
  background-color: rgba(255, 255, 255, 0.96);
  
  .tabbar-container {
    display: flex;
    align-items: stretch;
    height: calc(112rpx + constant(safe-area-inset-bottom));
    height: calc(112rpx + env(safe-area-inset-bottom));
    box-sizing: border-box;
    background-color: rgba(255, 255, 255, 0.96);
    border-top: 1px solid rgba(100, 116, 139, 0.16);
    box-shadow: 0 -8rpx 28rpx rgba(15, 23, 42, 0.06);
    padding-bottom: constant(safe-area-inset-bottom);
    padding-bottom: env(safe-area-inset-bottom);
    
    .tabbar-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 0;
      padding: 8rpx 0 6rpx;
      
      .tabbar-icon {
		position: relative;
        margin-bottom: 4rpx;
        height: 44rpx;
        
        .icon-text {
          font-size: 32rpx;
          line-height: 1;
          transition: color 0.3s;
        }

		.unread-count {
			position: absolute;
			top: -16rpx;
			left: 30rpx;
			min-width: 28rpx;
			height: 28rpx;
			padding: 0 6rpx;
			box-sizing: border-box;
			border-radius: 14rpx;
			background: #f56c6c;
			color: #ffffff;
			font-size: 18rpx;
			line-height: 28rpx;
			text-align: center;
		}
      }
      
      .tabbar-text {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 23rpx;
        line-height: 30rpx;
        transition: color 0.3s;
      }
    }
  }
}
</style>
