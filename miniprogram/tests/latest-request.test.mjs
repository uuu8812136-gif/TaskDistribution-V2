import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createLatestRequestGate } from '../utils/latestRequest.js'

function deferred() {
  let resolve
  const promise = new Promise((next) => { resolve = next })
  return { promise, resolve }
}

test('latest request gate rejects stale responses and invalidated work', () => {
  const gate = createLatestRequestGate()
  const first = gate.begin({ page: 1, filter: 'old' })
  const second = gate.begin({ page: 1, filter: 'new' })

  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
  assert.equal(second.filter, 'new')

  gate.invalidate()
  assert.equal(gate.isCurrent(second), false)
})

test('rapid filter changes commit only the newest asynchronous response', async () => {
  const gate = createLatestRequestGate()
  const oldResponse = deferred()
  const newResponse = deferred()
  let committed = null

  const run = async (snapshot, response) => {
    const request = gate.begin(snapshot)
    const value = await response.promise
    if (!gate.isCurrent(request)) return false
    committed = { request, value }
    return true
  }

  const oldRun = run({ status: 'pending', page: 1 }, oldResponse)
  const newRun = run({ status: 'approved', page: 1 }, newResponse)

  newResponse.resolve(['new'])
  assert.equal(await newRun, true)
  assert.equal(committed.request.status, 'approved')
  assert.deepEqual(committed.value, ['new'])

  oldResponse.resolve(['old'])
  assert.equal(await oldRun, false)
  assert.equal(committed.request.status, 'approved')
  assert.deepEqual(committed.value, ['new'])
})

test('component teardown invalidates an in-flight response', async () => {
  const gate = createLatestRequestGate()
  const response = deferred()
  let committed = false
  const request = gate.begin({ page: 1 })

  const run = response.promise.then(() => {
    if (gate.isCurrent(request)) committed = true
  })

  gate.invalidate()
  response.resolve()
  await run
  assert.equal(committed, false)
})

test('all asynchronous mini-program lists apply only their latest request snapshot', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pages = [
    'pages/equipment/repair-list.vue',
    'pages/message/index.vue',
    'pages/equipment/routine-workbench.vue',
    'pages/extension/list.vue',
    'pages/reporting/attendance.vue',
    'pages/task/manage.vue',
    'pages/task/received.vue'
  ]

  for (const page of pages) {
    const source = fs.readFileSync(`${root}/${page}`, 'utf8')
    assert.match(source, /createLatestRequestGate/)
    assert.match(source, /requestGate\.begin\(/)
    assert.match(source, /requestGate\.isCurrent\(request\)/)
    assert.match(source, /onUnmounted\(\(\) => requestGate\.invalidate\(\)\)/)
    assert.ok(
      (source.match(/requestGate\.isCurrent\(request\)/g) || []).length >= 2,
      `${page} must guard both result writes and request cleanup`
    )
  }
})

test('filterable and paginated lists use immutable request fields after awaiting', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const expectations = {
    'pages/extension/list.vue': [
      /status: currentStatus\.value\.value/,
      /page: request\.page/,
      /status = request\.status/,
      /if \(request\.append\)/,
      /loadList\(\{ append: true \}\)/
    ],
    'pages/task/manage.vue': [
      /status: currentStatus\.value\.value/,
      /priority: currentPriority\.value\.value/,
      /keyword: keyword\.value\.trim\(\)/,
      /status = request\.status/,
      /priority = request\.priority/,
      /keyword = request\.keyword/,
      /if \(request\.append\)/,
      /loadTasks\(\{ append: true \}\)/
    ],
    'pages/task/received.vue': [
      /type: activeTab\.value/,
      /keyword: keyword\.value\.trim\(\)/,
      /type: request\.type/,
      /keyword = request\.keyword/,
      /if \(request\.append\)/,
      /loadTasks\(\{ append: true \}\)/
    ]
  }

  for (const [page, patterns] of Object.entries(expectations)) {
    const source = fs.readFileSync(`${root}/${page}`, 'utf8')
    for (const pattern of patterns) assert.match(source, pattern, `${page}: ${pattern}`)
    assert.doesNotMatch(
      source,
      /if \(page\.value === 1\)/,
      `${page} must not use live pagination state after a response resolves`
    )
  }
})
