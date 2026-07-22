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
const TaskReview = require('../../../app/models/TaskReview');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const {
  ORG_UNIT_TYPES,
  SESSION_MODES
} = require('../../../app/config/permissions');
const { createSessionLifecycleService } = require('../../../app/services/sessionLifecycleService');

const TEST_DATABASE_NAME = `task_attachment_${randomUUID().replaceAll('-', '')}_v2_test`;
const JWT_SECRET = 'task-attachment-test-secret-0123456789abcdef';
const PNG_CONTENT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(8, 0x02)
]);
const MODELS = [
  AuditLog,
  AuthSession,
  FileAsset,
  OrgUnit,
  ProjectTeam,
  Task,
  TaskReview,
  TeamMembership,
  User
];

let replSet;
let storageRoot;
let app;
let fixture;

async function createUser(username) {
  return User.create({
    username,
    password: 'test-password-123',
    name: username,
    roles: ['executor']
  });
}

async function issueToken(user, teamId) {
  const result = await createSessionLifecycleService().issueSession({
    userId: user._id,
    mode: SESSION_MODES.TEAM,
    activeTeamId: teamId,
    tokenVersion: user.tokenVersion
  });
  return result.token;
}

async function upload(token, filename) {
  const response = await request(app)
    .post('/api/files')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', PNG_CONTENT, { filename, contentType: 'image/png' })
    .expect(201);
  return response.body.file;
}

async function seed() {
  const systemUser = await createUser('attachment-system-user');
  const creatorA = await createUser('attachment-creator-a');
  const executor2A = await createUser('attachment-executor-2-a');
  const viewerA = await createUser('attachment-viewer-a');
  const reviewerA = await createUser('attachment-reviewer-a');
  const memberB = await createUser('attachment-member-b');
  const [teamA, teamB] = await ProjectTeam.create([
    { code: 'ATTACH_A', name: 'Attachment A', createdBy: systemUser._id },
    { code: 'ATTACH_B', name: 'Attachment B', createdBy: systemUser._id }
  ]);
  const [orgA, orgB] = await OrgUnit.create([
    {
      teamId: teamA._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Attachment A Root',
      level: 1,
      path: '/'
    },
    {
      teamId: teamB._id,
      type: ORG_UNIT_TYPES.DEPARTMENT,
      code: 'ROOT',
      name: 'Attachment B Root',
      level: 1,
      path: '/'
    }
  ]);
  await TeamMembership.create([
    {
      teamId: teamA._id,
      userId: creatorA._id,
      orgUnitId: orgA._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit', 'task.assign']
    },
    {
      teamId: teamA._id,
      userId: executor2A._id,
      orgUnitId: orgA._id,
      permissionKeys: ['task.view']
    },
    {
      teamId: teamA._id,
      userId: viewerA._id,
      orgUnitId: orgA._id,
      permissionKeys: ['task.view']
    },
    {
      teamId: teamA._id,
      userId: reviewerA._id,
      orgUnitId: orgA._id,
      permissionKeys: ['task.review']
    },
    {
      teamId: teamB._id,
      userId: memberB._id,
      orgUnitId: orgB._id,
      permissionKeys: ['task.view', 'task.create', 'task.edit', 'task.assign', 'task.review']
    }
  ]);

  const plannedCompletionTime = new Date(Date.now() + 86_400_000);
  const [completionTask, reviewTask, taskB] = await Task.create([
    {
      teamId: teamA._id,
      orgUnitId: orgA._id,
      taskName: 'Completion attachment task',
      creator: creatorA._id,
      executor: [creatorA._id, executor2A._id],
      mainExecutor: creatorA._id,
      ccUsers: [reviewerA._id],
      plannedCompletionTime,
      executorCompletions: [
        { executor: creatorA._id, status: 'pending', attachments: [] },
        { executor: executor2A._id, status: 'pending', attachments: [] }
      ]
    },
    {
      teamId: teamA._id,
      orgUnitId: orgA._id,
      taskName: 'Review attachment task',
      creator: creatorA._id,
      executor: [creatorA._id],
      mainExecutor: creatorA._id,
      ccUsers: [reviewerA._id],
      plannedCompletionTime,
      status: 'pending_review'
    },
    {
      teamId: teamB._id,
      orgUnitId: orgB._id,
      taskName: 'Team B attachment task',
      creator: memberB._id,
      executor: [memberB._id],
      mainExecutor: memberB._id,
      plannedCompletionTime
    }
  ]);

  return {
    teamA,
    teamB,
    orgA,
    creatorA,
    executor2A,
    viewerA,
    reviewerA,
    memberB,
    completionTask,
    reviewTask,
    taskB,
    creatorToken: await issueToken(creatorA, teamA._id),
    executor2Token: await issueToken(executor2A, teamA._id),
    viewerToken: await issueToken(viewerA, teamA._id),
    reviewerToken: await issueToken(reviewerA, teamA._id),
    memberBToken: await issueToken(memberB, teamB._id)
  };
}

before(async () => {
  assert.match(TEST_DATABASE_NAME, /_v2_test$/);
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.JWT_EXPIRE = '1h';
  process.env.JWT_ISSUER = 'task-distribution-v2';
  process.env.JWT_AUDIENCE = 'task-distribution-v2-clients';
  storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'task-attachment-v2-'));
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: TEST_DATABASE_NAME }]
  });
  await mongoose.connect(replSet.getUri(TEST_DATABASE_NAME), { dbName: TEST_DATABASE_NAME });
  for (const model of MODELS) await model.syncIndexes();
  app = createApp({
    appEnv: 'test',
    nodeEnv: 'test',
    instanceName: 'task-attachment-v2-test',
    port: 18096,
    mongodbUri: replSet.getUri(TEST_DATABASE_NAME),
    jwtSecret: JWT_SECRET,
    jwtExpire: '1h',
    uploadPath: storageRoot,
    maxFileSize: 1024,
    corsOrigins: ['http://localhost:3101'],
    enableLegacyPublicUploads: false
  });
  fixture = await seed();
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
  if (storageRoot) await fs.promises.rm(storageRoot, { recursive: true, force: true });
});

test('task attachments use private FileAsset references end to end', async (t) => {
  let managedTaskId;
  let managedFile;

  await t.test('legacy multipart and client-supplied path metadata are rejected', async () => {
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .field('taskName', 'Legacy multipart task')
      .field('plannedCompletionTime', new Date(Date.now() + 86_400_000).toISOString())
      .field('executor', String(fixture.creatorA._id))
      .attach('attachments', PNG_CONTENT, { filename: 'legacy.png', contentType: 'image/png' })
      .expect(415)
      .expect(({ body }) => assert.equal(body.code, 'LEGACY_MULTIPART_DISABLED'));

    const forged = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({
        taskName: 'Forged path task',
        plannedCompletionTime: new Date(Date.now() + 86_400_000),
        executor: [String(fixture.creatorA._id)],
        mainExecutor: String(fixture.creatorA._id),
        attachments: [{ path: '/uploads/forged.png', filename: 'forged.png' }]
      })
      .expect(400);
    assert.equal(forged.body.code, 'FILE_ATTACHMENT_INVALID');
    assert.equal(await Task.exists({ taskName: 'Forged path task' }), null);
  });

  await t.test('task creation binds trusted metadata and replacement soft-deletes old assets', async () => {
    managedFile = await upload(fixture.creatorToken, 'task-original.png');
    const created = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({
        taskName: 'Managed attachment task',
        plannedCompletionTime: new Date(Date.now() + 86_400_000),
        executor: [String(fixture.creatorA._id)],
        mainExecutor: String(fixture.creatorA._id),
        attachments: [{ fileId: managedFile._id }]
      })
      .expect(201);
    managedTaskId = created.body.task._id;

    let storedTask = await Task.findById(managedTaskId).lean();
    assert.equal(String(storedTask.attachments[0].fileId), managedFile._id);
    assert.equal(storedTask.attachments[0].originalName, 'task-original.png');
    assert.equal(storedTask.attachments[0].mimeType, 'image/png');
    assert.equal(storedTask.attachments[0].path, undefined);
    assert.equal(storedTask.attachments[0].filename, undefined);

    let storedFile = await FileAsset.findById(managedFile._id).lean();
    assert.equal(storedFile.ownerType, 'TASK');
    assert.equal(String(storedFile.ownerId), managedTaskId);
    assert.equal(storedFile.status, 'ACTIVE');

    const replacement = await upload(fixture.creatorToken, 'task-replacement.png');
    await request(app)
      .put(`/api/tasks/${managedTaskId}`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({ attachments: [{ fileId: replacement._id }] })
      .expect(200);

    storedTask = await Task.findById(managedTaskId).lean();
    assert.deepEqual(storedTask.attachments.map((item) => String(item.fileId)), [replacement._id]);
    assert.equal((await FileAsset.findById(managedFile._id).lean()).status, 'DELETED');
    assert.equal((await FileAsset.findById(replacement._id).lean()).status, 'ACTIVE');
    managedFile = replacement;
  });

  await t.test('cross-team file ids return 404 without changing business references', async () => {
    const teamBFile = await upload(fixture.memberBToken, 'team-b-private.png');
    const beforeCount = await Task.countDocuments({ teamId: fixture.teamA._id });
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({
        taskName: 'Cross team attachment task',
        plannedCompletionTime: new Date(Date.now() + 86_400_000),
        executor: [String(fixture.creatorA._id)],
        mainExecutor: String(fixture.creatorA._id),
        attachments: [{ fileId: teamBFile._id }]
      })
      .expect(404);
    assert.equal(await Task.countDocuments({ teamId: fixture.teamA._id }), beforeCount);

    await request(app)
      .put(`/api/tasks/${managedTaskId}`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({ attachments: [{ fileId: teamBFile._id }] })
      .expect(404);
    const unchanged = await Task.findById(managedTaskId).lean();
    assert.deepEqual(unchanged.attachments.map((item) => String(item.fileId)), [managedFile._id]);
    assert.equal((await FileAsset.findById(teamBFile._id).lean()).status, 'TEMPORARY');
  });

  await t.test('executor completion supports trusted replacement attachments', async () => {
    const first = await upload(fixture.creatorToken, 'completion-first.png');
    await request(app)
      .post(`/api/tasks/${fixture.completionTask._id}/complete`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({ completionNote: 'first completion', attachments: [{ fileId: first._id }] })
      .expect(200);
    assert.equal((await FileAsset.findById(first._id).lean()).ownerType, 'TASK_COMPLETION');

    const replacement = await upload(fixture.creatorToken, 'completion-replacement.png');
    await request(app)
      .put(`/api/tasks/${fixture.completionTask._id}/complete`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({ completionNote: 'updated completion', attachments: [{ fileId: replacement._id }] })
      .expect(200);

    const task = await Task.findById(fixture.completionTask._id).lean();
    const actorCompletion = task.executorCompletions.find(
      (item) => String(item.executor) === String(fixture.creatorA._id)
    );
    assert.deepEqual(actorCompletion.attachments.map((item) => String(item.fileId)), [replacement._id]);
    assert.equal(actorCompletion.attachments[0].path, undefined);
    assert.equal((await FileAsset.findById(first._id).lean()).status, 'DELETED');
    assert.equal((await FileAsset.findById(replacement._id).lean()).ownerType, 'TASK_COMPLETION');

    const viewerTemporary = await upload(fixture.viewerToken, 'viewer-temporary.png');
    await request(app)
      .patch(`/api/files/${viewerTemporary._id}/bind`)
      .set('Authorization', `Bearer ${fixture.viewerToken}`)
      .send({
        ownerType: 'TASK_COMPLETION',
        ownerId: String(fixture.completionTask._id)
      })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));
    await request(app)
      .delete(`/api/files/${replacement._id}`)
      .set('Authorization', `Bearer ${fixture.viewerToken}`)
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));

    await request(app)
      .patch(`/api/files/${viewerTemporary._id}/bind`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .send({ ownerType: 'TASK', ownerId: managedTaskId })
      .expect(404);
    assert.equal((await FileAsset.findById(viewerTemporary._id).lean()).status, 'TEMPORARY');
    assert.equal((await FileAsset.findById(replacement._id).lean()).status, 'ACTIVE');

    const executorEvidence = await upload(fixture.executor2Token, 'completion-executor-two.png');
    await request(app)
      .post(`/api/tasks/${fixture.completionTask._id}/complete`)
      .set('Authorization', `Bearer ${fixture.executor2Token}`)
      .send({
        completionNote: 'view-only executor completion',
        attachments: [{ fileId: executorEvidence._id }]
      })
      .expect(200);
    const completedTask = await Task.findById(fixture.completionTask._id).lean();
    const executorCompletion = completedTask.executorCompletions.find(
      (item) => String(item.executor) === String(fixture.executor2A._id)
    );
    assert.deepEqual(
      executorCompletion.attachments.map((item) => String(item.fileId)),
      [executorEvidence._id]
    );
    assert.equal(completedTask.status, 'pending_review');
    assert.equal((await FileAsset.findById(executorEvidence._id).lean()).ownerType, 'TASK_COMPLETION');
  });

  await t.test('a review-only member can upload and bind review evidence', async () => {
    const reviewFile = await upload(fixture.reviewerToken, 'review-evidence.png');
    await request(app)
      .post(`/api/tasks/${fixture.reviewTask._id}/review`)
      .set('Authorization', `Bearer ${fixture.reviewerToken}`)
      .send({
        content: 'review evidence accepted',
        result: 'approved',
        rating: 5,
        attachments: [{ fileId: reviewFile._id }]
      })
      .expect(200);

    const review = await TaskReview.findOne({ task: fixture.reviewTask._id }).lean();
    assert.equal(String(review.attachments[0].fileId), reviewFile._id);
    assert.equal(review.attachments[0].path, undefined);
    const storedFile = await FileAsset.findById(reviewFile._id).lean();
    assert.equal(storedFile.ownerType, 'TASK_REVIEW');
    assert.equal(String(storedFile.ownerId), String(fixture.reviewTask._id));

    const orphanReviewFile = await upload(fixture.reviewerToken, 'orphan-review.png');
    await request(app)
      .patch(`/api/files/${orphanReviewFile._id}/bind`)
      .set('Authorization', `Bearer ${fixture.reviewerToken}`)
      .send({
        ownerType: 'TASK_REVIEW',
        ownerId: String(fixture.reviewTask._id)
      })
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));
    await request(app)
      .delete(`/api/files/${reviewFile._id}`)
      .set('Authorization', `Bearer ${fixture.reviewerToken}`)
      .expect(409)
      .expect(({ body }) => assert.equal(body.code, 'FILE_WORKFLOW_OWNER_MANAGED'));
    assert.equal((await FileAsset.findById(orphanReviewFile._id).lean()).status, 'TEMPORARY');
    assert.equal((await FileAsset.findById(reviewFile._id).lean()).status, 'ACTIVE');
  });

  await t.test('managed task attachment downloads remain private and authenticated', async () => {
    const download = await request(app)
      .get(`/api/files/${managedFile._id}/download`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .expect('content-type', 'image/png')
      .expect('x-content-type-options', 'nosniff')
      .expect(200);
    assert.deepEqual(download.body, PNG_CONTENT);

    await request(app)
      .get(`/api/files/${managedFile._id}/download`)
      .set('Authorization', `Bearer ${fixture.memberBToken}`)
      .expect(404);

    await request(app)
      .put(`/api/tasks/${managedTaskId}`)
      .set('Authorization', `Bearer ${fixture.creatorToken}`)
      .field('taskName', 'Multipart update attempt')
      .attach('attachments', PNG_CONTENT, { filename: 'legacy-update.png', contentType: 'image/png' })
      .expect(415);
  });
});
