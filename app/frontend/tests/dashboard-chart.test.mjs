import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboardSource = readFileSync(
  new URL('../src/views/Dashboard.vue', import.meta.url),
  'utf8'
)

test('dashboard uses the ECharts 6 outer-bounds layout without legacy warnings', () => {
  assert.doesNotMatch(dashboardSource, /containLabel\s*:/)
  assert.match(dashboardSource, /outerBoundsMode:\s*'same'/)
  assert.match(dashboardSource, /outerBoundsContain:\s*'axisLabel'/)
})

test('dashboard renders explicit empty states instead of zero-value charts', () => {
  assert.match(dashboardSource, /stillShowZeroSum:\s*false/)
  assert.match(dashboardSource, /v-if="statusChartHasData"/)
  assert.match(dashboardSource, /description="暂无任务状态数据"/)
  assert.match(dashboardSource, /v-if="priorityChartHasData"/)
  assert.match(dashboardSource, /description="暂无任务优先级数据"/)
  assert.match(dashboardSource, /Number\(value\) > 0/)
})
