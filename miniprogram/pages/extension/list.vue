<template>
  <view class="extension-list-container">
    <!-- 筛选栏 -->
    <view class="filter-bar">
      <picker
        mode="selector"
        :range="statusOptions"
        range-key="label"
        @change="onStatusChange"
      >
        <view class="filter-item">
          <text>{{ currentStatus.label }}</text>
          <text class="arrow">▼</text>
        </view>
      </picker>
    </view>

    <view style="padding: 0px 24rpx">
      <!-- 列表 -->
      <scroll-view
        class="extension-list"
        scroll-y
        @scrolltolower="loadMore"
        :refresher-enabled="true"
        :refresher-triggered="refreshing"
        @refresherrefresh="onRefresh"
      >
        <view v-if="list.length > 0">
          <view v-for="ext in list" :key="ext._id" class="extension-card">
            <view class="card-header">
              <view class="header-left">
                <text class="task-name">{{ ext.task?.taskName }}</text>
                <text class="applicant">申请人: {{ ext.applicant?.name }}</text>
              </view>
              <view
                class="status"
                :style="{ backgroundColor: getStatusColor(ext.status) }"
              >
                <text>{{ getStatusText(ext.status) }}</text>
              </view>
            </view>

            <view class="card-body">
              <view class="info-item">
                <text class="label">请求天数:</text>
                <text class="value">{{ ext.requestedDays }} 天</text>
              </view>
              <view class="info-item">
                <text class="label">原完成时间:</text>
                <text class="value">{{
                  formatDate(ext.originalCompletionTime, "YYYY-MM-DD HH:mm")
                }}</text>
              </view>
              <view v-if="ext.newCompletionTime" class="info-item">
                <text class="label">新完成时间:</text>
                <text class="value">{{
                  formatDate(ext.newCompletionTime, "YYYY-MM-DD HH:mm")
                }}</text>
              </view>
              <view class="info-item">
                <text class="label">延期理由:</text>
                <text class="value">{{ ext.reason }}</text>
              </view>
              <view class="info-item">
                <text class="label">申请时间:</text>
                <text class="value">{{
                  formatDate(ext.applyTime, "YYYY-MM-DD HH:mm")
                }}</text>
              </view>
              <view v-if="ext.approvalNote" class="info-item">
                <text class="label">审批备注:</text>
                <text class="value">{{ ext.approvalNote }}</text>
              </view>
            </view>

            <view v-if="canApproveRequest(ext)" class="card-footer">
              <button
                class="action-btn reject"
                :disabled="approvingId === ext._id"
                :loading="approvingId === ext._id"
                @click="handleApprove(ext, false)"
              >
                拒绝
              </button>
              <button
                class="action-btn approve"
                :disabled="approvingId === ext._id"
                :loading="approvingId === ext._id"
                @click="handleApprove(ext, true)"
              >
                通过
              </button>
            </view>
          </view>
        </view>

        <!-- 空状态 -->
        <view v-else-if="!loading" class="empty-state">
          <text class="empty-text">暂无延期申请</text>
        </view>

        <!-- 加载更多 -->
        <view v-if="hasMore" class="load-more">
          <text>{{ loading ? "加载中..." : "上拉加载更多" }}</text>
        </view>

        <view v-else-if="list.length > 0" class="load-more">
          <text>没有更多了</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<script>
import { ref, onMounted, onUnmounted } from "vue";
import { getExtensions, approveExtension } from "@/api/index.js";
import { useUserStore } from "@/stores/user.js";
import { canApproveExtensionRequest } from "@/utils/taskPolicy.js";
import { createLatestRequestGate } from "@/utils/latestRequest.js";
import {
  formatDate,
  getExtensionStatusText,
  getExtensionStatusColor,
} from "@/utils/format.js";

export default {
  name: "ExtensionList",
  setup() {
    const userStore = useUserStore();
    const canApproveRequest = (request) => canApproveExtensionRequest({
      request,
      userId: userStore.userInfo?._id,
      isTeamMode: userStore.isTeamMode,
      isReadOnly: userStore.isReadOnly,
      hasReviewPermission: userStore.can('task.review', { write: true, teamRequired: true }),
      isSuperAdmin: userStore.isSuperAdmin,
      membershipRole: userStore.context?.membership?.role
    });

    const statusOptions = [
      { label: "全部状态", value: "" },
      { label: "待审批", value: "pending" },
      { label: "已通过", value: "approved" },
      { label: "已拒绝", value: "rejected" },
    ];

    const currentStatus = ref(statusOptions[1]); // 默认显示待审批
    const list = ref([]);
    const loading = ref(false);
    const refreshing = ref(false);
    const page = ref(1);
    const limit = ref(10);
    const hasMore = ref(true);
    const approvingId = ref('');
    const requestGate = createLatestRequestGate();

    onMounted(() => {
      if (!userStore.can('task.view')) {
        uni.showToast({
          title: "无权限访问",
          icon: "none",
          duration: 2000,
        });
        setTimeout(() => {
          uni.navigateBack();
        }, 2000);
        return;
      }

      loadList();
    });

    // 状态筛选变化
    const onStatusChange = (e) => {
      const index = e.detail.value;
      currentStatus.value = statusOptions[index];
      page.value = 1;
      list.value = [];
      hasMore.value = true;
      loadList();
    };

    // 加载列表
    const loadList = async ({ append = false } = {}) => {
      const request = requestGate.begin({
        append,
        page: page.value,
        limit: limit.value,
        status: currentStatus.value.value,
      });
      loading.value = true;

      try {
        const params = {
          page: request.page,
          limit: request.limit,
        };

        if (request.status) {
          params.status = request.status;
        }

        const res = await getExtensions(params);
        if (!requestGate.isCurrent(request)) return;

        if (request.append) {
          list.value = [...list.value, ...(res.requests || [])];
        } else {
          list.value = res.requests || [];
        }

        hasMore.value = list.value.length < Number(res.total || 0);
      } catch (error) {
        if (requestGate.isCurrent(request)) {
          if (request.append && page.value === request.page) {
            page.value = Math.max(1, request.page - 1);
          }
          console.error("加载延期申请失败:", error);
        }
      } finally {
        if (requestGate.isCurrent(request)) {
          loading.value = false;
          refreshing.value = false;
        }
      }
    };

    // 下拉刷新
    const onRefresh = () => {
      refreshing.value = true;
      page.value = 1;
      list.value = [];
      hasMore.value = true;
      loadList();
    };

    // 加载更多
    const loadMore = () => {
      if (loading.value || !hasMore.value) return;

      page.value++;
      loadList({ append: true });
    };

    onUnmounted(() => requestGate.invalidate());

    // 审批延期申请
    const handleApprove = async (ext, approved) => {
      if (!canApproveRequest(ext) || approvingId.value) {
        uni.showToast({ title: '当前申请不可审批', icon: 'none' });
        return;
      }
      const title = approved ? "通过延期申请" : "拒绝延期申请";
      const content = approved
        ? "确认通过该延期申请？"
        : "确认拒绝该延期申请？";

      // 如果是批准，需要让用户输入批准的延期天数
      if (approved) {
        uni.showModal({
          title: '批准延期申请',
          editable: true,
          placeholderText: ext.requestedDays.toString(),
          content: `申请延期${ext.requestedDays}天，请输入实际批准的延期天数`,
          success: async (res) => {
            if (res.confirm) {
              const approvedDays = parseInt(res.content) || ext.requestedDays;
              
              if (approvedDays < 1) {
                uni.showToast({
                  title: '延期天数至少为1天',
                  icon: 'none'
                });
                return;
              }
              
              try {
                approvingId.value = ext._id;
                await approveExtension(ext._id, {
                  status: 'approved',
                  approvedDays: approvedDays,
                  approvalNote: ''
                });
                
                uni.showToast({
                  title: "操作成功",
                  icon: "success",
                });

                // 刷新列表
                onRefresh();
              } catch (error) {
                console.error("审批失败:", error);
              } finally {
                approvingId.value = '';
              }
            }
          }
        });
      } else {
        // 拒绝审批
        uni.showModal({
          title,
          content,
          success: async (res) => {
            if (res.confirm) {
              try {
                approvingId.value = ext._id;
                await approveExtension(ext._id, {
                  status: 'rejected',
                  approvalNote: ''
                });
                
                uni.showToast({
                  title: "操作成功",
                  icon: "success",
                });

                // 刷新列表
                onRefresh();
              } catch (error) {
                console.error("审批失败:", error);
              } finally {
                approvingId.value = '';
              }
            }
          },
        });
      }
    };

    const getStatusText = (status) => getExtensionStatusText(status);
    const getStatusColor = (status) => getExtensionStatusColor(status);

    return {
      statusOptions,
      currentStatus,
      list,
      loading,
      refreshing,
      hasMore,
      canApproveRequest,
      approvingId,
      onStatusChange,
      onRefresh,
      loadMore,
      handleApprove,
      formatDate,
      getStatusText,
      getStatusColor,
    };
  },
};
</script>

<style scoped lang="scss">
.extension-list-container {
  min-height: 100vh;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
}

.filter-bar {
  background: #ffffff;
  padding: 24rpx;

  .filter-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 24rpx;
    height: 64rpx;
    background: #f5f7fa;
    border-radius: 32rpx;
    font-size: 26rpx;
    color: #606266;

    .arrow {
      font-size: 20rpx;
      color: #909399;
    }
  }
}

.extension-list {
  flex: 1;
}

.extension-card {
  background: #ffffff;
  border-radius: 16rpx;
  padding: 32rpx;
  margin-bottom: 24rpx;

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 24rpx;
    padding-bottom: 20rpx;
    border-bottom: 1px solid #ebeef5;

    .header-left {
      flex: 1;

      .task-name {
        display: block;
        font-size: 32rpx;
        font-weight: bold;
        color: #303133;
        margin-bottom: 12rpx;
      }

      .applicant {
        display: block;
        font-size: 24rpx;
        color: #909399;
      }
    }

    .status {
      padding: 6rpx 16rpx;
      border-radius: 24rpx;
      font-size: 22rpx;
      color: #ffffff;
    }
  }

  .card-body {
    .info-item {
      display: flex;
      margin-bottom: 16rpx;
      font-size: 26rpx;

      &:last-child {
        margin-bottom: 0;
      }

      .label {
        min-width: 200rpx;
        color: #909399;
      }

      .value {
        flex: 1;
        color: #606266;
      }
    }
  }

  .card-footer {
    display: flex;
    margin-top: 24rpx;
    padding-top: 20rpx;
    border-top: 1px solid #ebeef5;

    .action-btn {
      flex: 1;
      height: 64rpx;
      line-height: 64rpx;
      font-size: 28rpx;
      border-radius: 8rpx;
      border: none;

      &::after {
        border: none;
      }

      &.reject {
        background: #f56c6c;
        color: #ffffff;
        margin-right: 16rpx;
      }

      &.approve {
        background: #67c23a;
        color: #ffffff;
      }
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
