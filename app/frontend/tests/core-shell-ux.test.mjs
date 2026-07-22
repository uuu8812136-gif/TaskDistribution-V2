import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readView = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')
const loginSource = readView('../src/views/Login.vue')
const layoutSource = readView('../src/layouts/MainLayout.vue')
const dashboardSource = readView('../src/views/Dashboard.vue')
const teamSelectSource = readView('../src/views/TeamSelect.vue')
const notFoundSource = readView('../src/views/NotFound.vue')
const globalStyleSource = readView('../src/assets/styles/main.scss')
const requestSource = readView('../src/utils/request.js')

test('login reports credential responses once and clears a half-initialized session', () => {
  assert.match(loginSource, /error\?\.config\?\.url === '\/auth\/login'/)
  assert.match(loginSource, /if \(isLoginResponseError \|\| !error\?\.config\)/)
  assert.match(loginSource, /requestErrorMessage\(error, '登录失败'\)/)
  assert.match(requestSource, /AUTH_CREDENTIALS_INVALID: '用户名或密码错误'/)
  assert.match(loginSource, /session\.token && !session\.isReady/)
  assert.match(loginSource, /session\.clearLocalSession\('login-bootstrap-failed'\)/)
})

test('account actions lock before password validation or logout confirmation', () => {
  assert.match(layoutSource, /if \(passwordSubmitting\.value\) return\s+\n\s*passwordSubmitting\.value = true/)
  assert.match(layoutSource, /if \(logoutSubmitting\.value\) return[\s\S]*?logoutSubmitting\.value = true/)
  assert.match(layoutSource, /:close-on-click-modal="!passwordSubmitting"/)
  assert.match(layoutSource, /:disabled="accountActionPending"/)
})

test('dashboard distinguishes loading, failure, empty data and stale responses', () => {
  assert.match(dashboardSource, /v-if="loading" class="dashboard-skeleton"/)
  assert.match(dashboardSource, /title="统计看板加载失败"/)
  assert.match(dashboardSource, /@click="fetchData">重新加载/)
  assert.match(dashboardSource, /const requestId = \+\+dashboardRequestId/)
  assert.match(dashboardSource, /if \(requestId === dashboardRequestId\) loading\.value = false/)
  assert.match(dashboardSource, /await Promise\.all\(/)
})

test('dashboard skips task endpoints and task-only panels without task.view', () => {
  assert.match(dashboardSource, /const canViewTasks = computed\(\(\) => session\.hasPermission\('task\.view'\)\)/)
  assert.match(dashboardSource, /v-if="canViewTasks" class="stats-grid"/)
  assert.match(dashboardSource, /canViewTasks\.value \? getStatisticsOverview\(\) : Promise\.resolve\(\{ overview: \{\} \}\)/)
  assert.match(dashboardSource, /canViewTasks\.value[\s\S]*?getMyTasks\([\s\S]*?: Promise\.resolve\(\{ tasks: \[\] \}\)/)
})

test('dashboard messages use the shared scoped resource navigation policy', () => {
  assert.match(dashboardSource, /hasMessageResource\(message\)/)
  assert.match(dashboardSource, /messageResourceLocation\(message, \{ includeTeamId: session\.isGlobalReadOnly \}\)/)
  assert.doesNotMatch(dashboardSource, /router\.push\(`\/tasks\/\$\{message\.relatedTask\._id\}`\)/)
})

test('team selection exposes refresh errors and blocks conflicting actions', () => {
  assert.match(teamSelectSource, /v-if="teamsError" class="team-error" role="alert"/)
  assert.match(teamSelectSource, /if \(refreshing\.value\) return/)
  assert.match(teamSelectSource, /if \(switching\.value \|\| refreshing\.value \|\| logoutSubmitting\.value\) return/)
  assert.match(teamSelectSource, /:disabled="Boolean\(switching\) \|\| refreshing \|\| logoutSubmitting"/)
})

test('small-screen shell surfaces keep actions reachable without clipping', () => {
  assert.match(globalStyleSource, /\.el-dialog__footer \{[\s\S]*?flex-wrap: wrap;/)
  assert.match(notFoundSource, /min-height: 100vh;\s+min-height: 100dvh;/)
  assert.match(notFoundSource, /overflow: auto;/)
})
