'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { after, before, beforeEach, test } = require('node:test');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '../../../app');
const appRequire = (name) => require(require.resolve(name, { paths: [APP_ROOT] }));
const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');

const EquipmentAsset = require('../../../app/models/EquipmentAsset');
const EquipmentCategory = require('../../../app/models/EquipmentCategory');
const EquipmentRoutinePlan = require('../../../app/models/EquipmentRoutinePlan');
const EquipmentRoutineRule = require('../../../app/models/EquipmentRoutineRule');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const {
  createEquipmentRoutineBusinessAuditService
} = require('../../../app/services/equipmentRoutineBusinessAuditService');

const DATABASE_NAME = 'customer_acceptance_v2_test';
const MODELS = [
  EquipmentAsset,
  EquipmentCategory,
  EquipmentRoutinePlan,
  EquipmentRoutineRule,
  ProjectTeam
];

let mongo;

function objectId() {
  return new mongoose.Types.ObjectId();
}

function category({ _id = objectId(), teamId, name, parentId = null }) {
  return { _id, teamId, name, parentId, status: 'ACTIVE', sortOrder: 0 };
}

function rule({ _id = objectId(), teamId, categoryId, routineType, name, status = 'ACTIVE' }) {
  return { _id, teamId, categoryId, routineType, name, status, version: 1 };
}

function asset({ _id = objectId(), teamId, categoryId, assetCode, status = 'IN_USE' }) {
  return {
    _id,
    teamId,
    categoryId,
    assetCode,
    name: assetCode,
    status,
    qrToken: `audit_${String(_id)}`
  };
}

function openPlan({
  _id = objectId(),
  rule: routineRule,
  equipment,
  scheduledFor = new Date('2030-01-15T00:00:00.000Z'),
  status = 'PLANNED',
  cycleKey = null,
  windowKey = 'PERIOD'
}) {
  return {
    _id,
    teamId: routineRule.teamId,
    equipmentId: equipment._id,
    categoryId: equipment.categoryId,
    ruleId: routineRule._id,
    routineType: routineRule.routineType,
    scheduledFor,
    status,
    cycleKey: cycleKey || `audit-${routineRule._id}-${equipment._id}-${_id}`,
    windowKey
  };
}

async function seedBusinessFixture() {
  const teamId = objectId();
  await ProjectTeam.collection.insertOne({
    _id: teamId,
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    status: 'ACTIVE',
    createdBy: objectId()
  });

  const root = category({ teamId, name: '装卸搬运设备' });
  const forkliftType = category({ teamId, name: '叉车', parentId: root._id });
  const acidPrimary = category({
    teamId,
    name: '电动叉车（分类：铅酸电池）',
    parentId: forkliftType._id
  });
  const lithiumPrimary = category({
    teamId,
    name: '电动叉车（分类：锂离子电池）',
    parentId: forkliftType._id
  });
  const conveyorPrimary = category({ teamId, name: '辊子输送机', parentId: forkliftType._id });
  const otherPrimary = category({ teamId, name: '其他叉车', parentId: forkliftType._id });
  const acidChild = category({ teamId, name: '电动叉车Q', parentId: acidPrimary._id });
  const lithiumChild = category({ teamId, name: '电动叉车L', parentId: lithiumPrimary._id });
  const lithiumBalanceChild = category({ teamId, name: '平衡重式叉车', parentId: lithiumPrimary._id });
  const conveyorChild = category({ teamId, name: '输送链', parentId: conveyorPrimary._id });
  const otherChild = category({ teamId, name: '其他叉车子类', parentId: otherPrimary._id });
  const categories = [
    root,
    forkliftType,
    acidPrimary,
    lithiumPrimary,
    conveyorPrimary,
    otherPrimary,
    acidChild,
    lithiumChild,
    lithiumBalanceChild,
    conveyorChild,
    otherChild
  ];
  await EquipmentCategory.collection.insertMany(categories);

  const rules = {
    acidInspection: rule({
      teamId,
      categoryId: acidPrimary._id,
      routineType: 'INSPECTION',
      name: '叉车点检（铅酸蓄电池类）'
    }),
    acidMaintenance: rule({
      teamId,
      categoryId: acidPrimary._id,
      routineType: 'MAINTENANCE',
      name: '叉车保养（铅酸蓄电池）'
    }),
    lithiumInspection: rule({
      teamId,
      categoryId: lithiumPrimary._id,
      routineType: 'INSPECTION',
      name: '叉车点检（锂离子电池类）'
    }),
    lithiumMaintenance: rule({
      teamId,
      categoryId: lithiumPrimary._id,
      routineType: 'MAINTENANCE',
      name: '叉车保养（锂离子电池）'
    }),
    conveyorInspection: rule({
      teamId,
      categoryId: conveyorPrimary._id,
      routineType: 'INSPECTION',
      name: '输送链点检'
    })
  };
  await EquipmentRoutineRule.collection.insertMany(Object.values(rules));

  const acidAssets = Array.from({ length: 6 }, (_, index) => asset({
    teamId,
    categoryId: acidChild._id,
    assetCode: `ACID-${index + 1}`
  }));
  const lithiumAssets = Array.from({ length: 5 }, (_, index) => asset({
    teamId,
    categoryId: index < 3 ? lithiumChild._id : lithiumBalanceChild._id,
    assetCode: `LITHIUM-${index + 1}`
  }));
  const conveyorAssets = [asset({ teamId, categoryId: conveyorChild._id, assetCode: 'CHAIN-1' })];
  const otherAssets = [asset({ teamId, categoryId: otherChild._id, assetCode: 'OTHER-1' })];
  const assets = [...acidAssets, ...lithiumAssets, ...conveyorAssets, ...otherAssets];
  await EquipmentAsset.collection.insertMany(assets);

  const plans = [];
  for (const equipment of acidAssets) {
    plans.push(openPlan({ rule: rules.acidInspection, equipment }));
    plans.push(openPlan({ rule: rules.acidMaintenance, equipment }));
  }
  for (const equipment of lithiumAssets) {
    plans.push(openPlan({ rule: rules.lithiumInspection, equipment }));
    plans.push(openPlan({ rule: rules.lithiumMaintenance, equipment }));
  }
  for (const equipment of conveyorAssets) {
    plans.push(openPlan({ rule: rules.conveyorInspection, equipment }));
  }
  await EquipmentRoutinePlan.collection.insertMany(plans);

  return {
    teamId,
    categories: {
      root,
      forkliftType,
      acidPrimary,
      lithiumPrimary,
      conveyorPrimary,
      otherPrimary,
      acidChild,
      lithiumChild,
      lithiumBalanceChild,
      conveyorChild,
      otherChild
    },
    rules,
    acidAssets,
    lithiumAssets,
    conveyorAssets,
    otherAssets,
    plans
  };
}

async function databaseSnapshot() {
  const result = {};
  for (const Model of MODELS) {
    result[Model.collection.name] = await Model.collection.find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.parse(JSON.stringify(result));
}

function releaseExpectations() {
  return [
    { name: '电动叉车（分类：铅酸电池）', expectedInUse: 6 },
    { name: '电动叉车（分类：锂离子电池）', expectedInUse: 5 },
    { name: '辊子输送机', expectedInUse: 1 }
  ];
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(DATABASE_NAME), {
    dbName: DATABASE_NAME,
    autoIndex: false
  });
  assert.equal(mongoose.connection.name, DATABASE_NAME);
  await Promise.all(MODELS.map((Model) => Model.syncIndexes()));
});

beforeEach(async () => {
  await Promise.all(MODELS.map((Model) => Model.collection.deleteMany({})));
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test('read-only routine business audit passes complete level-3 branch coverage gates without mutation', async () => {
  await seedBusinessFixture();
  const beforeState = await databaseSnapshot();
  const service = createEquipmentRoutineBusinessAuditService({
    connection: mongoose.connection,
    clock: () => new Date('2030-01-16T00:00:00.000Z')
  });
  const report = await service.run({
    teamCode: 'GEARBOX_LOGISTICS',
    expectedPrimaries: releaseExpectations()
  });
  const afterState = await databaseSnapshot();

  assert.equal(report.status, 'PASSED');
  assert.equal(report.mode, 'read-only');
  assert.equal(report.writePerformed, false);
  assert.equal(report.database.name, DATABASE_NAME);
  assert.equal(report.summary.activeRuleCount, 5);
  assert.equal(report.summary.openPlanCount, 23);
  assert.equal(report.summary.duplicateOpenPlanGroupCount, 0);
  assert.equal(report.summary.violationCount, 0);
  assert.deepEqual(afterState, beforeState);

  const acid = report.targetPrimaries.find(({ requestedName }) => (
    requestedName === '电动叉车（分类：铅酸电池）'
  ));
  assert.equal(acid.status, 'PASSED');
  assert.equal(acid.inUseEquipmentCount, 6);
  assert.equal(acid.equipmentWithOpenPlanCount, 6);
  assert.deepEqual(acid.missingAssets, []);
  assert.deepEqual(acid.coveredCategories.map(({ name }) => name), [
    '电动叉车（分类：铅酸电池）',
    '电动叉车Q'
  ]);
  assert.equal(acid.coveredCategories.some(({ name }) => name.includes('锂离子')), false);
  assert.deepEqual(
    acid.byRoutineType.map(({ routineType, equipmentWithOpenPlanCount }) => ({
      routineType,
      equipmentWithOpenPlanCount
    })),
    [
      { routineType: 'INSPECTION', equipmentWithOpenPlanCount: 6 },
      { routineType: 'MAINTENANCE', equipmentWithOpenPlanCount: 6 }
    ]
  );

  const lithium = report.targetPrimaries.find(({ requestedName }) => (
    requestedName === '电动叉车（分类：锂离子电池）'
  ));
  assert.equal(lithium.inUseEquipmentCount, 5);
  assert.equal(lithium.equipmentWithOpenPlanCount, 5);
  assert.deepEqual(lithium.coveredCategories.map(({ name }) => name), [
    '电动叉车（分类：锂离子电池）',
    '电动叉车L',
    '平衡重式叉车'
  ]);

  const conveyor = report.targetPrimaries.find(({ requestedName }) => requestedName === '辊子输送机');
  assert.equal(conveyor.inUseEquipmentCount, 1);
  assert.equal(conveyor.equipmentWithOpenPlanCount, 1);
  assert.deepEqual(conveyor.coveredCategories.map(({ name }) => name), ['辊子输送机', '输送链']);
});

test('routine business audit fails non-primary rules, cross-branch plans, duplicates, and target gaps', async () => {
  const fixture = await seedBusinessFixture();
  const invalidActiveRule = rule({
    teamId: fixture.teamId,
    categoryId: fixture.categories.acidChild._id,
    routineType: 'INSPECTION',
    name: '历史四级活动规则'
  });
  const historicalRule = rule({
    teamId: fixture.teamId,
    categoryId: fixture.categories.acidChild._id,
    routineType: 'MAINTENANCE',
    name: '历史四级停用规则',
    status: 'DISABLED'
  });
  await EquipmentRoutineRule.collection.insertMany([invalidActiveRule, historicalRule]);
  await EquipmentRoutinePlan.collection.insertOne(openPlan({
    rule: historicalRule,
    equipment: fixture.acidAssets[0],
    cycleKey: 'historical-fourth-level'
  }));
  await EquipmentRoutinePlan.collection.insertOne(openPlan({
    rule: fixture.rules.acidInspection,
    equipment: fixture.otherAssets[0],
    cycleKey: 'cross-primary-branch'
  }));

  const original = fixture.plans.find((plan) => (
    normalizeId(plan.ruleId) === normalizeId(fixture.rules.acidInspection._id) &&
    normalizeId(plan.equipmentId) === normalizeId(fixture.acidAssets[0]._id)
  ));
  await EquipmentRoutinePlan.collection.insertOne(openPlan({
    rule: fixture.rules.acidInspection,
    equipment: fixture.acidAssets[0],
    scheduledFor: original.scheduledFor,
    status: 'OVERDUE',
    cycleKey: 'duplicate-business-key',
    windowKey: 'DUPLICATE'
  }));
  await EquipmentRoutinePlan.collection.deleteOne({
    ruleId: fixture.rules.acidMaintenance._id,
    equipmentId: fixture.acidAssets[5]._id
  });

  const report = await createEquipmentRoutineBusinessAuditService({
    connection: mongoose.connection
  }).run({
    teamCode: 'GEARBOX_LOGISTICS',
    expectedPrimaries: releaseExpectations()
  });
  const codes = new Set(report.violations.map(({ code }) => code));
  assert.equal(report.status, 'FAILED');
  for (const code of [
    'ACTIVE_RULE_CATEGORY_DEPTH_INVALID',
    'HISTORICAL_NON_PRIMARY_RULE_OPEN_PLAN',
    'OPEN_PLAN_OUTSIDE_RULE_BRANCH',
    'DUPLICATE_OPEN_PLAN',
    'TARGET_PRIMARY_OPEN_PLAN_COVERAGE_INCOMPLETE'
  ]) assert.equal(codes.has(code), true, `missing violation ${code}`);
  assert.equal(report.summary.duplicateOpenPlanGroupCount, 1);

  const acid = report.targetPrimaries.find(({ requestedName }) => (
    requestedName === '电动叉车（分类：铅酸电池）'
  ));
  assert.equal(acid.status, 'FAILED');
  assert.equal(acid.inUseEquipmentCount, 6);
  assert.equal(acid.equipmentWithOpenPlanCount, 5);
  assert.equal(acid.missingAssets.length, 1);
  assert.equal(acid.missingAssets[0].assetCode, 'ACID-6');
  assert.deepEqual(acid.missingAssets[0].missingRules.map(({ routineType }) => routineType), [
    'MAINTENANCE'
  ]);
  assert.equal(
    report.duplicateOpenPlanGroups[0].equipmentId,
    normalizeId(fixture.acidAssets[0]._id)
  );
});

test('routine business audit CLI emits JSON and exits 2 when an explicit release gate fails', async () => {
  const fixture = await seedBusinessFixture();
  await EquipmentRoutinePlan.collection.deleteOne({
    ruleId: fixture.rules.conveyorInspection._id,
    equipmentId: fixture.conveyorAssets[0]._id
  });
  const script = path.resolve(APP_ROOT, 'script/auditEquipmentRoutineBusiness.js');
  const child = spawnSync(process.execPath, [
    script,
    '--team-code', 'GEARBOX_LOGISTICS',
    '--expect-primary', '电动叉车（分类：铅酸电池）=6',
    '--expect-primary', '电动叉车（分类：锂离子电池）=5',
    '--expect-primary', '辊子输送机=1'
  ], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ENV_FILE: path.resolve(__dirname, 'missing-audit-env-file'),
      MONGODB_URI: mongo.getUri(DATABASE_NAME)
    },
    timeout: 30_000
  });

  assert.equal(child.signal, null);
  assert.equal(child.status, 2, child.stderr);
  assert.equal(child.stderr, '');
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'FAILED');
  assert.equal(report.mode, 'read-only');
  assert.equal(report.writePerformed, false);
  assert.equal(report.database.name, DATABASE_NAME);
  assert.equal(
    report.violations.some(({ code }) => code === 'TARGET_PRIMARY_OPEN_PLAN_COVERAGE_INCOMPLETE'),
    true
  );
  const conveyor = report.targetPrimaries.find(({ requestedName }) => requestedName === '辊子输送机');
  assert.equal(conveyor.inUseEquipmentCount, 1);
  assert.equal(conveyor.equipmentWithOpenPlanCount, 0);
  assert.equal(conveyor.missingAssets[0].assetCode, 'CHAIN-1');
});

test('routine business audit independently rejects an incomplete production category resolver', async () => {
  const fixture = await seedBusinessFixture();
  const report = await createEquipmentRoutineBusinessAuditService({
    connection: mongoose.connection,
    resolveRuleAssetCategoryIds: async ({ ruleCategoryId }) => [ruleCategoryId]
  }).run({ teamCode: 'GEARBOX_LOGISTICS' });

  assert.equal(report.status, 'FAILED');
  const mismatches = report.violations.filter(({ code }) => code === 'RULE_CATEGORY_SCOPE_MISMATCH');
  assert.equal(mismatches.length, 5);
  const acid = mismatches.find(({ ruleId }) => ruleId === normalizeId(fixture.rules.acidInspection._id));
  assert.deepEqual(acid.missingCategories.map(({ name }) => name), ['电动叉车Q']);
  assert.deepEqual(acid.unexpectedCategories, []);
});

test('routine business audit fails closed when the acceptance database has no teams', async () => {
  const report = await createEquipmentRoutineBusinessAuditService({
    connection: mongoose.connection
  }).run();

  assert.equal(report.status, 'FAILED');
  assert.equal(report.summary.teamCount, 0);
  assert.deepEqual(report.violations.map(({ code }) => code), ['NO_TEAMS_FOUND']);
});

function normalizeId(value) {
  return String(value);
}
