import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentName,
  existingAttachmentFileList,
  isImageAttachment,
  managedFileId,
  prepareAttachmentReferences
} from '../src/utils/attachments.js'

const FILE_ID = '64b000000000000000000001'

test('managed attachment helpers accept only opaque ObjectId references', () => {
  assert.equal(managedFileId({ fileId: FILE_ID }), FILE_ID)
  assert.equal(managedFileId({ path: '/uploads/private.png' }), null)
  assert.equal(attachmentName({ originalName: 'evidence.png' }), 'evidence.png')
  assert.equal(isImageAttachment({ mimeType: 'image/png' }), true)
  assert.equal(isImageAttachment({ originalName: 'report.pdf' }), false)
});

test('existing file lists retain managed ids and omit legacy path-only entries', () => {
  assert.deepEqual(existingAttachmentFileList([
    { fileId: FILE_ID, originalName: 'managed.pdf', size: 12 },
    { path: '/uploads/legacy.pdf', originalName: 'legacy.pdf' }
  ]), [{
    uid: FILE_ID,
    fileId: FILE_ID,
    name: 'managed.pdf',
    size: 12,
    status: 'success'
  }]);
});

test('upload preparation returns only fileId references and tracks new temporary files', async () => {
  const result = await prepareAttachmentReferences([
    { fileId: FILE_ID, name: 'existing.pdf' },
    { raw: { name: 'new.png' } }
  ], async () => ({ file: { _id: '64b000000000000000000002' } }));

  assert.deepEqual(result, {
    references: [
      { fileId: FILE_ID },
      { fileId: '64b000000000000000000002' }
    ],
    uploadedFileIds: ['64b000000000000000000002']
  });
});
