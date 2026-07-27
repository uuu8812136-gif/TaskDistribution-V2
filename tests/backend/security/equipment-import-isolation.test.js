'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
const FileAsset = require('../../../app/models/FileAsset');
const ImportException = require('../../../app/models/ImportException');
const ImportJob = require('../../../app/models/ImportJob');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const { resolveStoragePath } = require('../../../app/services/fileStorageService');
const { rowKey } = require('../../../app/services/equipmentWorkbookMediaExtractor');
const {
  EXCEL_MIME_TYPE,
  createEquipmentImportService
} = require('../../../app/services/equipmentImportService');
const {
  createEquipmentImportStagingCleanupService
} = require('../../../app/services/equipmentImportStagingCleanupService');

const TEST_DATABASE_NAME = 'equipment_import_isolation_v2_test';
const MODELS = [
  AuditLog,
  EquipmentAsset,
  EquipmentCategory,
  EquipmentChangeRecord,
  FileAsset,
  ImportException,
  ImportJob,
  OrgUnit,
  ProjectTeam,
  TeamMembership,
  User
];

let replicaSet;
let fixture;
let storageRoot;
let previousUploadPath;

const PNG_CONTENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(8, 0x01)
]);

const NORMALIZED_JPEG_CONTENT = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
  0x4a, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0xff, 0xd9
]);

function mediaExtractor({ sheetName = '测试分类', rowNumber = 2 } = {}) {
  return () => ({
    imagesByRow: new Map([[
      rowKey(sheetName, rowNumber),
      [{
        sheetName,
        rowNumber,
        imageRef: `DRAWING:test:${rowNumber}`,
        sourceKind: 'DRAWING',
        mediaPath: 'xl/media/test.png',
        extension: '.png',
        mimeType: 'image/png',
        buffer: PNG_CONTENT
      }]
    ]]),
    summary: {
      wpsImageDefinitions: 0,
      wpsCellReferences: 0,
      uniqueWpsImageReferences: 0,
      unusedWpsImageDefinitions: [],
      drawingImages: 1,
      rowsWithImages: 1,
      referencedMediaBytes: PNG_CONTENT.length
    }
  });
}

function mixedValidityMediaExtractor() {
  const extract = mediaExtractor();
  return () => {
    const result = extract();
    const key = rowKey('测试分类', 2);
    result.imagesByRow.get(key).push({
      sheetName: '测试分类',
      rowNumber: 2,
      imageRef: 'DRAWING:test:invalid',
      sourceKind: 'DRAWING',
      mediaPath: 'xl/media/invalid.jpeg',
      extension: '.jpg',
      mimeType: 'image/jpeg',
      buffer: null,
      byteLength: 128,
      isValid: false,
      validationError: 'File content does not match its declared MIME type'
    });
    result.summary.drawingImages = 2;
    result.summary.referencedMediaBytes += 128;
    result.summary.invalidMediaFiles = 1;
    result.summary.invalidMediaReferences = 1;
    result.summary.invalidMediaPaths = ['xl/media/invalid.jpeg'];
    return result;
  };
}

function sanitizedJpegMediaExtractor() {
  return () => ({
    imagesByRow: new Map([[
      rowKey('测试分类', 2),
      [{
        sheetName: '测试分类',
        rowNumber: 2,
        imageRef: 'DRAWING:test:sanitized-jpeg',
        sourceKind: 'DRAWING',
        mediaPath: 'xl/media/wps-trailing.jpeg',
        extension: '.jpg',
        mimeType: 'image/jpeg',
        buffer: NORMALIZED_JPEG_CONTENT,
        byteLength: NORMALIZED_JPEG_CONTENT.length + 24,
        isValid: true,
        validationError: null,
        sanitizationType: 'JPEG_TRAILING_DATA_STRIPPED',
        originalByteLength: NORMALIZED_JPEG_CONTENT.length + 24,
        normalizedByteLength: NORMALIZED_JPEG_CONTENT.length,
        removedTrailingBytes: 24
      }]
    ]]),
    summary: {
      wpsImageDefinitions: 0,
      wpsCellReferences: 0,
      uniqueWpsImageReferences: 0,
      unusedWpsImageDefinitions: [],
      drawingImages: 1,
      rowsWithImages: 1,
      referencedMediaBytes: NORMALIZED_JPEG_CONTENT.length + 24,
      sanitizedMediaFiles: 1,
      sanitizedMediaReferences: 1,
      sanitizedBytesRemoved: 24,
      sanitizedMediaPaths: ['xl/media/wps-trailing.jpeg'],
      invalidMediaFiles: 0,
      invalidMediaReferences: 0,
      invalidMediaPaths: []
    }
  });
}

async function storedFileCount() {
  const entries = await fs.promises.readdir(storageRoot, {
    recursive: true,
    withFileTypes: true
  }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).length;
}

function objectId() {
  return new mongoose.Types.ObjectId();
}

function context({
  teamId,
  orgUnitId,
  userId,
  scope = permissions.DATA_SCOPES.TEAM,
  equipmentOrgUnitScopeIds = undefined
}) {
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
    ...(equipmentOrgUnitScopeIds
      ? { equipmentOrgUnitScopeIds: Object.freeze(equipmentOrgUnitScopeIds.map(String)) }
      : {}),
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

function multiSheetWorkbookUpload(sheets, originalname = 'equipment-import-multi.xlsx') {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheetName);
  }
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
    序号: 7,
    资产编码: 'IMPORT-001',
    名称: 'Imported asset',
    资产类别: '测试分类',
    产品编码: 'PRODUCT-001',
    车牌号: '鲁A-TEST1',
    品牌: 'Test Brand',
    品牌编号: 'BRAND-SN-001',
    所在部室: 'A1',
    使用人: 'User A1',
    账存数量: 1,
    实盘数量: 1,
    单位: '台',
    出厂日期: '2023年5月6日',
    启用日期: '2024年6月7日',
    状态: '在用',
    型号规格: 'MODEL-A',
    生产厂家: 'Factory A',
    车长: '4.2米',
    吨位: '2吨',
    叉车是否高低位: '高位',
    叉车环保编号: '环D-TEST-001',
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
  previousUploadPath = process.env.UPLOAD_PATH;
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'equipment-import-v2-'));
  process.env.UPLOAD_PATH = storageRoot;
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  await Promise.all(MODELS.map((model) => model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.collection.deleteMany({})));
  await fs.promises.rm(storageRoot, { recursive: true, force: true });
  await fs.promises.mkdir(storageRoot, { recursive: true });
  fixture = await seedFixture();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
  await fs.promises.rm(storageRoot, { recursive: true, force: true });
  if (previousUploadPath === undefined) delete process.env.UPLOAD_PATH;
  else process.env.UPLOAD_PATH = previousUploadPath;
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
  const stagedCandidate = preview.importJob.rows[0].candidate;
  assert.equal(stagedCandidate.sourceSequence, '7');
  assert.equal(stagedCandidate.sourceAssetCode, 'IMPORT-001');
  assert.equal(stagedCandidate.productCode, 'PRODUCT-001');
  assert.equal(stagedCandidate.plateNumber, '鲁A-TEST1');
  assert.equal(stagedCandidate.brandSerialNumber, 'BRAND-SN-001');
  assert.equal(stagedCandidate.productionDatePrecision, EquipmentAsset.DATE_PRECISIONS.DAY);
  assert.equal(stagedCandidate.activationDatePrecision, EquipmentAsset.DATE_PRECISIONS.DAY);
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
  assert.equal(asset.sourceSequence, '7');
  assert.equal(asset.sourceSheetName, '测试分类');
  assert.equal(asset.sourceRowNumber, 2);
  assert.equal(asset.sourceAssetCode, 'IMPORT-001');
  assert.equal(asset.productCode, 'PRODUCT-001');
  assert.equal(asset.plateNumber, '鲁A-TEST1');
  assert.equal(asset.brand, 'Test Brand');
  assert.equal(asset.brandSerialNumber, 'BRAND-SN-001');
  assert.equal(asset.vehicleLength, '4.2米');
  assert.equal(asset.ratedCapacityText, '2吨');
  assert.equal(asset.productionDatePrecision, EquipmentAsset.DATE_PRECISIONS.DAY);
  assert.equal(asset.activationDatePrecision, EquipmentAsset.DATE_PRECISIONS.DAY);
  assert.equal(asset.bookQuantity, 1);
  assert.equal(asset.physicalQuantity, 1);
  assert.equal(asset.custodianDisplayName, 'User A1');
  assert.equal(asset.orgUnitNameSnapshot, 'A1');
  assert.equal(asset.conditionText, '在用');
  assert.equal(asset.forkliftPosition, '高位');
  assert.equal(asset.environmentalRegistrationCode, '环D-TEST-001');
  assert.equal(asset.sourceRawValues['产品编码'], 'PRODUCT-001');
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

test('new ledger imports resolve the exact four-level category path before publication', async () => {
  const ids = [objectId(), objectId(), objectId(), objectId()];
  await EquipmentCategory.collection.insertMany([
    { _id: ids[0], teamId: fixture.teamA, name: '运输装备', parentId: null, status: 'ACTIVE', sortOrder: 0, createdBy: fixture.userA1, updatedBy: fixture.userA1 },
    { _id: ids[1], teamId: fixture.teamA, name: '车辆', parentId: ids[0], status: 'ACTIVE', sortOrder: 0, createdBy: fixture.userA1, updatedBy: fixture.userA1 },
    { _id: ids[2], teamId: fixture.teamA, name: '厢式货车', parentId: ids[1], status: 'ACTIVE', sortOrder: 0, createdBy: fixture.userA1, updatedBy: fixture.userA1 },
    { _id: ids[3], teamId: fixture.teamA, name: '4.2米轻卡', parentId: ids[2], status: 'ACTIVE', sortOrder: 0, createdBy: fixture.userA1, updatedBy: fixture.userA1 }
  ]);
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const upload = multiSheetWorkbookUpload([['设备台账模板', [{
    序号: 1,
    设备所属大类: '运输装备',
    设备所属类型: '车辆',
    设备一级名称: '厢式货车',
    设备二级名称: '4.2米轻卡',
    固定资产编号: '鲁A0C01F',
    车牌号: '鲁A0C01F',
    环保编号: '/',
    '产品/品牌编码': 'LZZJBADB4KE765069',
    型号规格: '4.2米轻卡',
    单位: '辆',
    出厂日期: '2019/10/1',
    启用日期: '2019/10/1',
    车长: '4.2米',
    吨位: '/',
    '高位/低位': '/',
    '设备动力类型：锂电/铅酸/柴油': '柴油',
    排放标准: '国5',
    品牌: '豪沃',
    生产厂家: '中国重汽',
    账存数量: 1,
    实盘数量: 1,
    所在部室: 'A1',
    使用人: 'User A1',
    状态: '在用',
    存放地点: '外仓'
  }]]]);
  const service = createEquipmentImportService();
  const preview = await service.createPreview({ authContext, upload, input: {} });
  assert.equal(preview.exceptionCount, 0);
  assert.equal(preview.importJob.rows[0].candidate.categoryId, String(ids[3]));
  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: '确认新版设备台账模板',
      decisions: []
    }
  });
  assert.equal(confirmed.importJob.publishedRows, 1);
  const asset = await EquipmentAsset.findOne({ assetCode: '鲁A0C01F' }).lean();
  assert.deepEqual([
    asset.majorCategoryName,
    asset.equipmentTypeName,
    asset.primaryName,
    asset.secondaryName
  ], ['运输装备', '车辆', '厢式货车', '4.2米轻卡']);
  assert.equal(String(asset.categoryId), String(ids[3]));
  assert.equal(asset.name, '4.2米轻卡');
  assert.equal(asset.powerType, '柴油');
  assert.equal(asset.emissionStandard, '国5');
});

test('a second-level equipment row accepts a custodian from its child group only', async () => {
  const service = createEquipmentImportService();
  const subDepartment = objectId();
  const childGroup = objectId();
  const otherSubDepartment = objectId();
  const branchCustodian = objectId();
  await OrgUnit.collection.insertMany([
    {
      _id: subDepartment,
      teamId: fixture.teamA,
      parentId: fixture.orgA1,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'IMPORT_SUB_A',
      name: 'Import Sub A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 2,
      path: `/${fixture.orgA1}/`
    },
    {
      _id: childGroup,
      teamId: fixture.teamA,
      parentId: subDepartment,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'IMPORT_GROUP_A',
      name: 'Import Group A',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 3,
      path: `/${fixture.orgA1}/${subDepartment}/`
    },
    {
      _id: otherSubDepartment,
      teamId: fixture.teamA,
      parentId: fixture.orgA1,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'IMPORT_SUB_A2',
      name: 'Import Sub A2',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 1,
      level: 2,
      path: `/${fixture.orgA1}/`
    }
  ]);
  await User.collection.insertOne({
    _id: branchCustodian,
    username: 'branch-import-custodian',
    usernameNormalized: 'branch-import-custodian',
    password: 'unused',
    name: 'Branch Import Custodian',
    roles: [],
    isSuperAdmin: false,
    tokenVersion: 0,
    status: 'active'
  });
  await TeamMembership.collection.insertOne({
    _id: objectId(),
    teamId: fixture.teamA,
    userId: branchCustodian,
    orgUnitId: childGroup,
    role: permissions.MEMBERSHIP_ROLES.MEMBER,
    positionLevel: permissions.POSITION_LEVEL_BY_KEY[permissions.POSITION_KEYS.EMPLOYEE],
    positionKey: permissions.POSITION_KEYS.EMPLOYEE,
    functionalRoleKeys: [],
    permissionKeys: [],
    moduleDataScopes: permissions.deriveModuleDataScopes({
      positionLevel: permissions.POSITION_LEVEL_BY_KEY[permissions.POSITION_KEYS.EMPLOYEE]
    }),
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE,
    joinedAt: new Date()
  });
  const branchContext = context({
    teamId: fixture.teamA,
    orgUnitId: childGroup,
    userId: fixture.userA1,
    scope: permissions.DATA_SCOPES.ORG_UNIT,
    equipmentOrgUnitScopeIds: [subDepartment, childGroup]
  });

  const preview = await service.createPreview({
    authContext: branchContext,
    upload: workbookUpload([validRow({
      资产编码: 'BRANCH-IMPORT-001',
      所在部室: 'Import Sub A',
      使用人: 'Branch Import Custodian'
    })]),
    input: {}
  });
  assert.equal(preview.exceptionCount, 0);
  assert.equal(preview.importJob.validRows, 1);
  assert.equal(preview.importJob.rows[0].candidate.custodianUserId, String(branchCustodian));
  const confirmed = await service.confirmImport({
    authContext: branchContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Confirm child-group custodian for second-level equipment',
      decisions: []
    }
  });
  assert.equal(confirmed.importJob.publishedRows, 1);
  const asset = await EquipmentAsset.findOne({ assetCode: 'BRANCH-IMPORT-001' }).lean();
  assert.equal(String(asset.orgUnitId), String(subDepartment));
  assert.equal(String(asset.custodianUserId), String(branchCustodian));

  const outOfScopePreview = await service.createPreview({
    authContext: branchContext,
    upload: workbookUpload([validRow({
      资产编码: 'BRANCH-IMPORT-OUTSIDE',
      产品编码: 'PRODUCT-OUTSIDE',
      所在部室: 'Import Sub A2',
      使用人: ''
    })]),
    input: {}
  });
  const outOfScopeExceptions = await service.listExceptions({
    authContext: branchContext,
    importJobId: outOfScopePreview.importJob._id
  });
  assert.ok(outOfScopeExceptions.exceptions.some(
    ({ exceptionType }) => exceptionType === 'ORG_UNIT_OUT_OF_SCOPE'
  ));
});

test('embedded workbook images stage under the import and bind to equipment only after publication', async () => {
  const service = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot
  });
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'MEDIA-001' })]),
    input: {}
  });
  const candidate = preview.importJob.rows[0].candidate;
  assert.equal(candidate.photoFileIds.length, 1);
  assert.equal(candidate.dataQuality.photoMappingStatus, 'STAGED');
  assert.equal(preview.importJob.mediaSummary.stagedMediaFiles, 1);

  const stagedFiles = await FileAsset.find({ ownerId: preview.importJob._id })
    .sort({ ownerType: 1 })
    .lean();
  assert.equal(stagedFiles.length, 2);
  assert.deepEqual(
    stagedFiles.map(({ ownerType }) => ownerType).sort(),
    [
      FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
      FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE
    ].sort()
  );
  assert.equal(stagedFiles.every(({ status }) => status === FileAsset.FILE_STATUSES.ACTIVE), true);
  const stagedMedia = stagedFiles.find(({ ownerType }) => (
    ownerType === FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
  ));
  assert.deepEqual(
    await fs.promises.readFile(resolveStoragePath(storageRoot, stagedMedia.storageKey)),
    PNG_CONTENT
  );

  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Publish mapped workbook media',
      decisions: []
    }
  });
  const asset = await EquipmentAsset.findById(confirmed.equipmentIds[0]).lean();
  assert.deepEqual(asset.photoFileIds.map(String), candidate.photoFileIds);
  assert.equal(asset.dataQuality.photoMappingStatus, 'MAPPED');
  const boundMedia = await FileAsset.findById(candidate.photoFileIds[0]).lean();
  assert.equal(boundMedia.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT);
  assert.equal(String(boundMedia.ownerId), String(asset._id));
  assert.equal(boundMedia.status, FileAsset.FILE_STATUSES.ACTIVE);
  const sourceFile = await FileAsset.findById(preview.importJob.sourceFileId).lean();
  assert.equal(sourceFile.ownerType, FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE);
  assert.equal(String(sourceFile.ownerId), preview.importJob._id);
});

test('sanitized workbook JPEG is staged, published, and recorded as a non-blocking notice', async () => {
  const service = createEquipmentImportService({
    extractWorkbookMedia: sanitizedJpegMediaExtractor(),
    storageRoot
  });
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'SANITIZED-JPEG-001' })]),
    input: {}
  });

  assert.equal(preview.exceptionCount, 0);
  assert.equal(preview.importJob.mediaSummary.sanitizedMediaFiles, 1);
  assert.equal(preview.importJob.mediaSummary.sanitizedMediaReferences, 1);
  assert.equal(preview.importJob.mediaSummary.sanitizedBytesRemoved, 24);
  const candidate = preview.importJob.rows[0].candidate;
  assert.equal(candidate.photoFileIds.length, 1);
  assert.equal(candidate.dataQuality.photoMappingStatus, 'STAGED');
  assert.equal(candidate.dataQuality.sanitizedPhotoCount, 1);
  assert.deepEqual(candidate.dataQuality.mediaNotices, [{
    code: 'SANITIZED_WORKBOOK_MEDIA',
    sanitizationType: 'JPEG_TRAILING_DATA_STRIPPED',
    imageRef: 'DRAWING:test:sanitized-jpeg',
    sourceKind: 'DRAWING',
    mediaPath: 'xl/media/wps-trailing.jpeg',
    mimeType: 'image/jpeg',
    originalByteLength: NORMALIZED_JPEG_CONTENT.length + 24,
    normalizedByteLength: NORMALIZED_JPEG_CONTENT.length,
    removedTrailingBytes: 24
  }]);
  const stagedMedia = await FileAsset.findById(candidate.photoFileIds[0]).lean();
  assert.deepEqual(
    await fs.promises.readFile(resolveStoragePath(storageRoot, stagedMedia.storageKey)),
    NORMALIZED_JPEG_CONTENT
  );

  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Publish safely normalized WPS JPEG',
      decisions: []
    }
  });
  const asset = await EquipmentAsset.findById(confirmed.equipmentIds[0]).lean();
  assert.equal(asset.photoFileIds.length, 1);
  assert.equal(asset.dataQuality.photoMappingStatus, 'MAPPED');
  assert.equal(asset.dataQuality.sanitizedPhotoCount, 1);
  assert.equal(asset.dataQuality.mediaNotices[0].code, 'SANITIZED_WORKBOOK_MEDIA');
  assert.equal(await ImportException.countDocuments({ importJobId: preview.importJob._id }), 0);
});

test('invalid embedded media is visible as an exception and is never staged or published', async () => {
  const service = createEquipmentImportService({
    extractWorkbookMedia: mixedValidityMediaExtractor(),
    storageRoot
  });
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'MIXED-MEDIA-001' })]),
    input: {}
  });
  assert.equal(preview.importJob.rows[0].candidate.photoFileIds.length, 1);
  assert.equal(preview.importJob.rows[0].candidate.dataQuality.invalidPhotoCount, 1);
  assert.equal(preview.importJob.rows[0].candidate.dataQuality.photoMappingStatus, 'PARTIALLY_STAGED');
  assert.equal(await FileAsset.countDocuments({ ownerId: preview.importJob._id }), 2);

  const exceptionResult = await service.listExceptions({
    authContext,
    importJobId: preview.importJob._id,
    query: { pageSize: 20 }
  });
  const invalidMedia = exceptionResult.exceptions.find(({ exceptionType }) => (
    exceptionType === 'INVALID_WORKBOOK_MEDIA'
  ));
  assert.ok(invalidMedia);
  assert.equal(invalidMedia.severity, ImportException.IMPORT_EXCEPTION_SEVERITIES.ERROR);
  await assert.rejects(service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Cannot silently ignore invalid media',
      decisions: []
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_CONFIRMATION_INVALID');

  const confirmed = await service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Customer confirmed publication without the invalid image',
      decisions: [{
        exceptionId: invalidMedia._id,
        action: ImportException.IMPORT_CUSTOMER_DECISIONS.USE_RESOLVED_VALUE,
        value: 'Publish without invalid media'
      }]
    }
  });
  const asset = await EquipmentAsset.findById(confirmed.equipmentIds[0]).lean();
  assert.equal(asset.photoFileIds.length, 1);
  assert.equal(asset.dataQuality.photoMappingStatus, 'PARTIALLY_MAPPED_CONFIRMED');
  assert.equal(await FileAsset.countDocuments({
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
    ownerId: asset._id,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }), 1);
});

test('cancelling a preview soft-deletes its source workbook and every staged image', async () => {
  const service = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot
  });
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'CANCEL-MEDIA-001' })]),
    input: {}
  });
  const stagedFiles = await FileAsset.find({ ownerId: preview.importJob._id }).lean();
  const stagedPaths = stagedFiles.map(({ storageKey }) => resolveStoragePath(storageRoot, storageKey));
  assert.equal(stagedPaths.every((filePath) => fs.existsSync(filePath)), true);
  const cancelled = await service.cancelImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'User discarded this preview'
    }
  });
  assert.equal(cancelled.importJob.status, ImportJob.IMPORT_JOB_STATUSES.CANCELLED);
  assert.equal(cancelled.importJob.cancelReason, 'User discarded this preview');
  assert.equal(cancelled.importJob.stagingCleanupStatus, 'COMPLETE');
  assert.equal(cancelled.stagingCleanup.deletedFiles, 2);
  assert.equal(stagedPaths.every((filePath) => !fs.existsSync(filePath)), true);
  assert.equal(await FileAsset.countDocuments({
    ownerId: preview.importJob._id,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }), 0);
  assert.equal(await FileAsset.countDocuments({
    ownerId: preview.importJob._id,
    status: FileAsset.FILE_STATUSES.DELETED
  }), 2);
  await assert.rejects(service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: cancelled.importJob.version,
      reason: 'Cancelled previews cannot publish',
      decisions: []
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_CANCELLED');
});

test('failed physical cleanup is persisted, audited, and retryable', async () => {
  const failingCleanupService = createEquipmentImportStagingCleanupService({
    storageRoot,
    fsPromises: {
      rm: async () => {
        const error = new Error('simulated sharing violation');
        error.code = 'EBUSY';
        throw error;
      }
    }
  });
  const service = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot,
    stagingCleanupService: failingCleanupService
  });
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 璧勪骇缂栫爜: 'CLEANUP-RETRY-001' })]),
    input: {}
  });
  const stagedFiles = await FileAsset.find({ ownerId: preview.importJob._id }).lean();
  const stagedPaths = stagedFiles.map(({ storageKey }) => resolveStoragePath(storageRoot, storageKey));
  const cancelled = await service.cancelImport({
    authContext,
    importJobId: preview.importJob._id,
    input: { expectedVersion: preview.importJob.version, reason: 'Exercise retryable cleanup' }
  });
  assert.equal(cancelled.importJob.status, 'CANCELLED');
  assert.equal(cancelled.importJob.stagingCleanupStatus, 'FAILED');
  assert.match(cancelled.importJob.stagingCleanupLastError, /EBUSY/);
  assert.equal(stagedPaths.every((filePath) => fs.existsSync(filePath)), true);

  const retryService = createEquipmentImportStagingCleanupService({ storageRoot });
  const retried = await retryService.finalizeCleanup({
    jobId: preview.importJob._id,
    teamId: fixture.teamA
  });
  assert.equal(retried.cleanup.status, 'COMPLETE');
  assert.equal(retried.cleanup.attempt, 2);
  assert.equal(stagedPaths.every((filePath) => !fs.existsSync(filePath)), true);
  assert.equal(await AuditLog.countDocuments({
    resourceId: String(preview.importJob._id),
    action: permissions.AUDIT_ACTIONS.FILE_DELETE
  }), 2);
});

test('expired previews are cleaned while published asset images remain intact', async () => {
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const service = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot
  });
  const preview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 璧勪骇缂栫爜: 'EXPIRE-001' })]),
    input: {}
  });
  const previewFiles = await FileAsset.find({ ownerId: preview.importJob._id }).lean();
  const previewPaths = previewFiles.map(({ storageKey }) => resolveStoragePath(storageRoot, storageKey));
  const oldDate = new Date('2026-07-15T00:00:00.000Z');
  await ImportJob.collection.updateOne({ _id: new mongoose.Types.ObjectId(preview.importJob._id) }, {
    $set: { createdAt: oldDate }
  });

  const publishedPreview = await service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 璧勪骇缂栫爜: 'PUBLISHED-KEEP-001' })]),
    input: {}
  });
  const published = await service.confirmImport({
    authContext,
    importJobId: publishedPreview.importJob._id,
    input: {
      expectedVersion: publishedPreview.importJob.version,
      reason: 'Publish before expiration sweep',
      decisions: []
    }
  });
  const asset = await EquipmentAsset.findById(published.equipmentIds[0]).lean();
  const publishedImage = await FileAsset.findById(asset.photoFileIds[0]).lean();
  const publishedImagePath = resolveStoragePath(storageRoot, publishedImage.storageKey);
  await ImportJob.collection.updateOne({ _id: new mongoose.Types.ObjectId(publishedPreview.importJob._id) }, {
    $set: { createdAt: oldDate }
  });

  const cleanupService = createEquipmentImportStagingCleanupService({ storageRoot });
  const result = await cleanupService.cleanupExpiredPreviews({
    now: new Date('2026-07-17T00:00:00.000Z'),
    maxAgeMs: 24 * 60 * 60 * 1000,
    limit: 10
  });
  assert.equal(result.matched, 1);
  const expired = await ImportJob.findById(preview.importJob._id).lean();
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(expired.stagingCleanupStatus, 'COMPLETE');
  assert.equal(previewPaths.every((filePath) => !fs.existsSync(filePath)), true);
  assert.equal(await FileAsset.countDocuments({
    ownerId: preview.importJob._id,
    status: FileAsset.FILE_STATUSES.DELETED
  }), 2);
  assert.equal(fs.existsSync(publishedImagePath), true);
  assert.equal((await FileAsset.findById(publishedImage._id).lean()).status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal((await ImportJob.findById(publishedPreview.importJob._id).lean()).status, 'PUBLISHED');
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

test('idle rows matching an earlier source identifier are staged as duplicate source records', async () => {
  const service = createEquipmentImportService();
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const preview = await service.createPreview({
    authContext,
    upload: multiSheetWorkbookUpload([
      ['测试分类', [validRow({
        资产编码: 'ACTIVE-SOURCE-001',
        产品编码: 'SHARED-SOURCE-001'
      })]],
      ['闲置', [{
        序号: 1,
        资产类别: '测试分类',
        名称: 'Idle duplicate',
        '编号/牌号': 'SHARED-SOURCE-001',
        数量: 1,
        放置日期: 2026.3,
        存放地点: 'A1',
        当前状态: '正常'
      }]]
    ]),
    input: {}
  });
  const exceptions = await service.listExceptions({
    authContext,
    importJobId: preview.importJob._id,
    query: { pageSize: 200 }
  });
  const duplicate = exceptions.exceptions.find(({ exceptionType }) => (
    exceptionType === 'DUPLICATE_SOURCE_IDENTIFIER_IN_FILE'
  ));
  assert.ok(duplicate);
  assert.equal(duplicate.sheetName, '闲置');
  assert.equal(duplicate.field, '_sourceIdentity');
  await assert.rejects(service.confirmImport({
    authContext,
    importJobId: preview.importJob._id,
    input: {
      expectedVersion: preview.importJob.version,
      reason: 'Idle duplicates cannot publish without explicit row decisions',
      decisions: []
    }
  }), (error) => error.code === 'EQUIPMENT_IMPORT_CONFIRMATION_INVALID');
  assert.equal(await EquipmentAsset.countDocuments({}), 0);
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
  const previewService = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot
  });
  const preview = await previewService.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'ROLLBACK-IMPORT' })]),
    input: {}
  });
  const failingService = createEquipmentImportService({
    storageRoot,
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
  const stagedMedia = await FileAsset.findOne({
    ownerId: preview.importJob._id,
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA
  }).lean();
  assert.equal(stagedMedia.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(String(stagedMedia.ownerId), preview.importJob._id);
});

test('preview persistence failure removes staged database rows and private bytes', async () => {
  const authContext = context({
    teamId: fixture.teamA,
    orgUnitId: fixture.orgA1,
    userId: fixture.userA1
  });
  const service = createEquipmentImportService({
    extractWorkbookMedia: mediaExtractor(),
    storageRoot,
    auditService: {
      async record() {
        throw new Error('forced preview audit failure');
      }
    }
  });
  await assert.rejects(service.createPreview({
    authContext,
    upload: workbookUpload([validRow({ 资产编码: 'PREVIEW-ROLLBACK-001' })]),
    input: {}
  }), /forced preview audit failure/);
  assert.equal(await ImportJob.countDocuments({}), 0);
  assert.equal(await ImportException.countDocuments({}), 0);
  assert.equal(await FileAsset.countDocuments({}), 0);
  assert.equal(await storedFileCount(), 0);
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
