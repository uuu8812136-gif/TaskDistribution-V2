import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import config from '../config/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const loginSource = await readFile(`${root}/pages/login/index.vue`, 'utf8')
const requestSource = await readFile(`${root}/utils/request.js`, 'utf8')

assert.equal(process.env.NODE_ENV === 'production', false, 'Run this check only for an isolated non-production build')
assert.equal(config.baseURL, 'http://127.0.0.1:18099/api')
assert.doesNotMatch(loginSource, /getStorageSync\(["']savedPassword["']\)/)
assert.doesNotMatch(loginSource, /setStorageSync\(["']savedPassword["']/)
assert.doesNotMatch(requestSource, /headers?\[['"](?:x-)?team-id['"]\]\s*=/i)

console.log('Mini-program isolation checks passed')
