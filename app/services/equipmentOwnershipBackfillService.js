'use strict';

const path = require('node:path');
const mongoose = require('mongoose');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const ProjectTeam = require('../models/ProjectTeam');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  MEMBERSHIP_STATUSES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { loadEquipmentOwnershipResolver } = require('./equipmentOwnershipResolver');
const { runWithRequiredTransaction } = require('./transactionService');

const BACKFILL_REPORT_FORMAT = 'customer-equipment-ownership-backfill/v1';
const EQUIPMENT_ASSET_COLLECTION = 'equipmentassets';
const EQUIPMENT_ROUTINE_PLAN_COLLECTION = 'equipmentroutineplans';
const DEFAULT_EXPECTED_ASSET_COUNT = 141;
const ALLOWED_EXECUTION_DATABASE = 'customer_acceptance_v2_test';
const DEFAULT_REASON = 'Backfill customer fixed-asset organization and custodian from exact source-name matches';

const BACKFILL_EXCEPTION_CODES = Object.freeze({
  EXISTING_ORG_UNIT_CONFLICT: 'EXISTING_ORG_UNIT_CONFLICT',
  EXISTING_CUSTODIAN_CONFLICT: 'EXISTING_CUSTODIAN_CONFLICT'
});

class EquipmentOwnershipBackfillError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EquipmentOwnershipBackfillError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new EquipmentOwnershipBackfillError(code, message, details);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value._id ?? value);
}

function sameId(left, right) {
  const leftId = normalizeId(left);
  const rightId = normalizeId(right);
  return leftId !== null && rightId !== null && leftId === rightId;
}

function ownershipSnapshot(asset) {
  return {
    orgUnitId: normalizeId(asset.orgUnitId),
    custodianUserId: normalizeId(asset.custodianUserId)
  };
}

function conflict(code, { field, originalValue, suggestedValue, message }) {
  return { code, field, originalValue, suggestedValue, candidates: [], message };
}

function buildEquipmentOwnershipBackfillPlan({ assets, resolver } = {}) {
  if (!Array.isArray(assets)) throw new TypeError('assets must be an array');
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new TypeError('resolver with resolve() is required');
  }
  const updates = [];
  const ownershipTargets = [];
  const anomalies = [];
  let orgUnitMatches = 0;
  let custodianMatches = 0;
  let orgUnitUpdates = 0;
  let custodianUpdates = 0;
  const exceptionReasonCounts = {};

  for (const asset of assets) {
    const resolution = resolver.resolve({
      orgUnitNameSnapshot: asset.orgUnitNameSnapshot,
      custodianDisplayName: asset.custodianDisplayName
    });
    const exceptions = [...resolution.exceptions];
    const before = ownershipSnapshot(asset);
    const patch = {};
    let orgConflict = false;

    if (resolution.orgUnit) {
      orgUnitMatches += 1;
      if (!sameId(asset.orgUnitId, resolution.orgUnit._id)) {
        if (resolver.rootOrgUnitIds.has(normalizeId(asset.orgUnitId))) {
          patch.orgUnitId = resolution.orgUnit._id;
          orgUnitUpdates += 1;
        } else {
          orgConflict = true;
          exceptions.push(conflict(BACKFILL_EXCEPTION_CODES.EXISTING_ORG_UNIT_CONFLICT, {
            field: 'orgUnitId',
            originalValue: normalizeId(asset.orgUnitId),
            suggestedValue: normalizeId(resolution.orgUnit),
            message: 'A non-root organization is already assigned; the backfill will not overwrite it'
          }));
        }
      }
      if (!orgConflict) {
        ownershipTargets.push({
          asset,
          equipmentId: asset._id,
          assetCode: asset.assetCode,
          expectedOrgUnitId: resolution.orgUnit._id
        });
      }
    }

    if (resolution.custodian) {
      custodianMatches += 1;
      if (!sameId(asset.custodianUserId, resolution.custodian._id)) {
        if (!asset.custodianUserId && !orgConflict) {
          patch.custodianUserId = resolution.custodian._id;
          custodianUpdates += 1;
        } else {
          exceptions.push(conflict(BACKFILL_EXCEPTION_CODES.EXISTING_CUSTODIAN_CONFLICT, {
            field: 'custodianUserId',
            originalValue: normalizeId(asset.custodianUserId),
            suggestedValue: normalizeId(resolution.custodian),
            message: 'A custodian is already assigned or the existing organization conflicts; the backfill will not overwrite it'
          }));
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      const after = {
        orgUnitId: normalizeId(patch.orgUnitId ?? asset.orgUnitId),
        custodianUserId: normalizeId(patch.custodianUserId ?? asset.custodianUserId)
      };
      updates.push({ asset, patch, before, after });
    }
    if (exceptions.length > 0) {
      for (const { code } of exceptions) {
        exceptionReasonCounts[code] = (exceptionReasonCounts[code] || 0) + 1;
      }
      anomalies.push({
        equipmentId: normalizeId(asset),
        assetCode: asset.assetCode,
        orgUnitNameSnapshot: asset.orgUnitNameSnapshot || null,
        custodianDisplayName: asset.custodianDisplayName || null,
        exceptions
      });
    }
  }

  return {
    updates,
    ownershipTargets,
    anomalies,
    summary: {
      assetsScanned: assets.length,
      orgUnitMatches,
      custodianMatches,
      assetsToUpdate: updates.length,
      orgUnitUpdates,
      custodianUpdates,
      anomalousAssets: anomalies.length,
      exceptionReasonCounts: Object.fromEntries(
        Object.entries(exceptionReasonCounts).sort(([left], [right]) => left.localeCompare(right))
      )
    }
  };
}

function buildRoutinePlanOwnershipBackfillPlan({
  routinePlans,
  ownershipTargets,
  rootOrgUnitIds
} = {}) {
  if (!Array.isArray(routinePlans)) throw new TypeError('routinePlans must be an array');
  if (!Array.isArray(ownershipTargets)) throw new TypeError('ownershipTargets must be an array');
  if (!(rootOrgUnitIds instanceof Set)) throw new TypeError('rootOrgUnitIds must be a Set');

  const targetByEquipmentId = new Map(
    ownershipTargets.map((target) => [normalizeId(target.equipmentId), target])
  );
  const updates = [];
  const anomalies = [];
  let eligible = 0;
  let matchedOrgUnit = 0;
  let outsideResolvedOwnership = 0;

  for (const routinePlan of routinePlans) {
    const target = targetByEquipmentId.get(normalizeId(routinePlan.equipmentId));
    if (!target) {
      outsideResolvedOwnership += 1;
      continue;
    }
    eligible += 1;
    if (sameId(routinePlan.orgUnitId, target.expectedOrgUnitId)) {
      matchedOrgUnit += 1;
      continue;
    }
    if (rootOrgUnitIds.has(normalizeId(routinePlan.orgUnitId))) {
      updates.push({
        routinePlan,
        equipmentId: routinePlan.equipmentId,
        assetCode: target.assetCode,
        beforeOrgUnitId: routinePlan.orgUnitId,
        afterOrgUnitId: target.expectedOrgUnitId
      });
      continue;
    }
    anomalies.push({
      routinePlanId: normalizeId(routinePlan),
      equipmentId: normalizeId(routinePlan.equipmentId),
      assetCode: target.assetCode,
      status: routinePlan.status || null,
      code: 'ROUTINE_PLAN_ORG_UNIT_CONFLICT',
      originalOrgUnitId: normalizeId(routinePlan.orgUnitId),
      suggestedOrgUnitId: normalizeId(target.expectedOrgUnitId),
      message: 'A routine plan has a non-root organization that conflicts with the resolved equipment owner'
    });
  }

  return {
    updates,
    anomalies,
    summary: {
      routinePlansScanned: routinePlans.length,
      routinePlansEligible: eligible,
      routinePlansOutsideResolvedOwnership: outsideResolvedOwnership,
      routinePlansMatchedOrgUnit: matchedOrgUnit,
      routinePlansToUpdate: updates.length,
      routinePlanOrgUnitConflicts: anomalies.length
    }
  };
}

function groupRoutinePlanUpdates(updates) {
  const groups = new Map();
  for (const update of updates) {
    const key = [
      normalizeId(update.equipmentId),
      normalizeId(update.beforeOrgUnitId),
      normalizeId(update.afterOrgUnitId)
    ].join(':');
    if (!groups.has(key)) {
      groups.set(key, {
        equipmentId: update.equipmentId,
        assetCode: update.assetCode,
        beforeOrgUnitId: update.beforeOrgUnitId,
        afterOrgUnitId: update.afterOrgUnitId,
        routinePlanIds: []
      });
    }
    groups.get(key).routinePlanIds.push(update.routinePlan._id);
  }
  return [...groups.values()];
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
}

async function verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier }) {
  if (typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
    fail('BACKUP_DIRECTORY_REQUIRED', '--backup-directory is required in execute mode');
  }
  if (!path.isAbsolute(backupDirectory)) {
    fail('BACKUP_DIRECTORY_NOT_ABSOLUTE', '--backup-directory must be absolute in execute mode');
  }
  const resolved = path.resolve(backupDirectory);
  const verified = await backupVerifier(resolved, { verifyFiles: true });
  if (verified?.manifest?.database?.name !== databaseName) {
    fail('BACKUP_DATABASE_MISMATCH', 'Verified backup database name does not match the connected database', {
      expected: databaseName,
      actual: verified?.manifest?.database?.name || null
    });
  }
  const collectionNames = new Set(
    (verified?.manifest?.database?.collections || []).map((collection) => collection?.name)
  );
  const requiredCollections = [EQUIPMENT_ASSET_COLLECTION, EQUIPMENT_ROUTINE_PLAN_COLLECTION];
  const fileNames = new Set((verified?.manifest?.files || []).map((entry) => entry?.file));
  const missingCollections = requiredCollections.filter((name) => !collectionNames.has(name));
  const missingDumpFiles = requiredCollections
    .map((name) => `database/${databaseName}/${name}.bson`)
    .filter((file) => !fileNames.has(file));
  if (missingCollections.length > 0 || missingDumpFiles.length > 0) {
    fail('BACKUP_EQUIPMENT_OWNERSHIP_DATA_MISSING', 'Verified backup is missing ownership backfill collections or BSON dumps', {
      missingCollections,
      missingDumpFiles
    });
  }
  return {
    backupDirectory: verified.backupDirectory || resolved,
    backupId: verified.manifest.backupId || null,
    completedAt: verified.manifest.completedAt || null,
    databaseName,
    manifestSha256: verified.manifestSha256
  };
}

function createEquipmentOwnershipBackfillService({
  EquipmentAssetModel = EquipmentAsset,
  EquipmentChangeRecordModel = EquipmentChangeRecord,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  ProjectTeamModel = ProjectTeam,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  backupVerifier = verifyBackupSet,
  now = () => new Date(),
  connection = mongoose.connection,
  loadResolver = loadEquipmentOwnershipResolver,
  allowedExecutionDatabaseNames = [ALLOWED_EXECUTION_DATABASE]
} = {}) {
  if (!Array.isArray(allowedExecutionDatabaseNames) && !(allowedExecutionDatabaseNames instanceof Set)) {
    throw new TypeError('allowedExecutionDatabaseNames must be an array or Set');
  }
  const allowedExecutionDatabases = new Set(
    [...allowedExecutionDatabaseNames]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  if (allowedExecutionDatabases.size === 0) {
    throw new TypeError('allowedExecutionDatabaseNames must not be empty');
  }
  async function resolveTeam(teamCode, session = null) {
    const query = ProjectTeamModel.findOne({
      code: String(teamCode || '').trim().toUpperCase(),
      status: TEAM_STATUSES.ACTIVE
    });
    if (session) query.session(session);
    const team = await query.lean();
    if (!team) fail('TEAM_NOT_FOUND', `Active team does not exist: ${teamCode}`);
    return team;
  }

  async function resolveOperator({ operatorUsername, teamId, session }) {
    const normalized = String(operatorUsername || '').normalize('NFKC').trim().toLowerCase();
    if (!normalized) fail('OPERATOR_USERNAME_REQUIRED', '--operator-username is required in execute mode');
    const userQuery = UserModel.findOne({ usernameNormalized: normalized, status: 'active' });
    if (session) userQuery.session(session);
    const user = await userQuery.lean();
    if (!user || user.isSystemAccount === true) {
      fail('OPERATOR_NOT_FOUND', 'The execute operator must be an active non-system user');
    }
    if (!user.isSuperAdmin) {
      const membershipQuery = TeamMembershipModel.exists({
        teamId,
        userId: user._id,
        status: MEMBERSHIP_STATUSES.ACTIVE
      });
      if (session) membershipQuery.session(session);
      if (!await membershipQuery) {
        fail('OPERATOR_NOT_TEAM_MEMBER', 'The execute operator is not an active member of the target team');
      }
    }
    return user;
  }

  async function scan({ team, importTag, session = null }) {
    const query = EquipmentAssetModel.find({
      teamId: team._id,
      'dataQuality.importTag': importTag
    }).sort({ assetCode: 1, _id: 1 }).lean();
    if (session) query.session(session);
    const assets = await query;
    const resolver = await loadResolver({
      teamId: team._id,
      TeamMembershipModel,
      UserModel,
      session
    });
    const ownershipPlan = buildEquipmentOwnershipBackfillPlan({ assets, resolver });
    const routinePlanQuery = EquipmentRoutinePlanModel.find({
      teamId: team._id,
      equipmentId: { $in: assets.map(({ _id }) => _id) }
    }).select('_id teamId orgUnitId equipmentId status updatedAt').sort({ _id: 1 }).lean();
    if (session) routinePlanQuery.session(session);
    const routinePlans = assets.length > 0 ? await routinePlanQuery : [];
    const routinePlanOwnershipPlan = buildRoutinePlanOwnershipBackfillPlan({
      routinePlans,
      ownershipTargets: ownershipPlan.ownershipTargets,
      rootOrgUnitIds: resolver.rootOrgUnitIds
    });
    return {
      assets,
      plan: {
        ...ownershipPlan,
        routinePlanUpdates: routinePlanOwnershipPlan.updates,
        routinePlanAnomalies: routinePlanOwnershipPlan.anomalies,
        summary: {
          ...ownershipPlan.summary,
          ...routinePlanOwnershipPlan.summary
        }
      }
    };
  }

  async function run({
    execute = false,
    confirmDatabase,
    backupDirectory,
    teamCode,
    importTag,
    expectedAssetCount = DEFAULT_EXPECTED_ASSET_COUNT,
    operatorUsername,
    reason = DEFAULT_REASON
  } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (!Number.isInteger(expectedAssetCount) || expectedAssetCount < 1) {
      fail('EXPECTED_ASSET_COUNT_INVALID', 'expectedAssetCount must be a positive integer');
    }
    if (typeof importTag !== 'string' || !importTag.trim()) {
      fail('IMPORT_TAG_REQUIRED', 'importTag is required');
    }
    if (execute && confirmDatabase !== databaseName) {
      fail('DATABASE_CONFIRMATION_MISMATCH', '--confirm-database must exactly match the connected database name', {
        expected: databaseName,
        actual: confirmDatabase || null
      });
    }
    if (execute && !allowedExecutionDatabases.has(databaseName)) {
      fail(
        'EXECUTION_DATABASE_FORBIDDEN',
        'Execution is restricted to the configured database allowlist',
        { allowed: [...allowedExecutionDatabases].sort(), actual: databaseName }
      );
    }

    const team = await resolveTeam(teamCode);
    const preview = await scan({ team, importTag });
    const countMatchesExpected = preview.assets.length === expectedAssetCount;
    const baseReport = {
      format: BACKFILL_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode: execute ? 'execute' : 'dry-run',
      status: execute ? 'EXECUTED' : 'DRY_RUN_READY',
      database: { name: databaseName },
      target: {
        teamId: normalizeId(team),
        teamCode: team.code,
        importTag,
        expectedAssetCount,
        actualAssetCount: preview.assets.length,
        countMatchesExpected
      },
      backup: null,
      ...preview.plan.summary,
      anomalies: preview.plan.anomalies,
      routinePlanAnomalies: preview.plan.routinePlanAnomalies
    };
    if (!execute) {
      return {
        ...baseReport,
        assetsUpdated: 0,
        routinePlansUpdated: 0,
        changeRecordsCreated: 0,
        auditLogsCreated: 0,
        writePerformed: false
      };
    }
    if (!countMatchesExpected) {
      fail('EQUIPMENT_ASSET_COUNT_MISMATCH', 'Imported equipment count does not match the explicit execution guard', {
        expected: expectedAssetCount,
        actual: preview.assets.length,
        teamCode: team.code,
        importTag
      });
    }
    if (preview.plan.summary.routinePlanOrgUnitConflicts > 0) {
      fail('ROUTINE_PLAN_ORG_UNIT_CONFLICT', 'Routine plan ownership conflicts must be resolved before execution', {
        conflicts: preview.plan.summary.routinePlanOrgUnitConflicts
      });
    }

    const backup = await verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier });
    return runWithRequiredTransaction(async (session) => {
      const transactionalTeam = await resolveTeam(teamCode, session);
      const operator = await resolveOperator({
        operatorUsername,
        teamId: transactionalTeam._id,
        session
      });
      const current = await scan({ team: transactionalTeam, importTag, session });
      if (current.assets.length !== expectedAssetCount) {
        fail('EQUIPMENT_ASSET_COUNT_CHANGED', 'Imported equipment count changed after the execution preview', {
          expected: expectedAssetCount,
          actual: current.assets.length
        });
      }
      if (current.plan.summary.routinePlanOrgUnitConflicts > 0) {
        fail('ROUTINE_PLAN_ORG_UNIT_CHANGED', 'Routine plan ownership changed after the execution preview', {
          conflicts: current.plan.summary.routinePlanOrgUnitConflicts
        });
      }

      let assetsUpdated = 0;
      let routinePlansUpdated = 0;
      let auditLogsCreated = 0;
      const routinePlanGroups = groupRoutinePlanUpdates(current.plan.routinePlanUpdates);
      const routinePlanCountByEquipmentId = new Map();
      for (const group of routinePlanGroups) {
        const equipmentId = normalizeId(group.equipmentId);
        routinePlanCountByEquipmentId.set(
          equipmentId,
          (routinePlanCountByEquipmentId.get(equipmentId) || 0) + group.routinePlanIds.length
        );
      }
      const assetUpdateIds = new Set(current.plan.updates.map(({ asset }) => normalizeId(asset)));
      for (const update of current.plan.updates) {
        const filter = {
          _id: update.asset._id,
          teamId: transactionalTeam._id,
          orgUnitId: update.asset.orgUnitId,
          custodianUserId: update.asset.custodianUserId || null
        };
        const query = EquipmentAssetModel.updateOne(filter, {
          $set: { ...update.patch, updatedBy: operator._id },
          $inc: { __v: 1 }
        });
        if (session) query.session(session);
        const result = await query;
        if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
          fail('EQUIPMENT_ASSET_CONCURRENT_CHANGE', 'An equipment ownership row changed during backfill', {
            equipmentId: normalizeId(update.asset),
            assetCode: update.asset.assetCode
          });
        }
        await EquipmentChangeRecordModel.create([{
          teamId: transactionalTeam._id,
          orgUnitId: update.after.orgUnitId,
          equipmentId: update.asset._id,
          changeType: EquipmentChangeRecord.EQUIPMENT_CHANGE_TYPES.UPDATE,
          before: update.before,
          after: update.after,
          operatorId: operator._id,
          reason
        }], { session });
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
          resourceId: update.asset._id,
          before: update.before,
          after: {
            ...update.after,
            source: 'customer-equipment-ownership-backfill',
            operatorUserId: normalizeId(operator),
            routinePlansUpdated: routinePlanCountByEquipmentId.get(normalizeId(update.asset)) || 0
          },
          reason,
          targetTeamId: transactionalTeam._id,
          session
        });
        assetsUpdated += 1;
        auditLogsCreated += 1;
      }

      const migratedAt = now();
      for (const group of routinePlanGroups) {
        const result = await EquipmentRoutinePlanModel.collection.updateMany({
          _id: { $in: group.routinePlanIds },
          teamId: transactionalTeam._id,
          equipmentId: group.equipmentId,
          orgUnitId: group.beforeOrgUnitId
        }, {
          $set: {
            orgUnitId: group.afterOrgUnitId,
            updatedAt: migratedAt
          },
          $inc: { __v: 1 }
        }, { session });
        if (
          result.matchedCount !== group.routinePlanIds.length ||
          result.modifiedCount !== group.routinePlanIds.length
        ) {
          fail('EQUIPMENT_ROUTINE_PLAN_CONCURRENT_CHANGE', 'A routine plan changed during ownership backfill', {
            equipmentId: normalizeId(group.equipmentId),
            assetCode: group.assetCode,
            expected: group.routinePlanIds.length,
            matched: result.matchedCount,
            modified: result.modifiedCount
          });
        }
        routinePlansUpdated += result.modifiedCount;
      }

      const targetByEquipmentId = new Map(
        current.plan.ownershipTargets.map((target) => [normalizeId(target.equipmentId), target])
      );
      for (const [equipmentId, count] of routinePlanCountByEquipmentId) {
        if (assetUpdateIds.has(equipmentId)) continue;
        const target = targetByEquipmentId.get(equipmentId);
        const snapshot = ownershipSnapshot(target.asset);
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.EQUIPMENT_ASSET,
          resourceId: target.asset._id,
          before: snapshot,
          after: {
            ...snapshot,
            source: 'customer-equipment-ownership-backfill',
            operatorUserId: normalizeId(operator),
            routinePlansUpdated: count
          },
          reason,
          targetTeamId: transactionalTeam._id,
          session
        });
        auditLogsCreated += 1;
      }

      return {
        ...baseReport,
        generatedAt: now().toISOString(),
        backup,
        ...current.plan.summary,
        anomalies: current.plan.anomalies,
        routinePlanAnomalies: current.plan.routinePlanAnomalies,
        assetsUpdated,
        routinePlansUpdated,
        changeRecordsCreated: assetsUpdated,
        auditLogsCreated,
        writePerformed: assetsUpdated > 0 || routinePlansUpdated > 0
      };
    }, connection, {
      code: 'EQUIPMENT_OWNERSHIP_BACKFILL_TRANSACTIONS_REQUIRED',
      message: 'Equipment ownership backfill requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  ALLOWED_EXECUTION_DATABASE,
  BACKFILL_EXCEPTION_CODES,
  BACKFILL_REPORT_FORMAT,
  DEFAULT_EXPECTED_ASSET_COUNT,
  EQUIPMENT_ASSET_COLLECTION,
  EQUIPMENT_ROUTINE_PLAN_COLLECTION,
  EquipmentOwnershipBackfillError,
  buildEquipmentOwnershipBackfillPlan,
  buildRoutinePlanOwnershipBackfillPlan,
  createEquipmentOwnershipBackfillService,
  verifyExecutionBackup
};
