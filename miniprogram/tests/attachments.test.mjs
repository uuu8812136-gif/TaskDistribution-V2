import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  attachmentMimeType,
  canOpenDocument,
  isImageAttachment,
  managedFileId,
  taskTemporaryUploadUrl
} from '../utils/attachments.js'

const FILE_ID = '64b000000000000000000001'

test('mini-program attachment helpers require private FileAsset ids', () => {
  assert.equal(managedFileId({ fileId: FILE_ID }), FILE_ID)
  assert.equal(managedFileId({ path: '/uploads/legacy.png' }), null)
  assert.equal(attachmentMimeType({ mimeType: 'image/png' }), 'image/png')
  assert.equal(isImageAttachment({ mimeType: 'image/png' }), true)
  assert.equal(canOpenDocument({ originalName: 'report.xlsx' }), true)
})

test('task-scoped temporary uploads require exactly one encoded resource scope', () => {
  assert.equal(
    taskTemporaryUploadUrl({ taskId: 'task/1' }),
    '/files/task-temporary?taskId=task%2F1'
  )
  assert.equal(
    taskTemporaryUploadUrl({ orgUnitId: 'org 1' }),
    '/files/task-temporary?orgUnitId=org%201'
  )
  assert.throws(() => taskTemporaryUploadUrl(), /必须且只能指定/)
  assert.throws(
    () => taskTemporaryUploadUrl({ taskId: 'task-1', orgUnitId: 'org-1' }),
    /必须且只能指定/
  )
})

test('mini-program source no longer calls the unauthenticated legacy upload endpoint', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const apiSource = fs.readFileSync(`${root}/api/index.js`, 'utf8')
  const detailSource = fs.readFileSync(`${root}/pages/task/detail.vue`, 'utf8')
  const manageSource = fs.readFileSync(`${root}/pages/task/manage.vue`, 'utf8')
  const messageSource = fs.readFileSync(`${root}/pages/message/index.vue`, 'utf8')
  assert.equal(apiSource.includes("upload('/upload'"), false)
  assert.equal(detailSource.includes(':src="getFileUrl('), false)
  assert.match(manageSource, /taskDetailUrl\(task, \{ includeTeamId: userStore\.isGlobalReadOnly \}\)/)
  assert.match(detailSource, /getTaskDetail\(request\.taskId, request\.params\)/)
  assert.match(detailSource, /getTaskReviews\(taskId\.value, readParams\(\)\)/)
  assert.match(detailSource, /getExtensionHistory\(taskId\.value, readParams\(\)\)/)
  assert.match(detailSource, /downloadTaskAttachment\(file, readParams\(\)\)/)
  assert.match(messageSource, /messageResourceUrl\(msg, \{/)
  assert.match(messageSource, /includeTeamId: userStore\.isGlobalReadOnly/)
})
