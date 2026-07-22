'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const permissions = require('../../../app/config/permissions');
const FileAsset = require('../../../app/models/FileAsset');
const { createFileAssetService } = require('../../../app/services/fileAssetService');

function queryResult(result) {
  return {
    select() { return this; },
    session() { return this; },
    async lean() { return result; }
  };
}

test('equipment-owned files use equipment permission and organization scope', async () => {
  const teamId = new mongoose.Types.ObjectId();
  const orgUnitId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const fileId = new mongoose.Types.ObjectId();
  let ownerFilter = null;

  const file = {
    _id: fileId,
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
    ownerId: equipmentId,
    originalName: 'equipment.jpg',
    mimeType: 'image/jpeg',
    size: 123,
    sha256: 'a'.repeat(64),
    uploaderId: userId,
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const service = createFileAssetService({
    storageRoot: 'E:\\test-only-file-storage',
    FileAssetModel: {
      async findOne(filter) {
        return String(filter.teamId) === String(teamId) ? file : null;
      }
    },
    EquipmentAssetModel: {
      findOne(filter) {
        ownerFilter = filter;
        return queryResult({ _id: equipmentId, teamId, orgUnitId });
      }
    }
  });
  const authContext = {
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId: String(userId),
    activeTeamId: String(teamId),
    permissionKeys: ['equipment.view'],
    moduleDataScopes: { equipment: permissions.DATA_SCOPES.ORG_UNIT },
    membership: { orgUnitId: String(orgUnitId) },
    orgUnit: { _id: String(orgUnitId) },
    readOnly: false,
    canAccessBusiness: true
  };

  const result = await service.getMetadata({
    authContext,
    fileId: String(fileId),
    method: 'GET'
  });

  assert.equal(result.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT);
  assert.deepEqual(ownerFilter.$and[0], {
    _id: String(equipmentId),
    teamId: String(teamId),
    orgUnitId: String(orgUnitId)
  });
});

test('equipment import source files resolve ImportJob scopeOrgUnitId instead of asset orgUnitId', async () => {
  const teamId = new mongoose.Types.ObjectId();
  const orgUnitId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const importJobId = new mongoose.Types.ObjectId();
  const fileId = new mongoose.Types.ObjectId();
  let ownerFilter = null;
  const file = {
    _id: fileId,
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
    ownerId: importJobId,
    originalName: 'source.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 456,
    sha256: 'b'.repeat(64),
    uploaderId: userId,
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const service = createFileAssetService({
    storageRoot: 'E:\\test-only-file-storage',
    FileAssetModel: {
      async findOne() { return file; }
    },
    ImportJobModel: {
      findOne(filter) {
        ownerFilter = filter;
        return queryResult({ _id: importJobId, teamId, scopeOrgUnitId: orgUnitId });
      }
    }
  });
  const authContext = {
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId: String(userId),
    activeTeamId: String(teamId),
    permissionKeys: ['equipment.import'],
    moduleDataScopes: { equipment: permissions.DATA_SCOPES.ORG_UNIT },
    membership: { orgUnitId: String(orgUnitId) },
    orgUnit: { _id: String(orgUnitId) },
    readOnly: false,
    canAccessBusiness: true
  };
  const result = await service.getMetadata({
    authContext,
    fileId: String(fileId),
    method: 'GET'
  });
  assert.equal(result.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE);
  assert.deepEqual(ownerFilter, {
    _id: String(importJobId),
    teamId: String(teamId),
    scopeOrgUnitId: String(orgUnitId)
  });
});

test('workflow-owned active files reject generic bind and delete mutations', async () => {
  const teamId = new mongoose.Types.ObjectId();
  const orgUnitId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const inventoryItemId = new mongoose.Types.ObjectId();
  const fileId = new mongoose.Types.ObjectId();
  const file = {
    _id: fileId,
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.INVENTORY,
    ownerId: inventoryItemId,
    originalName: 'inventory-evidence.jpg',
    mimeType: 'image/jpeg',
    size: 123,
    sha256: 'c'.repeat(64),
    uploaderId: new mongoose.Types.ObjectId(),
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const service = createFileAssetService({
    storageRoot: 'E:\\test-only-file-storage',
    FileAssetModel: {
      async findOne() { return file; }
    },
    InventoryItemModel: {
      findOne() {
        return queryResult({ _id: inventoryItemId, teamId, orgUnitId });
      }
    }
  });
  const authContext = {
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId: String(userId),
    activeTeamId: String(teamId),
    permissionKeys: ['equipment.inventory'],
    moduleDataScopes: { equipment: permissions.DATA_SCOPES.ORG_UNIT },
    membership: { orgUnitId: String(orgUnitId) },
    orgUnit: { _id: String(orgUnitId) },
    readOnly: false,
    canAccessBusiness: true
  };

  await assert.rejects(
    service.deleteFile({ authContext, fileId: String(fileId) }),
    (error) => error.status === 409 && error.code === 'FILE_WORKFLOW_OWNER_MANAGED'
  );
  await assert.rejects(
    service.bindFile({
      authContext,
      fileId: String(new mongoose.Types.ObjectId()),
      ownerType: FileAsset.FILE_OWNER_TYPES.INVENTORY,
      ownerId: String(inventoryItemId)
    }),
    (error) => error.status === 409 && error.code === 'FILE_WORKFLOW_OWNER_MANAGED'
  );

  for (const ownerType of [
    FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
    FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
    FileAsset.FILE_OWNER_TYPES.INSPECTION,
    FileAsset.FILE_OWNER_TYPES.REPAIR,
    FileAsset.FILE_OWNER_TYPES.MAINTENANCE,
    FileAsset.FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION
  ]) {
    await assert.rejects(
      service.bindFile({
        authContext,
        fileId: String(new mongoose.Types.ObjectId()),
        ownerType,
        ownerId: String(inventoryItemId)
      }),
      (error) => error.status === 409 && error.code === 'FILE_WORKFLOW_OWNER_MANAGED'
    );
  }
});

test('ordinary equipment attachments require the owning business workflow', async () => {
  const teamId = new mongoose.Types.ObjectId();
  const orgUnitId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const equipmentId = new mongoose.Types.ObjectId();
  const fileId = new mongoose.Types.ObjectId();
  const file = {
    _id: fileId,
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.TEMPORARY,
    ownerId: null,
    originalName: 'equipment-evidence.jpg',
    mimeType: 'image/jpeg',
    size: 123,
    sha256: 'd'.repeat(64),
    uploaderId: userId,
    status: FileAsset.FILE_STATUSES.TEMPORARY,
    deletedAt: null,
    deletedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    async save() {}
  };
  const service = createFileAssetService({
    storageRoot: 'E:\\test-only-file-storage',
    FileAssetModel: {
      async find() { return [file]; },
      async findOne() { return file; }
    },
    EquipmentAssetModel: {
      findOne() {
        return queryResult({ _id: equipmentId, teamId, orgUnitId });
      }
    },
    auditService: { async record() {} }
  });
  const authContext = {
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    userId: String(userId),
    activeTeamId: String(teamId),
    permissionKeys: ['equipment.edit'],
    moduleDataScopes: { equipment: permissions.DATA_SCOPES.ORG_UNIT },
    membership: { orgUnitId: String(orgUnitId) },
    orgUnit: { _id: String(orgUnitId) },
    readOnly: false,
    canAccessBusiness: true
  };

  await assert.rejects(
    service.bindFile({
      authContext,
      fileId: String(fileId),
      ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
      ownerId: String(equipmentId)
    }),
    (error) => error.status === 409 && error.code === 'FILE_WORKFLOW_OWNER_MANAGED'
  );

  const [bound] = await service.reconcileOwnerFiles({
    authContext,
    attachments: [{ fileId: String(fileId) }],
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
    ownerId: String(equipmentId)
  });

  assert.equal(bound.fileId, String(fileId));
  assert.equal(file.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(file.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT);
  assert.equal(file.ownerId, String(equipmentId));
});
