'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (moduleName) => require(require.resolve(moduleName, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentChangeRecord = require('../../../app/models/EquipmentChangeRecord');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const FileAsset = require('../../../app/models/FileAsset');
const ImportException = require('../../../app/models/ImportException');
const ImportJob = require('../../../app/models/ImportJob');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentRegistryService
} = require('../../../app/services/equipmentRegistryService');
const {
  createEquipmentRoutineService
} = require('../../../app/services/equipmentRoutineService');
const {
  createEquipmentImportService
} = require('../../../app/services/equipmentImportService');

const TEST_DATABASE_NAME = 'equipment_registry_transactions_required_v2_test';
const REQUIRED_ERROR = Object.freeze({
  status: 503,
  code: 'EQUIPMENT_REGISTRY_TRANSACTIONS_REQUIRED',
  message: 'Equipment category and asset snapshot writes require MongoDB replica-set transaction support'
});
const ROUTINE_REQUIRED_ERROR = Object.freeze({
  status: 503,
  code: 'EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED',
  message: 'Equipment routine writes require MongoDB replica-set transaction support'
});

function objectId() {
  return new mongoose.Types.ObjectId();
}

function teamContext({ teamId, orgUnitId, userId }) {
  return Object.freeze({
    authenticated: true,
    sessionId: String(objectId()),
    mode: permissions.SESSION_MODES.TEAM,
    tokenVersion: 0,
    userId: String(userId),
    user: Object.freeze({ _id: String(userId), username: 'standalone-admin' }),
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
    permissionKeys: Object.freeze([
      'equipment.view',
      'equipment.create',
      'equipment.edit',
      'equipment.inspect',
      'equipment.import'
    ]),
    moduleDataScopes: Object.freeze({ equipment: permissions.DATA_SCOPES.TEAM }),
    readOnly: false,
    canAccessBusiness: true
  });
}

async function persistedState(teamId) {
  const [team, orgUnits, categories, assets, changes, rules, files, exceptions, jobs, audits] = await Promise.all([
    ProjectTeam.collection.findOne({ _id: teamId }),
    OrgUnit.collection.find({}).sort({ _id: 1 }).toArray(),
    EquipmentCategory.collection.find({}).sort({ _id: 1 }).toArray(),
    EquipmentAsset.collection.find({}).sort({ _id: 1 }).toArray(),
    EquipmentChangeRecord.collection.find({}).sort({ _id: 1 }).toArray(),
    EquipmentRoutineRule.collection.find({}).sort({ _id: 1 }).toArray(),
    FileAsset.collection.find({}).sort({ _id: 1 }).toArray(),
    ImportException.collection.find({}).sort({ _id: 1 }).toArray(),
    ImportJob.collection.find({}).sort({ _id: 1 }).toArray(),
    AuditLog.collection.find({}).sort({ _id: 1 }).toArray()
  ]);
  return JSON.parse(JSON.stringify({
    team,
    orgUnits,
    categories,
    assets,
    changes,
    rules,
    files,
    exceptions,
    jobs,
    audits
  }));
}

test('standalone mongod rejects every category snapshot write with stable 503 and zero writes', async () => {
  const standalone = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  try {
    await mongoose.connect(standalone.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
    assert.equal(mongoose.connection.client.topology.description.type, 'Single');

    const ids = {
      team: objectId(),
      orgUnit: objectId(),
      user: objectId(),
      category: objectId(),
      categoryMajor: objectId(),
      categoryType: objectId(),
      categoryPrimary: objectId(),
      asset: objectId(),
      rule: objectId(),
      importJob: objectId()
    };
    await ProjectTeam.collection.insertOne({
      _id: ids.team,
      code: 'STANDALONE_TX',
      name: 'Standalone Transaction Team',
      status: permissions.TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      equipmentCategoryStructureRevision: 0,
      createdBy: ids.user
    });
    await OrgUnit.collection.insertOne({
      _id: ids.orgUnit,
      teamId: ids.team,
      parentId: null,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      code: 'STANDALONE_ORG',
      name: 'Standalone Org Unit',
      status: permissions.ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: 1,
      path: '/'
    });
    await EquipmentCategory.collection.insertOne({
      _id: ids.category,
      teamId: ids.team,
      name: 'Existing Standalone Category',
      parentId: null,
      sortOrder: 0,
      status: 'DISABLED',
      createdBy: ids.user,
      updatedBy: ids.user
    });
    await EquipmentCategory.collection.insertMany([
      {
        _id: ids.categoryMajor,
        teamId: ids.team,
        name: 'Standalone Major',
        parentId: null,
        sortOrder: 0,
        status: 'ACTIVE',
        createdBy: ids.user,
        updatedBy: ids.user
      },
      {
        _id: ids.categoryType,
        teamId: ids.team,
        name: 'Standalone Type',
        parentId: ids.categoryMajor,
        sortOrder: 0,
        status: 'ACTIVE',
        createdBy: ids.user,
        updatedBy: ids.user
      },
      {
        _id: ids.categoryPrimary,
        teamId: ids.team,
        name: 'Standalone Primary',
        parentId: ids.categoryType,
        sortOrder: 0,
        status: 'ACTIVE',
        createdBy: ids.user,
        updatedBy: ids.user
      }
    ]);
    await EquipmentRoutineRule.collection.insertOne({
      _id: ids.rule,
      teamId: ids.team,
      categoryId: ids.categoryPrimary,
      routineType: 'INSPECTION',
      name: 'Existing Standalone Rule',
      description: '',
      checklistItems: [{
        key: 'standalone-check',
        name: 'Standalone check',
        description: '',
        required: true,
        sortOrder: 0
      }],
      schedule: { mode: 'MANUAL' },
      photoPolicy: 'NONE',
      abnormalNoteRequired: true,
      executionConfig: {},
      status: 'ACTIVE',
      version: 1,
      createdBy: ids.user,
      updatedBy: ids.user
    });
    await EquipmentAsset.collection.insertOne({
      _id: ids.asset,
      teamId: ids.team,
      orgUnitId: ids.orgUnit,
      assetCode: 'STANDALONE-ASSET-001',
      name: 'Standalone Asset',
      categoryId: ids.category,
      majorCategoryName: 'Existing Standalone Category',
      equipmentTypeName: '',
      primaryName: '',
      secondaryName: '',
      createdBy: ids.user,
      updatedBy: ids.user
    });
    await ImportJob.collection.insertOne({
      _id: ids.importJob,
      teamId: ids.team,
      type: ImportJob.IMPORT_TYPES.EQUIPMENT_ASSET,
      status: ImportJob.IMPORT_JOB_STATUSES.PREVIEW_READY,
      totalRows: 0,
      validRows: 0,
      warningRows: 0,
      errorRows: 0,
      skippedRows: 0,
      publishedRows: 0,
      stagedRows: [],
      createdBy: ids.user,
      __v: 0
    });

    const context = teamContext({
      teamId: ids.team,
      orgUnitId: ids.orgUnit,
      userId: ids.user
    });
    const service = createEquipmentRegistryService();
    const routineService = createEquipmentRoutineService();
    const importService = createEquipmentImportService({
      storageRoot: path.join(__dirname, 'standalone-unused-storage')
    });
    const before = await persistedState(ids.team);
    const operations = [
      ['createCategory', REQUIRED_ERROR, () => service.createCategory({
        authContext: context,
        input: { name: 'Must Not Be Created' }
      })],
      ['updateCategory', REQUIRED_ERROR, () => service.updateCategory({
        authContext: context,
        categoryId: ids.category,
        input: { name: 'Must Not Be Renamed' }
      })],
      ['deleteCategory', REQUIRED_ERROR, () => service.deleteCategory({
        authContext: context,
        categoryId: ids.category,
        input: { reason: 'Must not delete' }
      })],
      ['createAsset', REQUIRED_ERROR, () => service.createAsset({
        authContext: context,
        input: {
          assetCode: 'MUST-NOT-CREATE',
          name: 'Must Not Create Asset',
          orgUnitId: ids.orgUnit,
          categoryId: ids.category
        }
      })],
      ['updateAsset', REQUIRED_ERROR, () => service.updateAsset({
        authContext: context,
        equipmentId: ids.asset,
        input: { name: 'Must Not Rename Asset' }
      })],
      ['confirmImport', REQUIRED_ERROR, () => importService.confirmImport({
        authContext: context,
        importJobId: ids.importJob,
        input: {
          expectedVersion: 0,
          reason: 'Must not publish without transaction support',
          decisions: []
        }
      })],
      ['createRule', ROUTINE_REQUIRED_ERROR, () => routineService.createRule({
        authContext: context,
        input: {
          routineType: 'INSPECTION',
          categoryId: ids.categoryPrimary,
          name: 'Must Not Create Rule',
          checklistItems: [{ name: 'Must not persist' }],
          schedule: { mode: 'MANUAL' }
        }
      })],
      ['updateRule', ROUTINE_REQUIRED_ERROR, () => routineService.updateRule({
        authContext: context,
        ruleId: ids.rule,
        input: { name: 'Must Not Update Rule' }
      })]
    ];

    for (const [operationName, expectedError, operation] of operations) {
      await assert.rejects(operation(), (error) => {
        assert.equal(error.status, expectedError.status, operationName);
        assert.equal(error.code, expectedError.code, operationName);
        assert.equal(error.message, expectedError.message, operationName);
        return true;
      });
    }

    assert.deepEqual(await persistedState(ids.team), before);
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await standalone.stop();
  }
});
