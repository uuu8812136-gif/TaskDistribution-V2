import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  cacheRoutineRecord,
  defaultRoutineRecordDateFilters,
  normalizedRoutineType,
  readCachedRoutineRecord,
  routineRecordAbnormalCount,
  routineRecordDateRange,
  routineRecordItemRows,
  routineRecordItemName,
  routineRecordOperatorName,
  routineRecordPhotos,
  routineRecordPlanDue,
  routineRecordPlanStart,
  routineRecordPlateNumber,
  routineRecordRuleName
} from '../utils/equipmentRoutineRecords.js'

const pagesConfig = JSON.parse(readFileSync(new URL('../pages.json', import.meta.url), 'utf8'))
const apiSource = readFileSync(new URL('../api/index.js', import.meta.url), 'utf8')
const scanSource = readFileSync(new URL('../pages/equipment/scan.vue', import.meta.url), 'utf8')
const equipmentDetailSource = readFileSync(new URL('../pages/equipment/detail.vue', import.meta.url), 'utf8')
const recordListSource = readFileSync(new URL('../pages/equipment/routine-record-list.vue', import.meta.url), 'utf8')
const recordDetailSource = readFileSync(new URL('../pages/equipment/routine-record-detail.vue', import.meta.url), 'utf8')

test('routine record date filters use exact Shanghai day boundaries', () => {
  assert.deepEqual(defaultRoutineRecordDateFilters('2030-01-31T16:30:00.000Z'), {
    startDate: '2030-02-01',
    endDate: '2030-02-28'
  })
  assert.deepEqual(routineRecordDateRange('2032-02-01', '2032-02-29'), {
    from: '2032-02-01T00:00:00+08:00',
    to: '2032-02-29T23:59:59.999+08:00'
  })
  assert.throws(() => routineRecordDateRange('2030-02-30', '2030-03-01'), /有效日期/)
  assert.throws(() => routineRecordDateRange('2030-03-02', '2030-03-01'), /不能晚于/)
  assert.equal(normalizedRoutineType('inspection'), 'INSPECTION')
  assert.equal(normalizedRoutineType('OTHER'), '')
})

test('routine record helpers align plans, equipment and checklist details', () => {
  const record = {
    _id: 'record-1',
    planScheduledFor: '2030-02-02T00:00:00.000Z',
    planDueAt: '2030-02-02T04:00:00.000Z',
    scheduledFor: 'legacy-value',
    plan: {
      scheduledFor: 'plan-fallback-start',
      dueAt: 'plan-fallback-due'
    },
    equipment: {
      name: '牵引车',
      assetCode: 'ASSET-001',
      plateNumber: '鲁A12345'
    },
    performedByUser: { name: '测试执行人' },
    ruleSnapshot: {
      name: '每日点检',
      checklistItems: [{ key: 'brake', name: '制动系统', description: '检查制动状态' }]
    },
    itemResults: [
      { itemKey: 'brake', result: 'ABNORMAL', note: '制动力不足' },
      { itemKey: 'light', result: 'NORMAL', note: '' }
    ],
    photoEvidence: [{ fileId: 'photo-1', address: '现场一号位' }],
    photoFileIds: ['photo-1', 'photo-2']
  }
  assert.equal(routineRecordPlanStart(record), record.planScheduledFor)
  assert.equal(routineRecordPlanDue(record), record.planDueAt)
  assert.equal(routineRecordPlateNumber(record), '鲁A12345')
  assert.equal(routineRecordOperatorName(record), '测试执行人')
  assert.equal(routineRecordRuleName(record), '每日点检')
  assert.equal(routineRecordItemName(record, record.itemResults[0], 0), '制动系统')
  assert.equal(routineRecordItemName(record, record.itemResults[1], 1), '项目 2')
  assert.equal(routineRecordAbnormalCount(record), 1)
  assert.deepEqual(routineRecordPhotos(record), [
    { fileId: 'photo-1', address: '现场一号位' },
    { fileId: 'photo-2' }
  ])
  assert.equal(routineRecordPlanStart({ plan: { scheduledFor: 'plan-start' } }), 'plan-start')
  assert.equal(routineRecordPlanStart({ scheduledFor: 'legacy-start' }), 'legacy-start')
  assert.equal(routineRecordPlanDue({ plan: { dueAt: 'plan-due' } }), 'plan-due')

  const orderedRows = routineRecordItemRows({
    ruleSnapshot: {
      checklistItems: [
        { key: 'second', name: '第二项', sortOrder: 2 },
        { key: 'first', name: '第一项', description: '先检查', sortOrder: 1 }
      ]
    },
    itemResults: [{ itemKey: 'second', result: 'NORMAL', note: '' }]
  })
  assert.deepEqual(orderedRows, [
    {
      itemKey: 'first',
      result: 'UNRECORDED',
      note: '',
      itemName: '第一项',
      itemDescription: '先检查'
    },
    {
      itemKey: 'second',
      result: 'NORMAL',
      note: '',
      itemName: '第二项',
      itemDescription: ''
    }
  ])
})

test('temporary routine record cache is team-scoped and expires', () => {
  const record = { _id: 'record-cache-1', overallResult: 'NORMAL' }
  const userA = { userId: 'user-a', activeTeamId: 'team-a' }
  const userB = { userId: 'user-b', activeTeamId: 'team-a' }
  cacheRoutineRecord(record, { teamId: 'team-a', cacheIdentity: userA, now: 1000 })
  assert.equal(readCachedRoutineRecord('record-cache-1', {
    teamId: 'team-a',
    cacheIdentity: userA,
    now: 2000
  }), record)
  assert.equal(readCachedRoutineRecord('record-cache-1', {
    teamId: 'team-b',
    cacheIdentity: userA,
    now: 2000
  }), null)
  assert.equal(readCachedRoutineRecord('record-cache-1', {
    teamId: 'team-a',
    cacheIdentity: userB,
    now: 2000
  }), null)
  assert.equal(readCachedRoutineRecord('record-cache-1', {
    teamId: 'team-a',
    cacheIdentity: userA,
    now: 302001
  }), null)
  assert.equal(readCachedRoutineRecord('record-cache-1', {
    teamId: 'team-a',
    cacheIdentity: { userId: '', activeTeamId: 'team-a' },
    now: 2000
  }), null)
})

test('scan and equipment detail expose independent inspection and maintenance records', () => {
  assert.match(scanSource, />点检记录</)
  assert.match(scanSource, />保养记录</)
  assert.match(scanSource, /openRoutineRecords\('INSPECTION'\)/)
  assert.match(scanSource, /openRoutineRecords\('MAINTENANCE'\)/)
  assert.match(equipmentDetailSource, />点检记录</)
  assert.match(equipmentDetailSource, />保养记录</)
  assert.match(equipmentDetailSource, /pages\/equipment\/routine-record-list/)
  assert.match(scanSource, /本月稽查情况/, 'the existing monthly summary must remain available')
  assert.match(equipmentDetailSource, /本月稽查情况/, 'the existing monthly summary must remain available')
})

test('routine record pages are registered and preserve scoped paginated queries', () => {
  assert.ok(pagesConfig.pages.some(({ path }) => path === 'pages/equipment/routine-record-list'))
  assert.ok(pagesConfig.pages.some(({ path }) => path === 'pages/equipment/routine-record-detail'))
  assert.match(apiSource, /getEquipmentRoutineRecord\s*=\s*\(recordId/)
  assert.match(apiSource, /equipment\/routine-records\/\$\{encodeURIComponent\(recordId\)\}/)
  assert.match(recordListSource, /equipmentId:\s*equipmentId\.value/)
  assert.match(recordListSource, /routineType:\s*routineType\.value/)
  assert.match(recordListSource, /routineRecordDateRange\(startDate\.value, endDate\.value\)/)
  assert.match(recordListSource, /page:\s*targetPage/)
  assert.match(recordListSource, /pageSize/)
  assert.match(recordListSource, /onReachBottom\(\(\)\s*=>\s*loadRecords\(false\)\)/)
  assert.match(recordListSource, /userStore\.isGlobalReadOnly\s*\?\s*teamId\.value\s*:\s*''/)
  assert.match(recordListSource, /if \(reset\) \{[\s\S]*records\.value = \[\][\s\S]*page\.value = 0[\s\S]*total\.value = 0/)
  assert.match(recordListSource, /records\.length === 0[\s\S]*@click="loadRecords\(true\)"/)
  assert.match(recordListSource, /records\.length > 0[\s\S]*@click="loadRecords\(false\)"/)
})

test('routine record detail presents PC-aligned plan, result and photo evidence', () => {
  assert.match(recordDetailSource, /getEquipmentRoutineRecord/)
  assert.match(recordDetailSource, /routineRecordPlanStart\(record\)/)
  assert.match(recordDetailSource, /routineRecordPlanDue\(record\)/)
  assert.match(recordDetailSource, /关联计划编号/)
  assert.match(recordDetailSource, /计划窗口/)
  assert.match(recordDetailSource, /计划周期标识/)
  assert.match(recordDetailSource, /逐项结果/)
  assert.match(recordDetailSource, /UNRECORDED:\s*'未记录'/)
  assert.match(recordDetailSource, /异常汇总/)
  assert.match(recordDetailSource, /routineRecordItemName\(record, item, index\)/)
  assert.match(recordDetailSource, /downloadPrivateFile\([\s\S]*photo\.fileId[\s\S]*requestParams\(\)[\s\S]*silentError: true/)
  assert.match(recordDetailSource, /uni\.previewImage/)
  assert.match(recordDetailSource, /locationStatusLabel/)
  assert.match(recordDetailSource, /watermarkText/)
  assert.match(recordDetailSource, /readCachedRoutineRecord\(recordId\.value, \{[\s\S]*teamId: cacheScopeTeamId\(\)[\s\S]*cacheIdentity: userStore\.cacheIdentity/)
  assert.match(recordDetailSource, /routeUnavailable = \[404, 405\]\.includes[\s\S]*!String\(error\?\.code \|\| ''\)\.trim\(\)/)
})
