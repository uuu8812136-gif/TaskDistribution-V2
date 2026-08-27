const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')

const baseUrl = process.env.ACCEPTANCE_BASE_URL || 'https://www.horselink.cn'
const outputDir = process.env.ACCEPTANCE_OUTPUT_DIR || 'E:/TaskDistribution-V2-ContractSummaryBuild-20260827/web-acceptance'
const localAssetDir = process.env.ACCEPTANCE_LOCAL_ASSET_DIR || 'E:/TaskDistribution-V2-ContractSummaryBuild-20260827/rebuild/assets'

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }))
    }).on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const index = await get(`${baseUrl}/`)
  if (index.statusCode !== 200) throw new Error(`home returned ${index.statusCode}`)
  const html = index.body.toString('utf8')
  const refs = [...new Set([...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)].map((match) => match[1]))]
  const assets = []
  const seen = new Set()
  const queue = refs.slice()
  while (queue.length) {
    const ref = queue.shift()
    if (seen.has(ref)) continue
    seen.add(ref)
    const url = new URL(ref, baseUrl).toString()
    const response = await get(url)
    if (response.statusCode !== 200) throw new Error(`${ref} returned ${response.statusCode}`)
    const bodyText = response.body.toString('utf8')
    const nestedRefs = [...bodyText.matchAll(/assets\/([A-Za-z0-9._-]+\.(?:js|css))/g)].map((match) => `/assets/${match[1]}`)
    for (const nested of nestedRefs) if (!seen.has(nested)) queue.push(nested)
    const localPath = path.join(localAssetDir, path.basename(new URL(url).pathname))
    const localExists = fs.existsSync(localPath)
    const sha256 = crypto.createHash('sha256').update(response.body).digest('hex')
    const localSha256 = localExists ? crypto.createHash('sha256').update(fs.readFileSync(localPath)).digest('hex') : null
    assets.push({
      ref,
      statusCode: response.statusCode,
      bytes: response.body.length,
      sha256,
      localExists,
      localSha256,
      matchesLocal: localExists && localSha256 === sha256
    })
    const localName = path.join(outputDir, `online-${path.basename(new URL(url).pathname)}`)
    fs.writeFileSync(localName, response.body)
  }
  const result = { checkedAt: new Date().toISOString(), baseUrl, localAssetDir, indexBytes: index.body.length, assets }
  fs.writeFileSync(path.join(outputDir, 'web-asset-acceptance.json'), JSON.stringify(result, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
