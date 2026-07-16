'use strict';

const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (moduleName) => require(require.resolve(moduleName, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const XLSX = appRequire('xlsx');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentChangeRecord = require('../../../app/models/EquipmentChangeRecord');
const ImportException = require('../../../app/models/ImportException');
const ImportJob = require('../../../app/models/ImportJob');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  EXCEL_MIME_TYPE,
  createEquipmentImportService
} = require('../../../app/services/equipmentImportService');

const TEST_DATABASE_NAME = 'equipment_import_isolation_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentChangeRecord,
  ImportException,
  ImportJob,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replicaSet;
let fixture;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function context({ teamId, orgUnitId, userId, scope = permissions.DATA_SCOPES.TEAM }) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: `import-${userId}` }),
    isSuperAdmin: false,
    activeTeamId: String(teamId),
    team: Object.freeze({ _id: String(teamId), status: permissions.TEAM_STATUSES.ACTIVE }),
    membership: Object.freeze({
      _id: String(objectId()),
      teamId: String(teamId),
      userId: String(userId),
      orgUnitId: String(orgUnitId),
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }),
    orgUnit: Object.freeze({ _id: String(orgUnitId), teamId: String(teamId) }),
    actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
    permissionKeys: Object.freeze(['equipment.import']),
    moduleDataScopes: Object.freeze({ equipment: scope }),
    readOnly: false,
    canAccessBusiness: true
  });
}

function workbookUpload(rows, { sheetName = '测试分类', originalname = 'equipment-import.xlsx' } = {}) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: [
      '资产编码',
      '名称',
      '资产类别',
      '所在部室',
      '使用人',
      '实盘数量',
      '单位',
      '启用日期',
      '状态',
      '型号规格',
      '生产厂家',
      '备注'
    ]
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return {
    buffer,
    size: buffer.length,
    originalname,
    mimetype: EXCEL_MIME_TYPE
  };
}

function validRow(overrides = {}) {
  return {
    资产编码: 'IMPORT-001',
    名称: 'Imported asset',
    资产类别: '测试分类',
    所在部室: 'A1',
    使用人: 'User A1',
    实盘数量: 1,
    单位: '台',
    状态: '在用',
    型号规格: 'MODEL-A',
    生产厂家: 'Factory A',
    ...overrides
  };
}

async function seedFixture() {
  const ids = {
    teamA: objectId(),
    teamB: objectId(),
    orgA1: objectId(),
    orgA2: objectId(),
    orgB1: objectId(),
    userA1: objectId(),
    userA2: objectId(),
    userB1: objectId(),
    categoryA: objectId(),
    categoryB: objectId()
  };
  await User.collection.insertMany([
    {
      _id: ids.userA1,
      username: 'import-a1',
      usernameNormalized: 'import-a1',
      password: 'unused',
      name: 'User A1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userA2,
      username: 'import-a2',
      usernameNormalized: 'import-a2',
      password: 'unused',
      name: 'User A2',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    },
    {
      _id: ids.userB1,
      username: 'import-b1',
      usernameNormalized: 'import-b1',
      password: 'unused',
      name: 'User B1',
      roles: [],
      isSuperAdmin: false,
      tokenVersion: 0,
      status: 'active'
    }
  ]);
  await ProjectTeam.collection.insertMany([
    {
      _id: ids.teamA,
      code: 'IMPORT_A',
      name: 'Import Team A',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.userA1
    },
    {
      _id: ids.teamB,
      code: 'IMPORT_B',
      name: 'Import Team B',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: ids.userB1
    }
  ]);
  await OrgUnit.collection.insertMany([
    {
      _id: ids.orgA1,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A1',
      name: 'A1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgA2,
      teamId: ids.teamA,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'A2',
      name: 'A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    },
    {
      _id: ids.orgB1,
      teamId: ids.teamB,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'B1',
      name: 'B1',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.collection.insertMany([
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userA1,
      orgUnitId: ids.orgA1,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['equipment.import'],
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamA,
      userId: ids.userA2,
      orgUnitId: ids.orgA2,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['equipment.import'],
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    },
    {
      _id: objectId(),
      teamId: ids.teamB,
      userId: ids.userB1,
      orgUnitId: ids.orgB1,
      role: permissions.MEMBERSHIP_ROLES.PROJECT_ADMIN,
      positionLevel: 1,
      positionKey: permissions.POSITION_KEYS.DEPARTMENT_MANAGER,
      functionalRoleKeys: [],
      permissionKeys: ['equipment.import'],
      moduleDataScopes: permissions.deriveModuleDataScopes({ positionLevel: 1 }),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
      joinedAt: new Date()
    }
  ]);
  await EquipmentCategory.collection.insertMany([
    {
      _id: ids.categoryA,
      teamId: ids.teamA,
      name: '测试分类',
      parentId: null,
      sortOrder: 0,
      status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
      createdBy: ids.userA1,
      updatedBy: ids.userA1
    },
    {
      _id: ids.categoryB,
      teamId: ids.teamB,
      name: '测试分类',
      parentId: null,
      sortOrder: 0,
      status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
      createdBy: ids.userB1,
      updatedBy: ids.userB1
    }
  ]);
  return ids;
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('preview stages rows without touching the registry and confirmation publishes atomically', async () => {
  const service = createEquipmentImportService();
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow()]),
    input: {}
  });
  assert.equal(preview.importJob.status, ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY);
  assert.equal(preview.importJob.totalRows, 1);
  assert.equal(preview.importJob.validRows, 1);
  assert.equal(preview.exceptionCount, 0);
  assert.equal(await EquipmentAsset.countDocuments({}), 0);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 0);

  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Customer approved the clean preview',
      decisions: []
    }
  });
  assert.equal(confirmed.importJob.status, ImportJob.IMPORT_JOB_STATUSES.PUBLISHED);
  assert.equal(confirmed.importJob.publishedRows, 1);
  const asset = await EquipmentAsset.findOne({ assetCode: 'IMPORT-001' }).lean();
  assert.equal(String(asset.teamId), String(fixture.teamA));
  assert.equal(String(asset.orgUnitId), String(fixture.orgA1));
  assert.equal(String(asset.sourceImportJobId), preview.importJob._id);
  assert.equal(await EquipmentChangeRecord.countDocuments({ equipmentId: asset._id }), 1);
  assert.equal(await AuditLog.countDocuments({
    resourceType: permissions.AUDIT_RESOURCE_TYPES.IMPORT_JOB,
    resourceId: preview.importJob._id
  }), 3);

  await assert.rejects(service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: confirmed.importJob.version,
      reason: 'Duplicate confirmation must fail',
      decisions: []
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_ALREADY_PUBLISHED');
  assert.equal(await EquipmentAsset.countDocuments({ assetCode: 'IMPORT-001' }), 1);
});

test('all exceptions require explicit decisions and corrected values are revalidated before write', async () => {
  await EquipmentAsset.create({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    assetCode: 'DUPLICATE-001',
    name: 'Existing asset',
    categoryId: fixture.categoryA,
    createdBy: fixture.userA1,
    updatedBy: fixture.userA1
  });
  const service = createEquipmentImportService();
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({
      资产编码: 'DUPLICATE-001',
      启用日期: '2024年',
      状态: '未知状态'
    })]),
    input: {}
  });
  const exceptionResult = await service.listExceptions({
    authContext,
    importJobId: preview.importJob._id,
    query: { pageSize: 20 }
  });
  assert.deepEqual(
    new Set(exceptionResult.exceptions.map(({ exceptionType }) => exceptionType)),
    new Set([
      'DUPLICATE_ASSET_CODE_EXISTING',
      'PARTIAL_DATE',
      'STATUS_UNRECOGNIZED'
    ])
  );
  await assert.rejects(service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Missing decisions',
      decisions: []
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_CONFIRMATION_INVALID');
  assert.equal(await EquipmentAsset.countDocuments({}), 1);
  assert.equal(await ImportException.countDocuments({ status: 'PENDING' }), 3);

  const decisions = exceptionResult.exceptions.map((exception) => {
    if (exception.exceptionType === 'DUPLICATE_ASSET_CODE_EXISTING') {
      return {
        exceptionId: exception._id,
        action: ImportException.IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE,
        value: 'CORRECTED-001'
      };
    }
    return {
      exceptionId: exception._id,
      action: ImportException.IMPORT_CUSTOMER_DECISIONS.ACCEPT_SUGGESTION
    };
  });
  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Customer confirmed corrections',
      decisions
    }
  });
  assert.equal(confirmed.importJob.publishedRows, 1);
  const corrected = await EquipmentAsset.findOne({ assetCode: 'CORRECTED-001' }).lean();
  assert.ok(corrected);
  assert.equal(corrected.acquisitionDate, null);
  assert.equal(corrected.status, EquipmentAsset.EQUIPMENT_STATUSES.IN_USE);
  assert.equal(await ImportException.countDocuments({ status: 'RESOLVED' }), 3);
});

test('team and organization scopes hide import jobs and reject out-of-scope confirmation values', async () => {
  const service = createEquipmentImportService();
  const teamA = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const teamB = context({
    teamId: fixture.teamB,
    orgUnitId: fixture.orgB1,
    userId: fixture.userB1
  });
  const orgA1 = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT
  });

  const teamPreview = await service.createPreview({
    authContext: teamA,
    upload: workbookUpload([validRow({ 资产编码: 'TEAM-A2', 所在部室: 'A2', 使用人: 'User A2' })]),
    input: {}
  });
  await assert.rejects(service.getImportJob({
    authContext: teamB,
    importJobId: teamPreview.importJob._id
  }), (error) => error.status === 404);
  await assert.rejects(service.getImportJob({
    authContext: orgA1,
    importJobId: teamPreview.importJob._id
  }), (error) => error.status === 404);

  const scopedPreview = await service.createPreview({
    authContext: orgA1,
    upload: workbookUpload([validRow({
      资产编码: 'SCOPED-001',
      所在部室: 'A2',
      使用人: ''
    })]),
    input: {}
  });
  const exceptions = await service.listExceptions({
    authContext: orgA1,
    importJobId: scopedPreview.importJob._id
  });
  const scopeException = exceptions.exceptions.find(({ exceptionType }) => (
    exceptionType === 'ORG_UNIT_OUT_OF_SCOPE'
  ));
  assert.ok(scopeException);

  await assert.rejects(service.confirmImport({
    authContext: orgA1,
    importJobId: scopedPreview.importJob._id,
    input: {
      expectedVersion: scopedPreview.importJob.version,
      reason: 'Attempt to retain foreign organization',
      decisions: [{
        exceptionId: scopeException._id,
        action: ImportException.IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE,
        value: String(fixture.orgA2)
      }]
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_CONFIRMATION_INVALID');
  assert.equal(await EquipmentAsset.countDocuments({ assetCode: 'SCOPED-001' }), 0);
  assert.equal(await ImportException.countDocuments({
    _id: scopeException._id,
    status: 'PENDING'
  }), 1);

  const confirmed = await service.confirmImport({
    authContext: orgA1,
    importJobId: scopedPreview.importJob._id,
    input: {
      expectedVersion: scopedPreview.importJob.version,
      reason: 'Customer assigned the row to the permitted organization',
      decisions: [{
        exceptionId: scopeException._id,
        action: ImportException.IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE,
        value: String(fixture.orgA1)
      }]
    }
  });
  assert.equal(confirmed.importJob.publishedRows, 1);
  assert.equal(
    String((await EquipmentAsset.findOne({ assetCode: 'SCOPED-001' }).lean()).orgUnitId),
    String(fixture.orgA1)
  );
});

test('confirmation audit failure rolls back assets, change records, decisions, and job state', async () => {
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const previewService = createEquipmentImportService();
  const preview = await previewService.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'ROLLBACK-IMPORT' })]),
    input: {}
  });
  const failingService = createEquipmentImportService({
    auditService: {
      async record({ action }) {
        if (action === permissions.AUDIT_ACTIONS.PUBLISH) {
          throw new Error('forced import audit failure');
        }
      }
    }
  });
  await assert.rejects(failingService.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'This transaction must roll back',
      decisions: []
    }
  }), /forced import audit failure/);

  assert.equal(await EquipmentAsset.countDocuments({ assetCode: 'ROLLBACK-IMPORT' }), 0);
  assert.equal(await EquipmentChangeRecord.countDocuments({
    'after.assetCode': 'ROLLBACK-IMPORT'
  }), 0);
  const persistedJob = await ImportJob.findById(preview.importJob._id).lean();
  assert.equal(persistedJob.status, ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY);
  assert.equal(persistedJob.publishedRows, 0);
});

test('invalid workbook content and client-supplied team identity are rejected before staging', async () => {
  const service = createEquipmentImportService();
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  await assert.rejects(service.createPreview({
    authContext,
    upload: workbookUpload([validRow()]),
    input: { teamId: String(fixture.teamB) }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_TEAM_ID_IMMUTABLE');

  const buffer = Buffer.from('not an xlsx workbook');
  await assert.rejects(service.createPreview({
    authContext,
    upload: {
      buffer,
      size: buffer.length,
      originalname: 'forged.xlsx',
      mimetype: EXCEL_MIME_TYPE
    },
    input: {}
  }), (error) => error.code === 'EQUIPMENT_IMPORT_FILE_UNSUPPORTED');
  assert.equal(await ImportJob.countDocuments({}), 0);
});
