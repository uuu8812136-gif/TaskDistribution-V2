import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('custom tab bar badge is rendered from the message store without native badge APIs', () => {
  const messageStore = source('stores/message.js')
  const request = source('utils/request.js')
  const customTabBar = source('components/custom-tab-bar/CustomTabBar.vue')

  assert.doesNotMatch(messageStore, /(?:set|remove)TabBarBadge/)
  assert.doesNotMatch(request, /(?:set|remove)TabBarBadge/)
  assert.match(customTabBar, /messageStore\.unreadCount > 0/)
})

test('request wrapper owns loading feedback and ignores an unmatched hide', () => {
  const request = source('utils/request.js')
  const directLoadingPages = [
    'pages/task/complete.vue',
    'pages/task/review.vue',
    'pages/task/approve-extension.vue',
    'pages/task/components/CompleteDialog.vue'
  ]

  assert.match(request, /if \(loadingCount === 0\) return\s+loadingCount -= 1/)
  for (const page of directLoadingPages) {
    const pageSource = source(page)
    assert.doesNotMatch(pageSource, /uni\.showLoading\(/, `${page} must use request loading`)
    assert.doesNotMatch(pageSource, /uni\.hideLoading\(/, `${page} must use request loading`)
  }
})
