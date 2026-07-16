<template>
  <div class="login-container">
    <main class="login-shell">
      <section class="login-panel">
        <div class="login-brand">
          <span class="brand-mark" aria-hidden="true">
            <el-icon><Connection /></el-icon>
          </span>
          <span class="brand-name">HORSELINK</span>
        </div>

        <header class="login-header">
          <h1>公司管理系统</h1>
          <p>登录账号，进入所属项目团队</p>
        </header>

        <el-form
          ref="loginFormRef"
          :model="loginForm"
          :rules="loginRules"
          class="login-form"
          @submit.prevent="handleLogin"
        >
          <el-form-item prop="username">
            <div class="form-control">
              <label for="login-username">用户名</label>
              <el-input
                id="login-username"
                v-model="loginForm.username"
                placeholder="请输入用户名"
                size="large"
                prefix-icon="User"
                autocomplete="username"
              />
            </div>
          </el-form-item>
          <el-form-item prop="password">
            <div class="form-control">
              <label for="login-password">密码</label>
              <el-input
                id="login-password"
                v-model="loginForm.password"
                type="password"
                placeholder="请输入密码"
                size="large"
                prefix-icon="Lock"
                autocomplete="current-password"
                show-password
              />
            </div>
          </el-form-item>
          <el-form-item class="login-submit">
            <el-button
              type="primary"
              size="large"
              :loading="loading"
              class="login-button"
              native-type="submit"
            >
              登录
            </el-button>
          </el-form-item>
        </el-form>
      </section>
    </main>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loginFormRef = ref(null)
const loading = ref(false)

const loginForm = reactive({ username: '', password: '' })
const loginRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ]
}

const handleLogin = async () => {
  if (!loginFormRef.value || loading.value) return
  const valid = await loginFormRef.value.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    await session.login(loginForm)
    ElMessage.success('登录成功')
    if (session.isTeamSelection) {
      await router.replace({ name: 'TeamSelect' })
    } else {
      const redirect = typeof route.query.redirect === 'string' &&
        route.query.redirect.startsWith('/') &&
        !route.query.redirect.startsWith('//')
        ? route.query.redirect
        : null
      await router.replace(redirect || { name: 'Dashboard' })
    }
  } catch (error) {
    ElMessage.error(error.response?.data?.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="scss">
.login-container {
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 32px clamp(24px, 10vw, 160px);
  display: flex;
  align-items: center;
  background:
    linear-gradient(90deg, rgb(2 12 35 / 78%) 0%, rgb(2 18 52 / 56%) 48%, rgb(2 18 52 / 16%) 100%),
    url('@/assets/2.png');
  background-size: cover;
  background-position: center;
}

.login-shell {
  width: min(440px, 100%);
}

.login-panel {
  width: 100%;
  padding: 36px;
  color: var(--zl-text);
  background: rgb(255 255 255 / 88%);
  border: 1px solid rgb(255 255 255 / 76%);
  border-radius: var(--zl-radius);
  box-shadow: 0 24px 64px rgb(2 12 35 / 28%);
  backdrop-filter: blur(22px) saturate(1.35);
  animation: login-rise 0.5s var(--zl-easing) both;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 28px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 42px;
  color: #fff;
  background: var(--zl-primary-deep);
  border-radius: 12px;
  box-shadow: 0 8px 20px rgb(22 119 255 / 26%);
  font-size: 22px;
}

.brand-name {
  color: #0f376d;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0;
}

.login-header {
  margin-bottom: 30px;

  h1 {
    margin: 0 0 10px;
    color: #172033;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.3;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: var(--zl-muted);
    font-size: 14px;
    line-height: 1.6;
  }
}

.login-form {
  :deep(.el-form-item) {
    margin-bottom: 22px;
  }

  :deep(.el-form-item__content) {
    width: 100%;
  }

  :deep(.el-input__wrapper) {
    min-height: 46px;
    padding-inline: 14px;
    background: rgb(255 255 255 / 88%);
    border-radius: 12px;
    box-shadow: 0 0 0 1px #d7e2f1 inset;
  }

  :deep(.el-input__wrapper:hover) {
    box-shadow: 0 0 0 1px #a9cfff inset;
  }

  :deep(.el-input__wrapper.is-focus) {
    box-shadow: 0 0 0 1px var(--zl-primary) inset, 0 0 0 3px rgb(64 150 255 / 12%);
  }

  :deep(.el-input__inner) {
    line-height: 24px;
  }

  .form-control {
    width: 100%;
  }

  label {
    display: block;
    margin-bottom: 8px;
    color: #334155;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
  }

  .login-submit {
    margin-bottom: 0;
    padding-top: 2px;
  }

  .login-button {
    width: 100%;
    min-height: 46px;
    margin: 0;
    border-radius: 12px;
    box-shadow: 0 8px 20px rgb(22 119 255 / 22%);
    font-weight: 600;
  }
}

@keyframes login-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 600px) {
  .login-container {
    padding: 16px;
    align-items: flex-end;
    background-position: 66% center;
  }

  .login-panel {
    padding: 26px 22px;
  }

  .login-brand {
    margin-bottom: 22px;
  }

  .login-header {
    margin-bottom: 24px;

    h1 {
      font-size: 25px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-panel {
    animation: none;
  }
}
</style>
