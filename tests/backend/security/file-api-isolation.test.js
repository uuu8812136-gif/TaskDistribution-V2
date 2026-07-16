'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const request = appRequire('supertest');

const { createApp } = require('../../../app/app');
const AuditLog = require('../../../app/models/AuditLog');
const AuthSession = require('../../../app/models/AuthSession');
const FileAsset = require('../../../app/models/FileAsset');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const Task = require('../../../app/models/Task');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  AUDIT_ACTIONS,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  SESSION_MODES
} = require('../../../app/config/permissions');
const { resolveStoragePath } = require('../../../app/services/fileStorageService');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');

const TEST_DATABASE_NAME = `file_api_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_SECRET = 'file-api-test-secret-0123456789abcdef';
const MODELS = [
  AuditLog,
  AuthSession,
  FileAsset,
  OrgUnit,
  ProjectTeam,
  Task,
  TeamMembership,
  User
];
const PNG_CONTENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(8, 0x01)
]);

let replSet;
let storageRoot;
let app;
let seeded;

function config() {
  return {
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'file-api-v2-test',
    port: 18097,
    mongodbUri: `mongodb://127.0.0.1:27017/${TEST_DATABASE_NAME}`,
    jwtSecret: JWT_SECRET,
    jwtExpire: '1h',
    uploadPath: storageRoot,
    maxFileSize: 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
}

async function createUser(username, isSuperAdmin = false) {
  return User.create({
    username,
    password: 'test-password-123',
    name: username,
    isSuperAdmin,
    roles: isSuperAdmin ? ['admin'] : ['executor']
  });
}

async function issueToken(user, mode, activeTeamId = null) {
  const result = await createSessionLifecycleService().issueSession({
    userId: user._id,
    mode,
    activeTeamId,
    tokenVersion: user.tokenVersion
  });
  return result.token;
}

async function seed() {
  const superAdmin = await createUser('file-super-admin', true);
  const uploaderA = await createUser('file-uploader-a');
  const peerA = await createUser('file-peer-a');
  const otherOrgA = await createUser('file-other-org-a');
  const noPermissionA = await createUser('file-no-permission-a');
  const memberB = await createUser('file-member-b');

  const [teamA, teamB] = await ProjectTeam.create([
    { code: 'FILE_TEAM_A', name: 'File Team A', createdBy: superAdmin._id },
    { code: 'FILE_TEAM_B', name: 'File Team B', createdBy: superAdmin._id }
  ]);
  const [rootA, rootB] = await OrgUnit.create([
    {
      teamId: teamA._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Team A Root',
      level: 1,
      path: '/'
    },
    {
      teamId: teamB._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Team B Root',
      level: 1,
      path: '/'
    }
  ]);
  const otherUnitA = await OrgUnit.create({
    teamId: teamA._id,
    parentId: rootA._id,
    type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'OTHER',
    name: 'Other Team A Unit',
    level: 2,
    path: `/${rootA._id}/`
  });

  await TeamMembership.create([
    {
      teamId: teamA._id,
      userId: uploaderA._id,
      orgUnitId: rootA._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit']
    },
    {
      teamId: teamA._id,
      userId: peerA._id,
      orgUnitId: rootA._id,
      permissionKeys: ['task.view']
    },
    {
      teamId: teamA._id,
      userId: otherOrgA._id,
      orgUnitId: otherUnitA._id,
      permissionKeys: ['task.view', 'task.edit']
    },
    {
      teamId: teamA._id,
      userId: noPermissionA._id,
      orgUnitId: rootA._id,
      permissionKeys: []
    },
    {
      teamId: teamB._id,
      userId: memberB._id,
      orgUnitId: rootB._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit']
    }
  ]);

  const plannedCompletionTime = new Date(Date.now() + 86_400_000);
  const [taskA, taskOtherA, taskB] = await Task.create([
    {
      teamId: teamA._id,
      orgUnitId: rootA._id,
      taskName: 'File owner task A',
      creator: uploaderA._id,
      executor: [uploaderA._id],
      plannedCompletionTime
    },
    {
      teamId: teamA._id,
      orgUnitId: otherUnitA._id,
      taskName: 'Other org task A',
      creator: otherOrgA._id,
      executor: [otherOrgA._id],
      plannedCompletionTime
    },
    {
      teamId: teamB._id,
      orgUnitId: rootB._id,
      taskName: 'File owner task B',
      creator: memberB._id,
      executor: [memberB._id],
      plannedCompletionTime
    }
  ]);

  return {
    teamA,
    teamB,
    rootA,
    taskA,
    taskOtherA,
    taskB,
    uploaderA,
    uploaderAToken: await issueToken(uploaderA, SESSION_MODES.TEAM, teamA._id),
    peerAToken: await issueToken(peerA, SESSION_MODES.TEAM, teamA._id),
    otherOrgAToken: await issueToken(otherOrgA, SESSION_MODES.TEAM, teamA._id),
    noPermissionAToken: await issueToken(noPermissionA, SESSION_MODES.TEAM, teamA._id),
    memberBToken: await issueToken(memberB, SESSION_MODES.TEAM, teamB._id),
    globalToken: await issueToken(superAdmin, SESSION_MODES.GLOBAL_READ_ONLY),
    selectionToken: await issueToken(superAdmin, SESSION_MODES.TEAM_SELECTION)
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_EXPIRE = '1h';
  process.env.JWT_ISSUER = 'task-distribution-v2';
  process.env.JWT_AUDIENCE = 'task-distribution-v2-clients';
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'task-v2-files-'));

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
  for (const model of MODELS) await model.syncIndexes();
  app = createApp(config());
  seeded = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    assert.equal(mongoose.connection.name, TEST_DATABASE_NAME);
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  if (storageRoot) await fs.promises.rm(storageRoot, { recursive: true, force: true });
});

test('private file API enforces tenant, scope, content, and mutation boundaries', async (t) => {
  let fileId;
  let storagePath;

  await t.test('authentication and business context are checked before file operations', async () => {
    await request(app).get(`/api/files/${new mongoose.Types.ObjectId()}`).expect(401);

    const selectionResponse = await request(app)
      .get(`/api/files/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', `Bearer ${seeded.selectionToken}`)
      .expect(403);
    assert.equal(selectionResponse.body.code, 'BUSINESS_CONTEXT_REQUIRED');

    const deniedUpload = await request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.noPermissionAToken}`)
      .attach('file', Buffer.alloc(2048), {
        filename: 'oversized.png',
        contentType: 'image/png'
      })
      .expect(403);
    assert.equal(deniedUpload.body.code, 'PERMISSION_DENIED');
  });

  await t.test('declared MIME, extension, magic bytes, and size are all enforced', async () => {
    const mismatchedExtension = await request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', PNG_CONTENT, { filename: 'image.pdf', contentType: 'image/png' })
      .expect(415);
    assert.equal(mismatchedExtension.body.code, 'FILE_TYPE_UNSUPPORTED');

    const spoofedContent = await request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', Buffer.from('not a png'), {
        filename: 'spoofed.png',
        contentType: 'image/png'
      })
      .expect(415);
    assert.equal(spoofedContent.body.code, 'FILE_CONTENT_INVALID');

    const oversized = await request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', Buffer.alloc(2048), {
        filename: 'large.png',
        contentType: 'image/png'
      })
      .expect(413);
    assert.equal(oversized.body.code, 'FILE_TOO_LARGE');
    assert.equal(await FileAsset.countDocuments(), 0);
  });

  await t.test('temporary upload uses an opaque path and remains private to its uploader', async () => {
    const uploadResponse = await request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', PNG_CONTENT, {
        filename: 'report-final.png',
        contentType: 'image/png'
      })
      .expect(201);

    fileId = uploadResponse.body.file._id;
    assert.equal(uploadResponse.body.file.teamId, seeded.teamA._id.toString());
    assert.equal(uploadResponse.body.file.status, 'TEMPORARY');
    assert.equal(uploadResponse.body.file.storageKey, undefined);
    assert.equal(uploadResponse.body.file.absolutePath, undefined);

    const stored = await FileAsset.findById(fileId).lean();
    assert.match(stored.storageKey, new RegExp(`^${seeded.teamA._id}/\\d{4}/\\d{2}/`));
    assert.equal(stored.storageKey.includes('report-final'), false);
    storagePath = resolveStoragePath(storageRoot, stored.storageKey);
    assert.deepEqual(await fs.promises.readFile(storagePath), PNG_CONTENT);

    await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.peerAToken}`)
      .expect(404);
    await request(app)
      .get(`/api/files/${fileId}?teamId=${seeded.teamA._id}`)
      .set('Authorization', `Bearer ${seeded.globalToken}`)
      .expect(404);

    const ownerMetadata = await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .expect(200);
    assert.equal(ownerMetadata.body.file.originalName, 'report-final.png');
  });

  await t.test('binding verifies both owner scope and active team', async () => {
    const unsupportedOwner = await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'EQUIPMENT', ownerId: seeded.taskA._id.toString() })
      .expect(400);
    assert.equal(unsupportedOwner.body.code, 'FILE_OWNER_TYPE_UNSUPPORTED');

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskB._id.toString() })
      .expect(404);

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskOtherA._id.toString() })
      .expect(404);

    const bindResponse = await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskA._id.toString() })
      .expect(200);
    assert.equal(bindResponse.body.file.status, 'ACTIVE');
    assert.equal(bindResponse.body.file.ownerId, seeded.taskA._id.toString());

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskA._id.toString() })
      .expect(404);
  });

  await t.test('active file reads enforce team and organization scope', async () => {
    await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.memberBToken}`)
      .expect(404);
    await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.otherOrgAToken}`)
      .expect(404);

    const peerResponse = await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.peerAToken}`)
      .expect(200);
    assert.equal(peerResponse.body.file.ownerId, seeded.taskA._id.toString());
  });

  await t.test('downloads are authenticated and use safe response headers', async () => {
    const download = await request(app)
      .get(`/api/files/${fileId}/download`)
      .set('Authorization', `Bearer ${seeded.peerAToken}`)
      .expect('content-type', 'image/png')
      .expect('x-content-type-options', 'nosniff')
      .expect('cache-control', 'private, no-store')
      .expect(200);
    assert.match(download.headers['content-disposition'], /^attachment; filename="report-final\.png";/);
    assert.deepEqual(download.body, PNG_CONTENT);

    await request(app)
      .get(`/api/files/${fileId}/download`)
      .set('Authorization', `Bearer ${seeded.memberBToken}`)
      .expect(404);
  });

  await t.test('global mode can read a named team but cannot enumerate or mutate files', async () => {
    const missingTeam = await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.globalToken}`)
      .expect(400);
    assert.equal(missingTeam.body.code, 'FILE_TEAM_REQUIRED');

    const globalRead = await request(app)
      .get(`/api/files/${fileId}?teamId=${seeded.teamA._id}`)
      .set('Authorization', `Bearer ${seeded.globalToken}`)
      .expect(200);
    assert.equal(globalRead.body.file.teamId, seeded.teamA._id.toString());

    const globalWrite = await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.globalToken}`)
      .expect(403);
    assert.equal(globalWrite.body.code, 'TEAM_CONTEXT_REQUIRED');
  });

  await t.test('soft deletion preserves bytes, hides the record, and appends audits', async () => {
    await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.otherOrgAToken}`)
      .send({ reason: 'cross-scope attempt' })
      .expect(404);

    const deletedResponse = await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ reason: 'superseded attachment' })
      .expect(200);
    assert.equal(deletedResponse.body.file.status, 'DELETED');

    const stored = await FileAsset.findById(fileId).lean();
    assert.equal(stored.status, 'DELETED');
    assert.equal(stored.deletedBy.toString(), seeded.uploaderA._id.toString());
    assert.equal(await fs.promises.stat(storagePath).then((stat) => stat.isFile()), true);

    await request(app)
      .get(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .expect(404);

    const audits = await AuditLog.find({
      resourceType: 'FILE_ASSET',
      resourceId: fileId
    }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(
      audits.map(({ action }) => action),
      [AUDIT_ACTIONS.CREATE, AUDIT_ACTIONS.ASSIGN, AUDIT_ACTIONS.FILE_DELETE]
    );
    assert.equal(audits[2].reason, 'superseded attachment');
    assert.equal(audits.every((audit) => String(audit.targetTeamId) === String(seeded.teamA._id)), true);
  });
});
