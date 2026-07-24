import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DAILY_SCHEDULE_FIELDS } from '../src/utils/reporting.js'

const productionScheduleSource = readFileSync(
  new URL('../src/views/reporting/ProductionSchedules.vue', import.meta.url),
  'utf8'
)

function dailyProductionColumns(source) {
  return source.match(
    /<el-table-column\s+v-for="item in DAILY_SCHEDULE_FIELDS"[\s\S]*?<\/el-table-column>/
  )?.[0] || ''
}

test('daily production keeps all six production-line columns centered', () => {
  assert.equal(DAILY_SCHEDULE_FIELDS.length, 6)

  const columns = dailyProductionColumns(productionScheduleSource)
  assert.ok(columns)
  assert.match(columns, /align="center"/)
  assert.match(columns, /header-align="center"/)
  assert.match(columns, /class="table-number"/)
  assert.match(productionScheduleSource, /\.table-number :deep\(\.el-input__inner\) \{ text-align: center; \}/)
})

test('daily production uses compact desktop widths and centers its numeric editor', () => {
  const columns = dailyProductionColumns(productionScheduleSource)

  assert.match(columns, /:min-width="item\.key === 'transferCaseLine' \? 128 : 116"/)
  assert.match(productionScheduleSource, /<el-table-column label="日期" width="110" fixed="left">/)
  assert.match(productionScheduleSource, /<el-table-column label="合计" width="88" align="right" fixed="right">/)
  assert.match(
    productionScheduleSource,
    /\.table-number \{ display: block; width: 92px; max-width: 100%; min-width: 0; margin-inline: auto; \}/
  )
})
