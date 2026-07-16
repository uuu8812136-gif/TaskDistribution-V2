<template>
  <view class="approve-extension-page">
    <!-- 顶部导航 -->
    <view class="page-header">
      <view class="header-back" @click="goBack">
        <text>←</text>
      </view>
      <text class="header-title">审批延期申请</text>
      <view class="header-placeholder"></view>
    </view>

    <view style="padding: 24rpx;">
      <scroll-view class="page-content" scroll-y>
        <!-- 延期申请信息 -->
        <view class="section">
          <text class="section-title">申请信息</text>

          <view class="info-card">
            <view class="info-row">
              <text class="label">任务名称</text>
              <text class="value">{{ extensionData.task?.taskName }}</text>
            </view>

            <view class="info-row">
              <text class="label">申请人</text>
              <text class="value">{{ extensionData.applicant?.name }}</text>
            </view>

            <view class="info-row">
              <text class="label">申请时间</text>
              <text class="value">{{
                formatDate(extensionData.applyTime, "YYYY-MM-DD HH:mm")
              }}</text>
            </view>

            <view class="info-row">
              <text class="label">原完成时间</text>
              <text class="value">{{
                formatDate(
                  extensionData.originalCompletionTime,
                  "YYYY-MM-DD HH:mm"
                )
              }}</text>
            </view>

            <view class="info-row">
              <text class="label">请求延期</text>
              <text class="value highlight"
                >{{ extensionData.requestedDays }} 天</text
              >
            </view>

            <view class="info-row">
              <text class="label">延期理由</text>
              <text class="value reason">{{ extensionData.reason }}</text>
            </view>
          </view>
        </view>

        <!-- 审批表单 -->
        <view class="section">
          <text class="section-title">审批决定</text>

          <view class="radio-group">
            <view
              class="radio-item"
              :class="{ active: form.status === 'approved' }"
              @click="form.status = 'approved'"
            >
              <view class="radio-icon">
                <text v-if="form.status === 'approved'">✓</text>
              </view>
              <text class="radio-label success">同意延期</text>
            </view>

            <view
              class="radio-item"
              :class="{ active: form.status === 'rejected' }"
              @click="form.status = 'rejected'"
            >
              <view class="radio-icon">
                <text v-if="form.status === 'rejected'">✓</text>
              </view>
              <text class="radio-label danger">拒绝延期</text>
            </view>
          </view>

          <!-- 同意时显示：批准天数 -->
          <view v-if="form.status === 'approved'" class="form-item">
            <text class="form-label">批准延期天数</text>
            <input
              class="form-input"
              type="number"
              v-model.number="form.approvedDays"
              placeholder="请输入批准的延期天数"
            />
            <text class="form-hint"
              >申请延期 {{ extensionData.requestedDays }} 天</text
            >
          </view>

          <!-- 审批意见 -->
          <view class="form-item">
            <text class="form-label"
              >审批意见 <text class="required">*</text></text
            >
            <textarea
              class="form-textarea"
              v-model="form.approvalNote"
              :placeholder="
                form.status === 'approved'
                  ? '请填写同意理由...'
                  : '请填写拒绝理由...'
              "
              :maxlength="500"
            ></textarea>
            <text class="char-count">{{ form.approvalNote.length }}/500</text>
          </view>
        </view>

        <!-- 底部占位 -->
        <view class="bottom-placeholder"></view>
      </scroll-view>
    </view>

    <!-- 底部操作栏 -->
    <view class="action-bar">
      <button class="action-btn cancel" @click="goBack">取消</button>
      <button class="action-btn confirm" @click="handleSubmit">提交审批</button>
    </view>
  </view>
</template>

<script>
import { ref, reactive, onMounted } from "vue";
import { formatDate } from "@/utils/format.js";
import { approveExtension } from "@/api/index.js";
import { useUserStore } from "@/stores/user.js";

export default {
  name: "ApproveExtension",
  setup() {
    const userStore = useUserStore();
    const extensionData = ref({});
    const taskId = ref("");

    const form = reactive({
      status: "approved", // 默认选中同意
      approvedDays: 0,
      approvalNote: "",
    });

    onMounted(() => {
      if (!userStore.can('task.review', { write: true, teamRequired: true })) {
        uni.showToast({ title: '无权限执行该操作', icon: 'none' });
        setTimeout(() => uni.navigateBack(), 300);
        return;
      }
      // 从URL参数获取延期申请数据
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      const options = currentPage.options;

      if (options.data) {
        try {
          extensionData.value = JSON.parse(decodeURIComponent(options.data));
          form.approvedDays = extensionData.value.requestedDays || 1;
          taskId.value = options.taskId || "";
          console.log("延期申请数据:", extensionData.value);
        } catch (error) {
          console.error("解析延期申请数据失败:", error);
          uni.showToast({
            title: "数据加载失败",
            icon: "none",
          });
          setTimeout(() => {
            uni.navigateBack();
          }, 1500);
        }
      }
    });

    // 返回上一页
    const goBack = () => {
      uni.navigateBack();
    };

    // 提交审批
    const handleSubmit = async () => {
      // 验证
      if (!form.status) {
        uni.showToast({
          title: "请选择审批结果",
          icon: "none",
        });
        return;
      }

      if (!form.approvalNote || form.approvalNote.trim() === "") {
        uni.showToast({
          title: "请填写审批意见",
          icon: "none",
        });
        return;
      }

      if (form.status === "approved") {
        if (!form.approvedDays || form.approvedDays < 1) {
          uni.showToast({
            title: "延期天数至少为1天",
            icon: "none",
          });
          return;
        }
      }

      // 提交审批
      uni.showLoading({ title: "提交中..." });

      try {
        await approveExtension(extensionData.value._id, {
          status: form.status,
          approvedDays:
            form.status === "approved" ? form.approvedDays : undefined,
          approvalNote: form.approvalNote.trim(),
        });

        uni.hideLoading();
        uni.showToast({
          title: "审批成功",
          icon: "success",
        });

        // 延迟返回，让用户看到成功提示
        setTimeout(() => {
          uni.navigateBack();
        }, 1500);
      } catch (error) {
        uni.hideLoading();
        console.error("审批失败:", error);
        uni.showToast({
          title: error.message || "审批失败",
          icon: "none",
        });
      }
    };

    return {
      extensionData,
      form,
      goBack,
      handleSubmit,
      formatDate,
    };
  },
};
</script>

<style scoped lang="scss">
.approve-extension-page {
  min-height: 100vh;
  background: var(--zl-page-bg, #eef3fb);
  display: flex;
  flex-direction: column;
}

.page-header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: calc(88rpx + var(--status-bar-height));
  padding: calc(14rpx + var(--status-bar-height)) 24rpx 14rpx;
  box-sizing: border-box;
  background: #ffffff;
  border-bottom: 1px solid #ebeef5;

  .header-back {
    width: 60rpx;
    height: 60rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 40rpx;
    color: #303133;
  }

  .header-title {
    flex: 1;
    text-align: center;
    font-size: 32rpx;
    font-weight: bold;
    color: #303133;
  }

  .header-placeholder {
    width: 60rpx;
  }
}

.page-content {
  flex: 1;
  padding-bottom: calc(144rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(144rpx + env(safe-area-inset-bottom));
}

.section {
  margin-bottom: 32rpx;

  &:last-child {
    margin-bottom: 0;
  }

  .section-title {
    display: block;
    font-size: 28rpx;
    font-weight: bold;
    color: #303133;
    margin-bottom: 20rpx;
  }
}

.info-card {
  background: #ffffff;
  border-radius: 12rpx;
  padding: 24rpx;

  .info-row {
    display: flex;
    padding: 16rpx 0;
    border-bottom: 1px solid #f5f7fa;

    &:last-child {
      border-bottom: none;
    }

    .label {
      width: 180rpx;
      font-size: 26rpx;
      color: #909399;
    }

    .value {
      flex: 1;
      font-size: 26rpx;
      color: #606266;

      &.highlight {
        color: var(--zl-primary, #4096ff);
        font-weight: bold;
        font-size: 30rpx;
      }

      &.reason {
        line-height: 1.6;
      }
    }
  }
}

.radio-group {
  display: flex;
  gap: 24rpx;
  margin-bottom: 24rpx;

  .radio-item {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24rpx;
    background: #ffffff;
    border-radius: 8rpx;
    border: 2px solid #dcdfe6;
    transition: all 0.3s;

    &.active {
      background: #fff;
      border-color: var(--zl-primary, #4096ff);
      box-shadow: 0 2rpx 12rpx rgba(64, 158, 255, 0.2);
    }

    .radio-icon {
      width: 36rpx;
      height: 36rpx;
      border: 2px solid #dcdfe6;
      border-radius: 50%;
      margin-right: 12rpx;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20rpx;
      color: #fff;
      transition: all 0.3s;
    }

    &.active .radio-icon {
      background: var(--zl-primary, #4096ff);
      border-color: var(--zl-primary, #4096ff);
    }

    .radio-label {
      font-size: 28rpx;
      font-weight: 500;

      &.success {
        color: #67c23a;
      }

      &.danger {
        color: #f56c6c;
      }
    }
  }
}

.form-item {
  margin-bottom: 24rpx;

  .form-label {
    display: block;
    font-size: 26rpx;
    color: #606266;
    margin-bottom: 12rpx;

    .required {
      color: #f56c6c;
    }
  }

  .form-input {
    padding: 16rpx;
    background: #ffffff;
    border-radius: 8rpx;
    font-size: 28rpx;
    color: #303133;
    border: 1px solid #dcdfe6;
  }

  .form-hint {
    display: block;
    font-size: 22rpx;
    color: #909399;
    margin-top: 8rpx;
  }

  .form-textarea {
    width: 95%;
    min-height: 180rpx;
    padding: 16rpx;
    background: #ffffff;
    border-radius: 8rpx;
    font-size: 28rpx;
    color: #303133;
    line-height: 1.6;
    border: 1px solid #dcdfe6;
  }

  .char-count {
    display: block;
    text-align: right;
    font-size: 22rpx;
    color: #c0c4cc;
    margin-top: 8rpx;
  }
}

.bottom-placeholder {
  height: 40rpx;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  padding: 16rpx 24rpx calc(16rpx + constant(safe-area-inset-bottom));
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  background: rgba(255, 255, 255, 0.97);
  border-top: 1px solid var(--zl-border, rgba(100, 116, 139, 0.18));
  box-shadow: 0 -8rpx 28rpx rgba(15, 23, 42, 0.06);
  z-index: 100;

  .action-btn {
    flex: 1;
    height: var(--zl-control-height, 80rpx);
    line-height: var(--zl-control-height, 80rpx);
    margin: 0;
    padding: 0;
    font-size: 28rpx;
    border-radius: var(--zl-control-radius, 20rpx);
    border: none;

    &::after {
      border: none;
    }

    &.cancel {
      background: #f5f7fa;
      color: #606266;
      margin-right: 16rpx;
    }

    &.confirm {
      background: var(--zl-primary, #4096ff);
      color: #ffffff;
    }
  }
}
</style>
