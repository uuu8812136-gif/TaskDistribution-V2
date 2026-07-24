import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const commonPath = fileURLToPath(new URL('../linux/v2-test-release-common.sh', import.meta.url))
const common = fs.readFileSync(commonPath, 'utf8')

const releaseScripts = [
  'prepare-v2-test-candidate.sh',
  'create-v2-test-release-backup.sh',
  'activate-v2-test-candidate.sh',
  'verify-v2-test-release.sh',
  'restore-v2-test-backup.sh',
  'activate-v2-test-restored-rollback.sh'
].map((name) => ({
  name,
  source: fs.readFileSync(fileURLToPath(new URL(`../linux/${name}`, import.meta.url)), 'utf8')
}))

test('release guard pins V2 to 38130 -> 18130 and rejects legacy production ports', () => {
  assert.match(common, /readonly V2_EXPECTED_INNER_WEB_PORT='18130'/)
  assert.match(common, /readonly V2_EXPECTED_TUNNEL_PORT='38130'/)
  assert.match(common, /readonly LEGACY_EXPECTED_API_PORT='8099'/)
  assert.match(common, /readonly LEGACY_EXPECTED_TUNNEL_PORT='38080'/)
  assert.match(
    common,
    /-R 127\.0\.0\.1:\$\{V2_EXPECTED_TUNNEL_PORT\}:127\.0\.0\.1:\$\{V2_EXPECTED_INNER_WEB_PORT\}/
  )
  assert.match(common, /V2 tunnel unit references a legacy production port/)
})

test('legacy guard verifies direct 8099, local Nginx and the public 38080 path without writes', () => {
  assert.match(common, /http:\/\/127\.0\.0\.1:\$\{LEGACY_EXPECTED_API_PORT\}\//)
  assert.match(common, /http:\/\/127\.0\.0\.1\/health\?release_guard=\$\{cache_bust\}/)
  assert.match(common, /\$\{LEGACY_PUBLIC_ORIGIN\}\/health\?release_guard=\$\{cache_bust\}/)
  assert.match(common, /publicHealth\.status !== local\.status/)
  assert.match(common, /publicHealth\.service !== local\.service/)
  assert.doesNotMatch(common, /systemctl\s+(?:stop|start|restart)\s+"?\$LEGACY_/)
})

test('every release phase fails closed on the shared legacy boundary guard', () => {
  for (const { name, source } of releaseScripts) {
    assert.match(source, /v2_assert_legacy_healthy/, `${name} must call the shared legacy guard`)
    assert.doesNotMatch(
      source,
      /systemctl\s+(?:stop|start|restart)\s+[^\n]*(?:LEGACY_|38080|8099)/,
      `${name} must never mutate legacy services or ports`
    )
  }
})
