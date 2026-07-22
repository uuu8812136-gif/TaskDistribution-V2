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
          <h1>Horselink 公司管理系统</h1>
          <p>登录账号，进入所属项目团队</p>
        </header>

        <el-form
          ref="loginFormRef"
          :model="loginForm"
          :rules="loginRules"
          class="login-form"
          @submit.prevent="handleLogin"
        >
          <el-form-item prop="teamId">
            <div class="form-control">
              <label for="login-team">项目团队</label>
              <el-select
                id="login-team"
                v-model="loginForm.teamId"
                :disabled="teamsLoading || Boolean(teamsError) || loginTeams.length === 0"
                :loading="teamsLoading"
                :placeholder="teamsLoading ? '正在加载项目团队' : '请选择项目团队'"
                size="large"
                class="team-select"
              >
                <el-option
                  v-for="team in loginTeams"
                  :key="team._id"
                  :label="team.name"
                  :value="team._id"
                />
              </el-select>
              <div v-if="teamsError" class="team-state team-state--error" role="alert">
                <span>{{ teamsError }}</span>
                <el-button
                  link
                  type="primary"
                  native-type="button"
                  :disabled="teamsLoading"
                  @click="loadLoginTeams"
                >
                  重新加载
                </el-button>
              </div>
              <p v-else-if="!teamsLoading && loginTeams.length === 0" class="team-state" role="status">
                暂无可登录的项目团队，请联系超级管理员
              </p>
            </div>
          </el-form-item>
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
              :disabled="!canSubmit"
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
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getLoginTeams } from '@/api/auth'
import { useSessionStore } from '@/stores/session'
import { defaultLoginTeamId, normalizeLoginTeams } from '@/utils/loginTeams'
import { requestErrorMessage } from '@/utils/request'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loginFormRef = ref(null)
const loading = ref(false)
const teamsLoading = ref(true)
const teamsError = ref('')
const loginTeams = ref([])

const loginForm = reactive({ teamId: '', username: '', password: '' })
const loginRules = {
  teamId: [{ required: true, message: '请选择项目团队', trigger: 'change' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ]
}
const canSubmit = computed(() => (
  Boolean(loginForm.teamId) &&
  !teamsLoading.value &&
  !teamsError.value &&
  loginTeams.value.length > 0
))

const loadLoginTeams = async () => {
  teamsLoading.value = true
  teamsError.value = ''
  try {
    const payload = await getLoginTeams()
    const teams = normalizeLoginTeams(payload?.teams)
    loginTeams.value = teams
    if (!teams.some((team) => team._id === loginForm.teamId)) {
      loginForm.teamId = defaultLoginTeamId(teams)
    }
  } catch {
    loginTeams.value = []
    loginForm.teamId = ''
    teamsError.value = '项目团队加载失败，请检查网络后重试'
  } finally {
    teamsLoading.value = false
  }
}

const handleLogin = async () => {
  if (!loginFormRef.value || loading.value || !canSubmit.value) return
  const valid = await loginFormRef.value.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    await session.login({
      username: loginForm.username.trim(),
      password: loginForm.password,
      teamId: loginForm.teamId
    })
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
    const isLoginResponseError = error?.config?.url === '/auth/login' && Boolean(error?.response)
    if (isLoginResponseError || !error?.config) {
      ElMessage.error(requestErrorMessage(error, '登录失败'))
    }
    if (session.token && !session.isReady) {
      session.clearLocalSession('login-bootstrap-failed')
    }
  } finally {
    loading.value = false
  }
}

onMounted(loadLoginTeams)
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
    url('@/assets/login-logistics.jpg');
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

  :deep(.el-select__wrapper) {
    width: 100%;
    min-height: 46px;
    padding-inline: 14px;
    background: rgb(255 255 255 / 88%);
    border-radius: 12px;
    box-shadow: 0 0 0 1px #d7e2f1 inset;
  }

  :deep(.el-select__wrapper:hover) {
    box-shadow: 0 0 0 1px #a9cfff inset;
  }

  :deep(.el-select__wrapper.is-focused) {
    box-shadow: 0 0 0 1px var(--zl-primary) inset, 0 0 0 3px rgb(64 150 255 / 12%);
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
    min-width: 0;
  }

  .team-select {
    width: 100%;
  }

  .team-state {
    margin: 8px 0 0;
    color: var(--zl-muted);
    font-size: 13px;
    line-height: 20px;
  }

  .team-state--error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--el-color-danger);

    span {
      min-width: 0;
    }

    :deep(.el-button) {
      flex: 0 0 auto;
    }
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
