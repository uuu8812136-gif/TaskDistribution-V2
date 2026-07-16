'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const FileAsset = require('../../../app/models/FileAsset');
const { FILE_OWNER_TYPES, FILE_STATUSES } = FileAsset;

const TEAM_ID = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();
const OWNER_ID = new mongoose.Types.ObjectId();

function attributes(overrides = {}) {
  return {
    teamId: TEAM_ID,
    ownerType: FILE_OWNER_TYPES.TEMPORARY,
    storageKey: `${TEAM_ID}/2030/01/123e4567-e89b-12d3-a456-426614174000.pdf`,
    originalName: 'inspection.pdf',
    mimeType: 'application/pdf',
    size: 128,
    sha256: 'a'.repeat(64),
    uploaderId: USER_ID,
    ...overrides
  };
}

test('temporary files are tenant-scoped and cannot claim a business owner', async () => {
  const temporary = new FileAsset(attributes());
  await temporary.validate();
  assert.equal(temporary.status, FILE_STATUSES.TEMPORARY);
  assert.equal(temporary.ownerId, null);

  await assert.rejects(
    new FileAsset(attributes({ ownerId: OWNER_ID })).validate(),
    /temporary file cannot be bound/
  );
});

test('active files require a fixed owner type and owner id', async () => {
  await new FileAsset(attributes({
    status: FILE_STATUSES.ACTIVE,
    ownerType: FILE_OWNER_TYPES.TASK,
    ownerId: OWNER_ID
  })).validate();

  await assert.rejects(
    new FileAsset(attributes({ status: FILE_STATUSES.ACTIVE })).validate(),
    /requires a business owner/
  );
});

test('deleted files require deletion metadata and never expose an absolute path field', async () => {
  const deleted = new FileAsset(attributes({
    status: FILE_STATUSES.DELETED,
    ownerType: FILE_OWNER_TYPES.TASK,
    ownerId: OWNER_ID,
    deletedAt: new Date(),
    deletedBy: USER_ID
  }));
  await deleted.validate();

  assert.equal(FileAsset.schema.path('absolutePath'), undefined);
  assert.equal(FileAsset.schema.path('publicUrl'), undefined);
  assert.equal(FileAsset.schema.path('teamId').options.required, true);
  assert.equal(FileAsset.schema.path('storageKey').options.immutable, true);
});
