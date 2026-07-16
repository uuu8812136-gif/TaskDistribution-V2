<template>
  <div class="login-container">
    <section class="login-panel">
      <header class="login-header">
        <h1>Horselink 公司管理系统</h1>
        <p>账号登录</p>
      </header>

      <el-form
        ref="loginFormRef"
        :model="loginForm"
        :rules="loginRules"
        class="login-form"
        @keyup.enter="handleLogin"
      >
        <el-form-item prop="username">
          <el-input
            v-model="loginForm.username"
            placeholder="用户名"
            size="large"
            prefix-icon="User"
            autocomplete="username"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="密码"
            size="large"
            prefix-icon="Lock"
            autocomplete="current-password"
            show-password
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="loading"
            class="login-button"
            @click="handleLogin"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </section>
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
  padding: 24px clamp(20px, 12vw, 180px);
  display: flex;
  align-items: center;
  background: linear-gradient(rgba(17, 24, 39, 0.48), rgba(17, 24, 39, 0.48)), url('@/assets/2.png');
  background-size: cover;
  background-position: center;
}

.login-panel {
  width: min(420px, 100%);
  padding: 34px;
  color: #303133;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 6px;
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.26);
}

.login-header {
  margin-bottom: 28px;

  h1 {
    margin: 0 0 8px;
    font-size: 24px;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: #909399;
    font-size: 14px;
  }
}

.login-form {
  .login-button {
    width: 100%;
    margin-top: 6px;
  }
}

@media (max-width: 600px) {
  .login-container {
    padding: 16px;
    align-items: flex-end;
  }

  .login-panel {
    padding: 28px 22px;
  }
}
</style>
