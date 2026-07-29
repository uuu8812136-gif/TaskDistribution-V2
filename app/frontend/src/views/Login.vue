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
          <h1>Horselink（马链）管理系统</h1>
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
          <div class="login-options" :data-remember-state="rememberState">
            <el-checkbox
              v-model="rememberLogin"
              data-testid="remember-password-checkbox"
              @change="handleRememberLoginChange"
            >
              记住密码
            </el-checkbox>
            <span
              v-if="rememberStatusMessage"
              class="remember-status"
              role="status"
              aria-live="polite"
              data-testid="remember-password-status"
            >
              {{ rememberStatusMessage }}
            </span>
          </div>
          <blockquote class="login-motto" data-testid="login-motto">
            <p class="motto-title">沟通、协作、持续进步</p>
            <p class="motto-welcome">欢迎你，我的朋友。</p>
            <footer>-马延浩</footer>
          </blockquote>
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
import {
  forgetRememberedLogin,
  readPasswordCredential,
  readRememberedLogin,
  rememberLoginPassword
} from '@/utils/rememberedLogin'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const loginFormRef = ref(null)
const loading = ref(false)
const teamsLoading = ref(true)
const teamsError = ref('')
const loginTeams = ref([])
const rememberLogin = ref(false)
const rememberState = ref('idle')
const rememberStatusMessage = ref('')

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

const handleRememberLoginChange = async (enabled) => {
  rememberStatusMessage.value = ''
  if (enabled) {
    rememberState.value = 'selected'
    return
  }
  rememberState.value = 'clearing'
  const forgetResult = await forgetRememberedLogin()
  if (forgetResult.metadataCleared) {
    rememberState.value = 'cleared'
  } else {
    rememberState.value = 'unavailable'
    rememberStatusMessage.value = '浏览器阻止清除记住状态，请在浏览器设置中清除本站数据和已保存密码。'
  }
}

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
    let rememberWarning = ''
    if (rememberLogin.value) {
      const rememberResult = await rememberLoginPassword({
        username: loginForm.username.trim(),
        teamId: loginForm.teamId,
        password: loginForm.password
      })
      if (rememberResult.remembered) {
        rememberState.value = 'stored'
        rememberStatusMessage.value = ''
      } else {
        rememberLogin.value = false
        rememberState.value = 'unavailable'
        rememberWarning = '当前浏览器未能安全记住密码，请下次手动输入'
        rememberStatusMessage.value = rememberWarning
      }
    } else {
      const forgetResult = await forgetRememberedLogin()
      if (forgetResult.metadataCleared) {
        rememberState.value = 'cleared'
      } else {
        rememberState.value = 'unavailable'
        rememberWarning = '浏览器未能清除此前记住的登录状态，请在浏览器设置中清除本站数据'
        rememberStatusMessage.value = rememberWarning
      }
    }
    if (rememberWarning) ElMessage.warning(`登录成功，但${rememberWarning}`)
    else ElMessage.success('登录成功')
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

onMounted(async () => {
  const remembered = readRememberedLogin()
  if (remembered) {
    rememberLogin.value = true
    rememberState.value = 'restoring'
    loginForm.username = remembered.username
    loginForm.teamId = remembered.teamId
  }
  await loadLoginTeams()
  if (!rememberLogin.value) return
  const credential = await readPasswordCredential(loginForm.username)
  if (!credential) {
    const forgetResult = await forgetRememberedLogin()
    rememberLogin.value = false
    rememberState.value = 'unavailable'
    rememberStatusMessage.value = forgetResult.metadataCleared
      ? '未能读取已记住的密码，请重新输入后再次勾选。'
      : '未能读取或清除已记住的密码，请在浏览器设置中清除本站数据和已保存密码。'
    return
  }
  loginForm.username = credential.username
  loginForm.password = credential.password
  rememberState.value = 'restored'
})
</script>

<style scoped lang="scss">
.login-container {
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 32px clamp(24px, 10vw, 160px);
  display: grid;
  grid-template-columns: minmax(0, 440px) minmax(260px, 420px);
  align-items: center;
  justify-content: start;
  gap: clamp(32px, 6vw, 96px);
  overflow-y: auto;
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
  color: #eff6ff;
  background: rgb(7 37 84 / 82%);
  border: 1px solid rgb(96 165 250 / 42%);
  border-radius: var(--zl-radius);
  box-shadow: 0 24px 64px rgb(2 12 35 / 46%);
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
  color: #d9eaff;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0;
}

.login-header {
  margin-bottom: 30px;

  h1 {
    margin: 0 0 10px;
    color: #fff;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.3;
    letter-spacing: 0;
  }

  p {
    margin: 0;
    color: #bdd3ef;
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
    color: #c4d8f0;
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
    color: #eaf3ff;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
  }

  .login-submit {
    margin-bottom: 0;
    padding-top: 2px;
  }

  .login-options {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
    min-height: 24px;
    margin: -8px 0 12px;

    :deep(.el-checkbox__label) {
      color: #eaf3ff;
    }

    .remember-status {
      flex-basis: 100%;
      color: #ffd591;
      font-size: 12px;
      line-height: 18px;
    }
  }

  .login-motto {
    display: grid;
    grid-template-columns: max-content max-content;
    align-items: baseline;
    justify-content: start;
    gap: 3px 12px;
    width: 100%;
    margin: 0 0 18px;
    padding: 8px 2px 8px 12px;
    color: #dbeafe;
    border-left: 2px solid rgb(96 165 250 / 72%);
    text-shadow: 0 2px 12px rgb(2 12 35 / 48%);

    p,
    footer {
      margin: 0;
      letter-spacing: 0;
    }

    .motto-title {
      grid-column: 1 / -1;
      color: #f2f7ff;
      font-size: 14px;
      font-weight: 600;
      line-height: 20px;
    }

    .motto-welcome,
    footer {
      color: #bdd3ef;
      font-size: 13px;
      line-height: 19px;
    }

    footer {
      white-space: nowrap;
      text-align: right;
    }
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

@media (max-width: 900px) {
  .login-container {
    grid-template-columns: minmax(0, 440px);
    align-content: center;
    gap: 18px;
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
    align-content: start;
    gap: 16px;
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
