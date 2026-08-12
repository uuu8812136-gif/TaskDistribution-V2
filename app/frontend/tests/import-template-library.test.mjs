import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')
const apiSource = read('../src/api/importTemplate.js')
const pageSource = read('../src/views/templates/ImportTemplateLibrary.vue')
const routerSource = read('../src/router/index.js')
const layoutSource = read('../src/layouts/MainLayout.vue')

test('template library is a team-scoped route guarded by any relevant view or import permission', () => {
  assert.match(routerSource, /path: 'import-templates'/)
  assert.match(routerSource, /name: 'ImportTemplateLibrary'/)
  assert.match(routerSource, /permission: \[[\s\S]*?'equipment\.view'[\s\S]*?'equipment\.import'[\s\S]*?'contract\.supplier\.view'[\s\S]*?'contract\.supplier\.import'[\s\S]*?'contract\.settlement\.view'[\s\S]*?'contract\.settlement\.import'[\s\S]*?\]/)
  assert.match(routerSource, /permissionMatch: 'any'/)
  assert.match(routerSource, /allowedModes: \[SESSION_MODES\.TEAM\]/)
  assert.match(routerSource, /readOnlyAllowed: false/)
})

test('sidebar exposes one standalone template download entry only in team mode', () => {
  assert.match(layoutSource, /const canAccessImportTemplates = computed\(\(\) => \([\s\S]*?session\.isTeamMode[\s\S]*?session\.hasPermission\([\s\S]*?'equipment\.view'[\s\S]*?'equipment\.import'[\s\S]*?'contract\.supplier\.view'[\s\S]*?'contract\.supplier\.import'[\s\S]*?'contract\.settlement\.view'[\s\S]*?'contract\.settlement\.import'[\s\S]*?'any'[\s\S]*?\)\)/)
  assert.match(layoutSource, /<el-menu-item v-if="canAccessImportTemplates" index="\/import-templates">[\s\S]*?<Download \/>[\s\S]*?模板下载/)
})

test('template library obtains a permission-filtered catalog and downloads by template id', () => {
  assert.match(apiSource, /url: '\/import-templates'/)
  assert.match(apiSource, /url: `\/import-templates\/\$\{encodeURIComponent\(templateId\)\}\/download`/)
  assert.match(apiSource, /responseType: 'blob'/)
  assert.match(pageSource, /const response = await getImportTemplates\(\)/)
  assert.match(pageSource, /Array\.isArray\(response\?\.templates\)/)
  assert.match(pageSource, /await downloadImportTemplate\(template\.id\)/)
  assert.match(pageSource, /safeDownloadFileName\(template\.fileName, template\.name\)/)
})

test('template library keeps loading, failure, empty and responsive list states distinct', () => {
  assert.match(pageSource, /v-if="loadError"/)
  assert.match(pageSource, /@click="loadTemplates">重新加载/)
  assert.match(pageSource, /当前账号没有可下载的导入模板/)
  assert.match(pageSource, /没有符合筛选条件的模板/)
  assert.match(pageSource, /const requestId = \+\+loadRequestId/)
  assert.match(pageSource, /if \(requestId !== loadRequestId\) return/)
  assert.match(pageSource, /\.desktop-template-list[\s\S]*?display: none;/)
  assert.match(pageSource, /\.mobile-template-list[\s\S]*?display: grid;/)
  assert.doesNotMatch(pageSource, /overflow-x:\s*(auto|scroll)/)
})
