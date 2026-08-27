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
  const pick = (label) => {
    const match = raw.match(new RegExp(`${label}[:：]\\s*(.+)`))
    if (!match) throw new Error(`Missing credential: ${label}`)
    return match[1].trim()
  }
  return {
    username: pick('管理员账号'),
    password: pick('管理员密码')
  }
}

function ensureOutputDir() {
  fs.mkdirSync(outputDir, { recursive: true })
}

function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim()
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function capturePage(page, name) {
  const safeName = name.replace(/[^a-z0-9_-]+/gi, '-')
  const file = path.join(outputDir, `${safeName}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

async function main() {
  ensureOutputDir()
  const credentials = parseCredentials(credentialsPath)
  const results = {
    startedAt: new Date().toISOString(),
    baseUrl,
    pages: {},
    requests: [],
    errors: []
  }

  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
  const page = await context.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('request', (request) => {
    if (request.url().includes('/api/')) {
      results.requests.push({ method: request.method(), url: request.url().replace(/([?&](token|authorization|password)=)[^&]*/gi, '$1[redacted]') })
    }
  })
  page.on('pageerror', (error) => results.errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') results.errors.push(`console: ${message.text()}`)
  })

  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    results.pages.login = {
      url: page.url(),
      title: await page.title(),
      text: cleanText(await page.locator('body').innerText())
    }
    const username = await firstVisible(page, ['#login-username', 'input[autocomplete="username"]', 'input[placeholder*="用户名"]'])
    const password = await firstVisible(page, ['#login-password', 'input[autocomplete="current-password"]', 'input[placeholder*="密码"]'])
    const team = await firstVisible(page, ['#login-team', '.team-select input', 'input[placeholder*="项目团队"]'])
    if (!username || !password || !team) throw new Error('Login controls not found')
    await username.fill(credentials.username)
    await password.fill(credentials.password)

    // Element Plus select: click the visible wrapper and choose the first option.
    const selectedTeam = page.locator('.team-select .el-select__selected-item, .team-select .el-select__placeholder').first()
    const selectedText = cleanText(await selectedTeam.textContent().catch(() => ''))
    if (!selectedText || selectedText === '请选择项目团队') {
      const teamWrapper = page.locator('.team-select .el-select__wrapper').first()
      await teamWrapper.click().catch(async () => { if (team) await team.click({ force: true }) })
      const option = await firstVisible(page, ['.el-select-dropdown__item:not(.is-disabled)', '[role="option"]'])
      if (!option) throw new Error('Project team option not found')
      await option.click()
    }

    const submit = await firstVisible(page, ['button[type="submit"]', '.login-button', 'button:has-text("登录")'])
    if (!submit) throw new Error('Login submit button not found')
    await submit.click()
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 60000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    results.login = { url: page.url(), text: cleanText(await page.locator('body').innerText()) }

    const routes = [
      ['transport', '/reporting/transport'],
      ['contracts', '/contracts/suppliers'],
      ['production', '/reporting/production'],
      ['myTasks', '/tasks/my']
    ]
    for (const [name, route] of routes) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(800)
      results.pages[name] = {
        url: page.url(),
        title: await page.title(),
        text: cleanText(await page.locator('body').innerText()),
        screenshot: await capturePage(page, name)
      }
    }

    // Download the supplier detail export when the page exposes an export action.
    await page.goto(`${baseUrl}/contracts/suppliers`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
    const exportButton = await firstVisible(page, ['button:has-text("导出")', '[aria-label*="导出"]'])
    if (exportButton) {
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
      await exportButton.click()
      const download = await downloadPromise
      if (download) {
        const target = path.join(outputDir, 'supplier-contract-export.xlsx')
        await download.saveAs(target)
        results.contractExport = { downloaded: true, path: target, suggestedFilename: download.suggestedFilename() }
      } else {
        results.contractExport = { downloaded: false, reason: 'No download event' }
      }
    } else {
      results.contractExport = { downloaded: false, reason: 'Export button not visible on list page' }
    }
  } finally {
    results.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outputDir, 'web-public-acceptance.json'), JSON.stringify(results, null, 2), 'utf8')
    await context.close()
  }
  process.stdout.write(JSON.stringify(results, null, 2))
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\\n`)
  process.exitCode = 1
})
