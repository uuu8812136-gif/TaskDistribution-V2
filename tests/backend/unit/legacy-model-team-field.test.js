'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const Task = require('../../../app/models/Task');
const TaskReview = require('../../../app/models/TaskReview');
const ExtensionRequest = require('../../../app/models/ExtensionRequest');
const Message = require('../../../app/models/Message');

const MODELS = [Task, TaskReview, ExtensionRequest, Message];

function objectId() {
  return new mongoose.Types.ObjectId();
}

function validAttributes(Model, overrides = {}) {
  const attributesByModel = {
    Task: {
      taskName: 'Tenant-scoped task',
      creator: objectId(),
      orgUnitId: objectId(),
      plannedCompletionTime: new Date('2030-01-01T00:00:00.000Z')
    },
    TaskReview: {
      task: objectId(),
      reviewer: objectId(),
      content: 'Reviewed'
    },
    ExtensionRequest: {
      task: objectId(),
      applicant: objectId(),
      requestType: 'main_task',
      reason: 'More time is required',
      originalCompletionTime: new Date('2030-01-01T00:00:00.000Z')
    },
    Message: {
      type: 'system',
      title: 'Notification',
      content: 'Notification content',
      recipient: objectId()
    }
  };

  return { ...attributesByModel[Model.modelName], ...overrides };
}

test('legacy business documents require an immutable ProjectTeam reference', async () => {
  for (const Model of MODELS) {
    const teamPath = Model.schema.path('teamId');

    assert.ok(teamPath, `${Model.modelName} must define teamId`);
    assert.equal(teamPath.instance, 'ObjectId');
    assert.equal(teamPath.options.ref, 'ProjectTeam');
    assert.equal(teamPath.options.required, true);
    assert.equal(teamPath.options.immutable, true);

    await assert.rejects(
      new Model(validAttributes(Model)).validate(),
      (error) => error?.errors?.teamId?.kind === 'required',
      `${Model.modelName} must reject a missing teamId`
    );

    const originalTeamId = objectId();
    const persistedDocument = new Model(validAttributes(Model, { teamId: originalTeamId }));
    persistedDocument.$isNew = false;
    persistedDocument.teamId = objectId();
    assert.equal(
      persistedDocument.teamId.toString(),
      originalTeamId.toString(),
      `${Model.modelName} must ignore teamId reassignment after persistence`
    );
  }
});

test('every declared legacy-model index starts with teamId', () => {
  for (const Model of MODELS) {
    const indexes = Model.schema.indexes();
    assert.ok(indexes.length > 0, `${Model.modelName} must declare tenant-aware indexes`);

    for (const [fields] of indexes) {
      assert.equal(
        Object.keys(fields)[0],
        'teamId',
        `${Model.modelName} index ${JSON.stringify(fields)} must be team-prefixed`
      );
    }
  }
});

test('Task requires an organization unit for ORG_UNIT data scope', async () => {
  const task = new Task(validAttributes(Task, {
    teamId: objectId(),
    orgUnitId: undefined
  }));

  await assert.rejects(
    task.validate(),
    (error) => error?.errors?.orgUnitId?.kind === 'required'
  );
});

test('TaskReview uniqueness is scoped to team, task, and reviewer', () => {
  const uniqueIndexes = TaskReview.schema.indexes().filter(([, options]) => options.unique);

  assert.equal(uniqueIndexes.length, 1);
  assert.deepEqual(uniqueIndexes[0][0], { teamId: 1, task: 1, reviewer: 1 });
});

test('embedded Task records cannot carry an independent teamId', () => {
  const teamId = objectId();
  const forgedTeamId = objectId();
  const task = new Task(validAttributes(Task, {
    teamId,
    attachments: [{ filename: 'source.txt', teamId: forgedTeamId }],
    completionAttachments: [{ filename: 'result.txt', teamId: forgedTeamId }],
    executorCompletions: [{
      executor: objectId(),
      teamId: forgedTeamId,
      attachments: [{ filename: 'proof.txt', teamId: forgedTeamId }]
    }]
  }));

  assert.equal(task.teamId.toString(), teamId.toString());
  assert.equal(task.attachments[0].teamId, undefined);
  assert.equal(task.completionAttachments[0].teamId, undefined);
  assert.equal(task.executorCompletions[0].teamId, undefined);
  assert.equal(task.executorCompletions[0].attachments[0].teamId, undefined);
});

test('Task virtual population and Message static operations require a team scope', async () => {
  const teamId = objectId();
  const parentTask = new Task(validAttributes(Task, { teamId }));
  const subTaskVirtual = Task.schema.virtuals.subTasks.options;

  assert.deepEqual(subTaskVirtual.match(parentTask), { teamId });

  await assert.rejects(Message.getUnreadCount(objectId()), /trusted teamId/);
  await assert.rejects(
    Message.markMultipleAsRead([objectId()], objectId()),
    /trusted teamId/
  );
  await assert.rejects(Message.deleteUserMessages(objectId()), /trusted teamId/);
});
