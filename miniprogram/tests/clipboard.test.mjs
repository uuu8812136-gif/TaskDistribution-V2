import assert from 'node:assert/strict'
import test from 'node:test'

import { copyTextToClipboard } from '../utils/clipboard.js'

async function withUni(runtime, callback) {
  const previous = globalThis.uni
  globalThis.uni = runtime
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete globalThis.uni
    else globalThis.uni = previous
  }
}

async function withRuntimes({ wx: wxRuntime, uni: uniRuntime }, callback) {
  const previousWx = globalThis.wx
  const previousUni = globalThis.uni
  if (wxRuntime === undefined) delete globalThis.wx
  else globalThis.wx = wxRuntime
  if (uniRuntime === undefined) delete globalThis.uni
  else globalThis.uni = uniRuntime
  try {
    return await callback()
  } finally {
    if (previousWx === undefined) delete globalThis.wx
    else globalThis.wx = previousWx
    if (previousUni === undefined) delete globalThis.uni
    else globalThis.uni = previousUni
  }
}

test('clipboard helper prefers wx over uni', async () => {
  const calls = []
  await withRuntimes({
    wx: { setClipboardData({ data, success }) { calls.push(['wx', data]); success() } },
    uni: { setClipboardData() { calls.push(['uni']) } }
  }, async () => assert.equal((await copyTextToClipboard('wx text')).ok, true))
  assert.deepEqual(calls, [['wx', 'wx text']])
})

test('clipboard helper supports a promise-returning uni API', async () => {
  let data
  await withRuntimes({
    uni: { setClipboardData(payload) { data = payload.data; return Promise.resolve() } }
  }, async () => assert.equal((await copyTextToClipboard('promise text')).ok, true))
  assert.equal(data, 'promise text')
})

test('clipboard helper reports a rejected promise as failure', async () => {
  const error = new Error('promise rejected')
  await withRuntimes({
    uni: { setClipboardData() { return Promise.reject(error) } }
  }, async () => {
    const result = await copyTextToClipboard('promise failure')
    assert.equal(result.ok, false)
    assert.equal(result.error, error)
  })
})

test('clipboard helper preserves text and reports success', async () => {
  const runtime = {
    setClipboardData({ data, success }) {
      runtime.data = data
      success()
    },
    showToast(payload) {
      runtime.toast = payload
    }
  }
  await withUni(runtime, async () => {
    const text = '第一行\n  第二行  '
    const result = await copyTextToClipboard(text)
    assert.equal(result.ok, true)
    assert.equal(runtime.data, text)
    assert.equal(runtime.toast.title, '已复制')
  })
})

test('clipboard helper rejects empty text without touching the clipboard', async () => {
  let copied = false
  const toasts = []
  await withUni({
    setClipboardData() {
      copied = true
    },
    showToast(payload) {
      toasts.push(payload)
    }
  }, async () => {
    const result = await copyTextToClipboard('  \n\t', {
      emptyMessage: '暂无可复制的日报文字'
    })
    assert.deepEqual(result, { ok: false, reason: 'empty' })
    assert.equal(copied, false)
    assert.equal(toasts.at(-1).title, '暂无可复制的日报文字')
  })
})

test('clipboard helper reports native failure and catches synchronous exceptions', async () => {
  const failureToasts = []
  await withUni({
    setClipboardData({ fail }) {
      fail({ errMsg: 'denied' })
    },
    showToast(payload) {
      failureToasts.push(payload)
    }
  }, async () => {
    const result = await copyTextToClipboard('text')
    assert.equal(result.ok, false)
    assert.equal(result.error.errMsg, 'denied')
  })
  assert.equal(failureToasts.at(-1).title, '复制失败，请重试')

  await withUni({
    setClipboardData() {
      throw new Error('clipboard unavailable')
    },
    showToast(payload) {
      failureToasts.push(payload)
    }
  }, async () => {
    const result = await copyTextToClipboard('text')
    assert.equal(result.ok, false)
    assert.equal(result.error.message, 'clipboard unavailable')
  })
})

test('clipboard helper handles a runtime without clipboard support', async () => {
  const toasts = []
  await withRuntimes({ uni: {
    showToast(payload) { toasts.push(payload) }
  } }, async () => {
    assert.deepEqual(await copyTextToClipboard('text'), {
      ok: false,
      reason: 'unavailable'
    })
  })
  assert.equal(toasts.at(-1).title, '复制失败，请重试')
})
