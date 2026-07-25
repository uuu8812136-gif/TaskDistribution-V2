'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const AuditLog = require('../../../app/models/AuditLog');
const FileAsset = require('../../../app/models/FileAsset');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TransportMasterData = require('../../../app/models/TransportMasterData');
const TransportRecord = require('../../../app/models/TransportRecord');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  PLACEHOLDER_FILE_IDS,
  PLACEHOLDER_RECORD_IDS,
  REAL_RECORD_IDS,
  analyze,
  executeRepair
} = require('../../../app/script/repairAcceptanceTransportJuly2026');

const DATABASE_NAME = 'acceptance_transport_july_2026_repair_v2_test';
const REQUIRED_EMPTY_COLLECTIONS = [
  'attendancedailyreviews',
  'attendancesubmissions',
  'authsessions',
  'generateddailyreports',
  'productionschedules'
];
let replicaSet;

function oid(value) {
  return value ? new mongoose.Types.ObjectId(value) : new mongoose.Types.ObjectId();
}

async function createCollections() {
  for (const Model of [AuditLog, FileAsset, ProjectTeam, TransportMasterData, TransportRecord, User]) {
    await Model.createCollection();
  }
  for (const name of REQUIRED_EMPTY_COLLECTIONS) {
    await mongoose.connection.db.createCollection(name);
  }
}

async function seed() {
  const createdAt = new Date('2026-07-24T01:00:00.000Z');
  const systemUserId = oid();
  const reporterId = oid();
  const teamId = oid();
  const orgUnitId = oid();
  await User.collection.insertMany([
    {
      _id: systemUserId,
      username: 'system-transport-repair',
      usernameNormalized: 'system-transport-repair',
      password: 'unused-hash',
      name: '系统账号',
      roles: [],
      isSuperAdmin: true,
      isSystemAccount: true,
      tokenVersion: 0,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      __v: 0
    },
    {
      _id: reporterId,
      username: 'transport-reporter',
      usernameNormalized: 'transport-reporter',
      password: 'unused-hash',
      name: '运输提报员',
      roles: [],
      isSuperAdmin: false,
      isSystemAccount: false,
      tokenVersion: 0,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      __v: 0
    }
  ]);
  await ProjectTeam.collection.insertOne({
    _id: teamId,
    code: 'GEARBOX_LOGISTICS',
    name: '变速箱物流部',
    status: permissions.TEAM_STATUSES.ACTIVE,
    settings: { timeZone: 'Asia/Shanghai' },
    createdBy: systemUserId,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  });

  const masters = [];
  const createMaster = (kind, name, sortOrder) => {
    const value = {
      _id: oid(),
      teamId,
      kind,
      name,
      normalizedKey: `${kind}:${sortOrder}`,
      status: TransportMasterData.TRANSPORT_MASTER_STATUSES.ACTIVE,
      sortOrder,
      createdBy: systemUserId,
      updatedBy: systemUserId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    };
    masters.push(value);
    return value;
  };
  const trips = Array.from({ length: 15 }, (_, index) => createMaster(
    TransportMasterData.TRANSPORT_MASTER_KINDS.TRIP,
    `第${index + 1}车`,
    index + 1
  ));
  const route = createMaster(TransportMasterData.TRANSPORT_MASTER_KINDS.ROUTE, '李福仓库-PC', 1);
  const vehicleType = createMaster(
    TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_TYPE,
    '大厢式翼开车（9.6米）',
    1
  );
  const houDriver = createMaster(TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER, '侯宪磊', 1);
  const partyDriver = createMaster(TransportMasterData.TRANSPORT_MASTER_KINDS.DRIVER, '党光', 2);
  const plates = ['鲁AV1515', '鲁AV1528', '鲁AA2991'].map((name, index) => createMaster(
    TransportMasterData.TRANSPORT_MASTER_KINDS.VEHICLE_PLATE,
    name,
    index + 1
  ));
  await TransportMasterData.collection.insertMany(masters);

  const routeAliases = ['1212', 'pc-李福', 'pc_李福', '李福仓库_PC'];
  const vehicleTypeAliases = ['9.6', '9米6', '9.6米', '9.6货车', '9.6米厢式货车'];
  const realRecords = REAL_RECORD_IDS.map((recordId, index) => {
    const trip = trips[index % trips.length];
    const plate = plates[index % plates.length];
    const usePartyDriver = index % 5 === 0;
    return {
      _id: oid(recordId),
      teamId,
      orgUnitId,
      reportDate: index < 2 ? '2026-07-23' : '2026-07-24',
      shift: TransportRecord.TRANSPORT_SHIFTS.DAY,
      tripMasterId: trip._id,
      tripLabel: trip.name,
      routeMasterId: route._id,
      route: routeAliases[index % routeAliases.length],
      dispatchType: index % 2
        ? TransportRecord.TRANSPORT_DISPATCH_TYPES.RETURN_RACK
        : TransportRecord.TRANSPORT_DISPATCH_TYPES.DELIVERY,
      vehiclePlateMasterId: plate._id,
      vehiclePlate: plate.name,
      vehicleTypeMasterId: vehicleType._id,
      vehicleType: vehicleTypeAliases[index % vehicleTypeAliases.length],
      driverMasterId: usePartyDriver ? partyDriver._id : houDriver._id,
      driverName: usePartyDriver ? partyDriver.name : (index % 2 ? '侯磊' : houDriver.name),
      loadDetails: { standardPlasticPallet: index + 1 },
      photoFileIds: [],
      remark: '',
      submittedAt: createdAt,
      createdBy: reporterId,
      updatedBy: reporterId,
      createdAt,
      updatedAt: createdAt,
      __v: 0
    };
  });
  await TransportRecord.collection.insertMany(realRecords);

  const placeholderRecords = PLACEHOLDER_RECORD_IDS.map((recordId, index) => ({
    _id: oid(recordId),
    teamId,
    orgUnitId,
    reportDate: '2026-07-17',
    shift: TransportRecord.TRANSPORT_SHIFTS.DAY,
    tripLabel: `第${index + 1}车`,
    route: '待客户确认（测试占位）',
    dispatchType: TransportRecord.TRANSPORT_DISPATCH_TYPES.DELIVERY,
    vehiclePlate: plates[index % plates.length].name,
    vehicleType: '',
    driverName: '待客户确认',
    loadDetails: {},
    photoFileIds: [],
    remark: '[customer-real-test-data-2026-07-17-v1] placeholder',
    submittedAt: createdAt,
    createdBy: reporterId,
    updatedBy: reporterId,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  }));
  await TransportRecord.collection.insertMany(placeholderRecords);

  const files = PLACEHOLDER_FILE_IDS.map((fileId, index) => ({
    _id: oid(fileId),
    teamId,
    ownerType: FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT,
    ownerId: oid(PLACEHOLDER_RECORD_IDS[index % PLACEHOLDER_RECORD_IDS.length]),
    storageKey: `${String(teamId)}/2026/07/00000000-0000-4000-8000-${String(index).padStart(12, '0')}.jpg`,
    originalName: `placeholder-${index}.jpg`,
    mimeType: 'image/jpeg',
    size: 10,
    sha256: String(index + 1).padStart(64, '0'),
    uploaderId: reporterId,
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null,
    cleanupStartedAt: null,
    createdAt,
    updatedAt: createdAt,
    __v: 0
  }));
  await FileAsset.collection.insertMany(files);
  return { systemUserId, teamId, route, vehicleType, houDriver, partyDriver };
}

async function completeBackupVerifier() {
  const names = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .filter((name) => !name.startsWith('system.'))
    .sort();
  const collections = [];
  for (const name of names) {
    collections.push({
      name,
      documentCount: await mongoose.connection.db.collection(name).countDocuments({})
    });
  }
  return {
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-transport-july-repair-backup'),
    manifestSha256: 'c'.repeat(64),
    manifest: {
      backupId: 'backup-20990101T000000Z-12345678',
      completedAt: '2099-01-01T00:00:00.000Z',
      database: {
        name: DATABASE_NAME,
        collectionCount: collections.length,
        collections
      },
      uploads: { fileCount: PLACEHOLDER_FILE_IDS.length, bytes: PLACEHOLDER_FILE_IDS.length * 10 },
      consistency: {
        restoreSet: 'database-and-uploads',
        databaseFileAssetsVerifiedAgainstUploadBytes: true
      },
      files: collections.map(({ name }) => ({
        file: `database/${DATABASE_NAME}/${name}.bson`
      }))
    }
  };
}

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), {
    dbName: DATABASE_NAME,
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 10_000
  });
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await createCollections();
  await seed();
});

after(async () => {
  await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('repair transaction normalizes 17 records, removes tagged placeholders and is idempotent', async () => {
  const preview = await analyze();
  assert.equal(preview.state, 'READY');
  assert.deepEqual(preview.counts, {
    fixedRecordsExpected: 17,
    fixedRecordsFound: 17,
    placeholdersRemaining: 6,
    placeholderFilesFound: 13,
    transportCorrections: 17,
    placeholderRecordDeletes: 6,
    placeholderFileDeletes: 13
  });
  assert.equal(preview.operations.length, 36);

  const executed = await executeRepair({
    analysis: preview,
    backupDirectory: path.resolve(os.tmpdir(), 'acceptance-transport-july-repair-backup'),
    databaseName: DATABASE_NAME,
    backupVerifier: completeBackupVerifier,
    connection: mongoose.connection
  });
  assert.equal(executed.dataWrites, 36);
  assert.equal(executed.auditLogsCreated, 36);
  assert.equal(executed.after.state, 'ALREADY_APPLIED');

  const repaired = await TransportRecord.find({ _id: { $in: REAL_RECORD_IDS } }).lean();
  assert.equal(repaired.length, 17);
  assert.ok(repaired.every((record) => record.route === '李福仓库-PC'));
  assert.ok(repaired.every((record) => record.vehicleType === '大厢式翼开车（9.6米）'));
  assert.ok(repaired.every((record) => ['侯宪磊', '党光'].includes(record.driverName)));
  assert.equal(await TransportRecord.countDocuments({ _id: { $in: PLACEHOLDER_RECORD_IDS } }), 0);
  assert.equal(await FileAsset.countDocuments({
    _id: { $in: PLACEHOLDER_FILE_IDS },
    status: FileAsset.FILE_STATUSES.DELETED
  }), 13);
  assert.equal(await AuditLog.countDocuments({
    actorRole: permissions.AUDIT_ACTOR_ROLES.SYSTEM,
    actorMode: permissions.AUDIT_ACTOR_MODES.SYSTEM
  }), 36);

  const idempotent = await analyze();
  assert.equal(idempotent.state, 'ALREADY_APPLIED');
  assert.equal(idempotent.operations.length, 0);
  assert.equal(idempotent.blockers.length, 0);
});
