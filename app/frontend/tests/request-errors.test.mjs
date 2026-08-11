import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  REQUEST_ERROR_CODE_MESSAGES as webMessages,
  localizeRequestError,
  requestErrorMessage,
  resolveRequestErrorMessage
} from '../src/utils/requestErrorMessages.js'
import {
  REQUEST_ERROR_CODE_MESSAGES as miniProgramMessages,
  resolveRequestErrorMessage as resolveMiniProgramErrorMessage
} from '../../../miniprogram/utils/requestErrorMessages.js'

test('Web and mini-program expose the same centralized Chinese error-code map', () => {
  assert.deepEqual(miniProgramMessages, webMessages)
  assert.equal(webMessages.ATTENDANCE_LATE_REASON_REQUIRED, '09:00 后补报或修改出勤时，请填写修正原因')
  assert.equal(webMessages.GLOBAL_READ_ONLY, '跨团队查看模式为只读，请先进入具体团队后再修改')
  assert.equal(webMessages.EQUIPMENT_IMPORT_FILE_UNSUPPORTED, '仅支持符合模板的 .xlsx 文件')
  assert.equal(
    webMessages.EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT,
    '请先停用关联点检/保养规则，或保持设备一级名称层级'
  )
  assert.equal(
    webMessages.EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT,
    '设备分类结构已发生变化，请刷新后重试'
  )
  assert.equal(webMessages.TASK_CONFIRMATION_DENIED, '只有任务创建人或项目管理员可以确认任务完成')
  assert.equal(webMessages.EXTENSION_APPROVAL_DENIED, '只有任务创建人或项目管理员可以审批延期申请')
  const leadershipMessages = {
    TASK_LEADERSHIP_REQUIRED: '当前负责人已接管，主管不再具有主持权限，请刷新后重试',
    TASK_LEADERSHIP_TRANSACTIONS_REQUIRED: '任务主持服务暂不可用，请稍后重试',
    TASK_FILE_UPLOAD_DENIED: '当前任务或组织不允许上传附件，请刷新权限后重试',
    TASK_FILE_SCOPE_REQUIRED: '上传任务附件时必须且只能指定任务或所属组织',
    SUB_DEPARTMENT_LEADERSHIP_UNAVAILABLE: '分部负责人状态暂不可用，请稍后重试'
  }
  for (const [code, expected] of Object.entries(leadershipMessages)) {
    assert.equal(webMessages[code], expected)
    assert.deepEqual(Buffer.from(webMessages[code], 'utf8'), Buffer.from(miniProgramMessages[code], 'utf8'))
  }
  assert.equal(Object.keys(webMessages).length >= 200, true)
  for (const [code, message] of Object.entries(webMessages)) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/)
    assert.match(message, /[\u3400-\u9fff]/u)
  }
})

test('stable codes replace English API messages on both clients', () => {
  const response = {
    code: 'ATTENDANCE_LATE_REASON_REQUIRED',
    message: 'A correction reason is required for attendance officer changes at or after 09:00',
    statusCode: 400
  }
  const expected = '09:00 后补报或修改出勤时，请填写修正原因'
  assert.equal(resolveRequestErrorMessage(response, '保存失败'), expected)
  assert.equal(resolveMiniProgramErrorMessage(response, '保存失败'), expected)

  assert.equal(
    resolveRequestErrorMessage({
      code: 'TASK_LEADERSHIP_REQUIRED',
      message: 'A department leader has resumed control'
    }, '操作失败'),
    '当前负责人已接管，主管不再具有主持权限，请刷新后重试'
  )
  assert.equal(
    resolveMiniProgramErrorMessage({
      code: 'SUB_DEPARTMENT_LEADERSHIP_UNAVAILABLE',
      message: 'Department leadership state is unavailable'
    }, '操作失败'),
    '分部负责人状态暂不可用，请稍后重试'
  )

  assert.equal(
    resolveRequestErrorMessage({
      code: 'EQUIPMENT_FUTURE_STABLE_CODE',
      message: 'An English message added by a newer API'
    }, '保存失败'),
    '设备操作失败，请检查填写内容和当前状态'
  )

  const categoryConflictMessages = {
    EQUIPMENT_CATEGORY_ACTIVE_RULE_DEPTH_CONFLICT: '请先停用关联点检/保养规则，或保持设备一级名称层级',
    EQUIPMENT_CATEGORY_STRUCTURE_CONFLICT: '设备分类结构已发生变化，请刷新后重试'
  }
  for (const [code, expected] of Object.entries(categoryConflictMessages)) {
    const response = { code, message: 'Technical equipment category conflict', statusCode: 409 }
    assert.equal(resolveRequestErrorMessage(response, '设备操作失败'), expected)
    assert.equal(resolveMiniProgramErrorMessage(response, '设备操作失败'), expected)
  }
})

test('Chinese server details remain visible while unknown English never leaks', () => {
  assert.equal(
    resolveRequestErrorMessage({ code: 'UNKNOWN_CODE', message: '该记录已经由其他用户审核' }, '保存失败'),
    '该记录已经由其他用户审核'
  )
  assert.equal(
    resolveRequestErrorMessage({ code: 'UNKNOWN_CODE', message: 'Unexpected state transition' }, '保存失败'),
    '保存失败'
  )
  assert.equal(
    resolveRequestErrorMessage({ code: 'UNKNOWN_CODE', message: 'Unexpected state transition' }, 'Request failed'),
    '请求失败，请稍后重试'
  )
})

test('localized Web errors also protect direct error.message and response.data.message consumers', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: {
      status: 400,
      data: {
        code: 'ATTENDANCE_LATE_REASON_REQUIRED',
        message: 'A correction reason is required for attendance officer changes at or after 09:00'
      }
    }
  })
  const localized = localizeRequestError(error, '保存失败')

  assert.equal(localized, error)
  assert.equal(localized.message, '09:00 后补报或修改出勤时，请填写修正原因')
  assert.equal(localized.response.data.message, localized.message)
  assert.equal(localized.technicalMessage, 'Request failed with status code 400')
  assert.equal(requestErrorMessage(localized, '保存失败'), localized.message)
})

test('a caller-specific fallback remains available after the interceptor hides unknown English', () => {
  const error = Object.assign(new Error('Request failed with status code 409'), {
    response: {
      status: 409,
      data: { code: 'UNKNOWN_CONFLICT', message: 'Unexpected state transition' }
    }
  })
  localizeRequestError(error, '请求失败，请稍后重试')

  assert.equal(error.response.data.message, '请求失败，请稍后重试')
  assert.equal(error.technicalResponseMessage, 'Unexpected state transition')
  assert.equal(requestErrorMessage(error, '保存失败'), '保存失败')
})

test('Web request interceptor localizes errors before notifications and rejection', () => {
  const source = readFileSync(new URL('../src/utils/request.js', import.meta.url), 'utf8')
  assert.match(source, /localizeRequestError\(error, fallback\)/)
  assert.match(source, /ElMessage\.error\(localizedError\.message\)/)
  assert.match(source, /return Promise\.reject\(localizedError\)/)
})
