import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildRoutineRulePayload,
  createRoutineRecordPhotoRequestGuard,
  isRoutinePlanRestDaySelectable,
  loadRoutineRecordPhotoPreview,
  routinePlanCancellationReasonLabel,
  routineRecordChecklistItems,
  routineRecordPerformerName,
  routineRecordPlanWindow,
  routineRecordPlateNumber
} from '../src/utils/equipment.js'
import { routeComponentKey } from '../src/utils/routeComponentKey.js'

const routineWorkflowSource = readFileSync(
  new URL('../../services/equipmentRoutineWorkflowService.js', import.meta.url),
  'utf8'
)

const workbenchSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRoutineWorkbench.vue', import.meta.url),
  'utf8'
)
const ruleDialogSource = readFileSync(
  new URL('../src/views/equipment/components/EquipmentRuleDialog.vue', import.meta.url),
  'utf8'
)
const rulesSource = readFileSync(
  new URL('../src/views/equipment/EquipmentRules.vue', import.meta.url),
  'utf8'
)
const detailSource = readFileSync(
  new URL('../src/views/equipment/EquipmentDetail.vue', import.meta.url),
  'utf8'
)
const routerSource = readFileSync(
  new URL('../src/router/index.js', import.meta.url),
  'utf8'
)
const mainLayoutSource = readFileSync(
  new URL('../src/layouts/MainLayout.vue', import.meta.url),
  'utf8'
)

test('routine rule payload retains configurable windows and pending location policy without team identity', () => {
  const payload = buildRoutineRulePayload({
    routineType: 'INSPECTION',
    categoryId: 'category-1',
    name: '班前点检',
    checklistItems: [{ name: '检查温度', required: true }],
    schedule: {
      mode: 'CALENDAR',
      calendar: { unit: 'WEEK', interval: 1, firstDueAt: '2030-01-14T23:00:00.000Z' }
    },
    photoPolicy: 'ON_ABNORMAL',
    abnormalNoteRequired: true,
    executionConfig: {
      timeZone: 'Asia/Shanghai',
      windows: [
        { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00', enabled: true },
        { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00', enabled: true }
      ],
      weeklyDay: 1,
      monthlyDay: 1,
      inspectionEscalationMinutes: 60,
      locationPolicy: 'PENDING_CONFIRMATION',
      locationPrecisionMeters: null
    },
    teamId: 'must-not-leak'
  })
  assert.deepEqual(payload.executionConfig.windows.map(({ startTime, endTime }) => [startTime, endTime]), [
    ['07:00', '09:00'],
    ['19:00', '21:00']
  ])
  assert.equal(payload.executionConfig.weeklyDay, 1)
  assert.equal(payload.executionConfig.locationPolicy, 'PENDING_CONFIRMATION')
  assert.equal(Object.hasOwn(payload, 'teamId'), false)
})

test('Web exposes a cross-device routine workbench, fixed export, exception actions, and editable windows', () => {
  assert.match(routerSource, /path:\s*'equipment\/routines'/)
  assert.match(workbenchSource, /执行计划与提醒/)
  assert.match(workbenchSource, /getEquipmentRoutineRecords/)
  assert.match(workbenchSource, /getEquipmentRoutinePlans/)
  assert.match(workbenchSource, /getEquipmentRoutineExceptions/)
  assert.match(workbenchSource, /transitionEquipmentRoutineException/)
  assert.match(workbenchSource, /exportEquipmentRoutineRecords/)
  assert.match(workbenchSource, /getEquipmentList/)
  assert.match(workbenchSource, /getEquipmentOptions/)
  assert.match(workbenchSource, /v-model="filters\.equipmentId"/)
  assert.match(workbenchSource, /v-model="filters\.orgUnitId"/)
  assert.match(workbenchSource, /v-model="filters\.overallResult"/)
  assert.match(workbenchSource, /v-model="filters\.exceptionStatus"/)
  assert.match(workbenchSource, /params\.overallResult = filters\.overallResult/)
  assert.match(workbenchSource, /params\.dateBasis = 'PLAN'/)
  assert.match(workbenchSource, /params\.status = filters\.exceptionStatus/)
  assert.match(ruleDialogSource, /添加窗口/)
  assert.match(ruleDialogSource, /inspectionEscalationMinutes/)
  assert.match(ruleDialogSource, /PENDING_CONFIRMATION/)
})

test('routine plans return and render the equipment custodian', () => {
  assert.match(
    routineWorkflowSource,
    /EquipmentAssetModel\.find\([\s\S]*?\.select\('_id assetCode name location plateNumber custodianUserId custodianDisplayName'\)/
  )
  const plansSection = workbenchSource.slice(
    workbenchSource.indexOf('<section v-if="activeTab === \'plans\'"'),
    workbenchSource.indexOf('<section v-else-if="activeTab === \'records\'"')
  )
  assert.ok(
    plansSection.indexOf('label="组织"') < plansSection.indexOf('label="使用人"'),
    '设备使用人应位于组织列之后'
  )
  assert.match(
    plansSection,
    /<el-table-column label="使用人" width="120" class-name="routine-plan-custodian-column" header-cell-class-name="routine-plan-custodian-header">/
  )
  assert.match(plansSection, /class="routine-plan-table"/)
  assert.match(plansSection, /row\.equipment\?\.custodianDisplayName \|\| '-'/)
})

test('routine workbench keeps its component mounted while tab query parameters change', () => {
  assert.match(routerSource, /path:\s*'equipment\/routines'[\s\S]*reuseQueryKeys:\s*\['tab', 'planId', 'exceptionId'\]/)
  assert.match(mainLayoutSource, /const routedComponentKey = computed/)
  assert.match(mainLayoutSource, /routeComponentKey\(route, session\.contextEpoch\)/)
  assert.match(workbenchSource, /route\.query\.exceptionId,[\s\S]*route\.query\.equipmentId/)
  assert.match(workbenchSource, /async function syncRouteFocus\(\)/)
  assert.match(workbenchSource, /if \(!pageActive \|\| route\.name !== 'EquipmentRoutineWorkbench'\) return/)
  assert.match(workbenchSource, /const nextTab = ROUTINE_TABS\.has\(routedTab\) \? routedTab : 'plans'/)
  assert.match(workbenchSource, /const nextEquipmentId = String\(route\.query\.equipmentId \|\| ''\)/)
  assert.match(workbenchSource, /if \(!teamChanged && !tabChanged && !focusChanged && !equipmentChanged\) return/)
  assert.match(workbenchSource, /filters\.equipmentId = nextEquipmentId/)

  const base = {
    path: '/equipment/routines',
    meta: { reuseQueryKeys: ['tab', 'planId', 'exceptionId'] },
    query: { tab: 'plans', teamId: 'team-a', planId: 'plan-a' },
    hash: ''
  }
  assert.equal(
    routeComponentKey(base, 3),
    routeComponentKey({ ...base, query: { tab: 'records', teamId: 'team-a' } }, 3)
  )
  const exceptionBase = {
    ...base,
    query: { tab: 'exceptions', teamId: 'team-a', exceptionId: 'exception-a' }
  }
  assert.equal(
    routeComponentKey(exceptionBase, 3),
    routeComponentKey({ ...exceptionBase, query: { tab: 'records', teamId: 'team-a' } }, 3)
  )
  assert.notEqual(
    routeComponentKey(base, 3),
    routeComponentKey({ ...base, query: { ...base.query, teamId: 'team-b' } }, 3)
  )
  assert.equal(
    routeComponentKey(base, 3),
    routeComponentKey({ ...base, query: { ...base.query, planId: 'plan-b' } }, 3)
  )
  assert.notEqual(
    routeComponentKey(base, 3),
    routeComponentKey({ ...base, query: { ...base.query, equipmentId: 'equipment-a' } }, 3)
  )
  assert.notEqual(routeComponentKey(base, 3), routeComponentKey(base, 4))
})

test('routine tab changes start the destination request without waiting for route replacement', () => {
  assert.match(workbenchSource, /async function changeTab\(requestedTab = activeTab\.value\)/)
  assert.match(workbenchSource, /const nextTab = ROUTINE_TABS\.has\(String\(requestedTab \|\| ''\)\)/)
  assert.match(workbenchSource, /activeTab\.value = nextTab/)
  assert.match(workbenchSource, /const routeUpdate = router\.replace\(/)
  assert.match(workbenchSource, /const dataLoad = loadActiveTab\(\)/)
  assert.match(workbenchSource, /await Promise\.all\(\[routeUpdate, dataLoad\]\)/)
  assert.doesNotMatch(workbenchSource, /await router\.replace\([\s\S]*?\)\s+await loadActiveTab\(\)\s+}\s+\n\s*watch/)
})

test('routine workbench refreshes focus when a new message targets the reused route', () => {
  assert.match(workbenchSource, /const nextPlanId = nextTab === 'plans' \? String\(requestedPlanId \|\| ''\) : ''/)
  assert.match(workbenchSource, /const nextExceptionId = nextTab === 'exceptions' \? String\(requestedExceptionId \|\| ''\) : ''/)
  assert.match(workbenchSource, /const focusChanged = \([\s\S]*nextPlanId !== focusedPlanId\.value[\s\S]*nextExceptionId !== focusedExceptionId\.value/)
  assert.match(workbenchSource, /focusedExceptionId\.value = nextExceptionId[\s\S]*focusedPlanId\.value = nextPlanId[\s\S]*await loadActiveTab\(\)/)
})

test('routine workbench keeps an actionable page when an active API request fails', () => {
  assert.match(workbenchSource, /v-if="loadError"/)
  assert.match(workbenchSource, />重新加载<\/el-button>/)
  assert.match(workbenchSource, /const loadError = ref\(''\)/)
  assert.match(workbenchSource, /catch \(error\) \{[\s\S]*requestId !== activeTabRequestId/)
  assert.match(workbenchSource, /loadError\.value = requestErrorMessage\(error, '工作台数据加载失败，请重试'\)/)
  assert.match(workbenchSource, /if \(tab === 'plans'\) plans\.value = \[\]/)
  assert.match(workbenchSource, /if \(tab === 'records'\) records\.value = \[\]/)
  assert.match(workbenchSource, /if \(tab === 'exceptions'\) exceptions\.value = \[\]/)
})

test('only open routine plans approved by the server can be selected for rest day', () => {
  for (const status of ['PLANNED', 'IN_WINDOW', 'OVERDUE']) {
    assert.equal(isRoutinePlanRestDaySelectable({ status, restDayEligible: true }), true)
  }
  for (const status of ['COMPLETED', 'CANCELLED']) {
    assert.equal(isRoutinePlanRestDaySelectable({ status, restDayEligible: true }), false)
  }
  assert.equal(isRoutinePlanRestDaySelectable({ status: 'OVERDUE', restDayEligible: false }), false)
  assert.equal(isRoutinePlanRestDaySelectable({ status: 'OVERDUE' }), false)
  assert.match(workbenchSource, /canMarkRestDay\.value && isRoutinePlanRestDaySelectable\(row\)/)
  assert.match(workbenchSource, /const confirmation = confirmationGuard\.capture\(\)\s*const selectedPlanIds = \[\.\.\.selectedRestDayPlanIds\.value\]/)
  assert.match(workbenchSource, /if \(!confirmationGuard\.isCurrent\(confirmation\)\) return[\s\S]*planIds:\s*selectedPlanIds/)
  assert.match(workbenchSource, /markEquipmentRoutinePlansRestDay[\s\S]*if \(!confirmationGuard\.isCurrent\(confirmation\)\) return[\s\S]*ElMessage\.success/)
  assert.match(workbenchSource, />\s*所选计划设为休班\s*</)
  assert.match(workbenchSource, /按各自计划日期设为“休班”/)
})

test('authorized routine managers can run an immediate plan catch-up without restarting the server', () => {
  assert.match(workbenchSource, /v-if="canRunRoutineWorker"/)
  assert.match(workbenchSource, /<VideoPlay \/>/)
  assert.match(workbenchSource, /立即补跑计划/)
  assert.match(workbenchSource, /runEquipmentRoutineWorker\(\)/)
  assert.match(workbenchSource, /membership\.positionKey === 'DEPARTMENT_MANAGER'/)
  assert.match(workbenchSource, /membership\.functionalRoleKeys\?\.includes\('ASSET_ADMIN'\)/)
  assert.match(workbenchSource, /session\.moduleDataScopes\.equipment === 'TEAM'/)
  assert.match(workbenchSource, /session\.can\('equipment\.edit', \{ write: true, teamRequired: true \}\)/)
  assert.match(workbenchSource, /扫描 \$\{rulesProcessed\} 条规则，处理 \$\{plansProcessed\} 条计划/)
  assert.match(workbenchSource, /workerCompleted \? '补跑已完成，但计划列表刷新失败，请手动刷新' : '计划补跑失败，请稍后重试'/)
  assert.match(workbenchSource, /activeTab\.value = 'plans'[\s\S]*await changeTab\(\)/)
})

test('routine workbench makes cancelled plan reasons and record-to-plan details explicit', () => {
  for (const label of [
    '计划开始：',
    '计划截止：',
    '车牌号',
    '对应计划',
    '查看详情',
    '点检/保养执行详情',
    '执行人',
    '逐项执行结果',
    '照片信息'
  ]) assert.ok(workbenchSource.includes(label), `missing routine record field: ${label}`)
  assert.match(workbenchSource, /planCancellationReason\(row\)/)
  assert.match(workbenchSource, /routineRecordPlanWindow/)
  assert.match(workbenchSource, /routineRecordChecklistItems/)
})

test('routine record layout fits a 1366px desktop and keeps a compact narrow-screen view', () => {
  const recordsSection = workbenchSource.slice(
    workbenchSource.indexOf('<section v-else-if="activeTab === \'records\'"'),
    workbenchSource.indexOf('<section v-else class="table-shell">')
  )
  const desktopTable = recordsSection.slice(
    recordsSection.indexOf('<el-table'),
    recordsSection.indexOf('</el-table>') + '</el-table>'.length
  )
  const columns = [...desktopTable.matchAll(/<el-table-column\b([^>]*)>/g)]
  const totalWidth = columns.reduce((sum, [, attributes]) => {
    const width = attributes.match(/(?:min-width|width)="(\d+)"/)
    return sum + Number(width?.[1] || 0)
  }, 0)

  assert.equal(columns.length, 7)
  assert.equal(totalWidth, 1088)
  assert.match(recordsSection, /class="record-table-view"/)
  assert.match(recordsSection, /class="record-compact-view"/)
  assert.match(workbenchSource, /@media \(max-width: 1180px\) \{[\s\S]*?\.record-table-view \{ display: none; \}[\s\S]*?\.record-compact-view \{ display: block; \}/)
  assert.match(workbenchSource, /@media \(max-width: 760px\) \{[\s\S]*?\.record-compact-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)

  for (const visibleField of [
    '车牌号：',
    'routineLabel(row.routineType)',
    '计划开始：',
    '计划截止：',
    'displayTime(row.performedAt)',
    'recordPerformerName(row)',
    "row.performedRuntimeHours ?? '-'",
    "row.abnormalSummary || '无'",
    'recordPhotoSummary(row)',
    '查看详情'
  ]) assert.ok(recordsSection.includes(visibleField), `missing compact record information: ${visibleField}`)
})

test('routine plan cancellation labels explain known causes and do not guess missing history', () => {
  assert.equal(
    routinePlanCancellationReasonLabel({ status: 'CANCELLED', cancellationReason: 'REST_DAY' }),
    '该计划日期休班，设备不需点检'
  )
  assert.equal(
    routinePlanCancellationReasonLabel({ status: 'CANCELLED', cancelReason: 'RULE_UPDATED' }),
    '点检或保养规则已调整，原未执行计划已作废'
  )
  assert.equal(
    routinePlanCancellationReasonLabel({ status: 'CANCELLED', cancellationReason: 'SIBLING_COMPLETED' }),
    '同一周期已有计划完成，其余计划已作废'
  )
  assert.equal(
    routinePlanCancellationReasonLabel({
      status: 'CANCELLED',
      cancellationReason: 'SCHEDULE_CHANGED',
      cancellationReasonLabel: '规则执行周期或时间已调整，原未执行计划已作废'
    }),
    '规则执行周期或时间已调整，原未执行计划已作废'
  )
  assert.equal(
    routinePlanCancellationReasonLabel({ status: 'CANCELLED' }),
    '历史计划未记录取消原因'
  )
  assert.equal(routinePlanCancellationReasonLabel({ status: 'COMPLETED' }), '')
})

test('routine record presentation accepts enriched plan fields and maps snapshot checklist order', () => {
  const record = {
    planId: 'plan-12345678',
    planScheduledFor: '2026-08-09T06:25:00.000Z',
    planDueAt: '2026-08-09T06:50:00.000Z',
    planWindowName: '白班',
    planCycleKey: 'cycle-1',
    equipment: { plateNumber: '鲁A12345' },
    ruleSnapshot: {
      checklistItems: [
        { key: 'oil', name: '检查油位', description: '油位正常', required: true },
        { key: 'brake', name: '检查制动', required: true }
      ]
    },
    itemResults: [
      { itemKey: 'brake', result: 'ABNORMAL', note: '制动偏软' },
      { itemKey: 'oil', result: 'NORMAL', note: '' }
    ]
  }
  assert.deepEqual(routineRecordPlanWindow(record), {
    planId: 'plan-12345678',
    scheduledFor: '2026-08-09T06:25:00.000Z',
    dueAt: '2026-08-09T06:50:00.000Z',
    windowName: '白班',
    cycleKey: 'cycle-1'
  })
  assert.deepEqual(routineRecordPlanWindow({ planId: null }), {
    planId: '',
    scheduledFor: null,
    dueAt: null,
    windowName: '',
    cycleKey: ''
  })
  assert.equal(routineRecordPlateNumber(record), '鲁A12345')
  assert.equal(routineRecordPerformerName({
    performedByName: '  主记录姓名  ',
    performedByUser: { name: '用户回退姓名', username: 'fallback-user' }
  }), '主记录姓名')
  assert.equal(routineRecordPerformerName({
    performedByUser: { name: '用户回退姓名', username: 'fallback-user' }
  }), '用户回退姓名')
  assert.equal(routineRecordPerformerName({
    performedByUser: { name: '', username: 'fallback-user' }
  }), 'fallback-user')
  assert.equal(routineRecordPerformerName({}), '-')
  assert.deepEqual(
    routineRecordChecklistItems(record).map(({ itemKey, name, result, note }) => ({ itemKey, name, result, note })),
    [
      { itemKey: 'oil', name: '检查油位', result: 'NORMAL', note: '' },
      { itemKey: 'brake', name: '检查制动', result: 'ABNORMAL', note: '制动偏软' }
    ]
  )
  assert.deepEqual(
    routineRecordChecklistItems({
      ruleSnapshot: record.ruleSnapshot,
      itemResults: [{ itemKey: 'brake', result: 'NORMAL', note: '' }]
    }).map(({ itemKey, result }) => ({ itemKey, result })),
    [{ itemKey: 'oil', result: '' }, { itemKey: 'brake', result: 'NORMAL' }]
  )
})

test('routine record details preview private photos in the selected team context', () => {
  assert.match(workbenchSource, /import \{ downloadFileBlob \} from '@\/api\/file'/)
  assert.match(workbenchSource, /const selectedRecordPhotos = computed\(\(\) => recordPhotos\(selectedRecord\.value \|\| \{\}\)\)/)
  assert.match(workbenchSource, /for \(const value of Array\.isArray\(row\.photoFileIds\) \? row\.photoFileIds : \[\]\)/)
  assert.match(workbenchSource, /loadBlob: \(\) => downloadFileBlob\(fileId, requestedTeamId\)/)
  assert.match(workbenchSource, /@click="previewRecordPhoto\(photo, index\)"/)
  assert.match(workbenchSource, /URL\.revokeObjectURL\(recordPhotoPreviewUrl\.value\)/)
  assert.match(workbenchSource, /<el-button @click="closeRecordDetail">关闭<\/el-button>/)
  assert.match(workbenchSource, /function closeRecordDetail\(\) \{\s*invalidateRecordPhotoRequest\(\)/)
  assert.match(workbenchSource, /async function changeTeam\(\) \{\s*confirmationGuard\.invalidate\(\)\s*closeRecordDetail\(\)/)
  assert.match(workbenchSource, /onDeactivated\(deactivateRoutineWorkbench\)/)
  assert.match(workbenchSource, /function deactivateRoutineWorkbench\(\)[\s\S]*closeRecordDetail\(\)/)
  assert.match(workbenchSource, /onBeforeUnmount\(\(\) => \{\s*deactivateRoutineWorkbench\(\)\s*recordPhotoRequestGuard\.destroy\(\)/)
})

test('routine photo preview rejects stale record, team, close, and unmount responses', async () => {
  const deferred = () => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  }
  const baseContext = { recordId: 'record-a', teamId: 'team-a', userId: 'user-a' }

  for (const staleContext of [
    { ...baseContext, recordId: 'record-b' },
    { ...baseContext, teamId: 'team-b' },
    { ...baseContext, userId: 'user-b' }
  ]) {
    const guard = createRoutineRecordPhotoRequestGuard()
    const pending = deferred()
    const request = guard.begin(baseContext)
    let currentContext = baseContext
    let createCount = 0
    const previewPromise = loadRoutineRecordPhotoPreview({
      guard,
      request,
      currentContext: () => currentContext,
      loadBlob: () => pending.promise,
      createObjectUrl: () => {
        createCount += 1
        return 'blob:unexpected'
      },
      revokeObjectUrl: () => {}
    })
    currentContext = staleContext
    pending.resolve({ type: 'image/jpeg' })
    assert.deepEqual(await previewPromise, { stale: true, url: '' })
    assert.equal(createCount, 0)
  }

  for (const invalidate of [
    (guard) => guard.invalidate(),
    (guard) => guard.destroy()
  ]) {
    const guard = createRoutineRecordPhotoRequestGuard()
    const pending = deferred()
    const request = guard.begin(baseContext)
    let createCount = 0
    const previewPromise = loadRoutineRecordPhotoPreview({
      guard,
      request,
      currentContext: () => baseContext,
      loadBlob: () => pending.promise,
      createObjectUrl: () => {
        createCount += 1
        return 'blob:unexpected'
      },
      revokeObjectUrl: () => {}
    })
    invalidate(guard)
    pending.resolve({ type: 'image/jpeg' })
    assert.deepEqual(await previewPromise, { stale: true, url: '' })
    assert.equal(createCount, 0)
  }
})

test('routine photo preview revokes an object URL if it becomes stale during URL creation', async () => {
  const context = { recordId: 'record-a', teamId: 'team-a', userId: 'user-a' }
  const liveGuard = createRoutineRecordPhotoRequestGuard()
  const liveRequest = liveGuard.begin(context)
  const liveRevoked = []
  const liveResult = await loadRoutineRecordPhotoPreview({
    guard: liveGuard,
    request: liveRequest,
    currentContext: () => context,
    loadBlob: async () => ({ type: 'image/jpeg' }),
    createObjectUrl: () => 'blob:current-photo',
    revokeObjectUrl: (url) => liveRevoked.push(url)
  })
  assert.deepEqual(liveResult, { stale: false, url: 'blob:current-photo' })
  assert.deepEqual(liveRevoked, [])

  const guard = createRoutineRecordPhotoRequestGuard()
  const request = guard.begin(context)
  const revoked = []
  const result = await loadRoutineRecordPhotoPreview({
    guard,
    request,
    currentContext: () => context,
    loadBlob: async () => ({ type: 'image/jpeg' }),
    createObjectUrl: () => {
      guard.invalidate()
      return 'blob:late-photo'
    },
    revokeObjectUrl: (url) => revoked.push(url)
  })

  assert.deepEqual(result, { stale: true, url: '' })
  assert.deepEqual(revoked, ['blob:late-photo'])
})

test('routine rule terms include short customer-facing explanations without changing the payload', () => {
  for (const text of [
    '点检用于检查设备状态，保养用于记录维护工作。',
    '异常超过该时间未处理，就继续通知上一级负责人。',
    '决定手机定位失败时是否允许保存照片并提交记录。',
    '决定计划是手动发起，还是按日期或运行小时自动生成。',
    '决定提交时什么时候必须拍摄现场照片。'
  ]) assert.ok(ruleDialogSource.includes(text), `missing description: ${text}`)
})

test('routine exception actions trust the server access policy instead of guessing fixed positions', () => {
  assert.match(workbenchSource, /row\.accessPolicy\?\.canHandle === true/)
  assert.doesNotMatch(workbenchSource, /membership\.positionKey === 'SUB_DEPARTMENT_MANAGER'/)
  assert.match(workbenchSource, /SUB_DEPARTMENT_MANAGER: '分部负责人处理'/)
})

test('routine record export is permission gated and protected from stale page contexts', () => {
  assert.match(workbenchSource, /v-if="activeTab === 'records' && canExport"/)
  assert.match(workbenchSource, /:loading="exporting"/)
  assert.match(workbenchSource, /const canExport = computed\(\(\) => session\.hasPermission\('equipment\.export'\)\)/)
  assert.match(workbenchSource, /function currentExportContext\(\) \{[\s\S]*delete params\.page[\s\S]*delete params\.pageSize[\s\S]*routeName:[\s\S]*routeTeamId:[\s\S]*contextEpoch: session\.contextEpoch[\s\S]*teamId: currentTeamContextId\(\)[\s\S]*tab: activeTab\.value[\s\S]*paramsKey: JSON\.stringify\(params\)/)
  assert.match(workbenchSource, /function isCurrentExportContext\(context\) \{[\s\S]*pageActive[\s\S]*current\.routeTeamId === context\.routeTeamId[\s\S]*current\.contextEpoch === context\.contextEpoch[\s\S]*current\.teamId === context\.teamId[\s\S]*current\.tab === context\.tab[\s\S]*current\.paramsKey === context\.paramsKey/)
  assert.match(workbenchSource, /async function exportRows\(\) \{\s+if \(exporting\.value\) return\s+const requestId = \+\+exportRequestId\s+const context = currentExportContext\(\)\s+exporting\.value = true/)
  assert.match(workbenchSource, /if \(requestId !== exportRequestId \|\| !isCurrentExportContext\(context\)\) return/)
  assert.match(workbenchSource, /async function changeTeam\(\) \{[\s\S]*\+\+exportRequestId[\s\S]*exporting\.value = false/)
  assert.match(workbenchSource, /async function changeTab[\s\S]*\+\+exportRequestId[\s\S]*exporting\.value = false/)
  assert.match(workbenchSource, /finally \{\s+if \(requestId === exportRequestId\) exporting\.value = false\s+\}/)
})

test('routine workbench discards stale team and tab responses', () => {
  assert.match(workbenchSource, /let referenceRequestId = 0/)
  assert.match(workbenchSource, /let activeTabRequestId = 0/)
  assert.match(workbenchSource, /const requestId = \+\+referenceRequestId[\s\S]*requestId !== referenceRequestId \|\|[\s\S]*requestedTeamId !== String\(requestTeam\.value\.teamId \|\| ''\)[\s\S]*\) return/)
  assert.match(workbenchSource, /const requestId = \+\+activeTabRequestId[\s\S]*!pageActive \|\|[\s\S]*requestId !== activeTabRequestId \|\|[\s\S]*requestedTeamId !== currentTeamContextId\(\)[\s\S]*\) return false/)
  assert.match(workbenchSource, /if \(requestId === activeTabRequestId\) \{\s*activeTabRequestPending = false\s*loading\.value = false\s*\}/)
  assert.match(workbenchSource, /plans\.value = \[\][\s\S]*records\.value = \[\][\s\S]*exceptions\.value = \[\][\s\S]*total\.value = 0/)
  assert.match(workbenchSource, /requestedTeamId !== currentTeamContextId\(\)/)
  assert.match(workbenchSource, /async function changeTeam\(\) \{\s*confirmationGuard\.invalidate\(\)\s*closeRecordDetail\(\)\s*\+\+activeTabRequestId\s*\+\+referenceRequestId/)
  assert.match(workbenchSource, /changeTeam\(\)[\s\S]*plans\.value = \[\][\s\S]*records\.value = \[\][\s\S]*exceptions\.value = \[\]/)
  assert.match(workbenchSource, /async function changeTab\(requestedTab = activeTab\.value\)[\s\S]*?\+\+activeTabRequestId[\s\S]*?\+\+exportRequestId[\s\S]*?loading\.value = false/)
  assert.match(workbenchSource, /changeTab\(\)[\s\S]*plans\.value = \[\][\s\S]*records\.value = \[\][\s\S]*exceptions\.value = \[\][\s\S]*total\.value = 0/)
})

test('routine date filters include the complete selected end date', () => {
  assert.match(workbenchSource, /to: to \? `\$\{to\}T23:59:59\.999\+08:00` : undefined/)
})

test('message focus is removed before routine filters or pagination are applied', () => {
  assert.match(workbenchSource, /async function clearMessageFocus\(\)/)
  assert.match(workbenchSource, /planId: undefined,[\s\S]*exceptionId: undefined/)
  assert.match(workbenchSource, /async function applyFilters\(\)[\s\S]*await clearMessageFocus\(\)[\s\S]*await loadActiveTab\(\)/)
  assert.match(workbenchSource, /@change="changePage"/)
  assert.match(workbenchSource, /async function changePage\(\)[\s\S]*await clearMessageFocus\(\)/)
})

test('Web makes simultaneous calendar and runtime rules visible and quick to configure', () => {
  for (const preset of ['DAY', 'WEEK', 'MONTH', 'RUNTIME_HOURS', 'COMBINED']) {
    assert.match(rulesSource, new RegExp(`value: '${preset}'`))
  }
  assert.match(rulesSource, /:default-category-id="filters\.categoryId"/)
  assert.match(rulesSource, /:schedule-preset="newRuleSchedulePreset"/)
  assert.match(ruleDialogSource, /defaultCategoryId: \{ type: String, default: '' \}/)
  assert.match(ruleDialogSource, /function defaultSchedule\(\)/)
  assert.match(detailSource, /aria-label="当前设备生效规则分布"/)
  assert.match(detailSource, /row\.summary\.DAY/)
  assert.match(detailSource, /row\.summary\.WEEK/)
  assert.match(detailSource, /row\.summary\.MONTH/)
  assert.match(detailSource, /row\.summary\.RUNTIME_HOURS/)
  assert.match(detailSource, /runtimeHoursUpdatedAt/)
  assert.match(workbenchSource, /row\.performedRuntimeHours \?\? '-'/)
  assert.match(workbenchSource, /routineScheduleLabel\(row\.ruleSnapshot\?\.schedule\)/)
})

test('calendar execution day stays next to the calendar unit selector', () => {
  const unitIndex = ruleDialogSource.indexOf('label="日历单位"')
  const weeklyDayIndex = ruleDialogSource.indexOf('label="每周执行日"')
  const monthlyDayIndex = ruleDialogSource.indexOf('label="每月执行日"')
  const intervalIndex = ruleDialogSource.indexOf(':label="calendarIntervalLabel"')

  assert.ok(unitIndex >= 0)
  assert.ok(weeklyDayIndex > unitIndex)
  assert.ok(monthlyDayIndex > weeklyDayIndex)
  assert.ok(intervalIndex > monthlyDayIndex)
  assert.match(ruleDialogSource, /本周期适用于上方全部检查项；执行频率不同的项目请单独建立一条规则。/)
})

test('routine workbench heading actions stay aligned without overflowing at 390px', () => {
  assert.match(workbenchSource, /\.page-heading, \.heading-actions, \.toolbar, \.pagination-row \{ display: flex; align-items: center; \}/)
  assert.match(workbenchSource, /\.heading-actions \{ gap: 8px; \}/)
  assert.match(workbenchSource, /@media \(max-width: 760px\) \{[\s\S]*?\.page-heading \{ align-items: flex-start; flex-direction: column; \}/)
  assert.match(workbenchSource, /\.heading-actions, \.toolbar > \*, \.team-select \{ width: 100%; \}/)
})

test('routine rule window controls keep explicit positions on narrow screens', () => {
  assert.match(ruleDialogSource, /class="window-enabled"/)
  assert.match(ruleDialogSource, /class="window-name"/)
  assert.match(ruleDialogSource, /class="window-time window-time--start"/)
  assert.match(ruleDialogSource, /class="window-time window-time--end"/)
  assert.match(ruleDialogSource, /class="window-remove"/)
  assert.match(ruleDialogSource, /\.window-row \{ grid-template-columns: 40px repeat\(4, minmax\(0, 1fr\)\) 34px; \}/)
  assert.match(ruleDialogSource, /\.window-row > \* \{ min-width: 0; \}/)
  assert.match(ruleDialogSource, /\.window-row \.window-time \{[\s\S]*?--el-date-editor-width: 100%;[\s\S]*?width: 100% !important;[\s\S]*?min-width: 0 !important;/)
  assert.match(ruleDialogSource, /\.window-time--start \{ grid-column: 1 \/ 4; grid-row: 2; \}/)
  assert.match(ruleDialogSource, /\.window-time--end \{ grid-column: 4 \/ 7; grid-row: 2; \}/)
})
