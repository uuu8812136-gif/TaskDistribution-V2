import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearRememberedLogin,
  forgetRememberedLogin,
  readPasswordCredential,
  readRememberedLogin,
  rememberLoginPassword,
  storePasswordCredential,
  synchronizeRememberedPassword,
  writeRememberedLogin
} from '../src/utils/rememberedLogin.js'

function createStorage(initialValue = null) {
  const values = new Map()
  if (initialValue !== null) values.set('horselink:remembered-login:v1', initialValue)
  return {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) },
    raw() { return values.get('horselink:remembered-login:v1') ?? null }
  }
}

function installCredentialRuntime(t, credentials) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  class MockPasswordCredential {
    constructor(value) {
      Object.assign(this, value)
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { PasswordCredential: MockPasswordCredential }
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { credentials }
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else delete globalThis.navigator
  })
}

test('remembered login stores only non-secret account and team metadata', () => {
  const storage = createStorage()
  assert.equal(writeRememberedLogin({
    username: ' demo-user ',
    teamId: ' team-a ',
    password: 'must-not-be-stored'
  }, storage), true)

  assert.deepEqual(readRememberedLogin(storage), {
    username: 'demo-user',
    teamId: 'team-a'
  })
  assert.doesNotMatch(storage.raw(), /password|must-not-be-stored/i)
  clearRememberedLogin(storage)
  assert.equal(storage.raw(), null)
})

test('malformed remembered login metadata is removed instead of breaking login', () => {
  const storage = createStorage('{not-json')
  assert.equal(readRememberedLogin(storage), null)
  assert.equal(storage.raw(), null)
})

test('blocked browser storage access and operations never escape into the login flow', (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const blockedWindow = {}
  Object.defineProperty(blockedWindow, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage blocked') }
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: blockedWindow
  })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globalThis.window
  })

  assert.equal(readRememberedLogin(), null)
  assert.equal(writeRememberedLogin({ username: 'demo-user', teamId: 'team-a' }), false)
  assert.equal(clearRememberedLogin(), false)

  const throwingStorage = {
    getItem() { throw new Error('get blocked') },
    setItem() { throw new Error('set blocked') },
    removeItem() { throw new Error('remove blocked') }
  }
  assert.equal(readRememberedLogin(throwingStorage), null)
  assert.equal(writeRememberedLogin({ username: 'demo-user', teamId: 'team-a' }, throwingStorage), false)
  assert.equal(clearRememberedLogin(throwingStorage), false)
})

test('missing Credential Management API degrades without exposing an error', async () => {
  assert.equal(await readPasswordCredential('demo-user'), null)
  assert.equal(await storePasswordCredential({
    username: 'demo-user',
    password: 'runtime-only-secret'
  }), false)
})

test('Credential Management API stores and restores the remembered password', async (t) => {
  let storedCredential = null
  installCredentialRuntime(t, {
    async get() { return storedCredential },
    async store(credential) { storedCredential = credential }
  })

  assert.equal(await storePasswordCredential({
    username: 'demo-user',
    password: 'runtime-only-secret'
  }), true)
  assert.deepEqual(await readPasswordCredential('demo-user'), {
    username: 'demo-user',
    password: 'runtime-only-secret'
  })
  assert.equal(await readPasswordCredential('another-user'), null)
})

test('credential save failure does not write remembered metadata or reject successful login work', async (t) => {
  let metadataWrites = 0
  let metadataRemovals = 0
  let preventCalls = 0
  const storage = {
    getItem() { return null },
    setItem() { metadataWrites += 1 },
    removeItem() { metadataRemovals += 1 }
  }
  installCredentialRuntime(t, {
    async store() { throw new Error('credential store blocked') },
    async preventSilentAccess() { preventCalls += 1 }
  })

  const result = await rememberLoginPassword({
    username: 'demo-user',
    teamId: 'team-a',
    password: 'runtime-only-secret'
  }, storage)

  assert.equal(result.remembered, false)
  assert.equal(result.reason, 'CREDENTIAL_UNAVAILABLE')
  assert.equal(metadataWrites, 0)
  assert.equal(metadataRemovals, 1)
  assert.equal(preventCalls, 1)
})

test('metadata save failure is reported and cleanup is attempted', async (t) => {
  let metadataRemovals = 0
  let preventCalls = 0
  installCredentialRuntime(t, {
    async store() {},
    async preventSilentAccess() { preventCalls += 1 }
  })
  const storage = {
    getItem() { return null },
    setItem() { throw new Error('metadata store blocked') },
    removeItem() { metadataRemovals += 1 }
  }

  const result = await rememberLoginPassword({
    username: 'demo-user',
    teamId: 'team-a',
    password: 'runtime-only-secret'
  }, storage)

  assert.equal(result.remembered, false)
  assert.equal(result.reason, 'METADATA_UNAVAILABLE')
  assert.equal(result.metadataCleared, true)
  assert.equal(metadataRemovals, 1)
  assert.equal(preventCalls, 1)
})

test('cancelling remembered login clears metadata and prevents silent credential access', async (t) => {
  let preventCalls = 0
  const storage = createStorage()
  writeRememberedLogin({ username: 'demo-user', teamId: 'team-a' }, storage)
  installCredentialRuntime(t, {
    async preventSilentAccess() { preventCalls += 1 }
  })

  const result = await forgetRememberedLogin(storage)

  assert.equal(result.metadataCleared, true)
  assert.equal(result.silentAccessPrevented, true)
  assert.equal(storage.raw(), null)
  assert.equal(preventCalls, 1)
})

test('password synchronization matches username case and forgets stale metadata on failure', async (t) => {
  const storage = createStorage()
  let failStore = false
  let storedCredential = null
  let preventCalls = 0
  writeRememberedLogin({ username: 'Demo-User', teamId: 'team-a' }, storage)
  installCredentialRuntime(t, {
    async store(credential) {
      if (failStore) throw new Error('credential update blocked')
      storedCredential = credential
    },
    async preventSilentAccess() { preventCalls += 1 }
  })

  const updated = await synchronizeRememberedPassword({
    username: 'demo-user',
    password: 'new-runtime-secret'
  }, storage)
  assert.deepEqual(updated, { attempted: true, updated: true, forgotten: false })
  assert.equal(storedCredential.id, 'Demo-User')
  assert.equal(storedCredential.password, 'new-runtime-secret')

  failStore = true
  const failed = await synchronizeRememberedPassword({
    username: 'DEMO-USER',
    password: 'another-secret'
  }, storage)
  assert.equal(failed.attempted, true)
  assert.equal(failed.updated, false)
  assert.equal(failed.forgotten, true)
  assert.equal(storage.raw(), null)
  assert.equal(preventCalls, 1)
})

test('password synchronization reports inaccessible metadata instead of treating it as no remembered login', async (t) => {
  let preventCalls = 0
  installCredentialRuntime(t, {
    async preventSilentAccess() { preventCalls += 1 }
  })
  const blockedStorage = {
    getItem() { throw new Error('metadata read blocked') },
    removeItem() { throw new Error('metadata cleanup blocked') }
  }

  const result = await synchronizeRememberedPassword({
    username: 'demo-user',
    password: 'new-runtime-secret'
  }, blockedStorage)

  assert.equal(result.attempted, true)
  assert.equal(result.updated, false)
  assert.equal(result.forgotten, false)
  assert.equal(result.reason, 'METADATA_UNAVAILABLE')
  assert.equal(preventCalls, 1)
})
