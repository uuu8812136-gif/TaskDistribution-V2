import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceExtensions = new Set(['.css', '.html', '.js', '.json', '.scss', '.ts', '.vue'])
const ignoredDirectories = new Set(['node_modules', 'unpackage'])

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) return []

    const absolutePath = path.join(directory, entry)
    if (statSync(absolutePath).isDirectory()) return sourceFiles(absolutePath)
    return sourceExtensions.has(path.extname(entry)) ? [absolutePath] : []
  })
}

test('all mini-program /static references resolve to source assets', () => {
  const missing = []
  const referencePattern = /(?:@)?\/static\/[^\s'"`)<}]+/g

  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8')
    for (const reference of source.match(referencePattern) || []) {
      const relativeAsset = reference
        .replace(/^@?\/static\//, '')
        .split(/[?#]/, 1)[0]
      const assetPath = path.join(root, 'static', relativeAsset)

      if (!existsSync(assetPath)) {
        missing.push(`${path.relative(root, file)} -> ${reference}`)
      }
    }
  }

  assert.deepEqual(missing, [], `Missing mini-program static assets:\n${missing.join('\n')}`)
})
