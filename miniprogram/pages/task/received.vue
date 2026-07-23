<template>
  <view class="task-received-container">
    <!-- Tab切换 -->
    <view class="tabs">
      <view
        v-for="(tab, index) in tabs"
        :key="index"
        class="tab-item"
        :class="{ active: activeTab === tab.type }"
        @click="switchTab(tab.type)"
      >
        <text>{{ tab.label }}</text>
      </view>
    </view>

    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input-wrapper">
        <text class="search-icon">🔍</text>
        <input
          class="search-input"
          v-model="keyword"
          placeholder="搜索任务名称"
          @confirm="handleSearch"
        />
        <text v-if="keyword" class="clear-icon" @click="clearSearch">✕</text>
      </view>
      <button class="search-btn" @click="handleSearch">搜索</button>
    </view>

    <view style="padding: 0px 24rpx;">
      <!-- 任务列表 -->
      <scroll-view
        class="task-list"
        scroll-y
        @scrolltolower="loadMore"
        :refresher-enabled="true"
        :refresher-triggered="refreshing"
        @refresherrefresh="onRefresh"
      >
        <view v-if="taskList.length > 0">
          <view
            v-for="task in taskList"
            :key="task._id"
            class="task-card"
            @click="goToDetail(task)"
          >
            <!-- 任务标题 -->
            <view class="task-header">
              <text class="task-name">{{ task.taskName }}</text>
              <view
                class="task-priority"
                :style="{ backgroundColor: getPriorityColor(task.priority) }"
              >
                <text>{{ getPriorityText(task.priority) }}</text>
              </view>
            </view>

            <!-- 任务信息 -->
            <view class="task-info">
              <view class="info-item">
                <text class="label">类型:</text>
                <text class="value">{{ task.taskType }}</text>
              </view>
              <view class="info-item">
                <text class="label">来源:</text>
                <text class="value">{{ task.taskSource }}</text>
              </view>
            </view>

            <!-- 任务描述 -->
            <view v-if="task.description" class="task-desc">
              <text>{{ task.description }}</text>
            </view>

            <!-- 任务时间 -->
            <view class="task-time" :class="{ 'overdue': isTaskOverdue(task.plannedCompletionTime, task.status) }">
              <text class="time-label">⏰ 计划完成:</text>
              <text class="time-value">{{
                formatDate(task.plannedCompletionTime, "YYYY-MM-DD HH:mm")
              }}</text>
            </view>

            <!-- 任务状态 -->
            <view class="task-footer">
              <view
                class="task-status"
                :style="{ backgroundColor: isTaskOverdue(task.plannedCompletionTime, task.status) ? '#F56C6C' : getStatusColor(task.status) }"
              >
                <text>{{ isTaskOverdue(task.plannedCompletionTime, task.status) ? '已过期' : getStatusText(task.status) }}</text>
              </view>
              <text class="task-creator"
                >创建人: {{ task.creator?.name || "未知" }}</text
              >
            </view>
          </view>
        </view>

        <!-- 空状态 -->
        <view v-else-if="!loading" class="empty-state">
          <text class="empty-text">暂无任务</text>
        </view>

        <!-- 加载更多 -->
        <view v-if="hasMore" class="load-more">
          <text>{{ loading ? "加载中..." : "上拉加载更多" }}</text>
        </view>

        <view v-else-if="taskList.length > 0" class="load-more">
          <text>没有更多了</text>
        </view>
      </scroll-view>
    </view>
    <CustomTabbar />
  </view>
</template>

<script>
import { ref, onMounted, onUnmounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { getMyTasks } from "@/api/index.js";
import { useUserStore } from "@/stores/user.js";
import { taskDetailUrl } from "@/utils/taskPolicy.js";
import { createLatestRequestGate } from "@/utils/latestRequest.js";
import { useMessageStore } from "@/stores/message.js";
import CustomTabbar from "@/components/custom-tab-bar/CustomTabBar.vue";
import {
  formatDate,
  getTaskStatusText,
  getTaskStatusColor,
  getPriorityText,
  getPriorityColor,
  isTaskOverdue,
} from "@/utils/format.js";

export default {
  name: "TaskReceived",
  components: {
    CustomTabbar
  },
  setup() {
    const userStore = useUserStore();
    const messageStore = useMessageStore();

    const tabs = [
      { label: "我执行的", type: "executor" },
      { label: "抄送我的", type: "cc" },
      { label: "我创建的", type: "created" },
    ];

    const activeTab = ref("executor");
    const keyword = ref("");
    const taskList = ref([]);
    const loading = ref(false);
    const refreshing = ref(false);
    const page = ref(1);
    const limit = ref(10);
    const hasMore = ref(true);
    const requestGate = createLatestRequestGate();

    // 页面显示时触发
    onShow(() => {
      // 通知 TabBar 更新选中状态
      uni.$emit('tabbar-update');
    });

    onMounted(() => {
      loadTasks();
      // 刷新未读消息数量
      messageStore.fetchUnreadCount();
    });

    // 切换Tab
    const switchTab = (type) => {
      if (activeTab.value === type) return;

      activeTab.value = type;
      page.value = 1;
      taskList.value = [];
      hasMore.value = true;
      loadTasks();
    };

    // 加载任务列表
    const loadTasks = async ({ append = false } = {}) => {
      const request = requestGate.begin({
        append,
        page: page.value,
        limit: limit.value,
        type: activeTab.value,
        keyword: keyword.value.trim(),
      });
      loading.value = true;

      try {
        const params = {
          type: request.type,
          page: request.page,
          limit: request.limit,
        };

        if (request.keyword) {
          params.keyword = request.keyword;
        }

        const res = await getMyTasks(params);
        if (!requestGate.isCurrent(request)) return;

        if (request.append) {
          taskList.value = [...taskList.value, ...(res.tasks || [])];
        } else {
          taskList.value = res.tasks || [];
        }

        // 判断是否还有更多
        hasMore.value = taskList.value.length < Number(res.total || 0);
      } catch (error) {
        if (requestGate.isCurrent(request)) {
          if (request.append && page.value === request.page) {
            page.value = Math.max(1, request.page - 1);
          }
          console.error("加载任务失败:", error);
        }
      } finally {
        if (requestGate.isCurrent(request)) {
          loading.value = false;
          refreshing.value = false;
        }
      }
    };

    // 搜索
    const handleSearch = () => {
      page.value = 1;
      taskList.value = [];
      hasMore.value = true;
      loadTasks();
    };

    // 清空搜索
    const clearSearch = () => {
      keyword.value = "";
      handleSearch();
    };

    // 下拉刷新
    const onRefresh = () => {
      refreshing.value = true;
      page.value = 1;
      taskList.value = [];
      hasMore.value = true;
      loadTasks();
    };

    // 加载更多
    const loadMore = () => {
      if (loading.value || !hasMore.value) return;

      page.value++;
      loadTasks({ append: true });
    };

    onUnmounted(() => requestGate.invalidate());

    // 跳转到详情页
    const goToDetail = (task) => {
      uni.navigateTo({
        url: taskDetailUrl(task, {
          type: activeTab.value,
          includeTeamId: userStore.isGlobalReadOnly,
        }),
      });
    };

    // 格式化方法
    const getStatusText = (status) => getTaskStatusText(status);
    const getStatusColor = (status) => getTaskStatusColor(status);

    return {
      tabs,
      activeTab,
      keyword,
      taskList,
      loading,
      refreshing,
      hasMore,
      switchTab,
      handleSearch,
      clearSearch,
      onRefresh,
      loadMore,
      goToDetail,
      formatDate,
      getStatusText,
      getStatusColor,
      getPriorityText,
      getPriorityColor,
      isTaskOverdue,
    };
  },
};
</script>

<style scoped lang="scss">
.task-received-container {
  min-height: 100vh;
  background: var(--zl-page-bg, #eef3fb);
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
  padding-bottom: calc(136rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(136rpx + env(safe-area-inset-bottom));
}

.tabs {
  display: flex;
  background: #ffffff;
  border-bottom: 1px solid #e4e7ed;

  .tab-item {
    flex: 1;
    text-align: center;
    padding: 24rpx 0;
    font-size: 28rpx;
    color: #606266;
    position: relative;

    &.active {
      color: var(--zl-primary, #4096ff);
      font-weight: bold;

      &::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 60rpx;
        height: 4rpx;
        background: var(--zl-primary, #4096ff);
        border-radius: 2rpx;
      }
    }
  }
}

.search-bar {
  display: flex;
  align-items: center;
  padding: 24rpx;
  background: #ffffff;
  margin-bottom: 16rpx;

  .search-input-wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    height: var(--zl-control-height, 80rpx);
    background: var(--zl-surface-soft, #f5f8fc);
    border: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18));
    border-radius: var(--zl-control-radius, 20rpx);
    padding: 0 24rpx;
    margin-right: 16rpx;

    .search-icon {
      font-size: 32rpx;
      margin-right: 12rpx;
    }

    .search-input {
      flex: 1;
      min-width: 0;
      height: 78rpx;
      font-size: 28rpx;
    }

    .clear-icon {
      font-size: 28rpx;
      color: #909399;
      padding: 8rpx;
    }
  }

  .search-btn {
    flex: 0 0 120rpx;
    width: 120rpx;
    margin: 0;
    padding: 0;
    height: var(--zl-control-height, 80rpx);
    line-height: var(--zl-control-height, 80rpx);
    background: var(--zl-primary, #4096ff);
    color: #ffffff;
    font-size: 28rpx;
    border-radius: var(--zl-control-radius, 20rpx);
    border: none;

    &::after {
      border: none;
    }
  }
}

.task-list {
  flex: 1;
  // padding: 24rpx;
  box-sizing: border-box;
  width: 100%;
}

.task-card {
  background: #ffffff;
  border-radius: 16rpx;
  padding: 32rpx;
  margin-bottom: 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
  box-sizing: border-box;
  width: 100%;
}

.task-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20rpx;

  .task-name {
    flex: 1;
    font-size: 32rpx;
    font-weight: bold;
    color: #303133;
    margin-right: 16rpx;
  }

  .task-priority {
    padding: 6rpx 16rpx;
    border-radius: 24rpx;
    font-size: 22rpx;
    color: #ffffff;
  }
}

.task-info {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx 24rpx;
  margin-bottom: 20rpx;

  .info-item {
    min-width: 0;
    margin-right: 0;
    font-size: 24rpx;

    .label {
      color: #909399;
      margin-right: 8rpx;
    }

    .value {
      color: #606266;
    }
  }
}

.task-desc {
  font-size: 26rpx;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 20rpx;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.task-time {
  font-size: 24rpx;
  color: #909399;
  margin-bottom: 20rpx;

  .time-label {
    margin-right: 8rpx;
  }
  
  &.overdue {
    color: #F56C6C;
    
    .time-value {
      font-weight: bold;
    }
  }
}

.task-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16rpx;

  .task-status {
    flex-shrink: 0;
    padding: 6rpx 16rpx;
    border-radius: 24rpx;
    font-size: 22rpx;
    color: #ffffff;
  }

  .task-creator {
    min-width: 0;
    text-align: right;
    word-break: break-all;
    font-size: 24rpx;
    color: #909399;
  }
}

.empty-state {
  text-align: center;
  padding: 120rpx 0;

  .empty-text {
    display: block;
    font-size: 28rpx;
    color: #909399;
  }
}

.load-more {
  text-align: center;
  padding: 32rpx 0;
  font-size: 24rpx;
  color: #909399;
}
</style>
