import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { compileScript, compileTemplate, parse } = require(
  '../../app/frontend/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js'
)
const root = fileURLToPath(new URL('..', import.meta.url))

async function collectVueFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'unpackage'].includes(entry.name)) return []
      return collectVueFiles(fullPath)
    }
    return entry.name.endsWith('.vue') ? [fullPath] : []
  }))
  return nested.flat()
}

const failures = []
const files = await collectVueFiles(root)
for (const filename of files) {
  const source = await readFile(filename, 'utf8')
  const result = parse(source, { filename })
  if (result.errors.length > 0) {
    failures.push(...result.errors.map((error) => `${relative(root, filename)}: ${String(error)}`))
    continue
  }

  const { descriptor } = result
  try {
    if (descriptor.script || descriptor.scriptSetup) {
      compileScript(descriptor, { id: relative(root, filename) })
    }
    if (descriptor.template) {
      const compiled = compileTemplate({
        source: descriptor.template.content,
        filename,
        id: relative(root, filename)
      })
      failures.push(...compiled.errors.map((error) => `${relative(root, filename)}: ${String(error)}`))
    }
  } catch (error) {
    failures.push(`${relative(root, filename)}: ${error.stack || error}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Parsed and compiled ${files.length} Vue SFC files`)
}
