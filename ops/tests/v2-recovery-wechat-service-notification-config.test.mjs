import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptPath = path.join(
  repositoryRoot,
  'ops/windows/Set-V2RecoveryWechatServiceNotification.ps1'
)
const packageBuilderPath = path.join(
  repositoryRoot,
  'ops/windows/New-V2TestReleasePackage.ps1'
)
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function invokeHarness(body) {
  const harnessRoot = path.join(repositoryRoot, 'work', '.wechat-config-tests')
  fs.mkdirSync(harnessRoot, { recursive: true })
  const harness = path.join(harnessRoot, `${crypto.randomUUID()}.ps1`)
  fs.writeFileSync(harness, `\uFEFF. '${scriptPath.replaceAll("'", "''")}'\n${body}\n`)
  try {
    return spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harness
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true
    })
  } finally {
    fs.rmSync(harness, { force: true })
  }
}

test('operator script exposes no AppSecret command-line parameter or secret output', () => {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const parameterBlock = source.slice(source.indexOf('param('), source.indexOf('$ErrorActionPreference'))
  assert.doesNotMatch(parameterBlock, /AppSecret/i)
  assert.match(source, /Read-Host[^\r\n]+-AsSecureString/)
  assert.match(source, /secretInCommandLine\s*=\s*\$false/)
  assert.match(source, /temporarySecretFileCreated\s*=\s*\$false/)
  assert.doesNotMatch(source, /Write-(?:Output|Host|Information)[^\r\n]*(?:appSecret|secret)/i)
  assert.doesNotMatch(source, /(?:\.tmp|\.bak|Copy-Item)[^\r\n]*(?:app\.env|environmentFile)/i)
})

test('environment update preserves unrelated content and replaces each WeChat key exactly once', () => {
  const result = invokeHarness(String.raw`
$existing = @'
APP_ENV=production
# keep this comment
JWT_SECRET=unrelated-test-value
WECHAT_SERVICE_NOTIFICATION_ENABLED=false
WECHAT_MINIPROGRAM_APP_SECRET=old-value
WECHAT_MINIPROGRAM_APP_SECRET=duplicate-value
'@
$updates = [ordered]@{
  WECHAT_SERVICE_NOTIFICATION_ENABLED='true'
  WECHAT_MINIPROGRAM_APP_ID='wxd8f18985dfd63b89'
  WECHAT_MINIPROGRAM_APP_SECRET=('a' * 32)
  WECHAT_SERVICE_NOTIFICATION_TEMPLATE_ID='8_Z_s5GtNddhMm3SfH0R6pyR4oeoTJMKaPKcRCtjVv8'
  WECHAT_SERVICE_NOTIFICATION_PAGE='pages/message/index'
  WECHAT_SERVICE_NOTIFICATION_ACTIVATED_AT='2026-08-19T00:00:00.000Z'
  WECHAT_SERVICE_NOTIFICATION_WORKER_INTERVAL_MS='30000'
}
$updated = ConvertTo-UpdatedEnvironmentContent -ExistingContent $existing -Updates $updates
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($updated))
`)
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const updated = Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
  assert.match(updated, /^APP_ENV=production$/m)
  assert.match(updated, /^# keep this comment$/m)
  assert.match(updated, /^JWT_SECRET=unrelated-test-value$/m)
  for (const key of [
    'WECHAT_SERVICE_NOTIFICATION_ENABLED',
    'WECHAT_MINIPROGRAM_APP_ID',
    'WECHAT_MINIPROGRAM_APP_SECRET',
    'WECHAT_SERVICE_NOTIFICATION_TEMPLATE_ID',
    'WECHAT_SERVICE_NOTIFICATION_PAGE',
    'WECHAT_SERVICE_NOTIFICATION_ACTIVATED_AT',
    'WECHAT_SERVICE_NOTIFICATION_WORKER_INTERVAL_MS'
  ]) {
    assert.equal(updated.match(new RegExp(`^${key}=`, 'gm'))?.length, 1, key)
  }
  assert.match(updated, /^WECHAT_MINIPROGRAM_APP_SECRET=a{32}$/m)
  assert.doesNotMatch(updated, /old-value|duplicate-value/)
})

test('immutable release allowlist includes the reviewed operator script', () => {
  const packageBuilder = fs.readFileSync(packageBuilderPath, 'utf8')
  assert.match(
    packageBuilder,
    /'ops\/windows\/Set-V2RecoveryWechatServiceNotification\.ps1'/
  )
})

test('validation rejects line-breaking or placeholder secrets before any file write', () => {
  const result = invokeHarness(String.raw`
$failed = 0
foreach ($candidate in @('replace-me-with-real-value', ('validprefix' + [char]10 + 'secondline'))) {
  try {
    Assert-WechatConfigurationValue -AppId 'wxd8f18985dfd63b89' -AppSecret $candidate -TemplateId '8_Z_s5GtNddhMm3SfH0R6pyR4oeoTJMKaPKcRCtjVv8' -Page 'pages/message/index'
  } catch { $failed++ }
}
if ($failed -ne 2) { exit 7 }
`)
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
})

test('direct writer updates an existing E-drive fixture without creating sibling files', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(repositoryRoot, 'work', '.wechat-env-write-'))
  const fixture = path.join(fixtureRoot, 'app.env')
  fs.writeFileSync(fixture, 'APP_ENV=production\r\n', 'utf8')
  try {
    const result = invokeHarness(String.raw`
$path = '${fixture.replaceAll("'", "''")}'
$content = @('APP_ENV=production', 'TEST_VALUE=updated', '') -join [Environment]::NewLine
Write-ExistingFileWithoutTemporaryCopy -Path $path -Content $content
`)
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    assert.equal(fs.readFileSync(fixture, 'utf8'), 'APP_ENV=production\r\nTEST_VALUE=updated\r\n')
    assert.deepEqual(fs.readdirSync(fixtureRoot), ['app.env'])
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
