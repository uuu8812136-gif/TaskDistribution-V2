'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const AuditLog = require('../../../app/models/AuditLog');
const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentChangeRecord = require('../../../app/models/EquipmentChangeRecord');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createEquipmentOwnershipBackfillService
} = require('../../../app/services/equipmentOwnershipBackfillService');

const IMPORT_TAG = 'customer-fixed-assets-2026-midyear-v1';
const REHEARSAL_DATABASE = 'device_scope_rehearsal_v2_test';
let replicaSet;
let fixture;

function verifiedBackup(backupDirectory, databaseName = REHEARSAL_DATABASE) {
  return {
    backupDirectory,
    manifestSha256: 'a'.repeat(64),
    manifest: {
      backupId: 'equipment-ownership-test-backup',
      completedAt: '2026-07-24T00:00:00.000Z',
      database: {
        name: databaseName,
        collections: [
          { name: 'equipmentassets' },
          { name: 'equipmentroutineplans' }
        ]
      },
      files: [
        { file: `database/${databaseName}/equipmentassets.bson` },
        { file: `database/${databaseName}/equipmentroutineplans.bson` }
      ]
    }
  };
}

async function seed() {
  const operator = await User.create({
    username: 'ownership.migration',
    password: 'migration-password',
    name: 'Ownership Migration Operator',
    status: 'active',
    isSuperAdmin: true
  });
  const custodian = await User.create({
    username: 'gaoguangbing.test',
    password: 'custodian-password',
    name: '高广兵',
    status: 'active'
  });
  const team = await ProjectTeam.create({
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    createdBy: operator._id
  });
  const root = await OrgUnit.create({
    teamId: team._id,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: 'DEPARTMENT',
    name: '变速箱物流部',
    level: 1,
    path: '/'
  });
  const warehouseTwo = await OrgUnit.create({
    teamId: team._id,
    parentId: root._id,
    type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'WAREHOUSE_TWO',
    name: '仓配二分部',
    level: 2,
    path: `/${root._id}/`
  });
  const group = await OrgUnit.create({
    teamId: team._id,
    parentId: warehouseTwo._id,
    type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
    code: 'B1',
    name: 'B1 总装拣配组',
    level: 3,
    path: `/${root._id}/${warehouseTwo._id}/`
  });
  await TeamMembership.create({
    teamId: team._id,
    userId: custodian._id,
    orgUnitId: group._id,
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE
  });
  const category = await EquipmentCategory.create({
    teamId: team._id,
    name: '装卸装备',
    createdBy: operator._id,
    updatedBy: operator._id
  });
  const base = {
    teamId: team._id,
    orgUnitId: root._id,
    categoryId: category._id,
    quantity: 1,
    status: EquipmentAsset.EQUIPMENT_STATUSES.IN_USE,
    dataQuality: { importTag: IMPORT_TAG },
    createdBy: operator._id,
    updatedBy: operator._id
  };
  const assets = await EquipmentAsset.create([
    {
      ...base,
      assetCode: 'CUST26-HDL-005',
      name: '高位叉车',
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    },
    {
      ...base,
      assetCode: 'CUST26-HDL-006',
      name: '低位叉车',
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '未建档人员'
    },
    {
      ...base,
      assetCode: 'CUST26-AUX-001',
      name: '辅助设备',
      orgUnitNameSnapshot: '技术质量室',
      custodianDisplayName: '未建档人员'
    }
  ]);
  const now = new Date('2026-07-24T00:00:00.000Z');
  const routinePlans = assets.map((asset, index) => ({
    _id: new mongoose.Types.ObjectId(),
    teamId: team._id,
    orgUnitId: root._id,
    equipmentId: asset._id,
    categoryId: category._id,
    ruleId: new mongoose.Types.ObjectId(),
    ruleVersion: 1,
    ruleSnapshot: { name: `Rule ${index + 1}` },
    routineType: 'INSPECTION',
    cycleKey: `2026-07-24-${index + 1}`,
    windowKey: 'DAILY',
    windowName: '每日',
    scheduledFor: now,
    dueAt: new Date(now.getTime() + 60 * 60 * 1000),
    status: 'PLANNED',
    completedRecordId: null,
    completedAt: null,
    completedBy: null,
    createdAt: now,
    updatedAt: now,
    __v: 0
  }));
  await EquipmentRoutinePlan.collection.insertMany(routinePlans);
  return { operator, custodian, team, root, warehouseTwo, group, assets, routinePlans };
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri(REHEARSAL_DATABASE), {
    autoIndex: true,
    serverSelectionTimeoutMS: 10_000
  });
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('equipment ownership backfill is previewable, transactional, audited and idempotent', async () => {
  const service = createEquipmentOwnershipBackfillService({
    connection: mongoose.connection,
    backupVerifier: async (backupDirectory) => verifiedBackup(backupDirectory),
    allowedExecutionDatabaseNames: [REHEARSAL_DATABASE]
  });
  const input = {
    teamCode: fixture.team.code,
    importTag: IMPORT_TAG,
    expectedAssetCount: 3
  };
  const preview = await service.run(input);
  assert.equal(preview.status, 'DRY_RUN_READY');
  assert.equal(preview.assetsScanned, 3);
  assert.equal(preview.orgUnitMatches, 2);
  assert.equal(preview.custodianMatches, 1);
  assert.equal(preview.assetsToUpdate, 2);
  assert.equal(preview.orgUnitUpdates, 2);
  assert.equal(preview.custodianUpdates, 1);
  assert.equal(preview.routinePlansScanned, 3);
  assert.equal(preview.routinePlansEligible, 2);
  assert.equal(preview.routinePlansOutsideResolvedOwnership, 1);
  assert.equal(preview.routinePlansMatchedOrgUnit, 0);
  assert.equal(preview.routinePlansToUpdate, 2);
  assert.equal(preview.routinePlanOrgUnitConflicts, 0);
  assert.equal(preview.routinePlansUpdated, 0);
  assert.equal(preview.exceptionReasonCounts.CUSTODIAN_NOT_FOUND, 1);
  assert.equal(preview.exceptionReasonCounts.ORG_UNIT_NOT_FOUND, 1);
  assert.equal(preview.exceptionReasonCounts.CUSTODIAN_ORG_UNRESOLVED, 1);
  assert.equal(preview.writePerformed, false);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({}), 0);

  const backupDirectory = path.resolve(os.tmpdir(), 'equipment-ownership-backup');
  const executed = await service.run({
    ...input,
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    backupDirectory,
    operatorUsername: fixture.operator.usernameNormalized
  });
  assert.equal(executed.status, 'EXECUTED');
  assert.equal(executed.assetsUpdated, 2);
  assert.equal(executed.routinePlansUpdated, 2);
  assert.equal(executed.changeRecordsCreated, 2);
  assert.equal(executed.auditLogsCreated, 2);
  assert.equal(executed.writePerformed, true);

  const first = await EquipmentAsset.findById(fixture.assets[0]._id).lean();
  const second = await EquipmentAsset.findById(fixture.assets[1]._id).lean();
  const unresolved = await EquipmentAsset.findById(fixture.assets[2]._id).lean();
  assert.equal(String(first.orgUnitId), String(fixture.warehouseTwo._id));
  assert.equal(String(first.custodianUserId), String(fixture.custodian._id));
  assert.equal(String(second.orgUnitId), String(fixture.warehouseTwo._id));
  assert.equal(second.custodianUserId, null);
  assert.equal(String(unresolved.orgUnitId), String(fixture.root._id));
  assert.equal(unresolved.custodianUserId, null);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 2);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    _id: { $in: fixture.routinePlans.slice(0, 2).map(({ _id }) => _id) },
    orgUnitId: fixture.warehouseTwo._id
  }), 2);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    _id: fixture.routinePlans[2]._id,
    orgUnitId: fixture.root._id
  }), 1);
  assert.equal(await AuditLog.countDocuments({
    action: permissions.AUDIT_ACTIONS.UPDATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
    targetTeamId: fixture.team._id
  }), 2);

  await EquipmentRoutinePlan.collection.updateOne({
    _id: fixture.routinePlans[0]._id
  }, {
    $set: { orgUnitId: fixture.root._id }
  });
  const repairPreview = await service.run(input);
  assert.equal(repairPreview.assetsToUpdate, 0);
  assert.equal(repairPreview.routinePlansToUpdate, 1);

  const repaired = await service.run({
    ...input,
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    backupDirectory,
    operatorUsername: fixture.operator.usernameNormalized
  });
  assert.equal(repaired.assetsToUpdate, 0);
  assert.equal(repaired.assetsUpdated, 0);
  assert.equal(repaired.routinePlansToUpdate, 1);
  assert.equal(repaired.routinePlansUpdated, 1);
  assert.equal(repaired.changeRecordsCreated, 0);
  assert.equal(repaired.auditLogsCreated, 1);
  assert.equal(repaired.writePerformed, true);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    _id: fixture.routinePlans[0]._id,
    orgUnitId: fixture.warehouseTwo._id
  }), 1);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 2);
  assert.equal(await AuditLog.countDocuments({}), 3);

  const repeated = await service.run({
    ...input,
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    backupDirectory,
    operatorUsername: fixture.operator.usernameNormalized
  });
  assert.equal(repeated.assetsToUpdate, 0);
  assert.equal(repeated.routinePlansToUpdate, 0);
  assert.equal(repeated.assetsUpdated, 0);
  assert.equal(repeated.routinePlansUpdated, 0);
  assert.equal(repeated.writePerformed, false);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 2);
  assert.equal(await AuditLog.countDocuments({}), 3);
});

test('execute mode rejects every database except the isolated customer acceptance database', async () => {
  const service = createEquipmentOwnershipBackfillService({
    connection: { name: REHEARSAL_DATABASE }
  });
  await assert.rejects(service.run({
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    teamCode: 'GEARBOX_LOGISTICS',
    importTag: IMPORT_TAG,
    expectedAssetCount: 3
  }), (error) => error.code === 'EXECUTION_DATABASE_FORBIDDEN');
});

test('routine-plan count drift aborts and rolls back asset, history, audit, and plan writes', async () => {
  const driftingRoutinePlanModel = {
    find: (...args) => EquipmentRoutinePlan.find(...args),
    collection: {
      async updateMany(filter, update, options) {
        const result = await EquipmentRoutinePlan.collection.updateMany(filter, update, options);
        return { ...result, modifiedCount: Math.max(0, result.modifiedCount - 1) };
      }
    }
  };
  const service = createEquipmentOwnershipBackfillService({
    connection: mongoose.connection,
    EquipmentRoutinePlanModel: driftingRoutinePlanModel,
    backupVerifier: async (backupDirectory) => verifiedBackup(backupDirectory),
    allowedExecutionDatabaseNames: [REHEARSAL_DATABASE]
  });
  await assert.rejects(service.run({
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    backupDirectory: path.resolve(os.tmpdir(), 'equipment-ownership-backup'),
    operatorUsername: fixture.operator.usernameNormalized,
    teamCode: fixture.team.code,
    importTag: IMPORT_TAG,
    expectedAssetCount: 3
  }), (error) => error.code === 'EQUIPMENT_ROUTINE_PLAN_CONCURRENT_CHANGE');

  assert.equal(await EquipmentAsset.countDocuments({
    _id: { $in: fixture.assets.map(({ _id }) => _id) },
    orgUnitId: fixture.root._id
  }), 3);
  assert.equal(await EquipmentRoutinePlan.countDocuments({
    _id: { $in: fixture.routinePlans.map(({ _id }) => _id) },
    orgUnitId: fixture.root._id
  }), 3);
  assert.equal(await EquipmentChangeRecord.countDocuments({}), 0);
  assert.equal(await AuditLog.countDocuments({}), 0);
});

test('execute requires a verified routine-plan dump in addition to equipment assets', async () => {
  const service = createEquipmentOwnershipBackfillService({
    connection: mongoose.connection,
    backupVerifier: async (backupDirectory) => {
      const backup = verifiedBackup(backupDirectory);
      backup.manifest.database.collections = [{ name: 'equipmentassets' }];
      backup.manifest.files = [{
        file: `database/${REHEARSAL_DATABASE}/equipmentassets.bson`
      }];
      return backup;
    },
    allowedExecutionDatabaseNames: [REHEARSAL_DATABASE]
  });
  await assert.rejects(service.run({
    execute: true,
    confirmDatabase: REHEARSAL_DATABASE,
    backupDirectory: path.resolve(os.tmpdir(), 'equipment-ownership-backup'),
    operatorUsername: fixture.operator.usernameNormalized,
    teamCode: fixture.team.code,
    importTag: IMPORT_TAG,
    expectedAssetCount: 3
  }), (error) => (
    error.code === 'BACKUP_EQUIPMENT_OWNERSHIP_DATA_MISSING' &&
    error.details.missingCollections.includes('equipmentroutineplans') &&
    error.details.missingDumpFiles.some((file) => file.endsWith('/equipmentroutineplans.bson'))
  ));
});
