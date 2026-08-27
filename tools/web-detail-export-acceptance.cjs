const fs = require('fs')
const path = require('path')
const playwright = require('C:/AIApps/yuntuike-assistant/_internal/playwright/driver/package/index.js')

const baseUrl = process.env.ACCEPTANCE_BASE_URL || 'https://www.horselink.cn'
const outputDir = process.env.ACCEPTANCE_OUTPUT_DIR || 'E:/TaskDistribution-V2-ContractSummaryBuild-20260827/web-acceptance'
const credentialsPath = process.env.ACCEPTANCE_CREDENTIALS || 'E:/TaskDistribution-V2-Offhost/production-cutover-20260819/production-login-credentials.txt'
const browserPath = process.env.ACCEPTANCE_BROWSER || 'C:/AIApps/yuntuike-assistant/_internal/bundled/ms-playwright/chromium-1200/chrome-win64/chrome.exe'
const userDataDir = process.env.ACCEPTANCE_USER_DATA_DIR || 'E:/TaskDistribution-V2-ContractSummaryBuild-20260827/web-acceptance/chromium-profile'

function parseCredentials(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const value = (label) => {
    const match = raw.match(new RegExp(`${label}[:：]\\s*(.+)`))
    if (!match) throw new Error(`Missing credential: ${label}`)
    return match[1].trim()
  }
  return { username: value('管理员账号'), password: value('管理员密码') }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const credentials = parseCredentials(credentialsPath)
  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = await context.newPage({ viewport: { width: 1440, height: 1000 } })
  const result = { startedAt: new Date().toISOString(), baseUrl, errors: [], requests: [] }
  page.on('pageerror', (error) => result.errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error') result.errors.push(`console: ${message.text()}`) })
  page.on('requestfailed', (request) => result.errors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`))
  page.on('request', (request) => {
    if (request.url().includes('/contracts/')) result.requests.push({ method: request.method(), url: request.url() })
  })

  try {
    await page.goto(`${baseUrl}/contracts/suppliers`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    if (page.url().includes('/login')) {
      const username = await firstVisible(page, ['#login-username', 'input[autocomplete="username"]'])
      const password = await firstVisible(page, ['#login-password', 'input[autocomplete="current-password"]'])
      if (!username || !password) throw new Error('login controls not found')
      await username.fill(credentials.username)
      await password.fill(credentials.password)
      await page.waitForTimeout(1200)
      const selected = page.locator('.team-select .el-select__selected-item, .team-select .el-select__placeholder').first()
      const selectedText = String(await selected.textContent().catch(() => '')).trim()
      if (!selectedText || selectedText === '请选择项目团队') {
        const wrapper = page.locator('.team-select .el-select__wrapper').first()
        await wrapper.click({ force: true })
        await page.waitForTimeout(200)
        const option = await firstVisible(page, ['.el-select-dropdown__item:not(.is-disabled)', '[role="option"]'])
        if (!option) throw new Error('team option not found')
        await option.click()
      }
      const submit = await firstVisible(page, ['button[type="submit"]', '.login-button', 'button:has-text("登录")'])
      if (!submit) throw new Error('login submit not found')
      await submit.click()
      await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 60000 }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
      await page.goto(`${baseUrl}/contracts/suppliers`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    }
    await page.waitForTimeout(800)
    const detailButton = page.getByRole('button', { name: '导出汇总', exact: true }).first()
    if (!(await detailButton.count()) || !(await detailButton.isVisible().catch(() => false))) {
      throw new Error('三级汇总导出按钮未显示')
    }
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 })
    await detailButton.click()
    const download = await downloadPromise
    const target = path.join(outputDir, 'supplier-contract-detail-export.xlsx')
    await download.saveAs(target)
    result.url = page.url()
    result.text = String(await page.locator('body').innerText()).replace(/\\s+/g, ' ').trim()
    result.download = {
      downloaded: true,
      path: target,
      suggestedFilename: download.suggestedFilename(),
      bytes: fs.statSync(target).size
    }
  } catch (error) {
    result.error = error.stack || error.message
    process.exitCode = 1
  } finally {
    result.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outputDir, 'web-detail-export-acceptance.json'), JSON.stringify(result, null, 2), 'utf8')
    await context.close()
  }
  process.stdout.write(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\\n`)
  process.exitCode = 1
})
