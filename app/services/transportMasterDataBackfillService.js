'use strict';

const path = require('node:path');
const mongoose = require('mongoose');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const AuditLog = require('../models/AuditLog');
const ProjectTeam = require('../models/ProjectTeam');
const TransportMasterData = require('../models/TransportMasterData');
const TransportRecord = require('../models/TransportRecord');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./reportingServiceSupport');
const { runWithRequiredTransaction } = require('./transactionService');

const {
  TRANSPORT_MASTER_KINDS,
  TRANSPORT_MASTER_STATUSES,
  transportMasterNormalizedKey
} = TransportMasterData;
const { TRANSPORT_LOAD_FIELDS } = TransportRecord;
const BACKFILL_REPORT_FORMAT = 'transport-master-data-backfill/v1';
const TRANSPORT_RECORD_COLLECTION = 'transportrecords';
const MASTER_REFERENCE_FIELDS = Object.freeze([
  Object.freeze({ field: 'tripMasterId', kind: TRANSPORT_MASTER_KINDS.TRIP, snapshotField: 'tripLabel' }),
  Object.freeze({ field: 'routeMasterId', kind: TRANSPORT_MASTER_KINDS.ROUTE, snapshotField: 'route' }),
  Object.freeze({
    field: 'vehiclePlateMasterId',
    kind: TRANSPORT_MASTER_KINDS.VEHICLE_PLATE,
    snapshotField: 'vehiclePlate'
  }),
  Object.freeze({
    field: 'vehicleTypeMasterId',
    kind: TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
    snapshotField: 'vehicleType'
  }),
  Object.freeze({ field: 'driverMasterId', kind: TRANSPORT_MASTER_KINDS.DRIVER, snapshotField: 'driverName' })
]);

class TransportMasterDataBackfillError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TransportMasterDataBackfillError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new TransportMasterDataBackfillError(code, message, details);
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
  const requiredDump = `database/${databaseName}/${TRANSPORT_RECORD_COLLECTION}.bson`;
  const fileNames = new Set((verified?.manifest?.files || []).map((entry) => entry?.file));
  if (!collectionNames.has(TRANSPORT_RECORD_COLLECTION) || !fileNames.has(requiredDump)) {
    fail(
      'BACKUP_TRANSPORT_RECORDS_MISSING',
      'Verified backup is missing the transportrecords collection or BSON dump',
      {
        missingCollection: !collectionNames.has(TRANSPORT_RECORD_COLLECTION),
        missingDumpFile: fileNames.has(requiredDump) ? null : requiredDump
      }
    );
  }
  return {
    backupDirectory: verified.backupDirectory || resolved,
    backupId: verified.manifest.backupId || null,
    completedAt: verified.manifest.completedAt || null,
    databaseName,
    manifestSha256: verified.manifestSha256
  };
}

function candidateKey(teamId, kind, value) {
  return `${normalizeId(teamId)}:${kind}:${transportMasterNormalizedKey(kind, value)}`;
}

function buildCandidates(records, activeTeams = []) {
  const candidates = new Map();
  for (const record of records) {
    for (const { field, kind, snapshotField } of MASTER_REFERENCE_FIELDS) {
      // Existing references are authoritative. A later master-data rename must
      // not recreate the old snapshot label or rebind historical records.
      if (normalizeId(record[field]) !== null) continue;
      const value = String(record[snapshotField] || '').trim();
      if (!value) continue;
      const key = candidateKey(record.teamId, kind, value);
      if (!candidates.has(key)) {
        candidates.set(key, {
          key,
          teamId: record.teamId,
          kind,
          normalizedKey: transportMasterNormalizedKey(kind, value),
          payload: { name: value }
        });
      }
    }
  }
  for (const team of activeTeams) {
    for (const [sortOrder, { label }] of TRANSPORT_LOAD_FIELDS.entries()) {
      const key = candidateKey(team._id, TRANSPORT_MASTER_KINDS.LOAD_TYPE, label);
      if (!candidates.has(key)) {
        candidates.set(key, {
          key,
          teamId: team._id,
          kind: TRANSPORT_MASTER_KINDS.LOAD_TYPE,
          normalizedKey: transportMasterNormalizedKey(TRANSPORT_MASTER_KINDS.LOAD_TYPE, label),
          payload: { name: label },
          sortOrder
        });
      }
    }
  }
  return { candidates: [...candidates.values()], conflicts: [] };
}

function createTransportMasterDataBackfillService({
  AuditLogModel = AuditLog,
  TransportMasterDataModel = TransportMasterData,
  TransportRecordModel = TransportRecord,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  backupVerifier = verifyBackupSet,
  now = () => new Date(),
  connection = mongoose.connection
} = {}) {
  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (execute && confirmDatabase !== databaseName) {
      fail(
        'DATABASE_CONFIRMATION_MISMATCH',
        '--confirm-database must exactly match the connected database name',
        { expected: databaseName, actual: confirmDatabase || null }
      );
    }
    const backup = execute
      ? await verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier })
      : null;
    const [records, activeTeams] = await Promise.all([
      TransportRecordModel.find({})
        .sort({ reportDate: -1, submittedAt: -1, _id: -1 })
        .lean(),
      ProjectTeamModel.find({ status: TEAM_STATUSES.ACTIVE })
        .sort({ _id: 1 })
        .select({ _id: 1 })
        .lean()
    ]);
    const activeTeamIds = activeTeams.map(({ _id }) => _id);
    const [configuredTeamIds, initializedTeamIds] = activeTeamIds.length === 0
      ? [[], []]
      : await Promise.all([
          TransportMasterDataModel.distinct('teamId', {
            teamId: { $in: activeTeamIds },
            kind: TRANSPORT_MASTER_KINDS.LOAD_TYPE
          }),
          AuditLogModel.distinct('targetTeamId', {
            targetTeamId: { $in: activeTeamIds },
            resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
            $or: [
              { 'before.kind': TRANSPORT_MASTER_KINDS.LOAD_TYPE },
              { 'after.kind': TRANSPORT_MASTER_KINDS.LOAD_TYPE },
              { 'after.defaultLoadTypesCreated': { $gt: 0 } }
            ]
          })
        ]);
    const loadTypesInitialized = new Set(
      [...configuredTeamIds, ...initializedTeamIds].map(normalizeId)
    );
    const teamsNeedingDefaultLoadTypes = activeTeams.filter(
      ({ _id }) => !loadTypesInitialized.has(normalizeId(_id))
    );
    const { candidates, conflicts } = buildCandidates(records, teamsNeedingDefaultLoadTypes);
    const existingMasters = candidates.length === 0
      ? []
      : await TransportMasterDataModel.find({
          teamId: { $in: [...new Set(candidates.map(({ teamId }) => normalizeId(teamId)))] },
          kind: { $in: Object.values(TRANSPORT_MASTER_KINDS) }
        }).lean();
    const masterByKey = new Map(existingMasters.map((master) => [
      candidateKey(
        master.teamId,
        master.kind,
        master.name
      ),
      master
    ]));
    const missingCandidates = candidates.filter((candidate) => !masterByKey.has(candidate.key));
    const previewRecordUpdates = records.filter((record) => (
      MASTER_REFERENCE_FIELDS.some(({ field, snapshotField }) => {
        if (normalizeId(record[field]) !== null) return false;
        const value = String(record[snapshotField] || '').trim();
        return Boolean(value);
      })
    )).length;

    const baseReport = {
      format: BACKFILL_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode: execute ? 'execute' : 'dry-run',
      status: execute ? 'EXECUTED' : 'DRY_RUN_READY',
      database: { name: databaseName },
      backup,
      recordsScanned: records.length,
      activeTeamsScanned: activeTeams.length,
      defaultLoadTypeTeamsToInitialize: teamsNeedingDefaultLoadTypes.length,
      candidates: candidates.length,
      existingMasters: existingMasters.length,
      mastersToCreate: missingCandidates.length,
      defaultLoadTypesToCreate: missingCandidates.filter(
        ({ kind }) => kind === TRANSPORT_MASTER_KINDS.LOAD_TYPE
      ).length,
      recordsToUpdate: previewRecordUpdates,
      conflicts
    };
    if (!execute || (missingCandidates.length === 0 && previewRecordUpdates === 0)) {
      return { ...baseReport, mastersCreated: 0, recordsUpdated: 0, writePerformed: false };
    }

    return runWithRequiredTransaction(async (session) => {
      let mastersCreated = 0;
      const teamStats = new Map();
      const statsFor = (teamId) => {
        const id = normalizeId(teamId);
        if (!teamStats.has(id)) {
          teamStats.set(id, { mastersCreated: 0, defaultLoadTypesCreated: 0, recordsUpdated: 0 });
        }
        return teamStats.get(id);
      };
      for (const candidate of missingCandidates) {
        const payload = {
          teamId: candidate.teamId,
          kind: candidate.kind,
          ...candidate.payload,
          status: TRANSPORT_MASTER_STATUSES.ACTIVE,
          sortOrder: candidate.sortOrder ?? 0,
          createdBy: null,
          updatedBy: null
        };
        const document = session
          ? (await TransportMasterDataModel.create([payload], { session }))[0]
          : await TransportMasterDataModel.create(payload);
        masterByKey.set(candidate.key, document);
        mastersCreated += 1;
        const stats = statsFor(candidate.teamId);
        stats.mastersCreated += 1;
        if (candidate.kind === TRANSPORT_MASTER_KINDS.LOAD_TYPE) {
          stats.defaultLoadTypesCreated += 1;
        }
      }

      let recordsUpdated = 0;
      for (const record of records) {
        const refs = {};
        for (const { field, kind, snapshotField } of MASTER_REFERENCE_FIELDS) {
          if (normalizeId(record[field]) !== null) continue;
          const value = String(record[snapshotField] || '').trim();
          if (!value) continue;
          const master = masterByKey.get(candidateKey(record.teamId, kind, value));
          if (!master) {
            fail(
              'TRANSPORT_MASTER_BACKFILL_TARGET_MISSING',
              'A transport master-data target disappeared during backfill',
              { recordId: normalizeId(record._id), field }
            );
          }
          refs[field] = master._id;
        }
        if (Object.keys(refs).length === 0) continue;
        const query = TransportRecordModel.updateOne({ _id: record._id }, { $set: refs });
        if (session) query.session(session);
        await query;
        recordsUpdated += 1;
        statsFor(record.teamId).recordsUpdated += 1;
      }

      for (const [teamId, stats] of teamStats) {
        await auditService.recordSystem({
          action: AUDIT_ACTIONS.IMPORT,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
          after: {
            source: 'transport-master-data-backfill',
            mastersCreated: stats.mastersCreated,
            defaultLoadTypesCreated: stats.defaultLoadTypesCreated,
            updatedRecordCount: stats.recordsUpdated,
            snapshotFieldsChanged: false
          },
          targetTeamId: teamId,
          session
        });
      }
      return {
        ...baseReport,
        mastersCreated,
        recordsUpdated,
        writePerformed: mastersCreated > 0 || recordsUpdated > 0
      };
    }, connection, {
      code: 'TRANSPORT_MASTER_BACKFILL_TRANSACTIONS_REQUIRED',
      message: 'Transport master-data backfill requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({ run });
}

module.exports = {
  BACKFILL_REPORT_FORMAT,
  MASTER_REFERENCE_FIELDS,
  TRANSPORT_RECORD_COLLECTION,
  TransportMasterDataBackfillError,
  buildCandidates,
  createTransportMasterDataBackfillService,
  verifyExecutionBackup
};
