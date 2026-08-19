import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

test('message page exposes a direct user-gesture WeChat reminder command', () => {
  const page = source('pages/message/index.vue')
  assert.match(page, />微信提醒<\/button>/)
  assert.match(page, /@click="enableWechatNotifications"/)
  assert.match(page, /requestWechatServiceNotificationSubscription\(wechatNotificationState\.value\)/)
  assert.match(page, /v-if="canWriteMessages" class="action-btn" @click="markAllRead"/)
})

test('subscription helper requests the approved template before binding the account', () => {
  const helper = source('utils/wechatServiceNotifications.js')
  const requestPosition = helper.indexOf('uni.requestSubscribeMessage')
  const loginPosition = helper.indexOf("uni.login, { provider: 'weixin' }")
  assert.ok(requestPosition > 0)
  assert.ok(loginPosition > requestPosition)
  assert.match(helper, /tmplIds: \[config\.templateId\]/)
  assert.match(helper, /result !== 'accept'/)
  assert.match(helper, /recordWechatServiceNotificationAuthorization\(config\.templateId, result\)/)
})

test('mini-program API never receives or exposes the WeChat AppSecret', () => {
  const api = source('api/index.js')
  const helper = source('utils/wechatServiceNotifications.js')
  assert.doesNotMatch(api, /appSecret|APP_SECRET|access_token/i)
  assert.doesNotMatch(helper, /appSecret|APP_SECRET|access_token/i)
})
