'use strict';

const mongoose = require('mongoose');
const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const Message = require('../models/Message');
const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } = require('../config/permissions');
const { createAuditService } = require('./auditService');
const {
  liveCollectionInventory,
  snapshot,
  verifyExecutionBackup
} = require('./acceptanceJuly2026DataRepairService');
const {
  RECIPIENT_GROUPS,
  recipientUserIds
} = require('./equipmentRoutineWorkflowService');
const { runWithRequiredTransaction } = require('./transactionService');

const REPAIR_REPORT_FORMAT = 'equipment-message-recipient-repair/v1';
const ALLOWED_EXECUTION_DATABASE = 'customer_acceptance_v2_test';
const REPAIR_REASON = 'Remove branch-external routine reminders and localize historic repair status messages';
const ROUTINE_RESOURCE_TYPE = 'EQUIPMENT_ROUTINE_PLAN';
const REPAIR_RESOURCE_TYPE = 'REPAIR_ORDER';

const REPAIR_STATUS_LABELS = Object.freeze({
  SUB_DEPARTMENT_REVIEW_PENDING: '待分部负责人审核',
  SUB_DEPARTMENT_ACCEPTANCE_PENDING: '待分部负责人验收',
  ASSET_ADMIN_RECEIPT_PENDING: '待设备管理员接单',
  ASSET_ADMIN_PRICING_PENDING: '待设备管理员确认配件价格',
  DEPUTY_APPROVAL_PENDING: '待副经理/经理助理审批',
  MANAGER_APPROVAL_PENDING: '待部门经理终审',
  RETURNED_TO_CREATOR: '已退回创建人',
  COMPLETED: '已完成',
  VOIDED: '已作废'
});

class EquipmentMessageRepairError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EquipmentMessageRepairError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new EquipmentMessageRepairError(code, message, details);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);
  return String(value);
}

function withSession(query, session) {
  return session && typeof query.session === 'function' ? query.session(session) : query;
}

function repairMessageContent(order, status) {
  const label = REPAIR_STATUS_LABELS[status];
  if (!label) return null;
  return `${order.equipmentSnapshot?.name || '设备'}（${order.equipmentSnapshot?.assetCode || '-'}）维修单状态：${label}`;
}

function blocker(code, message, details = null) {
  return { code, message, details };
}

async function analyzeEquipmentMessageRepair({
  EquipmentRepairOrderModel = EquipmentRepairOrder,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  session = null
} = {}) {
  const [routineMessages, repairMessages] = await Promise.all([
    withSession(MessageModel.find({
      type: 'system',
      'extraData.resourceType': ROUTINE_RESOURCE_TYPE
    }).sort({ _id: 1 }).lean(), session),
    withSession(MessageModel.find({
      type: 'system',
      'extraData.resourceType': REPAIR_RESOURCE_TYPE
    }).sort({ _id: 1 }).lean(), session)
  ]);
  const blockers = [];
  const operations = [];
  const planCache = new Map();
  const allowedRecipientCache = new Map();

  for (const message of routineMessages) {
    const planId = normalizeId(message.extraData?.planId);
    const cacheKey = `${normalizeId(message.teamId)}:${planId || ''}`;
    if (!planId || !mongoose.isValidObjectId(planId)) {
      blockers.push(blocker('ROUTINE_MESSAGE_PLAN_ID_INVALID', 'A routine reminder has no valid plan ID', {
        messageId: normalizeId(message._id)
      }));
      continue;
    }
    if (!planCache.has(cacheKey)) {
      planCache.set(cacheKey, await withSession(EquipmentRoutinePlanModel.findOne({
        _id: planId,
        teamId: message.teamId
      }).lean(), session));
    }
    const plan = planCache.get(cacheKey);
    if (!plan) {
      blockers.push(blocker('ROUTINE_MESSAGE_PLAN_MISSING', 'A routine reminder references a missing plan', {
        messageId: normalizeId(message._id),
        planId
      }));
      continue;
    }
    if (!allowedRecipientCache.has(cacheKey)) {
      const allowed = await recipientUserIds({
        TeamMembershipModel,
        OrgUnitModel,
        UserModel,
        teamId: plan.teamId,
        orgUnitId: plan.orgUnitId,
        group: RECIPIENT_GROUPS.SUB_DEPARTMENT_MANAGER,
        session
      });
      allowedRecipientCache.set(cacheKey, new Set(allowed.map(normalizeId)));
    }
    if (!allowedRecipientCache.get(cacheKey).has(normalizeId(message.recipient))) {
      operations.push({
        type: 'DELETE_ROUTINE_MESSAGE',
        messageId: normalizeId(message._id),
        teamId: normalizeId(message.teamId),
        recipientId: normalizeId(message.recipient),
        planId,
        message
      });
    }
  }

  for (const message of repairMessages) {
    const repairId = normalizeId(message.extraData?.repairId);
    const status = message.extraData?.status;
    if (!repairId || !mongoose.isValidObjectId(repairId)) {
      blockers.push(blocker('REPAIR_MESSAGE_ORDER_ID_INVALID', 'A repair notification has no valid order ID', {
        messageId: normalizeId(message._id)
      }));
      continue;
    }
    if (!REPAIR_STATUS_LABELS[status]) {
      blockers.push(blocker('REPAIR_MESSAGE_STATUS_UNKNOWN', 'A repair notification has an unknown status', {
        messageId: normalizeId(message._id),
        status: status || null
      }));
      continue;
    }
    const order = await withSession(EquipmentRepairOrderModel.findOne({
      _id: repairId,
      teamId: message.teamId
    }).lean(), session);
    if (!order) {
      blockers.push(blocker('REPAIR_MESSAGE_ORDER_MISSING', 'A repair notification references a missing order', {
        messageId: normalizeId(message._id),
        repairId
      }));
      continue;
    }
    const expectedContent = repairMessageContent(order, status);
    if (message.content !== expectedContent) {
      operations.push({
        type: 'LOCALIZE_REPAIR_MESSAGE',
        messageId: normalizeId(message._id),
        teamId: normalizeId(message.teamId),
        repairId,
        status,
        beforeContent: message.content,
        afterContent: expectedContent,
        message
      });
    }
  }

  const state = blockers.length > 0
    ? 'BLOCKED'
    : operations.length > 0
      ? 'READY'
      : 'ALREADY_APPLIED';
  return {
    state,
    blockers,
    operations,
    documents: { routineMessages, repairMessages }
  };
}

function reportAnalysis(analysis) {
  return {
    state: analysis.state,
    blockerCount: analysis.blockers.length,
    blockers: analysis.blockers,
    plannedWriteCount: analysis.operations.length,
    plannedAuditCount: analysis.operations.length,
    routineMessageCount: analysis.documents.routineMessages.length,
    repairMessageCount: analysis.documents.repairMessages.length,
    operations: analysis.operations.map((operation) => ({
      type: operation.type,
      messageId: operation.messageId,
      teamId: operation.teamId,
      recipientId: operation.recipientId || null,
      planId: operation.planId || null,
      repairId: operation.repairId || null,
      status: operation.status || null,
      beforeContent: operation.beforeContent || null,
      afterContent: operation.afterContent || null
    })),
    evidence: {
      routineMessages: snapshot(analysis.documents.routineMessages),
      repairMessages: snapshot(analysis.documents.repairMessages)
    }
  };
}

function operationSignature(operations) {
  return snapshot(operations.map((operation) => ({
    type: operation.type,
    messageId: operation.messageId,
    recipientId: operation.recipientId || null,
    beforeContent: operation.beforeContent || null,
    afterContent: operation.afterContent || null
  }))).sha256;
}

function newestTargetInstant(analysis) {
  const values = [
    ...analysis.documents.routineMessages,
    ...analysis.documents.repairMessages
  ].flatMap((document) => [document.updatedAt, document.createdAt])
    .map((value) => value instanceof Date ? value : new Date(value || Number.NaN))
    .filter((value) => Number.isFinite(value.getTime()));
  return values.length ? new Date(Math.max(...values.map((value) => value.getTime()))) : null;
}

function createEquipmentMessageRepairService({
  connection = mongoose.connection,
  EquipmentRepairOrderModel = EquipmentRepairOrder,
  EquipmentRoutinePlanModel = EquipmentRoutinePlan,
  MessageModel = Message,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  auditService = createAuditService(),
  backupVerifier,
  backupGuard = verifyExecutionBackup,
  collectionInventory = liveCollectionInventory,
  transactionRunner = runWithRequiredTransaction,
  now = () => new Date(),
  allowedExecutionDatabaseNames = [ALLOWED_EXECUTION_DATABASE]
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');
  const dependencies = {
    EquipmentRepairOrderModel,
    EquipmentRoutinePlanModel,
    MessageModel,
    OrgUnitModel,
    TeamMembershipModel,
    UserModel
  };
  const allowedDatabases = new Set(allowedExecutionDatabaseNames);

  async function analyze(session = null) {
    return analyzeEquipmentMessageRepair({ ...dependencies, session });
  }

  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = connection.name || connection.db.databaseName || null;
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (execute && confirmDatabase !== databaseName) {
      fail('DATABASE_CONFIRMATION_MISMATCH', '--confirm-database must exactly match the connected database name', {
        expected: databaseName,
        actual: confirmDatabase || null
      });
    }
    if (execute && !allowedDatabases.has(databaseName)) {
      fail('EXECUTION_DATABASE_FORBIDDEN', 'Execution is restricted to the acceptance database allowlist', {
        actual: databaseName,
        allowed: [...allowedDatabases].sort()
      });
    }

    const preview = await analyze();
    const base = {
      format: REPAIR_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode: execute ? 'execute' : 'dry-run',
      database: { name: databaseName },
      backup: null,
      before: reportAnalysis(preview),
      writePerformed: false,
      dataWrites: 0,
      auditLogsCreated: 0
    };
    if (!execute) {
      return {
        ...base,
        status: preview.state === 'BLOCKED'
          ? 'DRY_RUN_BLOCKED'
          : preview.operations.length > 0
            ? 'DRY_RUN_READY'
            : 'DRY_RUN_NO_CHANGES',
        after: null
      };
    }
    if (preview.state === 'BLOCKED') return { ...base, status: 'BLOCKED', after: null };
    if (preview.operations.length === 0) {
      return { ...base, status: 'NO_CHANGES', after: reportAnalysis(preview) };
    }
    if (typeof backupVerifier !== 'function') {
      fail('BACKUP_VERIFIER_REQUIRED', 'A complete backup verifier is required in execute mode');
    }

    const backup = await backupGuard({
      backupDirectory,
      databaseName,
      backupVerifier,
      liveCollections: await collectionInventory(connection),
      minimumCompletedAt: newestTargetInstant(preview)
    });
    const expectedSignature = operationSignature(preview.operations);

    return transactionRunner(async (session) => {
      const before = await analyze(session);
      if (
        before.state !== 'READY' ||
        before.blockers.length > 0 ||
        operationSignature(before.operations) !== expectedSignature
      ) {
        fail('TARGET_STATE_CHANGED_BEFORE_EXECUTION', 'Message state changed after backup verification', {
          before: reportAnalysis(before),
          writePerformed: false,
          transactionRolledBack: true
        });
      }

      for (const operation of before.operations) {
        if (operation.type === 'DELETE_ROUTINE_MESSAGE') {
          const result = await MessageModel.deleteOne({
            _id: operation.message._id,
            teamId: operation.message.teamId,
            recipient: operation.message.recipient,
            deduplicationKey: operation.message.deduplicationKey,
            __v: operation.message.__v ?? 0
          }, { session });
          if (result.deletedCount !== 1) {
            fail('ROUTINE_MESSAGE_CHANGED', 'A routine reminder changed during repair');
          }
          await auditService.recordSystem({
            action: AUDIT_ACTIONS.DELETE,
            resourceType: AUDIT_RESOURCE_TYPES.MESSAGE,
            resourceId: operation.message._id,
            before: snapshot(operation.message),
            after: snapshot({ deleted: true, reason: 'recipient-outside-current-branch-leadership' }),
            reason: REPAIR_REASON,
            targetTeamId: operation.message.teamId,
            session
          });
          continue;
        }

        const updatedAt = now();
        const result = await MessageModel.updateOne({
          _id: operation.message._id,
          teamId: operation.message.teamId,
          content: operation.beforeContent,
          __v: operation.message.__v ?? 0
        }, {
          $set: { content: operation.afterContent, updatedAt },
          $inc: { __v: 1 }
        }, { session, runValidators: true });
        if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
          fail('REPAIR_MESSAGE_CHANGED', 'A repair notification changed during localization');
        }
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.CORRECT,
          resourceType: AUDIT_RESOURCE_TYPES.MESSAGE,
          resourceId: operation.message._id,
          before: snapshot(operation.message),
          after: snapshot({
            ...operation.message,
            content: operation.afterContent,
            updatedAt,
            __v: (operation.message.__v ?? 0) + 1
          }),
          reason: REPAIR_REASON,
          targetTeamId: operation.message.teamId,
          session
        });
      }

      const after = await analyze(session);
      if (after.state !== 'ALREADY_APPLIED' || after.operations.length !== 0 || after.blockers.length !== 0) {
        fail('MESSAGE_REPAIR_POSTCONDITION_FAILED', 'Message repair did not reach the idempotent target state', {
          before: reportAnalysis(before),
          after: reportAnalysis(after),
          writePerformed: false,
          transactionRolledBack: true
        });
      }
      return {
        ...base,
        generatedAt: now().toISOString(),
        status: 'EXECUTED',
        backup,
        before: reportAnalysis(before),
        writePerformed: true,
        dataWrites: before.operations.length,
        auditLogsCreated: before.operations.length,
        after: reportAnalysis(after)
      };
    }, connection, {
      code: 'EQUIPMENT_MESSAGE_REPAIR_TRANSACTIONS_REQUIRED',
      message: 'Equipment message repair requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ analyze, run });
}

module.exports = {
  ALLOWED_EXECUTION_DATABASE,
  EquipmentMessageRepairError,
  REPAIR_REASON,
  REPAIR_REPORT_FORMAT,
  REPAIR_STATUS_LABELS,
  analyzeEquipmentMessageRepair,
  createEquipmentMessageRepairService,
  operationSignature,
  repairMessageContent,
  reportAnalysis
};
