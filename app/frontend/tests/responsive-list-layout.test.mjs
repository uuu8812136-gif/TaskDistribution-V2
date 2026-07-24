import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskListSource = readFileSync(
  new URL('../src/views/tasks/TaskList.vue', import.meta.url),
  'utf8'
)
const formatSource = readFileSync(
  new URL('../src/utils/format.js', import.meta.url),
  'utf8'
)
const mainLayoutSource = readFileSync(
  new URL('../src/layouts/MainLayout.vue', import.meta.url),
  'utf8'
)
const globalStyleSource = readFileSync(
  new URL('../src/assets/styles/main.scss', import.meta.url),
  'utf8'
)
const loginSource = readFileSync(new URL('../src/views/Login.vue', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('task list uses compact reachable pagination on narrow screens', () => {
  assert.match(taskListSource, /:pager-count="5"/)
  assert.match(taskListSource, /\.pagination \{[\s\S]*?width: 100%;[\s\S]*?overflow-x: auto;/)
  assert.match(taskListSource, /\.pagination :deep\(\.el-pagination__total\),/)
  assert.match(taskListSource, /\.pagination :deep\(\.el-pagination__sizes\),/)
  assert.match(taskListSource, /\.pagination :deep\(\.el-pagination__jump\)/)
})

test('task tag type maps only expose valid Element Plus tag types', () => {
  const allowedTypes = new Set(['primary', 'success', 'info', 'warning', 'danger'])
  const typeMaps = [...formatSource.matchAll(/export const (?:taskStatusType|priorityType) = \{([\s\S]*?)\n\}/g)]

  assert.equal(typeMaps.length, 2)
  for (const [, body] of typeMaps) {
    const values = [...body.matchAll(/:\s*'([^']*)'/g)].map((match) => match[1])
    assert.ok(values.length > 0)
    assert.ok(values.every((value) => allowedTypes.has(value)))
  }
})

test('authenticated shell and global mobile containers prefer dynamic viewport height', () => {
  assert.match(mainLayoutSource, /height: 100vh;\s+height: 100dvh;/)
  assert.match(globalStyleSource, /max-height: calc\(100vh - 48px\);\s+max-height: calc\(100dvh - 48px\);/)
  assert.match(globalStyleSource, /min-height: calc\(100vh - 64px\);\s+min-height: calc\(100dvh - 64px\);/)
  assert.match(globalStyleSource, /max-height: calc\(100vh - 24px\);\s+max-height: calc\(100dvh - 24px\);/)
})

test('mobile authenticated shell removes the closed sidebar and starts main content at x zero', () => {
  assert.match(mainLayoutSource, /v-if="!isMobile \|\| !isCollapse"/)
  assert.match(
    mainLayoutSource,
    /@media \(max-width: 768px\) \{[\s\S]*?\.layout-container \{[\s\S]*?display: block;[\s\S]*?width: 100%;[\s\S]*?overflow-x: hidden;/
  )
  assert.match(
    mainLayoutSource,
    /@media \(max-width: 768px\) \{[\s\S]*?\.layout-main \{[\s\S]*?width: 100%;[\s\S]*?margin: 0;[\s\S]*?overflow-x: hidden;[\s\S]*?transform: none;/
  )
  assert.match(
    mainLayoutSource,
    /@media \(max-width: 768px\) \{[\s\S]*?\.main-content \{[\s\S]*?max-width: 100%;[\s\S]*?min-width: 0;[\s\S]*?margin: 0;/
  )
})

test('browser title and visible product headings use one product name', () => {
  const productName = 'Horselink（马链）管理系统'

  assert.match(indexSource, new RegExp(`<title>${productName}</title>`))
  assert.match(loginSource, new RegExp(`<h1>${productName}</h1>`))
  assert.match(mainLayoutSource, new RegExp(`<span class="logo-title">${productName}</span>`))
})
