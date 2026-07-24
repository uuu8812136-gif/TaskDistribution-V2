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
  MEMBERSHIP_STATUSES,
  ORG_UNIT_TYPES,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  SESSION_MODES
} = require('../../../app/config/permissions');
const {
  createStorageKey,
  resolveStoragePath
} = require('../../../app/services/fileStorageService');
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
    temporaryFileUserMaxCount: 2,
    temporaryFileUserMaxBytes: 512,
    temporaryFileTeamMaxCount: 3,
    temporaryFileTeamMaxBytes: 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  };
}

async function quotaAsset({ teamId, uploaderId, size, status = 'TEMPORARY' }) {
  return FileAsset.create({
    teamId,
    ownerType: 'TEMPORARY',
    ownerId: null,
    storageKey: createStorageKey({
      teamId,
      originalName: 'quota.txt',
      mimeType: 'text/plain'
    }),
    originalName: 'quota.txt',
    mimeType: 'text/plain',
    size,
    sha256: 'a'.repeat(64),
    uploaderId,
    status,
    cleanupStartedAt: status === 'PURGING' ? new Date() : null
  });
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
  const actingSupervisor = await createUser('file-acting-supervisor');
  const primaryManager = await createUser('file-primary-manager');
  const siblingMemberA = await createUser('file-sibling-member-a');
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
  const subDepartmentA = await OrgUnit.create({
    teamId: teamA._id,
    parentId: rootA._id,
    type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
    code: 'LEADERSHIP_SUB',
    name: 'Leadership Sub-department',
    level: 2,
    path: `/${rootA._id}/`
  });
  const [supervisorGroupA, siblingGroupA] = await OrgUnit.create([
    {
      teamId: teamA._id,
      parentId: subDepartmentA._id,
      type: ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'LEADERSHIP_GROUP_A',
      name: 'Leadership Group A',
      level: 3,
      path: `/${rootA._id}/${subDepartmentA._id}/`
    },
    {
      teamId: teamA._id,
      parentId: subDepartmentA._id,
      type: ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'LEADERSHIP_GROUP_B',
      name: 'Leadership Group B',
      level: 3,
      path: `/${rootA._id}/${subDepartmentA._id}/`
    }
  ]);

  const memberships = await TeamMembership.create([
    {
      teamId: teamA._id,
      userId: uploaderA._id,
      orgUnitId: rootA._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit', 'task.assign']
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
      teamId: teamA._id,
      userId: actingSupervisor._id,
      orgUnitId: supervisorGroupA._id,
      positionKey: POSITION_KEYS.SUPERVISOR,
      positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.SUPERVISOR],
      permissionKeys: []
    },
    {
      teamId: teamA._id,
      userId: siblingMemberA._id,
      orgUnitId: siblingGroupA._id,
      permissionKeys: ['task.view']
    },
    {
      teamId: teamB._id,
      userId: memberB._id,
      orgUnitId: rootB._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit']
    }
  ]);

  const plannedCompletionTime = new Date(Date.now() + 86_400_000);
  const [taskA, taskOtherA, taskB, siblingLeadershipTask] = await Task.create([
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
    },
    {
      teamId: teamA._id,
      orgUnitId: siblingGroupA._id,
      taskName: 'Leadership sibling task',
      creator: siblingMemberA._id,
      executor: [siblingMemberA._id],
      mainExecutor: siblingMemberA._id,
      plannedCompletionTime
    }
  ]);

  return {
    teamA,
    teamB,
    rootA,
    otherUnitA,
    subDepartmentA,
    supervisorGroupA,
    siblingGroupA,
    taskA,
    taskOtherA,
    taskB,
    siblingLeadershipTask,
    uploaderA,
    actingSupervisor,
    actingSupervisorMembership: memberships[4],
    primaryManager,
    uploaderAToken: await issueToken(uploaderA, SESSION_MODES.TEAM, teamA._id),
    peerAToken: await issueToken(peerA, SESSION_MODES.TEAM, teamA._id),
    otherOrgAToken: await issueToken(otherOrgA, SESSION_MODES.TEAM, teamA._id),
    noPermissionAToken: await issueToken(noPermissionA, SESSION_MODES.TEAM, teamA._id),
    actingSupervisorToken: await issueToken(
      actingSupervisor,
      SESSION_MODES.TEAM,
      teamA._id
    ),
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

  await t.test('temporary upload quotas enforce user and team counts and bytes', async () => {
    const upload = () => request(app)
      .post('/api/files')
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', PNG_CONTENT, {
        filename: 'quota-check.png',
        contentType: 'image/png'
      });
    const removeSeeded = async (files) => FileAsset.deleteMany({
      _id: { $in: files.map((file) => file._id) }
    });

    const userCountFiles = await Promise.all([
      quotaAsset({
        teamId: seeded.teamA._id,
        uploaderId: seeded.uploaderA._id,
        size: 1
      }),
      quotaAsset({
        teamId: seeded.teamA._id,
        uploaderId: seeded.uploaderA._id,
        size: 1,
        status: 'PURGING'
      })
    ]);
    await upload().expect(429).expect(({ body }) => {
      assert.equal(body.code, 'TEMPORARY_FILE_USER_COUNT_LIMIT');
    });
    await removeSeeded(userCountFiles);

    const userBytesFile = await quotaAsset({
      teamId: seeded.teamA._id,
      uploaderId: seeded.uploaderA._id,
      size: 512 - PNG_CONTENT.length + 1
    });
    await upload().expect(429).expect(({ body }) => {
      assert.equal(body.code, 'TEMPORARY_FILE_USER_BYTES_LIMIT');
    });
    assert.equal(await FileAsset.countDocuments({
      teamId: seeded.teamA._id,
      uploaderId: seeded.uploaderA._id,
      status: 'TEMPORARY'
    }), 1);
    await removeSeeded([userBytesFile]);

    const teamCountFiles = await Promise.all(Array.from({ length: 3 }, () => quotaAsset({
      teamId: seeded.teamA._id,
      uploaderId: new mongoose.Types.ObjectId(),
      size: 1
    })));
    await upload().expect(429).expect(({ body }) => {
      assert.equal(body.code, 'TEMPORARY_FILE_TEAM_COUNT_LIMIT');
    });
    await removeSeeded(teamCountFiles);

    const teamByteSeed = 1024 - PNG_CONTENT.length + 1;
    const teamByteFiles = await Promise.all([
      quotaAsset({
        teamId: seeded.teamA._id,
        uploaderId: new mongoose.Types.ObjectId(),
        size: Math.floor(teamByteSeed / 2)
      }),
      quotaAsset({
        teamId: seeded.teamA._id,
        uploaderId: new mongoose.Types.ObjectId(),
        size: Math.ceil(teamByteSeed / 2)
      })
    ]);
    await upload().expect(429).expect(({ body }) => {
      assert.equal(body.code, 'TEMPORARY_FILE_TEAM_BYTES_LIMIT');
    });
    await removeSeeded(teamByteFiles);
    assert.equal(await FileAsset.countDocuments({ status: { $in: ['TEMPORARY', 'PURGING'] } }), 0);
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

  await t.test('business attachments can only bind through their owning endpoint', async () => {
    const unsupportedOwner = await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'ATTENDANCE_REPORT', ownerId: seeded.taskA._id.toString() })
      .expect(400);
    assert.equal(unsupportedOwner.body.code, 'FILE_OWNER_TYPE_UNSUPPORTED');

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskB._id.toString() })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskOtherA._id.toString() })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskA._id.toString() })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));

    await request(app)
      .put(`/api/tasks/${seeded.taskA._id}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ attachments: [{ fileId }] })
      .expect(200);

    const bound = await FileAsset.findById(fileId).lean();
    assert.equal(bound.status, 'ACTIVE');
    assert.equal(bound.ownerType, 'TASK');
    assert.equal(bound.ownerId.toString(), seeded.taskA._id.toString());

    await request(app)
      .patch(`/api/files/${fileId}/bind`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ ownerType: 'TASK', ownerId: seeded.taskA._id.toString() })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));
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

  await t.test('active business files only delete through owner reconciliation', async () => {
    await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.otherOrgAToken}`)
      .send({ reason: 'cross-scope attempt' })
      .expect(404);

    const deletedResponse = await request(app)
      .delete(`/api/files/${fileId}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ reason: 'superseded attachment' })
      .expect(409);
    assert.equal(deletedResponse.body.code, 'FILE_WORKFLOW_OWNER_MANAGED');

    await request(app)
      .put(`/api/tasks/${seeded.taskA._id}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .send({ attachments: [] })
      .expect(200);

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
    assert.equal(audits[2].reason, 'Business attachment replaced');
    assert.equal(audits.every((audit) => String(audit.targetTeamId) === String(seeded.teamA._id)), true);
  });
});

test('stored task permissions keep their original organization scope for task uploads', async () => {
  await FileAsset.deleteMany({});
  const upload = ({ taskId, orgUnitId }) => {
    const query = new URLSearchParams();
    if (taskId) query.set('taskId', String(taskId));
    if (orgUnitId) query.set('orgUnitId', String(orgUnitId));
    return request(app)
      .post(`/api/files/task-temporary?${query}`)
      .set('Authorization', `Bearer ${seeded.uploaderAToken}`)
      .attach('file', PNG_CONTENT, {
        filename: 'stored-task-scope.png',
        contentType: 'image/png'
      });
  };

  await upload({ taskId: seeded.taskA._id }).expect(201);
  await upload({ orgUnitId: seeded.rootA._id }).expect(201);
  assert.equal(await FileAsset.countDocuments(), 2);

  for (const scope of [
    { taskId: seeded.taskOtherA._id },
    { orgUnitId: seeded.otherUnitA._id },
    { taskId: seeded.taskB._id }
  ]) {
    const beforeCount = await FileAsset.countDocuments();
    const denied = await upload(scope).expect(403);
    assert.equal(denied.body.code, 'TASK_FILE_UPLOAD_DENIED');
    assert.equal(await FileAsset.countDocuments(), beforeCount);
  }
});

test('task-scoped temporary uploads enforce live supervisor scope before persistence and binding', async () => {
  await FileAsset.deleteMany({});
  let supervisorToken = seeded.actingSupervisorToken;

  const upload = ({ taskId, orgUnitId, token = supervisorToken }) => {
    const query = new URLSearchParams();
    if (taskId) query.set('taskId', String(taskId));
    if (orgUnitId) query.set('orgUnitId', String(orgUnitId));
    const suffix = query.toString() ? `?${query}` : '';
    return request(app)
      .post(`/api/files/task-temporary${suffix}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', PNG_CONTENT, {
        filename: 'leadership-task.png',
        contentType: 'image/png'
      });
  };

  const taskUpload = await upload({ taskId: seeded.siblingLeadershipTask._id }).expect(201);
  const createUpload = await upload({ orgUnitId: seeded.siblingGroupA._id }).expect(201);
  assert.equal(taskUpload.body.file.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(createUpload.body.file.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(await FileAsset.countDocuments(), 2);

  for (const scope of [
    { taskId: seeded.taskOtherA._id },
    { orgUnitId: seeded.otherUnitA._id },
    { taskId: seeded.taskB._id }
  ]) {
    const beforeCount = await FileAsset.countDocuments();
    const denied = await upload(scope).expect(403);
    assert.equal(denied.body.code, 'TASK_FILE_UPLOAD_DENIED');
    assert.equal(await FileAsset.countDocuments(), beforeCount);
  }

  const missingScopeCount = await FileAsset.countDocuments();
  const missingScope = await upload({}).expect(400);
  assert.equal(missingScope.body.code, 'TASK_FILE_SCOPE_REQUIRED');
  assert.equal(await FileAsset.countDocuments(), missingScopeCount);

  const createdWithAttachment = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${supervisorToken}`)
    .send({
      taskName: 'Leadership task with scoped attachment',
      orgUnitId: String(seeded.siblingGroupA._id),
      executor: [String(seeded.siblingLeadershipTask.mainExecutor)],
      mainExecutor: String(seeded.siblingLeadershipTask.mainExecutor),
      plannedCompletionTime: new Date(Date.now() + 86_400_000).toISOString(),
      attachments: [{ fileId: createUpload.body.file._id }]
    });
  assert.equal(
    createdWithAttachment.status,
    201,
    JSON.stringify(createdWithAttachment.body)
  );
  const boundCreateFile = await FileAsset.findById(createUpload.body.file._id).lean();
  assert.equal(boundCreateFile.status, FileAsset.FILE_STATUSES.ACTIVE);
  assert.equal(String(boundCreateFile.ownerId), String(createdWithAttachment.body.task._id));

  const revokedCreateUpload = await upload({
    orgUnitId: seeded.siblingGroupA._id
  }).expect(201);

  await TeamMembership.updateOne(
    { _id: seeded.actingSupervisorMembership._id },
    { $set: { status: MEMBERSHIP_STATUSES.DISABLED } }
  );
  const disabledCount = await FileAsset.countDocuments();
  const disabledResponse = await upload({ taskId: seeded.siblingLeadershipTask._id });
  assert.equal([401, 403].includes(disabledResponse.status), true);
  assert.equal(await FileAsset.countDocuments(), disabledCount);
  await TeamMembership.updateOne(
    { _id: seeded.actingSupervisorMembership._id },
    { $set: { status: MEMBERSHIP_STATUSES.ACTIVE } }
  );
  supervisorToken = await issueToken(
    seeded.actingSupervisor,
    SESSION_MODES.TEAM,
    seeded.teamA._id
  );

  await User.updateOne(
    { _id: seeded.actingSupervisor._id },
    { $set: { status: 'inactive' } }
  );
  const inactiveCount = await FileAsset.countDocuments();
  const inactiveResponse = await upload({ taskId: seeded.siblingLeadershipTask._id });
  assert.equal([401, 403].includes(inactiveResponse.status), true);
  assert.equal(await FileAsset.countDocuments(), inactiveCount);
  await User.updateOne(
    { _id: seeded.actingSupervisor._id },
    { $set: { status: 'active' } }
  );
  supervisorToken = await issueToken(
    seeded.actingSupervisor,
    SESSION_MODES.TEAM,
    seeded.teamA._id
  );

  await TeamMembership.create({
    teamId: seeded.teamA._id,
    userId: seeded.primaryManager._id,
    orgUnitId: seeded.subDepartmentA._id,
    positionKey: POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
    positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.SUB_DEPARTMENT_MANAGER],
    permissionKeys: []
  });

  const restoredLeaderCount = await FileAsset.countDocuments();
  await upload({ taskId: seeded.siblingLeadershipTask._id }).expect(403);
  await upload({ orgUnitId: seeded.siblingGroupA._id }).expect(403);
  assert.equal(await FileAsset.countDocuments(), restoredLeaderCount);

  const deniedBinding = await request(app)
    .put(`/api/tasks/${seeded.siblingLeadershipTask._id}`)
    .set('Authorization', `Bearer ${supervisorToken}`)
    .send({ attachments: [{ fileId: taskUpload.body.file._id }] })
    .expect(403);
  assert.equal(deniedBinding.body.code, 'TASK_LEADERSHIP_REQUIRED');
  const unboundFile = await FileAsset.findById(taskUpload.body.file._id).lean();
  assert.equal(unboundFile.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(unboundFile.ownerId, null);
  const unchangedTask = await Task.findById(seeded.siblingLeadershipTask._id).lean();
  assert.deepEqual(unchangedTask.attachments, []);

  const beforeDeniedCreate = await Task.countDocuments();
  const deniedCreateBinding = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${supervisorToken}`)
    .send({
      taskName: 'Revoked leadership must not bind create upload',
      orgUnitId: String(seeded.siblingGroupA._id),
      executor: [String(seeded.siblingLeadershipTask.mainExecutor)],
      mainExecutor: String(seeded.siblingLeadershipTask.mainExecutor),
      plannedCompletionTime: new Date(Date.now() + 86_400_000).toISOString(),
      attachments: [{ fileId: revokedCreateUpload.body.file._id }]
    })
    .expect(403);
  assert.equal(deniedCreateBinding.body.code, 'TASK_LEADERSHIP_REQUIRED');
  assert.equal(await Task.countDocuments(), beforeDeniedCreate);
  const unboundCreateFile = await FileAsset.findById(revokedCreateUpload.body.file._id).lean();
  assert.equal(unboundCreateFile.status, FileAsset.FILE_STATUSES.TEMPORARY);
  assert.equal(unboundCreateFile.ownerId, null);
});
