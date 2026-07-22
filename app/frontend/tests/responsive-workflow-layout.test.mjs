import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const attendanceSource = readFileSync(
  new URL('../src/views/reporting/AttendanceReports.vue', import.meta.url),
  'utf8'
)
const repairsSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRepairs.vue', import.meta.url),
  'utf8'
)
const statusApplicationsSource = readFileSync(
  new URL('../src/views/equipment/EquipmentStatusApplications.vue', import.meta.url),
  'utf8'
)

test('attendance filters and pagination remain aligned and reachable at 390px', () => {
  assert.match(attendanceSource, /:pager-count="5"/)
  assert.match(attendanceSource, /\.pagination-row \{[\s\S]*?display: flex;[\s\S]*?justify-content: space-between;/)
  assert.match(attendanceSource, /@media \(max-width: 760px\) \{[\s\S]*?\.toolbar > \*,[\s\S]*?\.date-range \{[\s\S]*?width: 100%;/)
  assert.match(attendanceSource, /\.toolbar > \.el-button\.is-circle \{[\s\S]*?width: var\(--zl-control-height\);[\s\S]*?align-self: flex-end;/)
  assert.match(attendanceSource, /\.pagination-row \{[\s\S]*?width: 100%;[\s\S]*?flex-direction: column;[\s\S]*?overflow-x: auto;/)
})

test('repair refresh keeps its fixed circular width on narrow screens', () => {
  assert.match(repairsSource, /<el-button circle aria-label="刷新维修单"/)
  assert.match(repairsSource, /\.toolbar > \.el-button\.is-circle \{ width: var\(--zl-control-height\) !important; align-self: flex-end; \}/)
})

test('status application pagination uses a compact reachable mobile layout', () => {
  assert.match(statusApplicationsSource, /:pager-count="5"/)
  assert.match(statusApplicationsSource, /class="pagination"/)
  assert.match(statusApplicationsSource, /\.pagination \{ width: 100%; justify-content: flex-start; overflow-x: auto; padding-bottom: 4px; \}/)
})
