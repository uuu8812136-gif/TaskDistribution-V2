import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const configUrl = new URL('../config/index.js', import.meta.url).href
const cwd = fileURLToPath(new URL('..', import.meta.url))

function evaluateConfig(overrides = {}) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import config from ${JSON.stringify(configUrl)}; console.log(config.baseURL)`],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        VUE_APP_API_BASE_URL: '',
        VUE_APP_UPLOAD_BASE_URL: '',
        ...overrides
      }
    }
  )
}

test('non-production defaults to the isolated V2 API', () => {
  const result = evaluateConfig()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'http://127.0.0.1:18099/api')
})

test('production refuses an implicit development fallback', () => {
  const result = evaluateConfig({ NODE_ENV: 'production' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /required for a production mini-program build/)
})

for (const forbidden of [
  'http://www.horselink.cn/api',
  'http://www.horselink.cn./api',
  'http://82.156.67.62/api',
  'http://127.0.0.1:8099/api'
]) {
  test(`non-production rejects ${forbidden}`, () => {
    const result = evaluateConfig({ VUE_APP_API_BASE_URL: forbidden })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cannot target (a live endpoint|live API port)/)
  })
}
