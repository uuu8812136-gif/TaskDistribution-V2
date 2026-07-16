'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createStorageKey,
  normalizeOriginalName,
  resolveStoragePath,
  validateFileContent,
  validatedExtension
} = require('../../../app/services/fileStorageService');

const TEAM_ID = '64b000000000000000000002';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('creates an opaque team-prefixed key without retaining the original filename', () => {
  const key = createStorageKey({
    teamId: TEAM_ID,
    originalName: '客户设备照片.JPG',
    mimeType: 'image/jpeg',
    now: new Date('2030-02-03T04:05:06.000Z'),
    id: UUID
  });

  assert.equal(key, `${TEAM_ID}/2030/02/${UUID}.jpg`);
  assert.equal(key.includes('客户'), false);
});

test('rejects mismatched extensions, unsupported MIME types, and traversal keys', () => {
  assert.throws(
    () => validatedExtension('report.exe', 'application/pdf'),
    /does not match/
  );
  assert.throws(
    () => validatedExtension('archive.zip', 'application/zip'),
    /Unsupported/
  );
  assert.throws(
    () => resolveStoragePath('C:\\safe-root', '../outside.txt'),
    /Invalid file storage key/
  );
});

test('normalizes browser-supplied paths and resolves only below the storage root', () => {
  assert.equal(normalizeOriginalName('C:\\fakepath\\evidence.pdf'), 'evidence.pdf');
  const key = `${TEAM_ID}/2030/02/${UUID}.pdf`;
  const root = path.resolve('E:\\isolated-v2-files');
  const target = resolveStoragePath(root, key);

  assert.equal(path.relative(root, target).startsWith('..'), false);
  assert.equal(target.endsWith(path.join(TEAM_ID, '2030', '02', `${UUID}.pdf`)), true);
});

test('normalizes UTF-8 browser filename bytes without trusting path segments', () => {
  const browserEncodedName = Buffer.from('client-photo.png', 'utf8').toString('latin1');
  assert.equal(normalizeOriginalName(`C:\\fakepath\\${browserEncodedName}`), 'client-photo.png');

  const encodedChineseName = Buffer.from('\u8bbe\u5907\u7167\u7247.png', 'utf8').toString('latin1');
  assert.equal(normalizeOriginalName(encodedChineseName), '\u8bbe\u5907\u7167\u7247.png');
});

test('validates file signatures instead of trusting the multipart MIME header', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
    Buffer.alloc(8)
  ]);
  assert.equal(validateFileContent(png, 'image/png'), true);
  assert.throws(
    () => validateFileContent(Buffer.from('not a png'), 'image/png'),
    /does not match/
  );
  assert.throws(
    () => validateFileContent(Buffer.from([0x61, 0x00, 0x62]), 'text/plain'),
    /does not match/
  );
});
