const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const { normalizeId } = require('./authSessionService');
const { runWithOptionalTransaction, supportsTransactions } = require('./transactionService');

const MIGRATION_REPORT_FORMAT = 'repair-followup-backfill/1';

const EQUIPMENT_REPAIR_TYPES = EquipmentRepairOrder.EQUIPMENT_REPAIR_TYPES;
const EQUIPMENT_REPAIR_STATUSES = EquipmentRepairOrder.EQUIPMENT_REPAIR_STATUSES;
const FOLLOWUP_TYPES = new Set([
  EQUIPMENT_REPAIR_TYPES.PARTS_REPAIR,
  EQUIPMENT_REPAIR_TYPES.NO_PARTS_REPAIR
]);

function backfillError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function createRepairFollowupBackfillService({
  EquipmentRepairOrderModel = EquipmentRepairOrder,
  connection = null
} = {}) {
  function pairKey(document) {
    return `${normalizeId(document.teamId) || ''}:${normalizeId(document.equipmentId) || ''}`;
  }

  // 按团队和设备分组、createdAt 升序，把每个独立后续单配对到其前最近的
  // 未配对已完成故障报修。一对一消耗，配不上的故障单保持派生待补状态。
  function planPairs({ faults, followups }) {
    const faultsByEquipment = new Map();
    for (const fault of faults) {
      const key = pairKey(fault);
      if (!faultsByEquipment.has(key)) faultsByEquipment.set(key, []);
      faultsByEquipment.get(key).push(fault);
    }
    for (const list of faultsByEquipment.values()) {
      list.sort((a, b) => (
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ));
    }

    const pairs = [];
    const unmatchedFollowups = [];
    const consumedFaultIds = new Set();
    for (const followup of [...followups].sort((a, b) => (
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    ))) {
      const candidates = faultsByEquipment.get(pairKey(followup)) || [];
      let matched = null;
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        if (consumedFaultIds.has(normalizeId(candidate._id))) continue;
        if (new Date(candidate.createdAt).getTime() > new Date(followup.createdAt).getTime()) continue;
        matched = candidate;
        break;
      }
      if (matched) {
        consumedFaultIds.add(normalizeId(matched._id));
        pairs.push({ fault: matched, followup });
      } else {
        unmatchedFollowups.push(followup);
      }
    }
    const pendingFaults = faults.filter(
      (fault) => !consumedFaultIds.has(normalizeId(fault._id))
    );
    return { pairs, unmatchedFollowups, pendingFaults };
  }

  async function run({ execute = false, confirmDatabase = null, databaseName = null } = {}) {
    if (execute) {
      if (!confirmDatabase) {
        throw backfillError('CONFIRM_DATABASE_REQUIRED', '--confirm-database is required in execute mode');
      }
      if (databaseName && confirmDatabase !== databaseName) {
        throw backfillError('DATABASE_MISMATCH', `--confirm-database (${confirmDatabase}) does not match the connected database (${databaseName})`);
      }
    }

    const faults = await EquipmentRepairOrderModel.find({
      type: EQUIPMENT_REPAIR_TYPES.FAULT_REPORT,
      status: EQUIPMENT_REPAIR_STATUSES.COMPLETED,
      followupRepairId: null
    }).sort({ createdAt: 1, _id: 1 }).lean();
    const followups = await EquipmentRepairOrderModel.find({
      type: { $in: [...FOLLOWUP_TYPES] },
      sourceRepairId: null,
      status: { $ne: EQUIPMENT_REPAIR_STATUSES.VOIDED }
    }).sort({ createdAt: 1, _id: 1 }).lean();

    const { pairs, unmatchedFollowups, pendingFaults } = planPairs({ faults, followups });

    let writePerformed = false;
    let linkedCount = 0;
    const linkFailures = [];
    if (execute) {
      if (!supportsTransactions(connection)) {
        throw backfillError(
          'REPAIR_FOLLOWUP_TRANSACTIONS_REQUIRED',
          'Repair follow-up backfill requires MongoDB replica-set transaction support'
        );
      }
      for (const { fault, followup } of pairs) {
        try {
          // CAS 双向写入放在同一事务内，避免只写一侧造成脏关联。
          await runWithOptionalTransaction(async (session) => {
            const options = session ? { session } : undefined;
            const markFollowup = await EquipmentRepairOrderModel.updateOne(
              { _id: followup._id, sourceRepairId: null },
              { $set: { sourceRepairId: fault._id } },
              options
            );
            if (markFollowup.modifiedCount !== 1) {
              throw backfillError('FOLLOWUP_ALREADY_LINKED', 'Follow-up repair is already linked');
            }
            const markFault = await EquipmentRepairOrderModel.updateOne(
              { _id: fault._id, followupRepairId: null },
              { $set: { followupRepairId: followup._id } },
              options
            );
            if (markFault.modifiedCount !== 1) {
              throw backfillError('FAULT_ALREADY_LINKED', 'Fault report is already linked');
            }
          }, connection);
          linkedCount += 1;
          writePerformed = true;
        } catch (error) {
          linkFailures.push({
            followupId: normalizeId(followup._id),
            faultId: normalizeId(fault._id),
            reason: error.code || 'PAIR_WRITE_FAILED'
          });
        }
      }
    }

    return {
      format: MIGRATION_REPORT_FORMAT,
      generatedAt: new Date().toISOString(),
      status: execute ? 'EXECUTED' : 'DRY_RUN',
      mode: execute ? 'execute' : 'dry-run',
      writePerformed,
      before: {
        eligibleFaultCount: faults.length,
        independentFollowupCount: followups.length,
        plannedLinkCount: pairs.length,
        unmatchedFollowupCount: unmatchedFollowups.length,
        pendingFollowupCount: pendingFaults.length
      },
      plannedPairs: pairs.map(({ fault, followup }) => ({
        faultId: normalizeId(fault._id),
        followupId: normalizeId(followup._id),
        equipmentId: normalizeId(fault.equipmentId),
        faultCreatedAt: fault.createdAt,
        followupCreatedAt: followup.createdAt
      })),
      pendingFaultIds: pendingFaults.map((fault) => normalizeId(fault._id)),
      unmatchedFollowupIds: unmatchedFollowups.map((followup) => normalizeId(followup._id)),
      dataWrites: { linkedCount, linkFailureCount: linkFailures.length, linkFailures },
      messagesCreated: 0
    };
  }

  return Object.freeze({ run, planPairs });
}

module.exports = {
  MIGRATION_REPORT_FORMAT,
  createRepairFollowupBackfillService
};
