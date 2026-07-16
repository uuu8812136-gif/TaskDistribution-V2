'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryServer } = appRequire('mongodb-memory-server');
const { SESSION_MODES } = require('../../../app/config/permissions');
const messageController = require('../../../app/controllers/messageController');
const Message = require('../../../app/models/Message');

const TEST_DATABASE_NAME = `messages_${randomUUID().replaceAll('-', '')}_v2_test`;
const USER_ID = new mongoose.Types.ObjectId();
const TEAM_A_ID = new mongoose.Types.ObjectId();
const TEAM_B_ID = new mongoose.Types.ObjectId();
let mongoServer;

function request(overrides = {}) {
  return {
    method: 'GET',
    params: {},
    query: {},
    body: {},
    authContext: {
      authenticated: true,
      mode: SESSION_MODES.TEAM,
      activeTeamId: TEAM_A_ID.toString(),
      userId: USER_ID.toString()
    },
    ...overrides
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function createMessage(teamId, title) {
  return Message.create({
    teamId,
    type: 'system',
    title,
    content: `${title} content`,
    recipient: USER_ID
  });
}

before(async () => {
  mongoServer = await MongoMemoryServer.create({
    instance: { dbName: TEST_DATABASE_NAME }
  });
  await mongoose.connect(mongoServer.getUri(TEST_DATABASE_NAME), {
    dbName: TEST_DATABASE_NAME
  });
  await Message.syncIndexes();
});

beforeEach(async () => {
  await Message.collection.deleteMany({});
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

test('message list and detail cannot read another team and GET has no write side effect', async () => {
  const teamA = await createMessage(TEAM_A_ID, 'A message');
  const teamB = await createMessage(TEAM_B_ID, 'B message');

  const listRes = response();
  await messageController.getMessages(request(), listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.messages.length, 1);
  assert.equal(listRes.body.messages[0]._id.toString(), teamA._id.toString());

  const deniedRes = response();
  await messageController.getMessageById(
    request({ params: { id: teamB._id.toString() } }),
    deniedRes
  );
  assert.equal(deniedRes.statusCode, 404);

  const detailRes = response();
  await messageController.getMessageById(
    request({ params: { id: teamA._id.toString() } }),
    detailRes
  );
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.body.message.isRead, false);
  assert.equal((await Message.findById(teamA._id)).isRead, false);
});

test('mixed-team bulk read and delete only mutate the active team', async () => {
  const teamA = await createMessage(TEAM_A_ID, 'A message');
  const teamB = await createMessage(TEAM_B_ID, 'B message');
  const ids = [teamA._id.toString(), teamB._id.toString()];

  const readRes = response();
  await messageController.markMultipleAsRead(
    request({ method: 'PUT', body: { messageIds: ids } }),
    readRes
  );
  assert.equal(readRes.body.modifiedCount, 1);
  assert.equal((await Message.findById(teamA._id)).isRead, true);
  assert.equal((await Message.findById(teamB._id)).isRead, false);

  const deleteRes = response();
  await messageController.deleteMultipleMessages(
    request({ method: 'DELETE', body: { messageIds: ids } }),
    deleteRes
  );
  assert.equal(deleteRes.body.deletedCount, 1);
  assert.equal(await Message.exists({ _id: teamA._id }), null);
  assert.ok(await Message.exists({ _id: teamB._id }));
});
