<template>
  <view class="login-container">
    <view class="login-header">
      <!-- <image class="logo" src="/static/logo.png" mode="aspectFit"></image> -->
      <text class="title">Horselink(马链)任务管理系统</text>
      <text class="subtitle"
        >Horselink Task Distribution Management System</text
      >
    </view>

    <view class="login-form">
      <view class="form-item">
        <view class="form-label">
          <text class="icon">👤</text>
          <text>账号</text>
        </view>
        <input
          class="form-input"
          v-model="form.username"
          placeholder="请输入账号"
          :maxlength="20"
        />
      </view>

      <view class="form-item">
        <view class="form-label">
          <text class="icon">🔒</text>
          <text>密码</text>
        </view>
        <input
          class="form-input"
          v-model="form.password"
          type="password"
          placeholder="请输入密码"
          :maxlength="20"
          @confirm="handleLogin"
        />
      </view>

      <view class="form-item-checkbox">
        <checkbox-group @change="handleRememberChange">
          <label>
            <checkbox :checked="rememberPassword" color="#409EFF" />
            <text>记住密码</text>
          </label>
        </checkbox-group>
      </view>

      <button class="login-btn" @click="handleLogin" :loading="loading">
        {{ loading ? "登录中..." : "登录" }}
      </button>
    </view>

    <view class="login-footer">
      <text class="tips" style="display: block;">沟通、协作、持续进步</text>
      <text class="tips" style="display: block;">欢迎你，我的朋友们。</text>
      <text class="tips" style="display: block;">一起见证Horselink成长。</text>
	  <text class="tips" style="display: block;">- 马延浩</text>
    </view>
  </view>
</template>

<script>
import { ref, onMounted } from "vue";
import { login } from "@/api/index.js";
import { useUserStore } from "@/stores/user.js";
import { useMessageStore } from "@/stores/message.js";

export default {
  name: "Login",
  setup() {
    const userStore = useUserStore();
    const messageStore = useMessageStore();

    const form = ref({
      username: "",
      password: "",
    });

    const rememberPassword = ref(false);
    const loading = ref(false);

    // 页面加载时检查是否记住密码
    onMounted(() => {
      // 检查是否自动登录
      checkAutoLogin();

      // 加载保存的账号密码
      const savedUsername = uni.getStorageSync("savedUsername");
      const savedPassword = uni.getStorageSync("savedPassword");
      const remember = uni.getStorageSync("rememberPassword");

      if (remember && savedUsername) {
        form.value.username = savedUsername;
        form.value.password = savedPassword || "";
        rememberPassword.value = true;
      }
    });

    // 检查自动登录
    const checkAutoLogin = () => {
      const token = uni.getStorageSync("token");
      if (token) {
        // 有token，尝试获取用户信息
        userStore
          .fetchUserInfo()
          .then(() => {
            // 成功，跳转到主页
            uni.reLaunch({
              url: "/pages/task/received",
            });
          })
          .catch(() => {
            // token失效，清除
            userStore.logout();
          });
      }
    };

    // 记住密码复选框变化
    const handleRememberChange = (e) => {
      rememberPassword.value = e.detail.value.length > 0;
    };

    // 登录
    const handleLogin = async () => {
      // 表单验证
      if (!form.value.username) {
        uni.showToast({
          title: "请输入账号",
          icon: "none",
        });
        return;
      }

      if (!form.value.password) {
        uni.showToast({
          title: "请输入密码",
          icon: "none",
        });
        return;
      }

      loading.value = true;

      try {
        // 调用登录接口
        const res = await login({
          username: form.value.username,
          password: form.value.password,
        });

        // 保存token和用户信息
        userStore.setToken(res.token);
        userStore.setUserInfo(res.user);

        // 记住密码
        if (rememberPassword.value) {
          uni.setStorageSync("rememberPassword", true);
          uni.setStorageSync("savedUsername", form.value.username);
          uni.setStorageSync("savedPassword", form.value.password);
        } else {
          uni.removeStorageSync("rememberPassword");
          uni.removeStorageSync("savedUsername");
          uni.removeStorageSync("savedPassword");
        }

        // 获取未读消息数量
        messageStore.fetchUnreadCount();

        uni.showToast({
          title: "登录成功",
          icon: "success",
        });

        // 跳转到主页
        setTimeout(() => {
          uni.reLaunch({
            url: "/pages/task/received",
          });
        }, 1000);
      } catch (error) {
        console.error("登录失败:", error);
        // 错误提示已在request.js中处理
      } finally {
        loading.value = false;
      }
    };

    return {
      form,
      rememberPassword,
      loading,
      handleRememberChange,
      handleLogin,
    };
  },
};
</script>

<style scoped lang="scss">
.login-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60rpx 40rpx;
  box-sizing: border-box;
}

.login-header {
  text-align: center;
  margin-bottom: 80rpx;

  .logo {
    width: 160rpx;
    height: 160rpx;
    margin-bottom: 40rpx;
  }

  .title {
    display: block;
    font-size: 48rpx;
    font-weight: bold;
    color: #ffffff;
    margin-bottom: 16rpx;
  }

  .subtitle {
    display: block;
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.8);
  }
}

.login-form {
  width: 100%;
  max-width: 600rpx;
  background: #ffffff;
  border-radius: 24rpx;
  padding: 60rpx 40rpx;
  box-shadow: 0 8rpx 32rpx rgba(0, 0, 0, 0.1);
  box-sizing: border-box;

  .form-item {
    margin-bottom: 40rpx;

    .form-label {
      display: flex;
      align-items: center;
      margin-bottom: 16rpx;
      font-size: 28rpx;
      color: #303133;

      .icon {
        margin-right: 8rpx;
        font-size: 32rpx;
      }
    }

    .form-input {
      width: 100%;
      height: 88rpx;
      padding: 0 24rpx;
      background: #f5f7fa;
      border-radius: 12rpx;
      font-size: 28rpx;
      color: #303133;
      box-sizing: border-box;
    }
  }

  .form-item-checkbox {
    margin-bottom: 40rpx;

    label {
      display: flex;
      align-items: center;
      font-size: 26rpx;
      color: #606266;

      checkbox {
        margin-right: 12rpx;
      }
    }
  }

  .login-btn {
    width: 100%;
    height: 88rpx;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #ffffff;
    font-size: 32rpx;
    font-weight: bold;
    border-radius: 12rpx;
    border: none;

    &::after {
      border: none;
    }
  }
}

.login-footer {
  margin-top: 60rpx;
  text-align: center;

  .tips {
    font-size: 24rpx;
    color: rgba(255, 255, 255, 0.8);
  }
}
</style>
