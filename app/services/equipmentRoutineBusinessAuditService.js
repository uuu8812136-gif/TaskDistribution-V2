'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRule = require('../models/EquipmentRoutineRule');
const ProjectTeam = require('../models/ProjectTeam');
const {
  resolveRoutineRuleAssetCategoryIds
} = require('./equipmentRoutineService');

const ALLOWED_DATABASE_NAME = 'customer_acceptance_v2_test';
const AUDIT_REPORT_FORMAT = 'taskdistribution-v2-equipment-routine-business-audit-v1';
const PRIMARY_CATEGORY_DEPTH = 3;
const MAX_CATEGORY_DEPTH = 4;
const OPEN_PLAN_STATUSES = Object.freeze([
  EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.PLANNED,
  EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.IN_WINDOW,
  EquipmentRoutinePlan.EQUIPMENT_ROUTINE_PLAN_STATUSES.OVERDUE
]);

function auditError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertAllowedDatabaseName(databaseName) {
  if (databaseName !== ALLOWED_DATABASE_NAME) {
    throw auditError(
      'EQUIPMENT_ROUTINE_AUDIT_DATABASE_REJECTED',
      `Equipment routine business audit is restricted to ${ALLOWED_DATABASE_NAME}`,
      { actualDatabaseName: databaseName || null, allowedDatabaseName: ALLOWED_DATABASE_NAME }
    );
  }
  return databaseName;
}

function connectionDatabaseName(connection) {
  return String(connection?.name || connection?.db?.databaseName || '');
}

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (typeof value === 'object' && value._id !== undefined) return normalizeId(value._id);
  return String(value);
}

function normalizeText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw auditError('EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID', `${field} is required`);
  }
  return value.trim();
}

function normalizeOptions({ teamCode = null, primaryNames = [], expectedPrimaries = [] } = {}) {
  const normalizedTeamCode = teamCode === null || teamCode === undefined || teamCode === ''
    ? null
    : normalizeText(teamCode, 'teamCode').toUpperCase();
  if (!Array.isArray(primaryNames) || !Array.isArray(expectedPrimaries)) {
    throw auditError(
      'EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID',
      'primaryNames and expectedPrimaries must be arrays'
    );
  }

  const names = [];
  const expectedByName = new Map();
  for (const value of primaryNames) {
    const name = normalizeText(value, 'primaryName');
    if (!names.includes(name)) names.push(name);
  }
  for (const expectation of expectedPrimaries) {
    if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) {
      throw auditError(
        'EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID',
        'Each expected primary must be an object'
      );
    }
    const name = normalizeText(expectation.name, 'expectedPrimary.name');
    const expectedInUse = expectation.expectedInUse;
    if (!Number.isSafeInteger(expectedInUse) || expectedInUse < 0) {
      throw auditError(
        'EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID',
        `Expected in-use count for ${name} must be a non-negative safe integer`
      );
    }
    if (expectedByName.has(name)) {
      throw auditError(
        'EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID',
        `Duplicate expected primary name: ${name}`
      );
    }
    expectedByName.set(name, expectedInUse);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > 0 && !normalizedTeamCode) {
    throw auditError(
      'EQUIPMENT_ROUTINE_AUDIT_INPUT_INVALID',
      'teamCode is required when primary-name gates are requested'
    );
  }
  return { teamCode: normalizedTeamCode, primaryNames: names, expectedByName };
}

function sortText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN');
}

function sortedAssetEvidence(assets, categoryById) {
  return [...assets]
    .sort((left, right) => sortText(left.assetCode, right.assetCode) || (
      normalizeId(left._id).localeCompare(normalizeId(right._id))
    ))
    .map((asset) => ({
      equipmentId: normalizeId(asset._id),
      assetCode: String(asset.assetCode || ''),
      categoryId: normalizeId(asset.categoryId),
      categoryName: categoryById.get(normalizeId(asset.categoryId))?.name || null
    }));
}

function buildCategoryGraph(categories) {
  const categoryById = new Map(categories.map((category) => [normalizeId(category._id), category]));
  const childrenByParent = new Map();
  for (const category of categories) {
    const parentId = normalizeId(category.parentId);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(category);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => sortText(left.name, right.name));
  }

  const metadataById = new Map();
  function metadata(category) {
    if (!category) {
      return {
        valid: false,
        reason: 'CATEGORY_MISSING',
        depth: null,
        path: [],
        primaryCategoryId: null
      };
    }
    const categoryId = normalizeId(category._id);
    if (metadataById.has(categoryId)) return metadataById.get(categoryId);
    const chain = [];
    const visited = new Set();
    const teamId = normalizeId(category.teamId);
    let cursor = category;
    let reason = null;
    while (cursor) {
      const cursorId = normalizeId(cursor._id);
      if (visited.has(cursorId)) {
        reason = 'CATEGORY_CYCLE';
        break;
      }
      if (normalizeId(cursor.teamId) !== teamId) {
        reason = 'CATEGORY_PARENT_CROSSES_TEAM';
        break;
      }
      visited.add(cursorId);
      chain.unshift(cursor);
      const parentId = normalizeId(cursor.parentId);
      if (!parentId) break;
      cursor = categoryById.get(parentId);
      if (!cursor) {
        reason = 'CATEGORY_PARENT_MISSING';
        break;
      }
    }
    const result = {
      valid: reason === null,
      reason,
      depth: reason === null ? chain.length : null,
      path: chain.map((item) => ({
        categoryId: normalizeId(item._id),
        name: String(item.name || '')
      })),
      primaryCategoryId: reason === null && chain.length >= PRIMARY_CATEGORY_DEPTH
        ? normalizeId(chain[PRIMARY_CATEGORY_DEPTH - 1]._id)
        : null
    };
    metadataById.set(categoryId, result);
    return result;
  }

  function subtree(categoryId) {
    const values = [];
    const queue = [categoryById.get(normalizeId(categoryId))].filter(Boolean);
    const visited = new Set();
    while (queue.length > 0) {
      const category = queue.shift();
      const currentId = normalizeId(category._id);
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);
      values.push(category);
      queue.push(...(childrenByParent.get(currentId) || []));
    }
    return values;
  }

  for (const category of categories) metadata(category);
  return { categoryById, childrenByParent, metadata, subtree };
}

function serializeCategory(category, graph) {
  const meta = graph.metadata(category);
  return {
    categoryId: normalizeId(category?._id),
    name: category?.name || null,
    status: category?.status || null,
    depth: meta.depth,
    path: meta.path.map(({ name }) => name)
  };
}

function serializeRule(rule, category, graph) {
  return {
    ruleId: normalizeId(rule._id),
    name: String(rule.name || ''),
    status: rule.status,
    routineType: rule.routineType,
    version: rule.version,
    category: serializeCategory(category, graph)
  };
}

function openPlanKey(plan) {
  const date = plan.scheduledFor instanceof Date
    ? plan.scheduledFor
    : new Date(plan.scheduledFor);
  const scheduledFor = Number.isNaN(date.getTime()) ? String(plan.scheduledFor || '') : date.toISOString();
  return [
    normalizeId(plan.equipmentId),
    normalizeId(plan.ruleId),
    scheduledFor,
    String(plan.routineType || '')
  ].join('|');
}

function createEquipmentRoutineBusinessAuditService({
  connection = mongoose.connection,
  ProjectTeamModel = ProjectTeam,
  EquipmentCategoryModel = EquipmentCategory,
  EquipmentRoutineRuleModel = EquipmentRoutineRule,
  EquipmentAssetModel = EquipmentAsset,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  resolveRuleAssetCategoryIds = resolveRoutineRuleAssetCategoryIds,
  clock = () => new Date()
} = {}) {
  async function run(options = {}) {
    const databaseName = assertAllowedDatabaseName(connectionDatabaseName(connection));
    const normalized = normalizeOptions(options);
    const teamFilter = normalized.teamCode ? { code: normalized.teamCode } : {};
    const teams = await ProjectTeamModel.find(teamFilter)
      .select('_id code name status')
      .sort({ code: 1, _id: 1 })
      .lean();
    const violations = [];
    if (normalized.teamCode && teams.length !== 1) {
      violations.push({
        code: 'TEAM_NOT_FOUND',
        message: `Team ${normalized.teamCode} does not exist`,
        teamCode: normalized.teamCode
      });
    } else if (!normalized.teamCode && teams.length === 0) {
      violations.push({
        code: 'NO_TEAMS_FOUND',
        message: 'The acceptance database contains no project teams',
        teamCode: null
      });
    }
    const teamIds = teams.map(({ _id }) => _id);
    const scopedFilter = { teamId: { $in: teamIds } };
    const [categories, rules, assets, plans] = teamIds.length > 0
      ? await Promise.all([
        EquipmentCategoryModel.find(scopedFilter)
          .select('_id teamId name parentId status sortOrder')
          .sort({ teamId: 1, sortOrder: 1, name: 1, _id: 1 })
          .lean(),
        EquipmentRoutineRuleModel.find(scopedFilter)
          .select('_id teamId categoryId routineType name status version schedule')
          .sort({ teamId: 1, name: 1, _id: 1 })
          .lean(),
        EquipmentAssetModel.find(scopedFilter)
          .select('_id teamId categoryId assetCode name status')
          .sort({ teamId: 1, assetCode: 1, _id: 1 })
          .lean(),
        EquipmentRoutinePlanModel.find(scopedFilter)
          .select('_id teamId equipmentId categoryId ruleId routineType scheduledFor status')
          .sort({ teamId: 1, scheduledFor: 1, _id: 1 })
          .lean()
      ])
      : [[], [], [], []];

    const teamById = new Map(teams.map((team) => [normalizeId(team._id), team]));
    const graph = buildCategoryGraph(categories);
    const ruleById = new Map(rules.map((rule) => [normalizeId(rule._id), rule]));
    const assetById = new Map(assets.map((asset) => [normalizeId(asset._id), asset]));
    const activeRules = rules.filter(({ status }) => (
      status === EquipmentRoutineRule.EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
    ));
    const inUseAssets = assets.filter(({ status }) => status === EquipmentAsset.EQUIPMENT_STATUSES.IN_USE);
    const openPlans = plans.filter(({ status }) => OPEN_PLAN_STATUSES.includes(status));
    const allowedCategoryIdsByRule = new Map();

    for (const rule of activeRules) {
      const ruleId = normalizeId(rule._id);
      const category = graph.categoryById.get(normalizeId(rule.categoryId));
      const meta = graph.metadata(category);
      const teamCode = teamById.get(normalizeId(rule.teamId))?.code || null;
      if (!meta.valid) {
        violations.push({
          code: 'ACTIVE_RULE_CATEGORY_INVALID',
          message: `Active rule ${rule.name} has an invalid category path`,
          teamCode,
          ruleId,
          ruleName: rule.name,
          categoryId: normalizeId(rule.categoryId),
          reason: meta.reason
        });
        continue;
      }
      if (meta.depth !== PRIMARY_CATEGORY_DEPTH) {
        violations.push({
          code: 'ACTIVE_RULE_CATEGORY_DEPTH_INVALID',
          message: `Active rule ${rule.name} must use a level-3 primary equipment category`,
          teamCode,
          ruleId,
          ruleName: rule.name,
          routineType: rule.routineType,
          category: serializeCategory(category, graph)
        });
        continue;
      }
      const branch = graph.subtree(category._id);
      const allowedIds = new Set(branch.map(({ _id }) => normalizeId(_id)));
      allowedCategoryIdsByRule.set(ruleId, allowedIds);
      try {
        const resolvedIds = new Set((await resolveRuleAssetCategoryIds({
          EquipmentCategoryModel,
          teamId: rule.teamId,
          ruleCategoryId: rule.categoryId
        })).map(normalizeId));
        const missingCategoryIds = [...allowedIds].filter((categoryId) => !resolvedIds.has(categoryId));
        const unexpectedCategoryIds = [...resolvedIds].filter((categoryId) => !allowedIds.has(categoryId));
        if (missingCategoryIds.length > 0 || unexpectedCategoryIds.length > 0) {
          violations.push({
            code: 'RULE_CATEGORY_SCOPE_MISMATCH',
            message: `Rule ${rule.name} does not resolve exactly its complete primary-category branch`,
            teamCode,
            ruleId,
            ruleName: rule.name,
            missingCategories: missingCategoryIds.map((categoryId) => (
              serializeCategory(graph.categoryById.get(categoryId), graph)
            )),
            unexpectedCategories: unexpectedCategoryIds.map((categoryId) => (
              serializeCategory(graph.categoryById.get(categoryId), graph)
            ))
          });
        }
      } catch (error) {
        violations.push({
          code: 'RULE_CATEGORY_SCOPE_RESOLUTION_FAILED',
          message: `Rule ${rule.name} category scope could not be resolved`,
          teamCode,
          ruleId,
          ruleName: rule.name,
          errorCode: error.code || null,
          errorMessage: error.message
        });
      }
      const invalidDescendants = branch.filter((descendant) => {
        const descendantMeta = graph.metadata(descendant);
        return !descendantMeta.valid ||
          descendantMeta.depth > MAX_CATEGORY_DEPTH ||
          descendantMeta.primaryCategoryId !== normalizeId(category._id);
      });
      if (invalidDescendants.length > 0) {
        violations.push({
          code: 'RULE_BRANCH_CATEGORY_INVALID',
          message: `Rule ${rule.name} has categories outside the supported level-4 branch`,
          teamCode,
          ruleId,
          ruleName: rule.name,
          invalidCategories: invalidDescendants.map((value) => serializeCategory(value, graph))
        });
      }
    }

    for (const plan of openPlans) {
      const planId = normalizeId(plan._id);
      const rule = ruleById.get(normalizeId(plan.ruleId));
      const asset = assetById.get(normalizeId(plan.equipmentId));
      const teamCode = teamById.get(normalizeId(plan.teamId))?.code || null;
      if (!rule) {
        violations.push({
          code: 'OPEN_PLAN_RULE_MISSING',
          message: 'Open routine plan references a missing rule',
          teamCode,
          planId,
          ruleId: normalizeId(plan.ruleId)
        });
        continue;
      }
      const category = graph.categoryById.get(normalizeId(rule.categoryId));
      const ruleMeta = graph.metadata(category);
      if (!ruleMeta.valid || ruleMeta.depth !== PRIMARY_CATEGORY_DEPTH) {
        violations.push({
          code: 'HISTORICAL_NON_PRIMARY_RULE_OPEN_PLAN',
          message: 'A historical non-level-3 rule still has an open plan',
          teamCode,
          planId,
          rule: serializeRule(rule, category, graph)
        });
        continue;
      }
      if (!asset) {
        violations.push({
          code: 'OPEN_PLAN_EQUIPMENT_MISSING',
          message: 'Open routine plan references missing equipment',
          teamCode,
          planId,
          equipmentId: normalizeId(plan.equipmentId),
          ruleId: normalizeId(rule._id)
        });
        continue;
      }
      const allowedIds = allowedCategoryIdsByRule.get(normalizeId(rule._id)) || new Set(
        graph.subtree(category._id).map(({ _id }) => normalizeId(_id))
      );
      const assetCategoryId = normalizeId(asset.categoryId);
      const planCategoryId = normalizeId(plan.categoryId);
      if (
        normalizeId(plan.teamId) !== normalizeId(rule.teamId) ||
        normalizeId(asset.teamId) !== normalizeId(rule.teamId)
      ) {
        violations.push({
          code: 'OPEN_PLAN_TEAM_MISMATCH',
          message: 'Open routine plan, rule, and equipment must belong to the same team',
          teamCode,
          planId,
          ruleId: normalizeId(rule._id),
          equipmentId: normalizeId(asset._id)
        });
      }
      if (!allowedIds.has(assetCategoryId) || !allowedIds.has(planCategoryId)) {
        violations.push({
          code: 'OPEN_PLAN_OUTSIDE_RULE_BRANCH',
          message: 'Open routine plan crosses its rule primary-category branch',
          teamCode,
          planId,
          rule: serializeRule(rule, category, graph),
          equipment: sortedAssetEvidence([asset], graph.categoryById)[0],
          planCategory: serializeCategory(graph.categoryById.get(planCategoryId), graph)
        });
      }
      if (plan.routineType !== rule.routineType) {
        violations.push({
          code: 'OPEN_PLAN_ROUTINE_TYPE_MISMATCH',
          message: 'Open routine plan type does not match its rule type',
          teamCode,
          planId,
          ruleId: normalizeId(rule._id),
          ruleRoutineType: rule.routineType,
          planRoutineType: plan.routineType
        });
      }
    }

    const plansByDuplicateKey = new Map();
    for (const plan of openPlans) {
      const key = openPlanKey(plan);
      const values = plansByDuplicateKey.get(key) || [];
      values.push(plan);
      plansByDuplicateKey.set(key, values);
    }
    const duplicateOpenPlanGroups = [...plansByDuplicateKey.values()]
      .filter((values) => values.length > 1)
      .map((values) => ({
        equipmentId: normalizeId(values[0].equipmentId),
        ruleId: normalizeId(values[0].ruleId),
        scheduledFor: values[0].scheduledFor,
        routineType: values[0].routineType,
        count: values.length,
        plans: values.map((plan) => ({ planId: normalizeId(plan._id), status: plan.status }))
      }));
    for (const duplicate of duplicateOpenPlanGroups) {
      violations.push({
        code: 'DUPLICATE_OPEN_PLAN',
        message: 'Duplicate open routine plans share equipment, rule, scheduled time, and type',
        ...duplicate
      });
    }

    const activeRuleAudits = [];
    const activeRuleAuditById = new Map();
    for (const rule of activeRules) {
      const ruleId = normalizeId(rule._id);
      const category = graph.categoryById.get(normalizeId(rule.categoryId));
      const meta = graph.metadata(category);
      const allowedIds = allowedCategoryIdsByRule.get(ruleId);
      if (!meta.valid || meta.depth !== PRIMARY_CATEGORY_DEPTH || !allowedIds) continue;
      const eligibleAssets = inUseAssets.filter((asset) => (
        normalizeId(asset.teamId) === normalizeId(rule.teamId) &&
        allowedIds.has(normalizeId(asset.categoryId))
      ));
      const eligibleIds = new Set(eligibleAssets.map(({ _id }) => normalizeId(_id)));
      const validRulePlans = openPlans.filter((plan) => (
        normalizeId(plan.ruleId) === ruleId &&
        plan.routineType === rule.routineType &&
        eligibleIds.has(normalizeId(plan.equipmentId)) &&
        allowedIds.has(normalizeId(plan.categoryId))
      ));
      const coveredIds = new Set(validRulePlans.map(({ equipmentId }) => normalizeId(equipmentId)));
      const missingAssets = eligibleAssets.filter(({ _id }) => !coveredIds.has(normalizeId(_id)));
      const branchCategories = [...allowedIds]
        .map((categoryId) => graph.categoryById.get(categoryId))
        .filter(Boolean)
        .sort((left, right) => (
          (graph.metadata(left).depth || 0) - (graph.metadata(right).depth || 0) ||
          sortText(left.name, right.name)
        ));
      const value = {
        teamCode: teamById.get(normalizeId(rule.teamId))?.code || null,
        rule: serializeRule(rule, category, graph),
        coveredCategories: branchCategories.map((item) => serializeCategory(item, graph)),
        inUseEquipmentCount: eligibleAssets.length,
        equipmentWithOpenPlanCount: coveredIds.size,
        missingAssets: sortedAssetEvidence(missingAssets, graph.categoryById),
        openPlanCount: validRulePlans.length
      };
      activeRuleAudits.push(value);
      activeRuleAuditById.set(ruleId, { ...value, coveredIds });
    }

    const targetPrimaries = [];
    for (const requestedName of normalized.primaryNames) {
      const matches = categories.filter((category) => {
        const meta = graph.metadata(category);
        return meta.valid &&
          meta.depth === PRIMARY_CATEGORY_DEPTH &&
          category.name === requestedName;
      });
      if (matches.length !== 1) {
        const code = matches.length === 0
          ? 'TARGET_PRIMARY_CATEGORY_NOT_FOUND'
          : 'TARGET_PRIMARY_CATEGORY_AMBIGUOUS';
        violations.push({
          code,
          message: matches.length === 0
            ? `Primary category ${requestedName} does not exist`
            : `Primary category ${requestedName} is ambiguous`,
          teamCode: normalized.teamCode,
          requestedName,
          matchCount: matches.length
        });
        targetPrimaries.push({
          requestedName,
          expectedInUseEquipmentCount: normalized.expectedByName.get(requestedName) ?? null,
          status: 'FAILED',
          reason: code
        });
        continue;
      }

      const primary = matches[0];
      const branch = graph.subtree(primary._id);
      const branchIds = new Set(branch.map(({ _id }) => normalizeId(_id)));
      const eligibleAssets = inUseAssets.filter((asset) => (
        normalizeId(asset.teamId) === normalizeId(primary.teamId) &&
        branchIds.has(normalizeId(asset.categoryId))
      ));
      const targetRules = activeRules.filter((rule) => (
        normalizeId(rule.teamId) === normalizeId(primary.teamId) &&
        normalizeId(rule.categoryId) === normalizeId(primary._id)
      ));
      const missingAssets = [];
      let fullyCoveredCount = 0;
      for (const asset of eligibleAssets) {
        const missingRules = targetRules.filter((rule) => (
          !activeRuleAuditById.get(normalizeId(rule._id))?.coveredIds.has(normalizeId(asset._id))
        ));
        if (targetRules.length > 0 && missingRules.length === 0) {
          fullyCoveredCount += 1;
        } else {
          missingAssets.push({
            ...sortedAssetEvidence([asset], graph.categoryById)[0],
            missingRules: missingRules.map((rule) => ({
              ruleId: normalizeId(rule._id),
              name: rule.name,
              routineType: rule.routineType
            }))
          });
        }
      }

      const byRoutineType = EquipmentRoutineRule.EQUIPMENT_ROUTINE_TYPE_VALUES
        .map((routineType) => {
          const typeRules = targetRules.filter((rule) => rule.routineType === routineType);
          if (typeRules.length === 0) return null;
          const coveredAssets = eligibleAssets.filter((asset) => typeRules.every((rule) => (
            activeRuleAuditById.get(normalizeId(rule._id))?.coveredIds.has(normalizeId(asset._id))
          )));
          const coveredIds = new Set(coveredAssets.map(({ _id }) => normalizeId(_id)));
          return {
            routineType,
            activeRuleCount: typeRules.length,
            equipmentWithOpenPlanCount: coveredAssets.length,
            missingAssets: sortedAssetEvidence(
              eligibleAssets.filter(({ _id }) => !coveredIds.has(normalizeId(_id))),
              graph.categoryById
            )
          };
        })
        .filter(Boolean);
      const expectedInUse = normalized.expectedByName.get(requestedName) ?? null;
      const targetViolations = [];
      if (expectedInUse !== null && eligibleAssets.length !== expectedInUse) {
        targetViolations.push('TARGET_PRIMARY_IN_USE_COUNT_MISMATCH');
        violations.push({
          code: 'TARGET_PRIMARY_IN_USE_COUNT_MISMATCH',
          message: `Primary category ${requestedName} has an unexpected in-use equipment count`,
          teamCode: normalized.teamCode,
          requestedName,
          expectedInUseEquipmentCount: expectedInUse,
          actualInUseEquipmentCount: eligibleAssets.length
        });
      }
      if (expectedInUse !== null && targetRules.length === 0) {
        targetViolations.push('TARGET_PRIMARY_ACTIVE_RULE_MISSING');
        violations.push({
          code: 'TARGET_PRIMARY_ACTIVE_RULE_MISSING',
          message: `Primary category ${requestedName} has no active routine rule`,
          teamCode: normalized.teamCode,
          requestedName
        });
      }
      if (expectedInUse !== null && fullyCoveredCount !== eligibleAssets.length) {
        targetViolations.push('TARGET_PRIMARY_OPEN_PLAN_COVERAGE_INCOMPLETE');
        violations.push({
          code: 'TARGET_PRIMARY_OPEN_PLAN_COVERAGE_INCOMPLETE',
          message: `Primary category ${requestedName} does not have open-plan coverage for every active rule`,
          teamCode: normalized.teamCode,
          requestedName,
          inUseEquipmentCount: eligibleAssets.length,
          equipmentWithOpenPlanCount: fullyCoveredCount,
          missingAssetCodes: missingAssets.map(({ assetCode }) => assetCode)
        });
      }

      targetPrimaries.push({
        requestedName,
        status: targetViolations.length === 0 ? 'PASSED' : 'FAILED',
        expectedInUseEquipmentCount: expectedInUse,
        primary: serializeCategory(primary, graph),
        coveredCategories: branch.map((category) => serializeCategory(category, graph)),
        activeRules: targetRules.map((rule) => serializeRule(
          rule,
          graph.categoryById.get(normalizeId(rule.categoryId)),
          graph
        )),
        coverageDefinition: 'equipment has one or more open plans for every active rule on the primary category',
        inUseEquipmentCount: eligibleAssets.length,
        equipmentWithOpenPlanCount: fullyCoveredCount,
        missingAssets,
        byRoutineType,
        gates: {
          expectedInUseMatches: expectedInUse === null || eligibleAssets.length === expectedInUse,
          hasActiveRules: targetRules.length > 0,
          completeOpenPlanCoverage: fullyCoveredCount === eligibleAssets.length
        }
      });
    }

    const categoryDepthCounts = {};
    for (const category of categories) {
      const meta = graph.metadata(category);
      const key = meta.valid ? String(meta.depth) : 'INVALID';
      categoryDepthCounts[key] = (categoryDepthCounts[key] || 0) + 1;
    }
    const report = {
      format: AUDIT_REPORT_FORMAT,
      generatedAt: clock().toISOString(),
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      mode: 'read-only',
      writePerformed: false,
      database: { name: databaseName },
      filters: {
        teamCode: normalized.teamCode,
        primaryNames: normalized.primaryNames,
        expectedPrimaries: [...normalized.expectedByName].map(([name, expectedInUse]) => ({
          name,
          expectedInUse
        }))
      },
      summary: {
        teamCount: teams.length,
        categoryCount: categories.length,
        categoryDepthCounts,
        activeRuleCount: activeRules.length,
        inUseEquipmentCount: inUseAssets.length,
        openPlanCount: openPlans.length,
        duplicateOpenPlanGroupCount: duplicateOpenPlanGroups.length,
        targetPrimaryCount: targetPrimaries.length,
        violationCount: violations.length
      },
      teams: teams.map((team) => ({
        teamId: normalizeId(team._id),
        code: team.code,
        name: team.name,
        status: team.status
      })),
      activeRuleAudits,
      duplicateOpenPlanGroups,
      targetPrimaries,
      violations
    };
    return report;
  }

  return Object.freeze({ run });
}

module.exports = {
  ALLOWED_DATABASE_NAME,
  AUDIT_REPORT_FORMAT,
  MAX_CATEGORY_DEPTH,
  OPEN_PLAN_STATUSES,
  PRIMARY_CATEGORY_DEPTH,
  assertAllowedDatabaseName,
  buildCategoryGraph,
  createEquipmentRoutineBusinessAuditService,
  normalizeOptions,
  openPlanKey
};
