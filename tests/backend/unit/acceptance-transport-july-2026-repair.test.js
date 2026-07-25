'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const TransportMasterData = require('../../../app/models/TransportMasterData');
const {
  ALLOWED_DATABASE,
  PLACEHOLDER_FILE_IDS,
  PLACEHOLDER_RECORD_IDS,
  REAL_RECORD_IDS,
  canonicalTransportRecord,
  newestInstant,
  parseArgs,
  sameRecordTarget,
  usage
} = require('../../../app/script/repairAcceptanceTransportJuly2026');

const { TRANSPORT_MASTER_KINDS, TRANSPORT_MASTER_STATUSES } = TransportMasterData;

function master(_id, teamId, kind, name) {
  return { _id, teamId, kind, name, status: TRANSPORT_MASTER_STATUSES.ACTIVE };
}

test('transport repair is fixed to the audited acceptance targets', () => {
  assert.equal(ALLOWED_DATABASE, 'customer_acceptance_v2_test');
  assert.equal(REAL_RECORD_IDS.length, 17);
  assert.equal(new Set(REAL_RECORD_IDS).size, 17);
  assert.equal(PLACEHOLDER_RECORD_IDS.length, 6);
  assert.equal(new Set(PLACEHOLDER_RECORD_IDS).size, 6);
  assert.equal(PLACEHOLDER_FILE_IDS.length, 13);
  assert.equal(new Set(PLACEHOLDER_FILE_IDS).size, 13);
});

test('transport repair CLI is dry-run by default and requires explicit execute inputs', () => {
  assert.deepEqual(parseArgs([]), { execute: false });
  assert.deepEqual(parseArgs([
    '--execute',
    `--confirm-database=${ALLOWED_DATABASE}`,
    '--backup-directory',
    'E:\\backup',
    '--report=E:\\report.json'
  ]), {
    execute: true,
    confirmDatabase: ALLOWED_DATABASE,
    backupDirectory: 'E:\\backup',
    report: 'E:\\report.json'
  });
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--report']), /requires a value/);
  assert.match(usage(), /dry-run by default/i);
  assert.match(usage(), /verified_backup_directory/);
});

test('canonical transport mapping accepts only the fixed active team-scoped masters', () => {
  const teamId = 'team-a';
  const trip = master('trip-1', teamId, TRANSPORT_MASTER_KINDS.TRIP, '第1车');
  const plate = master('plate-1', teamId, TRANSPORT_MASTER_KINDS.VEHICLE_PLATE, '鲁AV1515');
  const targets = {
    route: master('route-1', teamId, TRANSPORT_MASTER_KINDS.ROUTE, '李福仓库-PC'),
    vehicleType: master(
      'type-1',
      teamId,
      TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
      '大厢式翼开车（9.6米）'
    ),
    houDriver: master('driver-1', teamId, TRANSPORT_MASTER_KINDS.DRIVER, '侯宪磊'),
    partyDriver: master('driver-2', teamId, TRANSPORT_MASTER_KINDS.DRIVER, '党光')
  };
  const record = {
    _id: 'record-1',
    teamId,
    tripMasterId: trip._id,
    route: 'pc_李福',
    vehiclePlateMasterId: plate._id,
    vehiclePlate: plate.name,
    vehicleType: '9.6',
    driverName: '侯磊'
  };
  const masters = new Map([[trip._id, trip], [plate._id, plate]]);
  const target = canonicalTransportRecord(record, masters, targets);

  assert.equal(target.route, '李福仓库-PC');
  assert.equal(target.vehicleType, '大厢式翼开车（9.6米）');
  assert.equal(target.driverName, '侯宪磊');
  assert.equal(sameRecordTarget({ ...record, ...target }, target), true);
  assert.throws(
    () => canonicalTransportRecord({ ...record, route: 'unexpected' }, masters, targets),
    (error) => error.code === 'TRANSPORT_ROUTE_ALIAS_UNEXPECTED'
  );
  assert.throws(
    () => canonicalTransportRecord({ ...record, tripMasterId: 'missing' }, masters, targets),
    (error) => error.code === 'TRANSPORT_TRIP_TARGET_INVALID'
  );
});

test('backup freshness is bound to the newest target write time', () => {
  const result = newestInstant({
    operations: [
      { before: { createdAt: '2026-07-24T01:00:00.000Z' } },
      { before: { updatedAt: '2026-07-24T02:00:00.000Z' } },
      { before: { submittedAt: 'invalid' } }
    ]
  });
  assert.equal(result.toISOString(), '2026-07-24T02:00:00.000Z');
});
