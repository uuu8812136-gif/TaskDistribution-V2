import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  REQUEST_ERROR_CODE_MESSAGES,
  localizeRequestError,
  resolveRequestErrorMessage
} from '../utils/requestErrorMessages.js'

test('mini-program maps attendance cutoff errors to Chinese', () => {
  assert.equal(
    resolveRequestErrorMessage({
      code: 'ATTENDANCE_LATE_REASON_REQUIRED',
      message: 'A correction reason is required for attendance officer changes at or after 09:00',
      statusCode: 400
    }, '保存失败'),
    '09:00 后补报或修改出勤时，请填写修正原因'
  )
  assert.equal(REQUEST_ERROR_CODE_MESSAGES.EQUIPMENT_IMPORT_NOT_CLEANABLE, '请先取消设备导入预览，再清理暂存文件')
  assert.equal(REQUEST_ERROR_CODE_MESSAGES.CONTRACT_IMPORT_FILE_UNSUPPORTED, '仅支持 .xlsx 格式的合同管理 Excel 文件')
  assert.equal(REQUEST_ERROR_CODE_MESSAGES.CONTRACT_IMPORT_ATTACHMENT_UNRESOLVED, '合同附件未能从 Excel 读取，请在合同页面单独上传')
  assert.equal(REQUEST_ERROR_CODE_MESSAGES.CONTRACT_SETTLEMENT_SUPPLIER_IMMUTABLE, '结算记录创建后不能更换供应商')
  assert.equal(Object.keys(REQUEST_ERROR_CODE_MESSAGES).length >= 200, true)
})

test('mini-program maps dynamic task leadership errors to Chinese', () => {
  const cases = {
    TASK_LEADERSHIP_REQUIRED: '当前负责人已接管，主管不再具有主持权限，请刷新后重试',
    TASK_LEADERSHIP_TRANSACTIONS_REQUIRED: '任务主持服务暂不可用，请稍后重试',
    TASK_FILE_UPLOAD_DENIED: '当前任务或组织不允许上传附件，请刷新权限后重试',
    TASK_FILE_SCOPE_REQUIRED: '上传任务附件时必须且只能指定任务或所属组织',
    SUB_DEPARTMENT_LEADERSHIP_UNAVAILABLE: '分部负责人状态暂不可用，请稍后重试'
  }

  for (const [code, expected] of Object.entries(cases)) {
    assert.equal(REQUEST_ERROR_CODE_MESSAGES[code], expected)
    assert.equal(
      resolveRequestErrorMessage({ code, message: 'Technical leadership error' }, '操作失败'),
      expected
    )
  }
})

test('mini-program maps equipment category conflicts to actionable Chinese', () => {
  const cases = {
    EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT: '请先停用关联点检/保养规则，或保持设备一级名称层级',
    EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT: '设备分类结构已发生变化，请刷新后重试'
  }

  for (const [code, expected] of Object.entries(cases)) {
    assert.equal(REQUEST_ERROR_CODE_MESSAGES[code], expected)
    assert.equal(
      resolveRequestErrorMessage({ code, message: 'Technical equipment category conflict' }, '设备操作失败'),
      expected
    )
  }
})

test('mini-program preserves Chinese API details but hides unknown English', () => {
  assert.equal(
    resolveRequestErrorMessage({ code: 'UNKNOWN', message: '该流程已经结束' }, '提交失败'),
    '该流程已经结束'
  )
  assert.equal(
    resolveRequestErrorMessage({ code: 'UNKNOWN', message: 'Workflow is already closed' }, '提交失败'),
    '提交失败'
  )

  const nativeError = new Error('request:fail timeout')
  assert.equal(localizeRequestError(nativeError, '网络错误，请检查网络连接').message, '网络错误，请检查网络连接')
})

test('mini-program request wrapper displays and throws the same localized response error', () => {
  const source = readFileSync(new URL('../utils/request.js', import.meta.url), 'utf8')
  assert.match(source, /const responseError = createResponseError\(statusCode, data, options\)/)
  assert.match(source, /notifyError\(responseError\.message, options\)/)
  assert.match(source, /throw responseError/)
  assert.doesNotMatch(source, /let title = data\?\.message/)
})
