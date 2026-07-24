'use strict';

const fs = require('node:fs');

const FIELD_SPECS = Object.freeze([
  Object.freeze({ referenceField: 'tripMasterId', kind: 'TRIP', snapshotField: 'tripLabel' }),
  Object.freeze({ referenceField: 'routeMasterId', kind: 'ROUTE', snapshotField: 'route' }),
  Object.freeze({
    referenceField: 'vehiclePlateMasterId',
    kind: 'VEHICLE_PLATE',
    snapshotField: 'vehiclePlate'
  }),
  Object.freeze({
    referenceField: 'vehicleTypeMasterId',
    kind: 'VEHICLE_TYPE',
    snapshotField: 'vehicleType'
  }),
  Object.freeze({ referenceField: 'driverMasterId', kind: 'DRIVER', snapshotField: 'driverName' })
]);

function normalizedId(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function addMismatch(mismatches, code, details) {
  mismatches.push({ code, ...details });
}

function validateTransportReleaseState({ records = [], masters = [], baseline } = {}) {
  if (!baseline || baseline.format !== 'task-distribution-v2-transport-reference-baseline/v1') {
    throw new Error('Transport reference baseline format is invalid');
  }
  const masterById = new Map(masters.map((master) => [normalizedId(master.id), master]));
  const recordById = new Map(records.map((record) => [normalizedId(record.id), record]));
  const mismatches = [];

  for (const record of records) {
    const recordId = normalizedId(record.id);
    const teamId = normalizedId(record.teamId);
    for (const spec of FIELD_SPECS) {
      const snapshot = String(record[spec.snapshotField] || '').trim();
      const referenceId = normalizedId(record[spec.referenceField]);
      if (!snapshot) {
        if (referenceId !== null) {
          addMismatch(mismatches, 'REFERENCE_PRESENT_FOR_EMPTY_SNAPSHOT', {
            recordId,
            field: spec.referenceField,
            referenceId
          });
        }
        continue;
      }
      if (referenceId === null) {
        addMismatch(mismatches, 'REFERENCE_MISSING', { recordId, field: spec.referenceField });
        continue;
      }
      const master = masterById.get(referenceId);
      if (!master) {
        addMismatch(mismatches, 'MASTER_MISSING', { recordId, field: spec.referenceField, referenceId });
        continue;
      }
      if (normalizedId(master.teamId) !== teamId) {
        addMismatch(mismatches, 'MASTER_TEAM_MISMATCH', {
          recordId,
          field: spec.referenceField,
          referenceId
        });
      }
      if (master.kind !== spec.kind) {
        addMismatch(mismatches, 'MASTER_KIND_MISMATCH', {
          recordId,
          field: spec.referenceField,
          referenceId,
          expectedKind: spec.kind,
          actualKind: master.kind || null
        });
      }
    }
  }

  for (const binding of baseline.bindings || []) {
    const recordId = normalizedId(binding.recordId);
    const record = recordById.get(recordId);
    if (!record) {
      addMismatch(mismatches, 'BASELINE_RECORD_MISSING', { recordId, field: binding.field });
      continue;
    }
    const currentReferenceId = normalizedId(record[binding.field]);
    const expectedReferenceId = normalizedId(binding.referenceId);
    if (currentReferenceId !== expectedReferenceId) {
      addMismatch(mismatches, 'EXISTING_REFERENCE_CHANGED', {
        recordId,
        field: binding.field,
        expectedReferenceId,
        currentReferenceId
      });
    }
  }

  if (baseline.fullyBound === true) {
    const expectedMasterIds = new Set((baseline.masterIds || []).map(normalizedId));
    const currentMasterIds = new Set(masters.map(({ id }) => normalizedId(id)));
    const added = [...currentMasterIds].filter((id) => !expectedMasterIds.has(id)).sort();
    const removed = [...expectedMasterIds].filter((id) => !currentMasterIds.has(id)).sort();
    if (added.length || removed.length) {
      addMismatch(mismatches, 'MASTER_SET_CHANGED_FOR_FULLY_BOUND_BASELINE', { added, removed });
    }
  }

  return Object.freeze({
    status: mismatches.length ? 'TRANSPORT_REFERENCE_INVARIANTS_FAILED' : 'TRANSPORT_REFERENCE_INVARIANTS_OK',
    records: records.length,
    masters: masters.length,
    preservedBindings: (baseline.bindings || []).length,
    baselineFullyBound: baseline.fullyBound === true,
    nameComparisonsPerformed: false,
    mismatchCount: mismatches.length,
    mismatches
  });
}

function parseArgs(argv) {
  let baselineFile = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--baseline' || !argv[index + 1]) throw new Error('Usage: --baseline <absolute.json>');
    baselineFile = argv[++index];
  }
  if (!baselineFile) throw new Error('--baseline is required');
  return { baselineFile };
}

function main(argv = process.argv.slice(2)) {
  const { baselineFile } = parseArgs(argv);
  const state = JSON.parse(fs.readFileSync(0, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const result = validateTransportReleaseState({ ...state, baseline });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.mismatchCount) process.exitCode = 2;
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FIELD_SPECS, normalizedId, validateTransportReleaseState };
