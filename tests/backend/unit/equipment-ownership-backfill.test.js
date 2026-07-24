'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const permissions = require('../../../app/config/permissions');
const {
  EQUIPMENT_OWNERSHIP_EXCEPTION_CODES,
  createEquipmentOwnershipResolver
} = require('../../../app/services/equipmentOwnershipResolver');
const {
  BACKFILL_EXCEPTION_CODES,
  buildEquipmentOwnershipBackfillPlan,
  buildRoutinePlanOwnershipBackfillPlan,
  createEquipmentOwnershipBackfillService
} = require('../../../app/services/equipmentOwnershipBackfillService');
const {
  failureReport,
  parseArgs,
  usage,
  writeJsonAtomic
} = require('../../../app/script/backfillCustomerEquipmentOwnership');
const {
  resolveFixtureOwnership
} = require('../../../app/script/customerEquipmentRealDataImporter');

function oid(number) {
  return number.toString(16).padStart(24, '0');
}

function org({ id, teamId, parentId = null, type, level, name, status = 'ACTIVE' }) {
  return { _id: id, teamId, parentId, type, level, name, status, code: `ORG_${id.slice(-2)}` };
}

function member({ id, teamId, userId, orgUnitId, status = 'ACTIVE' }) {
  return { _id: id, teamId, userId, orgUnitId, status };
}

function resolverFixture({ duplicateSubDepartment = false } = {}) {
  const teamId = oid(1);
  const rootId = oid(2);
  const warehouseTwoId = oid(3);
  const otherId = oid(4);
  const groupId = oid(5);
  const duplicateId = oid(6);
  const aliceInScope = oid(11);
  const aliceOutside = oid(12);
  const bobOutside = oid(13);
  const orgUnits = [
    org({
      id: rootId,
      teamId,
      type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
      level: 1,
      name: '变速箱物流部'
    }),
    org({
      id: warehouseTwoId,
      teamId,
      parentId: rootId,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      name: '仓配二分部'
    }),
    org({
      id: otherId,
      teamId,
      parentId: rootId,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      name: '现场配送分部'
    }),
    org({
      id: groupId,
      teamId,
      parentId: warehouseTwoId,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      level: 3,
      name: 'B1 总装拣配组'
    })
  ];
  if (duplicateSubDepartment) {
    orgUnits.push(org({
      id: duplicateId,
      teamId,
      parentId: rootId,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      name: '仓配二分部'
    }));
  }
  const users = [
    { _id: aliceInScope, name: '高广兵', status: 'active', isSystemAccount: false },
    { _id: aliceOutside, name: '高广兵', status: 'active', isSystemAccount: false },
    { _id: bobOutside, name: '外部分部人员', status: 'active', isSystemAccount: false },
    { _id: oid(14), name: '已停用人员', status: 'inactive', isSystemAccount: false },
    { _id: oid(15), name: '系统账号', status: 'active', isSystemAccount: true }
  ];
  const memberships = [
    member({ id: oid(21), teamId, userId: aliceInScope, orgUnitId: groupId }),
    member({ id: oid(22), teamId, userId: aliceOutside, orgUnitId: otherId }),
    member({ id: oid(23), teamId, userId: bobOutside, orgUnitId: otherId }),
    member({ id: oid(24), teamId, userId: oid(14), orgUnitId: groupId }),
    member({ id: oid(25), teamId, userId: oid(15), orgUnitId: groupId })
  ];
  return {
    ids: { teamId, rootId, warehouseTwoId, otherId, groupId, aliceInScope },
    resolver: createEquipmentOwnershipResolver({ teamId, orgUnits, memberships, users })
  };
}

test('ownership resolver uses exact level-2 organization and unique active member in its subtree', () => {
  const { ids, resolver } = resolverFixture();
  const result = resolver.resolve({
    orgUnitNameSnapshot: '  仓配二分部  ',
    custodianDisplayName: '高广兵'
  });
  assert.equal(String(result.orgUnit._id), ids.warehouseTwoId);
  assert.equal(String(result.custodian._id), ids.aliceInScope);
  assert.equal(String(result.custodianMembership.orgUnitId), ids.groupId);
  assert.deepEqual(result.exceptions, []);
  assert.equal(resolver.isInsideOrgUnit(ids.groupId, ids.warehouseTwoId), true);
  assert.equal(resolver.isInsideOrgUnit(ids.otherId, ids.warehouseTwoId), false);
});

test('ownership resolver never guesses ambiguous, composite, disabled, or out-of-scope names', () => {
  const unique = resolverFixture().resolver;
  assert.deepEqual(
    unique.resolve({ orgUnitNameSnapshot: '仓配二分', custodianDisplayName: '高广兵' })
      .exceptions.map(({ code }) => code),
    [
      EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_NOT_FOUND,
      EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_ORG_UNRESOLVED
    ]
  );
  assert.equal(
    unique.resolve({ orgUnitNameSnapshot: '仓配二分部', custodianDisplayName: '外部分部人员' })
      .exceptions.at(-1).code,
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_OUTSIDE_ORG_UNIT
  );
  assert.equal(
    unique.resolve({ orgUnitNameSnapshot: '仓配二分部', custodianDisplayName: '高广兵、外部分部人员' })
      .exceptions.at(-1).code,
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_NOT_FOUND
  );
  assert.equal(
    unique.resolve({ orgUnitNameSnapshot: '仓配二分部', custodianDisplayName: '已停用人员' })
      .exceptions.at(-1).code,
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_NOT_FOUND
  );
  assert.equal(
    resolverFixture({ duplicateSubDepartment: true }).resolver.resolve({
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    }).exceptions[0].code,
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_AMBIGUOUS
  );
});

test('backfill plan only fills root-owned and empty-custodian fields', () => {
  const { ids, resolver } = resolverFixture();
  const assets = [
    {
      _id: oid(31),
      assetCode: 'CUST26-HDL-005',
      orgUnitId: ids.rootId,
      custodianUserId: null,
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    },
    {
      _id: oid(32),
      assetCode: 'MANUAL-ORG',
      orgUnitId: ids.otherId,
      custodianUserId: null,
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    },
    {
      _id: oid(33),
      assetCode: 'MANUAL-CUSTODIAN',
      orgUnitId: ids.warehouseTwoId,
      custodianUserId: oid(99),
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    }
  ];
  const plan = buildEquipmentOwnershipBackfillPlan({ assets, resolver });
  assert.equal(plan.summary.assetsScanned, 3);
  assert.equal(plan.summary.assetsToUpdate, 1);
  assert.equal(String(plan.updates[0].patch.orgUnitId), ids.warehouseTwoId);
  assert.equal(String(plan.updates[0].patch.custodianUserId), ids.aliceInScope);
  assert.deepEqual(
    plan.anomalies.map(({ exceptions }) => exceptions[0].code),
    [
      BACKFILL_EXCEPTION_CODES.EXISTING_ORG_UNIT_CONFLICT,
      BACKFILL_EXCEPTION_CODES.EXISTING_CUSTODIAN_CONFLICT
    ]
  );
});

test('routine-plan ownership migrates only resolved root snapshots and reports conflicts', () => {
  const { ids, resolver } = resolverFixture();
  const assets = [
    {
      _id: oid(31),
      assetCode: 'CUST26-HDL-005',
      orgUnitId: ids.warehouseTwoId,
      custodianUserId: ids.aliceInScope,
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵'
    },
    {
      _id: oid(32),
      assetCode: 'UNRESOLVED',
      orgUnitId: ids.rootId,
      custodianUserId: null,
      orgUnitNameSnapshot: '不存在的组织',
      custodianDisplayName: ''
    }
  ];
  const ownership = buildEquipmentOwnershipBackfillPlan({ assets, resolver });
  const routinePlan = buildRoutinePlanOwnershipBackfillPlan({
    ownershipTargets: ownership.ownershipTargets,
    rootOrgUnitIds: resolver.rootOrgUnitIds,
    routinePlans: [
      {
        _id: oid(41),
        equipmentId: oid(31),
        orgUnitId: ids.rootId,
        status: 'PLANNED'
      },
      {
        _id: oid(42),
        equipmentId: oid(31),
        orgUnitId: ids.warehouseTwoId,
        status: 'OVERDUE'
      },
      {
        _id: oid(43),
        equipmentId: oid(31),
        orgUnitId: ids.otherId,
        status: 'PLANNED'
      },
      {
        _id: oid(44),
        equipmentId: oid(32),
        orgUnitId: ids.rootId,
        status: 'PLANNED'
      }
    ]
  });
  assert.equal(routinePlan.summary.routinePlansScanned, 4);
  assert.equal(routinePlan.summary.routinePlansEligible, 3);
  assert.equal(routinePlan.summary.routinePlansOutsideResolvedOwnership, 1);
  assert.equal(routinePlan.summary.routinePlansMatchedOrgUnit, 1);
  assert.equal(routinePlan.summary.routinePlansToUpdate, 1);
  assert.equal(routinePlan.summary.routinePlanOrgUnitConflicts, 1);
  assert.equal(String(routinePlan.updates[0].beforeOrgUnitId), ids.rootId);
  assert.equal(String(routinePlan.updates[0].afterOrgUnitId), ids.warehouseTwoId);
  assert.equal(routinePlan.anomalies[0].code, 'ROUTINE_PLAN_ORG_UNIT_CONFLICT');
});

test('customer fixed-asset importer writes resolved ownership and preserves unresolved exceptions', () => {
  const { ids, resolver } = resolverFixture();
  const resolved = resolveFixtureOwnership({
    candidate: {
      orgUnitNameSnapshot: '仓配二分部',
      custodianDisplayName: '高广兵',
      dataQuality: { status: 'IMPORTED', issues: [], exceptionTypes: [] }
    },
    resolver,
    fallbackOrgUnitId: ids.rootId
  });
  assert.equal(String(resolved.orgUnitId), ids.warehouseTwoId);
  assert.equal(String(resolved.custodianUserId), ids.aliceInScope);
  assert.equal(resolved.dataQuality.status, 'IMPORTED');
  assert.deepEqual(resolved.dataQuality.issues, []);

  const unresolved = resolveFixtureOwnership({
    candidate: {
      orgUnitNameSnapshot: '技术质量室',
      custodianDisplayName: '多人/共用',
      dataQuality: { status: 'IMPORTED', issues: [], exceptionTypes: [] }
    },
    resolver,
    fallbackOrgUnitId: ids.rootId
  });
  assert.equal(String(unresolved.orgUnitId), ids.rootId);
  assert.equal(unresolved.custodianUserId, null);
  assert.equal(unresolved.dataQuality.status, 'PENDING_CONFIRMATION');
  assert.deepEqual(unresolved.dataQuality.exceptionTypes, [
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_NOT_FOUND,
    EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_ORG_UNRESOLVED
  ]);
});

test('equipment ownership CLI is dry-run by default and writes immutable evidence', async () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    '--confirm-database=customer_acceptance_v2_test',
    '--backup-directory',
    'E:\\backup',
    '--operator-username',
    'migration-user',
    '--expected-assets',
    '141',
    '--report',
    'E:\\report.json'
  ]), {
    execute: true,
    confirmDatabase: 'customer_acceptance_v2_test',
    backupDirectory: 'E:\\backup',
    operatorUsername: 'migration-user',
    expectedAssets: 141,
    report: 'E:\\report.json'
  });
  assert.throws(() => parseArgs(['--expected-assets', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--allowed-execution-database', 'other']), /Unknown option/);
  assert.throws(
    () => createEquipmentOwnershipBackfillService({ allowedExecutionDatabaseNames: [] }),
    /must not be empty/
  );
  assert.match(usage(), /dry-run by default/);
  assert.match(usage(), /Exact-match rules/i);
  assert.match(usage(), /No report file is written unless --report/);
  assert.match(usage(), /customer_acceptance_v2_test/);

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'equipment-owner-report-'));
  const reportPath = path.join(directory, 'report.json');
  try {
    const report = failureReport({
      error: Object.assign(new Error('backup missing'), { code: 'BACKUP_DIRECTORY_REQUIRED' }),
      execute: true,
      databaseName: 'customer_acceptance_v2_test'
    });
    assert.equal(await writeJsonAtomic(reportPath, report), reportPath);
    assert.deepEqual(JSON.parse(await fs.promises.readFile(reportPath, 'utf8')), report);
    await assert.rejects(writeJsonAtomic(reportPath, report), (error) => error.code === 'EEXIST');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
