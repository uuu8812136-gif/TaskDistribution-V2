#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const { databaseNameFromUri } = require('../config/environment');
const { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES } = require('../config/permissions');
const FileAsset = require('../models/FileAsset');
const ProjectTeam = require('../models/ProjectTeam');
const TransportMasterData = require('../models/TransportMasterData');
const TransportRecord = require('../models/TransportRecord');
const User = require('../models/User');
const { createAuditService } = require('../services/auditService');
const {
  verifyExecutionBackup
} = require('../services/acceptanceJuly2026DataRepairService');
const { runWithRequiredTransaction } = require('../services/transactionService');

dotenv.config({ path: process.env.ENV_FILE || path.resolve(__dirname, '../.env') });

const REPORT_FORMAT = 'task-distribution-v2-acceptance-transport-july-2026-repair/v1';
const ALLOWED_DATABASE = 'customer_acceptance_v2_test';
const REASON = 'Normalize customer-tested transport aliases and remove explicitly tagged acceptance placeholders';
const IMPORT_TAG = '[customer-real-test-data-2026-07-17-v1]';
const REAL_RECORD_IDS = Object.freeze([
  '6a61e2d780c79af624ead247',
  '6a61e74ae4e630b273b91404',
  '6a62b811e4e630b273ccea96',
  '6a62bcb6e4e630b273cd5632',
  '6a62c7f4e4e630b273ce6af5',
  '6a62c8b7e4e630b273ce7c70',
  '6a62cdcde4e630b273cef827',
  '6a62d77ce4e630b273cfdb3d',
  '6a62f36de4e630b273d277ad',
  '6a6300c4e4e630b273d3b3b2',
  '6a6301cbe4e630b273d3d093',
  '6a6302d8e4e630b273d3ed45',
  '6a63054ce4e630b273d4269f',
  '6a6318cd6287d4d83e811ea0',
  '6a631d836287d4d83e81909f',
  '6a631ee66287d4d83e81c97d',
  '6a6321566287d4d83e820294'
]);
const PLACEHOLDER_RECORD_IDS = Object.freeze([
  '006a2553f00ca735e67374ef',
  '441a98345f88a87712abf6c4',
  '62cc97a8af6775102319e72e',
  'cc958c6114366d1a235b62ef',
  '0578286b4411fc4c8656be6e',
  'be5fbeb4683dc95d2458f824'
]);
const PLACEHOLDER_FILE_IDS = Object.freeze([
  '08923da6a8f89ba17e8b42a0',
  '0f8326bb28d960ae261a21d1',
  '188a207be9616abc4b10e02a',
  '2fe172976497e3d3e83045aa',
  '318d6ae78df6b2213c675a6d',
  '3311a5d937761682577ba825',
  '40af0748c59c8749793a3bb1',
  '594c434a0ac3e8758416a5a3',
  '6029b09ba124f1d4ca06c96a',
  '7463cec778c88150fad2e413',
  '99954eb3802c0001e2f1ae8f',
  'a48eaca33d3421b164111fbf',
  'c99c441793e70c9327da9130'
]);
const ALLOWED_ROUTE_ALIASES = new Set([
  '1212',
  'pc-李福',
  'pc_李福',
  '李福仓库_PC',
  '李福仓库-PC'
]);
const ALLOWED_VEHICLE_TYPE_ALIASES = new Set([
  '9.6',
  '9米6',
  '9.6米',
  '9.6货车',
  '9.6米厢式货车',
  '大厢式翼开车（9.6米）'
]);
const ALLOWED_DRIVER_ALIASES = new Set(['侯磊', '侯宪磊', '党光']);
const VALUE_OPTIONS = new Set(['confirm-database', 'backup-directory', 'report']);
const FLAG_OPTIONS = new Set(['execute', 'dry-run', 'help']);

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function id(value) {
  return value ? String(value) : null;
}

function plain(value) {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value));
}

function sameId(left, right) {
  return id(left) === id(right);
}

function sameRecordTarget(record, target) {
  return [
    'tripMasterId',
    'tripLabel',
    'routeMasterId',
    'route',
    'vehiclePlateMasterId',
    'vehiclePlate',
    'vehicleTypeMasterId',
    'vehicleType',
    'driverMasterId',
    'driverName'
  ].every((field) => field.endsWith('MasterId')
    ? sameId(record[field], target[field])
    : record[field] === target[field]);
}

function canonicalTransportRecord(record, mastersById, targets) {
  const trip = mastersById.get(id(record.tripMasterId));
  if (
    !trip ||
    trip.kind !== TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP ||
    trip.status !== TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE ||
    !sameId(trip.teamId, record.teamId) ||
    !/^第(?:[1-9]|1[0-5])车$/.test(trip.name)
  ) {
    fail('TRANSPORT_TRIP_TARGET_INVALID', 'A fixed transport record does not reference an active canonical trip', {
      recordId: id(record._id)
    });
  }
  if (!ALLOWED_ROUTE_ALIASES.has(record.route)) {
    fail('TRANSPORT_ROUTE_ALIAS_UNEXPECTED', 'A fixed transport record has an unexpected route alias', {
      recordId: id(record._id),
      route: record.route
    });
  }
  if (!ALLOWED_VEHICLE_TYPE_ALIASES.has(record.vehicleType)) {
    fail('TRANSPORT_VEHICLE_TYPE_ALIAS_UNEXPECTED', 'A fixed transport record has an unexpected vehicle-type alias', {
      recordId: id(record._id),
      vehicleType: record.vehicleType
    });
  }
  if (!ALLOWED_DRIVER_ALIASES.has(record.driverName)) {
    fail('TRANSPORT_DRIVER_ALIAS_UNEXPECTED', 'A fixed transport record has an unexpected driver alias', {
      recordId: id(record._id),
      driverName: record.driverName
    });
  }
  const plate = mastersById.get(id(record.vehiclePlateMasterId));
  if (
    !plate ||
    plate.kind !== TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE ||
    plate.status !== TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE ||
    !sameId(plate.teamId, record.teamId) ||
    plate.name !== record.vehiclePlate
  ) {
    fail('TRANSPORT_PLATE_TARGET_INVALID', 'A fixed transport record does not reference its active vehicle plate', {
      recordId: id(record._id)
    });
  }
  const driver = record.driverName === '党光' ? targets.partyDriver : targets.houDriver;
  return {
    tripMasterId: trip._id,
    tripLabel: trip.name,
    routeMasterId: targets.route._id,
    route: targets.route.name,
    vehiclePlateMasterId: plate._id,
    vehiclePlate: plate.name,
    vehicleTypeMasterId: targets.vehicleType._id,
    vehicleType: targets.vehicleType.name,
    driverMasterId: driver._id,
    driverName: driver.name
  };
}

function parseArgs(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(rawName)) {
      if (inlineValue !== undefined) throw new Error(`--${rawName} does not accept a value`);
      if (rawName === 'execute') result.execute = true;
      if (rawName === 'dry-run') result.execute = false;
      if (rawName === 'help') result.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(rawName)) throw new Error(`Unknown option: --${rawName}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error(`--${rawName} requires a value`);
    result[rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  });
  try {
    await fs.promises.link(temporary, resolved);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  return resolved;
}

async function liveCollectionInventory(connection) {
  const collections = await connection.db.listCollections({}, { nameOnly: true }).toArray();
  const result = [];
  for (const { name } of collections.filter(({ name }) => !name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name))) {
    result.push({ name, documentCount: await connection.db.collection(name).countDocuments({}) });
  }
  return result;
}

function queryWithSession(query, session) {
  return session ? query.session(session) : query;
}

async function analyze({ session = null } = {}) {
  const team = await queryWithSession(ProjectTeam.findOne({ code: 'GEARBOX_LOGISTICS' }).lean(), session);
  if (!team) fail('TRANSPORT_TEAM_MISSING', 'The gearbox logistics team does not exist');
  const systemUser = await queryWithSession(User.findOne({
    isSystemAccount: true,
    isSuperAdmin: true,
    status: 'active'
  }).lean(), session);
  if (!systemUser) fail('SYSTEM_AUDIT_USER_MISSING', 'The active system audit user does not exist');

  const [masters, realRecords, placeholderRecords, placeholderFiles] = await Promise.all([
    queryWithSession(TransportMasterData.find({ teamId: team._id }).lean(), session),
    queryWithSession(TransportRecord.find({ _id: { $in: REAL_RECORD_IDS } }).sort({ _id: 1 }).lean(), session),
    queryWithSession(TransportRecord.find({ _id: { $in: PLACEHOLDER_RECORD_IDS } }).sort({ _id: 1 }).lean(), session),
    queryWithSession(FileAsset.find({ _id: { $in: PLACEHOLDER_FILE_IDS } }).sort({ _id: 1 }).lean(), session)
  ]);
  const mastersById = new Map(masters.map((master) => [id(master._id), master]));
  const activeTarget = (kind, name) => masters.find((master) => (
    master.kind === kind &&
    master.name === name &&
    master.status === TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE
  ));
  const targets = {
    route: activeTarget(TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE, '李福仓库-PC'),
    vehicleType: activeTarget(
      TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
      '大厢式翼开车（9.6米）'
    ),
    houDriver: activeTarget(TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER, '侯宪磊'),
    partyDriver: activeTarget(TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER, '党光')
  };
  const blockers = [];
  for (const [targetName, value] of Object.entries(targets)) {
    if (!value) blockers.push({ code: 'CANONICAL_MASTER_MISSING', targetName });
  }
  const realById = new Map(realRecords.map((record) => [id(record._id), record]));
  for (const recordId of REAL_RECORD_IDS) {
    if (!realById.has(recordId)) blockers.push({ code: 'FIXED_TRANSPORT_RECORD_MISSING', recordId });
  }
  const placeholderById = new Map(placeholderRecords.map((record) => [id(record._id), record]));
  const fileById = new Map(placeholderFiles.map((file) => [id(file._id), file]));
  const operations = [];

  if (blockers.length === 0) {
    for (const recordId of REAL_RECORD_IDS) {
      const record = realById.get(recordId);
      if (!sameId(record.teamId, team._id) || !['2026-07-23', '2026-07-24'].includes(record.reportDate)) {
        blockers.push({ code: 'FIXED_TRANSPORT_SCOPE_CHANGED', recordId });
        continue;
      }
      try {
        const target = canonicalTransportRecord(record, mastersById, targets);
        if (!sameRecordTarget(record, target)) {
          operations.push({
            type: 'CORRECT_TRANSPORT_RECORD',
            recordId,
            before: plain(record),
            target: plain(target)
          });
        }
      } catch (error) {
        blockers.push({ code: error.code || 'FIXED_TRANSPORT_RECORD_INVALID', recordId, details: error.details });
      }
    }
  }

  for (const recordId of PLACEHOLDER_RECORD_IDS) {
    const record = placeholderById.get(recordId);
    if (!record) continue;
    if (
      !sameId(record.teamId, team._id) ||
      record.driverName !== '待客户确认' ||
      record.route !== '待客户确认（测试占位）' ||
      !String(record.remark || '').startsWith(IMPORT_TAG)
    ) {
      blockers.push({ code: 'PLACEHOLDER_RECORD_CHANGED', recordId });
      continue;
    }
    operations.push({ type: 'DELETE_PLACEHOLDER_RECORD', recordId, before: plain(record) });
  }

  for (const fileId of PLACEHOLDER_FILE_IDS) {
    const file = fileById.get(fileId);
    if (!file) {
      blockers.push({ code: 'PLACEHOLDER_FILE_MISSING', fileId });
      continue;
    }
    if (
      file.ownerType !== FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT ||
      !PLACEHOLDER_RECORD_IDS.includes(id(file.ownerId))
    ) {
      blockers.push({ code: 'PLACEHOLDER_FILE_OWNER_CHANGED', fileId });
      continue;
    }
    if (file.status === FileAsset.FILE_STATUSES.ACTIVE) {
      operations.push({ type: 'DELETE_PLACEHOLDER_FILE', fileId, before: plain(file) });
    } else if (file.status !== FileAsset.FILE_STATUSES.DELETED) {
      blockers.push({ code: 'PLACEHOLDER_FILE_STATUS_CHANGED', fileId, status: file.status });
    }
  }

  const state = blockers.length > 0 ? 'BLOCKED' : operations.length > 0 ? 'READY' : 'ALREADY_APPLIED';
  return {
    state,
    team,
    systemUser,
    operations,
    blockers,
    counts: {
      fixedRecordsExpected: REAL_RECORD_IDS.length,
      fixedRecordsFound: realRecords.length,
      placeholdersRemaining: placeholderRecords.length,
      placeholderFilesFound: placeholderFiles.length,
      transportCorrections: operations.filter(({ type }) => type === 'CORRECT_TRANSPORT_RECORD').length,
      placeholderRecordDeletes: operations.filter(({ type }) => type === 'DELETE_PLACEHOLDER_RECORD').length,
      placeholderFileDeletes: operations.filter(({ type }) => type === 'DELETE_PLACEHOLDER_FILE').length
    }
  };
}

function publicAnalysis(value) {
  return {
    state: value.state,
    counts: value.counts,
    blockers: value.blockers,
    mappings: value.operations.map((operation) => ({
      type: operation.type,
      resourceId: operation.recordId || operation.fileId,
      before: operation.type === 'CORRECT_TRANSPORT_RECORD' ? {
        tripLabel: operation.before.tripLabel,
        route: operation.before.route,
        vehiclePlate: operation.before.vehiclePlate,
        vehicleType: operation.before.vehicleType,
        driverName: operation.before.driverName
      } : null,
      after: operation.target || null
    }))
  };
}

function newestInstant(analysis) {
  const values = analysis.operations.flatMap((operation) => [
    operation.before?.updatedAt,
    operation.before?.createdAt,
    operation.before?.submittedAt
  ]).map((value) => new Date(value || Number.NaN)).filter((value) => Number.isFinite(value.getTime()));
  return values.length ? new Date(Math.max(...values.map((value) => value.getTime()))) : null;
}

async function executeRepair({
  analysis,
  backupDirectory,
  databaseName,
  backupVerifier = verifyBackupSet,
  connection = mongoose.connection,
  auditService = createAuditService(),
  transactionRunner = runWithRequiredTransaction
}) {
  const backup = await verifyExecutionBackup({
    backupDirectory,
    databaseName,
    backupVerifier,
    liveCollections: await liveCollectionInventory(connection),
    minimumCompletedAt: newestInstant(analysis)
  });
  return transactionRunner(async (session) => {
    const before = await analyze({ session });
    if (before.state !== 'READY' || before.operations.length !== 36) {
      fail('TRANSPORT_REPAIR_STATE_CHANGED', 'Transport repair targets changed after backup verification', {
        backup,
        before: publicAnalysis(before)
      });
    }
    const occurredAt = new Date();
    let dataWrites = 0;
    let auditLogsCreated = 0;
    for (const operation of before.operations) {
      if (operation.type === 'CORRECT_TRANSPORT_RECORD') {
        const result = await TransportRecord.updateOne({
          _id: operation.before._id,
          teamId: before.team._id,
          __v: operation.before.__v ?? 0
        }, {
          $set: { ...operation.target, updatedAt: occurredAt },
          $inc: { __v: 1 }
        }, { session, runValidators: true });
        if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
          fail('TRANSPORT_RECORD_CHANGED', 'A fixed transport record changed during repair', {
            recordId: operation.recordId
          });
        }
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.CORRECT,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: operation.before._id,
          before: operation.before,
          after: { ...operation.before, ...operation.target, updatedAt: occurredAt },
          reason: REASON,
          targetTeamId: before.team._id,
          session
        });
      } else if (operation.type === 'DELETE_PLACEHOLDER_RECORD') {
        const result = await TransportRecord.deleteOne({
          _id: operation.before._id,
          teamId: before.team._id,
          __v: operation.before.__v ?? 0,
          driverName: '待客户确认',
          route: '待客户确认（测试占位）'
        }, { session });
        if (result.deletedCount !== 1) {
          fail('PLACEHOLDER_RECORD_CHANGED', 'A tagged placeholder record changed during repair', {
            recordId: operation.recordId
          });
        }
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_RECORD,
          resourceId: operation.before._id,
          before: operation.before,
          after: { deleted: true, importTag: IMPORT_TAG },
          reason: REASON,
          targetTeamId: before.team._id,
          session
        });
      } else if (operation.type === 'DELETE_PLACEHOLDER_FILE') {
        const result = await FileAsset.updateOne({
          _id: operation.before._id,
          teamId: before.team._id,
          ownerType: FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT,
          ownerId: operation.before.ownerId,
          status: FileAsset.FILE_STATUSES.ACTIVE,
          __v: operation.before.__v ?? 0
        }, {
          $set: {
            status: FileAsset.FILE_STATUSES.DELETED,
            deletedAt: occurredAt,
            deletedBy: before.systemUser._id,
            updatedAt: occurredAt
          },
          $inc: { __v: 1 }
        }, { session, runValidators: true });
        if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
          fail('PLACEHOLDER_FILE_CHANGED', 'A tagged placeholder file changed during repair', {
            fileId: operation.fileId
          });
        }
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.FILE_DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
          resourceId: operation.before._id,
          before: operation.before,
          after: {
            ...operation.before,
            status: FileAsset.FILE_STATUSES.DELETED,
            deletedAt: occurredAt,
            deletedBy: before.systemUser._id,
            updatedAt: occurredAt
          },
          reason: REASON,
          targetTeamId: before.team._id,
          session
        });
      }
      dataWrites += 1;
      auditLogsCreated += 1;
    }
    const after = await analyze({ session });
    if (after.state !== 'ALREADY_APPLIED' || after.operations.length !== 0 || after.blockers.length !== 0) {
      fail('TRANSPORT_REPAIR_POSTCONDITION_FAILED', 'Transport repair did not reach its exact target state', {
        backup,
        after: publicAnalysis(after)
      });
    }
    return { backup, before, after, dataWrites, auditLogsCreated };
  }, connection, {
    code: 'TRANSPORT_REPAIR_TRANSACTIONS_REQUIRED',
    message: 'Acceptance transport repair requires MongoDB replica-set transaction support'
  });
}

function usage() {
  return [
    'Repair the fixed July 2026 acceptance transport aliases (dry-run by default).',
    '',
    'Preview:',
    '  node script/repairAcceptanceTransportJuly2026.js --report <report.json>',
    '',
    'Execute:',
    '  node script/repairAcceptanceTransportJuly2026.js --execute \\',
    `    --confirm-database ${ALLOWED_DATABASE} \\`,
    '    --backup-directory <verified_backup_directory> \\',
    '    --report <report.json>'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (!args.report) throw new Error('--report is required');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const databaseName = databaseNameFromUri(process.env.MONGODB_URI);
  let connected = false;
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
    connected = true;
    const before = await analyze();
    const base = {
      format: REPORT_FORMAT,
      generatedAt: new Date().toISOString(),
      mode: args.execute ? 'execute' : 'dry-run',
      database: { name: databaseName },
      before: publicAnalysis(before),
      backup: null,
      writePerformed: false,
      dataWrites: 0,
      auditLogsCreated: 0,
      after: null
    };
    let report;
    if (!args.execute) {
      report = {
        ...base,
        status: before.state === 'BLOCKED'
          ? 'DRY_RUN_BLOCKED'
          : before.state === 'READY'
            ? 'DRY_RUN_READY'
            : 'DRY_RUN_NO_CHANGES'
      };
    } else {
      if (args.confirmDatabase !== databaseName) {
        fail('DATABASE_CONFIRMATION_MISMATCH', '--confirm-database must exactly match the connected database');
      }
      if (databaseName !== ALLOWED_DATABASE) {
        fail('EXECUTION_DATABASE_FORBIDDEN', 'Execution is restricted to the isolated acceptance database');
      }
      if (before.state === 'BLOCKED') {
        report = { ...base, status: 'BLOCKED' };
      } else if (before.state === 'ALREADY_APPLIED') {
        report = { ...base, status: 'NO_CHANGES', after: publicAnalysis(before) };
      } else {
        const executed = await executeRepair({
          analysis: before,
          backupDirectory: args.backupDirectory,
          databaseName
        });
        report = {
          ...base,
          generatedAt: new Date().toISOString(),
          status: 'EXECUTED',
          backup: executed.backup,
          before: publicAnalysis(executed.before),
          writePerformed: true,
          dataWrites: executed.dataWrites,
          auditLogsCreated: executed.auditLogsCreated,
          after: publicAnalysis(executed.after)
        };
      }
    }
    const reportPath = await writeJsonAtomic(args.report, report);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      writePerformed: report.writePerformed,
      dataWrites: report.dataWrites,
      auditLogsCreated: report.auditLogsCreated,
      reportPath
    })}\n`);
    return report;
  } finally {
    if (connected) await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    const args = (() => { try { return parseArgs(process.argv.slice(2)); } catch { return {}; } })();
    const failure = {
      format: REPORT_FORMAT,
      generatedAt: new Date().toISOString(),
      status: 'FAILED',
      mode: args.execute ? 'execute' : 'dry-run',
      database: { name: process.env.MONGODB_URI ? databaseNameFromUri(process.env.MONGODB_URI) : null },
      writePerformed: false,
      error: { code: error.code || 'TRANSPORT_REPAIR_FAILED', message: error.message, details: error.details || null }
    };
    if (args.report) await writeJsonAtomic(args.report, failure).catch(() => null);
    process.stderr.write(`${JSON.stringify(failure.error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_DATABASE,
  PLACEHOLDER_FILE_IDS,
  PLACEHOLDER_RECORD_IDS,
  REAL_RECORD_IDS,
  REPORT_FORMAT,
  analyze,
  canonicalTransportRecord,
  executeRepair,
  newestInstant,
  parseArgs,
  publicAnalysis,
  sameRecordTarget,
  usage
};
