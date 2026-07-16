'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Message = require('../../../app/models/Message');
const {
  notifyTaskAssigned,
  notifyTaskDeleted,
  sendSystemNotification
} = require('../../../app/utils/notificationHelper');

const TEAM_ID = '64b000000000000000000002';
const TASK_ID = '64b000000000000000000003';
const USER_ID = '64b000000000000000000004';

test('notification helpers reject operations without a trusted team', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      notifyTaskAssigned({ _id: TASK_ID, taskName: 'Task' }, [USER_ID], USER_ID),
      /trusted teamId/
    );
    await assert.rejects(
      notifyTaskDeleted('Task', [USER_ID], USER_ID),
      /trusted teamId/
    );
    await assert.rejects(
      sendSystemNotification('Title', 'Content', [USER_ID]),
      /trusted teamId/
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('task notifications stamp every inserted message with the task team', async () => {
  const originalInsertMany = Message.insertMany;
  const originalConsoleLog = console.log;
  let captured;
  Message.insertMany = async (messages) => {
    captured = messages;
    return messages;
  };
  console.log = () => {};

  try {
    await notifyTaskAssigned(
      {
        _id: TASK_ID,
        teamId: TEAM_ID,
        taskName: 'Tenant Task',
        plannedCompletionTime: new Date('2030-01-01T00:00:00.000Z')
      },
      [USER_ID],
      USER_ID
    );
  } finally {
    Message.insertMany = originalInsertMany;
    console.log = originalConsoleLog;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].teamId, TEAM_ID);
  assert.equal(captured[0].relatedTask, TASK_ID);
});
