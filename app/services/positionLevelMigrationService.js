'use strict';

const path = require('node:path');
const { verifyBackupSet } = require('../../ops/lib/backupCore');
const { POSITION_KEYS } = require('../config/permissions');
const { runWithRequiredTransaction } = require('./transactionService');

const MIGRATION_REPORT_FORMAT = 'team-membership-position-level-migration/v1';
const TEAM_MEMBERSHIP_COLLECTION = 'teammemberships';
const REQUIRED_BACKUP_COLLECTIONS = Object.freeze([TEAM_MEMBERSHIP_COLLECTION]);
const POSITION_LEVEL_MIGRATIONS = Object.freeze([
  Object.freeze({ positionKey: POSITION_KEYS.TEAM_LEADER, from: 4, to: 5 }),
  Object.freeze({ positionKey: POSITION_KEYS.EMPLOYEE, from: 5, to: 6 })
]);

class PositionLevelMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PositionLevelMigrationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new PositionLevelMigrationError(code, message, details);
}

function databaseNameOf(connection) {
  return connection?.name || connection?.db?.databaseName || null;
}

async function analyzePositionLevelMigrationState(db, session = null) {
  const collection = db.collection(TEAM_MEMBERSHIP_COLLECTION);
  const positionKeys = POSITION_LEVEL_MIGRATIONS.map(({ positionKey }) => positionKey);
  const memberships = await collection.find({
    positionKey: { $in: positionKeys }
  }, {
    ...(session ? { session } : {}),
    projection: {
      teamId: 1,
      userId: 1,
      orgUnitId: 1,
      positionKey: 1,
      positionLevel: 1,
      status: 1,
      updatedAt: 1,
      __v: 1
    }
  }).sort({ _id: 1 }).toArray();
  const ruleByPosition = new Map(
    POSITION_LEVEL_MIGRATIONS.map((rule) => [rule.positionKey, rule])
  );
  const updates = [];
  const blockers = [];
  const counts = Object.fromEntries(POSITION_LEVEL_MIGRATIONS.map((rule) => [rule.positionKey, {
    legacy: 0,
    target: 0,
    invalid: 0
  }]));

  for (const membership of memberships) {
    const rule = ruleByPosition.get(membership.positionKey);
    if (membership.positionLevel === rule.from) {
      counts[rule.positionKey].legacy += 1;
      updates.push({
        _id: membership._id,
        positionKey: membership.positionKey,
        from: rule.from,
        to: rule.to,
        version: membership.__v ?? 0
      });
      continue;
    }
    if (membership.positionLevel === rule.to) {
      counts[rule.positionKey].target += 1;
      continue;
    }
    counts[rule.positionKey].invalid += 1;
    blockers.push({
      code: 'POSITION_LEVEL_UNEXPECTED',
      message: 'TeamMembership positionLevel is neither the legacy nor target fixed value',
      details: {
        membershipId: String(membership._id),
        positionKey: membership.positionKey,
        positionLevel: membership.positionLevel,
        expectedLegacy: rule.from,
        expectedTarget: rule.to
      }
    });
  }

  return { memberships, updates, blockers, counts };
}

function reportAnalysis(analysis) {
  return {
    scannedCount: analysis.memberships.length,
    plannedUpdateCount: analysis.updates.length,
    counts: analysis.counts,
    blockers: analysis.blockers
  };
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
  const fileNames = new Set((verified?.manifest?.files || []).map((entry) => entry?.file));
  const missingCollections = REQUIRED_BACKUP_COLLECTIONS.filter((name) => !collectionNames.has(name));
  const missingDumpFiles = REQUIRED_BACKUP_COLLECTIONS
    .map((name) => `database/${databaseName}/${name}.bson`)
    .filter((name) => !fileNames.has(name));
  if (missingCollections.length || missingDumpFiles.length) {
    fail('BACKUP_REQUIRED_COLLECTIONS_MISSING', 'Verified backup is missing TeamMembership dump evidence', {
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

function createPositionLevelMigrationService({
  connection,
  backupVerifier = verifyBackupSet,
  transactionRunner = runWithRequiredTransaction,
  now = () => new Date()
} = {}) {
  if (!connection?.db) throw new TypeError('A connected Mongoose connection is required');

  async function run({ execute = false, confirmDatabase, backupDirectory } = {}) {
    const databaseName = databaseNameOf(connection);
    if (!databaseName) fail('DATABASE_NAME_MISSING', 'The connected database name is unavailable');
    if (execute && confirmDatabase !== databaseName) {
      fail('DATABASE_CONFIRMATION_MISMATCH', '--confirm-database must exactly match the connected database name', {
        expected: databaseName,
        actual: confirmDatabase || null
      });
    }
    const backup = execute
      ? await verifyExecutionBackup({ backupDirectory, databaseName, backupVerifier })
      : null;
    const reportBase = (before, mode = execute ? 'execute' : 'dry-run') => ({
      format: MIGRATION_REPORT_FORMAT,
      generatedAt: now().toISOString(),
      mode,
      database: { name: databaseName },
      backup,
      before: reportAnalysis(before),
      writePerformed: false
    });
    if (!execute) {
      const before = await analyzePositionLevelMigrationState(connection.db);
      const baseReport = reportBase(before, 'dry-run');
      return before.blockers.length
        ? { ...baseReport, status: 'DRY_RUN_BLOCKED', after: null }
        : { ...baseReport, status: 'DRY_RUN_READY', after: null };
    }

    return transactionRunner(async (session) => {
      const before = await analyzePositionLevelMigrationState(connection.db, session);
      const baseReport = reportBase(before, 'execute');
      if (before.blockers.length) {
        return { ...baseReport, status: 'BLOCKED', after: null };
      }

      const collection = connection.db.collection(TEAM_MEMBERSHIP_COLLECTION);
      let result = { matchedCount: 0, modifiedCount: 0 };
      if (before.updates.length) {
        result = await collection.bulkWrite(before.updates.map((update) => ({
          updateOne: {
            filter: {
              _id: update._id,
              positionKey: update.positionKey,
              positionLevel: update.from,
              __v: update.version
            },
            update: {
              $set: { positionLevel: update.to, updatedAt: now() },
              $inc: { __v: 1 }
            }
          }
        })), { ordered: true, session });
        if (result.matchedCount !== before.updates.length) {
          fail('MEMBERSHIP_CHANGED_DURING_MIGRATION', 'A membership changed after preflight', {
            expected: before.updates.length,
            matched: result.matchedCount,
            backup,
            before: reportAnalysis(before),
            transactionRolledBack: true,
            writePerformed: false
          });
        }
      }
      const after = await analyzePositionLevelMigrationState(connection.db, session);
      if (after.updates.length || after.blockers.length) {
        fail('POSITION_LEVEL_MIGRATION_INCOMPLETE', 'Position-level migration did not reach the target state', {
          backup,
          before: reportAnalysis(before),
          after: reportAnalysis(after),
          transactionRolledBack: true,
          writePerformed: false
        });
      }
      return {
        ...baseReport,
        status: 'EXECUTED',
        writePerformed: result.modifiedCount > 0,
        result: { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount },
        after: reportAnalysis(after)
      };
    }, connection, {
      code: 'POSITION_LEVEL_MIGRATION_TRANSACTIONS_REQUIRED',
      message: 'Position-level migration requires MongoDB replica-set transaction support'
    });
  }

  return Object.freeze({
    analyze: () => analyzePositionLevelMigrationState(connection.db),
    run
  });
}

module.exports = {
  MIGRATION_REPORT_FORMAT,
  POSITION_LEVEL_MIGRATIONS,
  PositionLevelMigrationError,
  REQUIRED_BACKUP_COLLECTIONS,
  TEAM_MEMBERSHIP_COLLECTION,
  analyzePositionLevelMigrationState,
  createPositionLevelMigrationService,
  reportAnalysis,
  verifyExecutionBackup
};
