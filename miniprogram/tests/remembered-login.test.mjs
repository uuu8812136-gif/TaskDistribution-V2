import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REMEMBERED_LOGIN_KEY,
  clearRememberedLogin,
  normalizeRememberedLogin,
  readRememberedLogin,
  writeRememberedLogin
} from '../utils/rememberedLogin.js'
import { clearLegacyCredentialCaches } from '../utils/sessionRuntime.js'

function withStorage(run) {
  const storage = new Map()
  const previousUni = globalThis.uni
  globalThis.uni = {
    getStorageSync: (key) => storage.get(key) ?? '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key)
  }
  try {
    return run(storage)
  } finally {
    if (previousUni === undefined) delete globalThis.uni
    else globalThis.uni = previousUni
  }
}

test('remembered login keeps only a complete normalized team and credential tuple', () => {
  assert.deepEqual(normalizeRememberedLogin({
    teamId: ' team-1 ',
    username: ' customer ',
    password: ' secret '
  }), {
    teamId: 'team-1',
    username: 'customer',
    password: ' secret '
  })
  assert.equal(normalizeRememberedLogin({ teamId: 'team-1', username: 'customer' }), null)
  assert.equal(normalizeRememberedLogin(null), null)
})

test('remembered login survives legacy cleanup and can be explicitly cleared', () => withStorage((storage) => {
  storage.set('savedPassword', 'legacy-secret')
  storage.set('rememberPassword', true)
  assert.equal(writeRememberedLogin({
    teamId: 'team-1',
    username: 'customer',
    password: 'current-secret'
  }), true)

  clearLegacyCredentialCaches()
  assert.equal(storage.has('savedPassword'), false)
  assert.equal(storage.has('rememberPassword'), false)
  assert.deepEqual(readRememberedLogin(), {
    teamId: 'team-1',
    username: 'customer',
    password: 'current-secret'
  })
  assert.equal(storage.has(REMEMBERED_LOGIN_KEY), true)

  clearRememberedLogin()
  assert.equal(readRememberedLogin(), null)
}))

test('remembered login storage failures do not turn a successful login into an error', () => {
  const previousUni = globalThis.uni
  globalThis.uni = {
    setStorageSync: () => {
      throw new Error('storage unavailable')
    }
  }
  try {
    assert.equal(writeRememberedLogin({
      teamId: 'team-1',
      username: 'customer',
      password: 'current-secret'
    }), false)
  } finally {
    if (previousUni === undefined) delete globalThis.uni
    else globalThis.uni = previousUni
  }
})
