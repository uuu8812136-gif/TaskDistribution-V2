<template>
  <view class="login-container">
    <view class="login-header">
      <!-- <image class="logo" src="/static/logo.png" mode="aspectFit"></image> -->
      <text class="title">Horselink（马链）管理系统</text>
      <text class="subtitle">Horselink Management System</text>
    </view>

    <view class="login-form">
      <view class="form-item">
        <view class="form-label">
          <text class="icon">🏢</text>
          <text>项目团队</text>
        </view>

        <view v-if="teamsLoading" class="team-state-box">
          <text class="team-state-text">正在加载项目团队...</text>
        </view>
        <view v-else-if="teamsError" class="team-state-box team-state-box--error">
          <text class="team-state-text">{{ teamsError }}</text>
          <button class="retry-button" :disabled="teamsLoading" @click="loadLoginTeams">
            重新加载
          </button>
        </view>
        <view v-else-if="loginTeams.length === 0" class="team-state-box">
          <text class="team-state-text">暂无可登录的项目团队，请联系超级管理员</text>
        </view>
        <picker
          v-else
          mode="selector"
          range-key="name"
          :range="loginTeams"
          :value="selectedTeamIndex"
          :disabled="loading"
          @change="handleTeamChange"
        >
          <view class="team-picker">
            <text class="team-picker-value">{{ selectedTeamName || "请选择项目团队" }}</text>
            <text class="team-picker-arrow">›</text>
          </view>
        </picker>
      </view>

      <view class="form-item">
        <view class="form-label">
          <text class="icon">👤</text>
          <text>账号</text>
        </view>
        <input
          class="form-input"
          v-model="form.username"
          placeholder="请输入账号"
          :maxlength="50"
        />
      </view>

      <view class="form-item form-item--password">
        <view class="form-label">
          <text class="icon">🔒</text>
          <text>密码</text>
        </view>
        <input
          class="form-input"
          v-model="form.password"
          type="password"
          placeholder="请输入密码"
          :maxlength="128"
          @confirm="handleLogin"
        />
      </view>

      <checkbox-group class="form-item-checkbox" @change="handleRememberChange">
        <label>
          <checkbox value="remember" :checked="rememberPassword" color="#667eea" />
          <text>记住账号和密码</text>
        </label>
      </checkbox-group>

      <button
        class="login-btn"
        :disabled="!canSubmit"
        :loading="loading"
        @click="handleLogin"
      >
        {{ loading ? "登录中..." : "登录" }}
      </button>
    </view>

    <view class="login-footer" aria-label="签名语录">
      <text class="motto-title">沟通、协作、持续进步</text>
      <view class="motto-byline">
        <text class="motto-welcome">欢迎你，我的朋友。</text>
        <text class="motto-signature">-马延浩</text>
      </view>
    </view>
  </view>
</template>

<script>
import { computed, ref, onMounted } from "vue";
import { useUserStore } from "@/stores/user.js";
import { useMessageStore } from "@/stores/message.js";
import { clearLegacyCredentialCaches, readAuthToken } from "@/utils/sessionRuntime.js";
import { getSessionEntryRoute } from "@/utils/sessionPolicy.js";
import { defaultLoginTeamId } from "@/utils/loginTeams.js";
import {
  clearRememberedLogin,
  readRememberedLogin,
  writeRememberedLogin,
} from "@/utils/rememberedLogin.js";

export default {
  name: "Login",
  setup() {
    const userStore = useUserStore();
    const messageStore = useMessageStore();

    const form = ref({
      teamId: "",
      username: "",
      password: "",
    });

    const loading = ref(false);
    const rememberPassword = ref(false);
    const teamsLoading = ref(true);
    const teamsError = ref("");
    const loginTeams = ref([]);
    const selectedTeamIndex = computed(() => {
      const index = loginTeams.value.findIndex((team) => team._id === form.value.teamId);
      return index >= 0 ? index : 0;
    });
    const selectedTeamName = computed(() => (
      loginTeams.value.find((team) => team._id === form.value.teamId)?.name || ""
    ));
    const canSubmit = computed(() => (
      !loading.value &&
      !teamsLoading.value &&
      !teamsError.value &&
      loginTeams.value.length > 0 &&
      Boolean(form.value.teamId)
    ));

    onMounted(() => {
      clearLegacyCredentialCaches();
      const remembered = readRememberedLogin();
      if (remembered) {
        Object.assign(form.value, remembered);
        rememberPassword.value = true;
      }
      loadLoginTeams();
      checkAutoLogin();
    });

    const loadLoginTeams = async () => {
      if (teamsLoading.value && loginTeams.value.length > 0) return;
      teamsLoading.value = true;
      teamsError.value = "";
      try {
        const teams = await userStore.loadLoginTeams();
        loginTeams.value = teams;
        if (!teams.some((team) => team._id === form.value.teamId)) {
          form.value.teamId = defaultLoginTeamId(teams);
        }
      } catch (error) {
        console.error("加载登录团队失败:", error);
        loginTeams.value = [];
        form.value.teamId = "";
        teamsError.value = "项目团队加载失败，请检查网络后重试";
      } finally {
        teamsLoading.value = false;
      }
    };

    const handleTeamChange = (event) => {
      const index = Number(event.detail.value);
      form.value.teamId = loginTeams.value[index]?._id || "";
    };

    const handleRememberChange = (event) => {
      rememberPassword.value = event.detail.value.includes("remember");
      if (!rememberPassword.value) clearRememberedLogin();
    };

    // 检查自动登录
    const checkAutoLogin = () => {
      const token = readAuthToken();
      if (token) {
        userStore
          .bootstrap()
          .then(() => {
            uni.reLaunch({
              url: getSessionEntryRoute(userStore.mode),
            });
          })
          .catch((error) => {
            console.error("恢复登录状态失败:", error);
          });
      }
    };

    // 登录
    const handleLogin = async () => {
      // 表单验证
      if (teamsLoading.value) {
        uni.showToast({ title: "项目团队正在加载", icon: "none" });
        return;
      }

      if (teamsError.value || loginTeams.value.length === 0 || !form.value.teamId) {
        uni.showToast({ title: "请先选择可用的项目团队", icon: "none" });
        return;
      }

      if (!form.value.username.trim()) {
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
        const credentials = {
          username: form.value.username.trim(),
          password: form.value.password,
          teamId: form.value.teamId,
        };
        await userStore.login(credentials);
        if (rememberPassword.value) writeRememberedLogin(credentials);
        else {
          clearRememberedLogin();
          form.value.password = "";
        }

        if (userStore.canAccessBusiness) messageStore.fetchUnreadCount();

        uni.showToast({
          title: "登录成功",
          icon: "success",
        });

        // 跳转到主页
        setTimeout(() => {
          uni.reLaunch({
            url: getSessionEntryRoute(userStore.mode),
          });
        }, 500);
      } catch (error) {
        console.error("登录失败:", error);
        // 错误提示已在request.js中处理
      } finally {
        loading.value = false;
      }
    };

    return {
      form,
      loading,
      teamsLoading,
      teamsError,
      loginTeams,
      selectedTeamIndex,
      selectedTeamName,
      canSubmit,
      rememberPassword,
      loadLoginTeams,
      handleTeamChange,
      handleRememberChange,
      handleLogin,
    };
  },
};
</script>

<style scoped lang="scss">
.login-container {
  min-height: 100vh;
  min-height: 100dvh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: calc(72rpx + env(safe-area-inset-top)) 40rpx max(44rpx, env(safe-area-inset-bottom));
  box-sizing: border-box;
}

.login-header {
  text-align: center;
  margin-bottom: 48rpx;

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

    .team-picker,
    .team-state-box {
      width: 100%;
      min-height: 88rpx;
      padding: 0 24rpx;
      display: flex;
      align-items: center;
      box-sizing: border-box;
      background: #f5f7fa;
      border: 2rpx solid transparent;
      border-radius: 12rpx;
    }

    .team-picker {
      justify-content: space-between;
    }

    .team-picker-value {
      min-width: 0;
      overflow: hidden;
      color: #303133;
      font-size: 28rpx;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .team-picker-arrow {
      flex: 0 0 auto;
      margin-left: 20rpx;
      color: #909399;
      font-size: 40rpx;
      line-height: 1;
    }

    .team-state-box {
      justify-content: space-between;
      gap: 16rpx;
    }

    .team-state-box--error {
      border-color: #f3b7b7;
      background: #fff4f4;
    }

    .team-state-text {
      min-width: 0;
      flex: 1;
      color: #606266;
      font-size: 24rpx;
      line-height: 34rpx;
    }

    .team-state-box--error .team-state-text {
      color: #c45656;
    }

    .retry-button {
      width: auto;
      min-width: 120rpx;
      height: 56rpx;
      margin: 0;
      padding: 0 16rpx;
      flex: 0 0 auto;
      color: #1677ff;
      background: transparent;
      border: 0;
      border-radius: 8rpx;
      font-size: 24rpx;
      line-height: 56rpx;

      &::after {
        border: 0;
      }
    }
  }

  .form-item--password {
    margin-bottom: 24rpx;
  }

  .form-item-checkbox {
    margin-bottom: 32rpx;

    label {
      display: flex;
      align-items: center;
      font-size: 26rpx;
      color: #606266;

      checkbox {
        margin-right: 12rpx;
        transform: scale(0.88);
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

    &[disabled] {
      opacity: 0.58;
    }

    &::after {
      border: none;
    }
  }
}

.login-footer {
  margin-top: auto;
  padding-top: 84rpx;
  text-align: center;
  color: rgba(255, 255, 255, 0.86);

  .motto-title,
  .motto-welcome,
  .motto-signature {
    display: block;
    font-size: 24rpx;
    line-height: 1.5;
  }

  .motto-title {
    font-weight: 600;
    color: #ffffff;
  }

  .motto-byline {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 16rpx;
    margin-top: 4rpx;
  }

  .motto-signature {
    white-space: nowrap;
  }
}
</style>
