import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createRequestSettlement } from '../utils/requestSettlement.js'

function createHarness(events) {
  return createRequestSettlement({
    finishLoading: () => events.push('hide'),
    resolve: (value) => events.push(`resolve:${value}`),
    reject: (error) => events.push(`reject:${error.message}`)
  })
}

test('successful transport hides loading before response handling and resolves only once', () => {
  const events = []
  const settlement = createHarness(events)

  settlement.resolveWith(() => {
    events.push('handle')
    return 'ok'
  })
  settlement.complete()
  settlement.resolveWith(() => 'duplicate')

  assert.deepEqual(events, ['hide', 'handle', 'resolve:ok'])
})

test('failed transport hides loading before user feedback and rejection', () => {
  const events = []
  const settlement = createHarness(events)

  settlement.rejectWith(() => {
    events.push('toast')
    return new Error('network')
  })
  settlement.complete()

  assert.deepEqual(events, ['hide', 'toast', 'reject:network'])
})

test('response exceptions are mapped after loading finishes and before rejection', () => {
  const events = []
  const settlement = createHarness(events)

  settlement.resolveWith(() => {
    events.push('parse')
    throw new Error('invalid json')
  }, (error) => {
    events.push('localize')
    return new Error(`localized ${error.message}`)
  })

  assert.deepEqual(events, [
    'hide',
    'parse',
    'localize',
    'reject:localized invalid json'
  ])
})

test('complete is a loading fallback and does not prevent later transport settlement', () => {
  const events = []
  const settlement = createHarness(events)

  settlement.complete()
  settlement.complete()
  settlement.resolveWith(() => {
    events.push('handle')
    return 'late'
  })

  assert.deepEqual(events, ['hide', 'handle', 'resolve:late'])
})

test('request, upload and download all use one-shot settlement with complete as fallback', () => {
  const requestSource = readFileSync(new URL('../utils/request.js', import.meta.url), 'utf8')

  assert.equal((requestSource.match(/createRequestSettlement\(\{/g) || []).length, 3)
  assert.equal((requestSource.match(/complete: settlement\.complete/g) || []).length, 3)
  assert.doesNotMatch(requestSource, /complete:\s*\(\)\s*=>\s*hideLoading/)
})
