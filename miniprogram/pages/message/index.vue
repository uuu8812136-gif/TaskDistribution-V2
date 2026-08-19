<template>
  <view class="message-container">
    <!-- 操作栏 -->
    <view v-if="showActionBar" class="action-bar">
      <button
        v-if="wechatNotificationsEnabled"
        class="action-btn action-btn--wechat"
        :loading="wechatSubscriptionPending"
        :disabled="wechatSubscriptionPending"
        @click="enableWechatNotifications"
      >微信提醒</button>
      <button v-if="canWriteMessages" class="action-btn" @click="markAllRead">全部已读</button>
      <button v-if="canWriteMessages" class="action-btn" @click="clearRead">清空已读</button>
    </view>

    <view style="padding: 0px 24rpx">
      <!-- 消息列表 -->
      <scroll-view
        class="message-list"
        scroll-y
        @scrolltolower="loadMore"
        :refresher-enabled="true"
        :refresher-triggered="refreshing"
        @refresherrefresh="onRefresh"
      >
        <view v-if="messages.length > 0">
          <view
            v-for="msg in messages"
            :key="msg._id"
            class="message-item"
            :class="{ unread: !msg.isRead }"
            @click="handleMessageClick(msg)"
          >
            <view class="message-header">
              <view class="message-type">
                <text class="type-icon">{{ getTypeIcon(msg.type) }}</text>
                <text class="type-text">{{ getTypeText(msg.type) }}</text>
              </view>
              <view v-if="!msg.isRead" class="unread-badge"></view>
            </view>

            <text class="message-title">{{ msg.title }}</text>
            <text class="message-content">{{ msg.content }}</text>

            <view class="message-footer">
              <text class="message-time">{{
                formatRelativeTime(msg.createdAt)
              }}</text>
              <text v-if="canWriteMessages" class="message-delete" @click.stop="handleDelete(msg._id)"
                >删除</text
              >
            </view>
          </view>
        </view>

        <!-- 空状态 -->
        <view v-else-if="!loading" class="empty-state">
          <text class="empty-text">暂无消息</text>
        </view>

        <!-- 加载更多 -->
        <view v-if="hasMore" class="load-more">
          <text>{{ loading ? "加载中..." : "上拉加载更多" }}</text>
        </view>

        <view v-else-if="messages.length > 0" class="load-more">
          <text>没有更多了</text>
        </view>
      </scroll-view>
    </view>

    <!-- 自定义 TabBar -->
    <CustomTabbar />
  </view>
</template>

<script>
import { ref, computed, onUnmounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import {
  getMessages,
  markMessageRead,
  markAllRead as apiMarkAllRead,
  deleteMessage,
  clearReadMessages,
} from "@/api/index.js";
import { useMessageStore } from "@/stores/message.js";
import { useUserStore } from "@/stores/user.js";
import { formatRelativeTime, getMessageTypeText } from "@/utils/format.js";
import { messageResourceUrl } from "@/utils/messageNavigation.js";
import { createLatestRequestGate } from "@/utils/latestRequest.js";
import {
  loadWechatServiceNotificationState,
  requestWechatServiceNotificationSubscription,
} from "@/utils/wechatServiceNotifications.js";
import CustomTabbar from "@/components/custom-tab-bar/CustomTabBar.vue";

export default {
  name: "MessageIndex",
  components: {
    CustomTabbar,
  },
  setup() {
    const messageStore = useMessageStore();
    const userStore = useUserStore();
    const canWriteMessages = computed(() => userStore.isTeamMode && !userStore.isReadOnly);
    const wechatNotificationState = ref({ enabled: false, remainingCount: 0 });
    const wechatSubscriptionPending = ref(false);
    const wechatNotificationsEnabled = computed(() => wechatNotificationState.value.enabled === true);
    const showActionBar = computed(() => canWriteMessages.value || wechatNotificationsEnabled.value);

    const messages = ref([]);
    const loading = ref(false);
    const refreshing = ref(false);
    const page = ref(1);
    const limit = ref(20);
    const hasMore = ref(true);
    const requestGate = createLatestRequestGate();
    const pendingMessageClicks = new Set();

    onUnmounted(() => requestGate.invalidate());

    // 加载消息列表
    const loadMessages = async () => {
      const request = requestGate.begin({ page: page.value });
      loading.value = true;

      try {
        const params = {
          page: request.page,
          limit: limit.value,
        };

        const res = await getMessages(params);
        if (!requestGate.isCurrent(request)) return;

        if (request.page === 1) {
          messages.value = res.messages || [];
        } else {
          messages.value = [...messages.value, ...(res.messages || [])];
        }

        const total = Number(res.pagination?.total ?? res.total ?? 0);
        hasMore.value = messages.value.length < total;
      } catch (error) {
        if (requestGate.isCurrent(request)) {
          if (request.page > 1 && page.value === request.page) page.value = request.page - 1;
          console.error("加载消息失败:", error);
        }
      } finally {
        if (requestGate.isCurrent(request)) {
          loading.value = false;
          refreshing.value = false;
        }
      }
    };

    const refreshVisibleMessages = () => {
      requestGate.invalidate();
      page.value = 1;
      messages.value = [];
      hasMore.value = true;
      loadMessages();
      messageStore.fetchUnreadCount();
    };

    // The page can stay cached while an approval creates a new message.
    onShow(() => {
      uni.$emit("tabbar-update");
      refreshVisibleMessages();
      loadWechatNotificationState();
    });

    const loadWechatNotificationState = async () => {
      try {
        wechatNotificationState.value = await loadWechatServiceNotificationState({ refresh: true });
      } catch (error) {
        console.error("加载微信提醒配置失败:", error);
        wechatNotificationState.value = { enabled: false, remainingCount: 0 };
      }
    };

    const enableWechatNotifications = async () => {
      if (wechatSubscriptionPending.value) return;
      wechatSubscriptionPending.value = true;
      try {
        const result = await requestWechatServiceNotificationSubscription(wechatNotificationState.value);
        if (result.result === "accept") {
          wechatNotificationState.value = {
            ...wechatNotificationState.value,
            bound: true,
            remainingCount: result.remainingCount,
          };
          uni.showToast({ title: "微信提醒已开启", icon: "success" });
        } else if (result.result === "ban") {
          uni.showModal({
            title: "微信提醒未开启",
            content: "请在微信设置中允许接收订阅消息",
            showCancel: false,
          });
        } else {
          uni.showToast({ title: "已取消微信提醒", icon: "none" });
        }
      } catch (error) {
        console.error("开启微信提醒失败:", error);
        uni.showToast({ title: error?.message || "微信提醒开启失败", icon: "none" });
      } finally {
        wechatSubscriptionPending.value = false;
      }
    };

    // 下拉刷新
    const onRefresh = () => {
      refreshing.value = true;
      refreshVisibleMessages();
    };

    // 加载更多
    const loadMore = () => {
      if (loading.value || !hasMore.value) return;

      page.value++;
      loadMessages();
    };

    // 点击消息
    const handleMessageClick = async (msg) => {
      const messageId = String(msg?._id || "");
      if (!messageId || pendingMessageClicks.has(messageId)) return;
      pendingMessageClicks.add(messageId);

      // 标记为已读
      try {
        if (canWriteMessages.value && !msg.isRead) {
          await markMessageRead(msg._id);
          if (!msg.isRead) {
            msg.isRead = true;
            messageStore.decreaseUnreadCount();
          }
        }

        const url = messageResourceUrl(msg, {
          includeTeamId: userStore.isGlobalReadOnly,
        });
        if (url) uni.navigateTo({ url });
      } catch (error) {
        console.error("处理消息失败:", error);
      } finally {
        setTimeout(() => pendingMessageClicks.delete(messageId), 800);
      }
    };

    // 全部已读
    const markAllRead = () => {
      uni.showModal({
        title: "确认",
        content: "确认将所有消息标记为已读？",
        success: async (res) => {
          if (res.confirm) {
            try {
              await apiMarkAllRead();
              uni.showToast({
                title: "操作成功",
                icon: "success",
              });

              // 更新本地数据
              messages.value.forEach((msg) => {
                msg.isRead = true;
              });

              messageStore.clearUnreadCount();
            } catch (error) {
              console.error("全部已读失败:", error);
            }
          }
        },
      });
    };

    // 清空已读
    const clearRead = () => {
      uni.showModal({
        title: "确认",
        content: "确认清空所有已读消息？",
        success: async (res) => {
          if (res.confirm) {
            try {
              await clearReadMessages();
              uni.showToast({
                title: "清空成功",
                icon: "success",
              });

              // 刷新列表
              onRefresh();
            } catch (error) {
              console.error("清空已读失败:", error);
            }
          }
        },
      });
    };

    // 删除消息
    const handleDelete = (id) => {
      uni.showModal({
        title: "确认",
        content: "确认删除该消息？",
        success: async (res) => {
          if (res.confirm) {
            try {
              await deleteMessage(id);
              uni.showToast({
                title: "删除成功",
                icon: "success",
              });

              // 从列表中移除
              const index = messages.value.findIndex((msg) => msg._id === id);
              if (index > -1) {
                const msg = messages.value[index];
                if (!msg.isRead) {
                  messageStore.decreaseUnreadCount();
                }
                messages.value.splice(index, 1);
              }
            } catch (error) {
              console.error("删除消息失败:", error);
            }
          }
        },
      });
    };

    // 获取消息类型图标
    const getTypeIcon = (type) => {
      const iconMap = {
        task_assigned: "📋",
        task_updated: "✏️",
        task_deleted: "🗑",
        task_completed: "✅",
        task_reviewed: "👀",
        task_confirmed: "✓",
        extension_applied: "⏰",
        extension_approved: "👍",
        extension_rejected: "👎",
        task_overdue: "⚠️",
      };
      return iconMap[type] || "📨";
    };

    const getTypeText = (type) => getMessageTypeText(type);

    return {
      messages,
      canWriteMessages,
      showActionBar,
      wechatNotificationsEnabled,
      wechatSubscriptionPending,
      loading,
      refreshing,
      hasMore,
      onRefresh,
      loadMore,
      handleMessageClick,
      markAllRead,
      clearRead,
      handleDelete,
      getTypeIcon,
      getTypeText,
      formatRelativeTime,
      enableWechatNotifications,
    };
  },
};
</script>

<style scoped lang="scss">
.message-container {
  min-height: 100vh;
  background: var(--zl-page-bg, #eef3fb);
  display: flex;
  flex-direction: column;
  padding-bottom: calc(136rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(136rpx + env(safe-area-inset-bottom));
}

.action-bar {
  display: flex;
  padding: 24rpx;
  background: #ffffff;
  margin-bottom: 16rpx;
  gap: 16rpx;

  .action-btn {
    flex: 1;
    height: var(--zl-control-height, 80rpx);
    line-height: var(--zl-control-height, 80rpx);
    margin: 0;
    padding: 0;
    font-size: 26rpx;
    background: var(--zl-surface-soft, #f5f8fc);
    color: var(--zl-muted, #64748b);
    border-radius: var(--zl-control-radius, 20rpx);
    border: none;

    &::after {
      border: none;
    }
  }

  .action-btn--wechat {
    background: #edf9f2;
    color: #16834b;
    border: 2rpx solid #b9e7cc;
  }
}

.message-list {
  flex: 1;
}

.message-item {
  background: #ffffff;
  border-radius: 16rpx;
  padding: 32rpx;
  margin-bottom: 24rpx;
  position: relative;

  &.unread {
    background: #f0f9ff;
    border-left: 6rpx solid var(--zl-primary, #4096ff);
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16rpx;

    .message-type {
      display: flex;
      align-items: center;

      .type-icon {
        font-size: 32rpx;
        margin-right: 12rpx;
      }

      .type-text {
        font-size: 24rpx;
        color: var(--zl-primary, #4096ff);
      }
    }

    .unread-badge {
      width: 16rpx;
      height: 16rpx;
      background: #f56c6c;
      border-radius: 50%;
    }
  }

  .message-title {
    display: block;
    font-size: 30rpx;
    font-weight: bold;
    color: #303133;
    margin-bottom: 12rpx;
  }

  .message-content {
    display: block;
    font-size: 26rpx;
    color: #606266;
    line-height: 1.6;
    margin-bottom: 16rpx;
  }

  .message-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .message-time {
      font-size: 22rpx;
      color: #909399;
    }

    .message-delete {
      font-size: 24rpx;
      color: #f56c6c;
      padding: 8rpx 16rpx;
    }
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
