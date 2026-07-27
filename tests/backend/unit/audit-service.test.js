'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const permissions = require('../../../app/config/permissions');
const {
  CIRCULAR_VALUE,
  FILE_CONTENT_OMITTED_VALUE,
  MAX_DEPTH_VALUE,
  REDACTED_VALUE,
  byteLength,
  createAuditService,
  sanitizeAuditSnapshot,
  sanitizeAuditSnapshots
} = require('../../../app/services/auditService');

function fakeAuditModel(createImplementation = async (payload) => payload) {
  const calls = [];
  const bulkCalls = [];
  return {
    calls,
    bulkCalls,
    async create(...args) {
      calls.push(args);
      return createImplementation(...args);
    },
    async bulkWrite(...args) {
      bulkCalls.push(args);
      return { insertedCount: args[0].length };
    }
  };
}

test('recursively redacts credentials and omits binary and file content', () => {
  const snapshot = sanitizeAuditSnapshot({
    username: 'operator',
    password: 'plain text',
    nested: {
      passwordHash: 'hash',
      access_token: 'jwt',
      headers: {
        Authorization: 'Bearer secret',
        cookie: 'sid=secret'
      }
    },
    raw: Buffer.from('file bytes'),
    upload: {
      originalname: 'evidence.txt',
      mimetype: 'text/plain',
      size: 12,
      content: 'actual file body'
    }
  });

  assert.equal(snapshot.username, 'operator');
  assert.equal(snapshot.password, REDACTED_VALUE);
  assert.equal(snapshot.nested.passwordHash, REDACTED_VALUE);
  assert.equal(snapshot.nested.access_token, REDACTED_VALUE);
  assert.equal(snapshot.nested.headers.Authorization, REDACTED_VALUE);
  assert.equal(snapshot.nested.headers.cookie, REDACTED_VALUE);
  assert.match(snapshot.raw, /BINARY OMITTED/);
  assert.equal(snapshot.upload.content, FILE_CONTENT_OMITTED_VALUE);
  assert.equal(Buffer.isBuffer(snapshot.raw), false);
});

test('enforces depth, array, string, and serialized snapshot limits', () => {
  const structurallyLimited = sanitizeAuditSnapshot({
    message: 'abcdefghijklmnopqrstuvwxyz',
    values: [1, 2, 3, 4],
    deep: { child: { grandchild: true } }
  }, {
    maxDepth: 2,
    maxArrayLength: 3,
    maxStringLength: 16,
    maxSnapshotBytes: 2048,
    maxTotalSnapshotBytes: 4096
  });

  assert.equal(structurallyLimited.message.length, 16);
  assert.equal(structurallyLimited.values.length, 3);
  assert.match(structurallyLimited.values[2], /ARRAY ITEMS OMITTED/);
  assert.equal(structurallyLimited.deep.child, MAX_DEPTH_VALUE);

  const byteLimited = sanitizeAuditSnapshot({
    rows: Array.from({ length: 100 }, (_, index) => ({
      index,
      value: `row-${index}-${'x'.repeat(100)}`
    }))
  }, {
    maxSnapshotBytes: 256,
    maxTotalSnapshotBytes: 256
  });

  assert.ok(byteLength(byteLimited) <= 256);
  assert.equal(byteLimited._truncated, true);

  const combined = sanitizeAuditSnapshots({
    before: { value: 'a'.repeat(1000) },
    after: { value: 'b'.repeat(1000) }
  }, {
    maxSnapshotBytes: 200,
    maxTotalSnapshotBytes: 100
  });
  assert.ok(byteLength(combined.before) + byteLength(combined.after) <= 100);
});

test('represents circular references without retaining the original object', () => {
  const input = { name: 'root' };
  input.self = input;
  input.child = { parent: input };

  const snapshot = sanitizeAuditSnapshot(input);

  assert.equal(snapshot.self, CIRCULAR_VALUE);
  assert.equal(snapshot.child.parent, CIRCULAR_VALUE);
  assert.notEqual(snapshot, input);
});

test('propagates audit persistence failures and rejects unknown enums', async () => {
  const persistenceError = new Error('audit database unavailable');
  const AuditLog = fakeAuditModel(async () => {
    throw persistenceError;
  });
  const service = createAuditService({ AuditLog });

  await assert.rejects(
    service.recordSystem({
      action: permissions.AUDIT_ACTIONS.CREATE,
      resourceType: permissions.AUDIT_RESOURCE_TYPES.SYSTEM
    }),
    (error) => error === persistenceError
  );

  await assert.rejects(
    service.recordSystem({
      action: 'UNCONFIGURED_ACTION',
      resourceType: permissions.AUDIT_RESOURCE_TYPES.SYSTEM
    }),
    /not configured/
  );
  assert.equal(AuditLog.calls.length, 1);
});

test('maps request and auth context and passes a mongoose session unchanged', async () => {
  const actorUserId = '507f1f77bcf86cd799439011';
  const activeTeamId = '507f1f77bcf86cd799439012';
  const targetTeamId = '507f1f77bcf86cd799439013';
  const mongooseSession = { id: 'transaction-session' };
  const AuditLog = fakeAuditModel(async (documents) => documents);
  const service = createAuditService({ AuditLog });
  const req = {
    id: 'request-123',
    method: 'patch',
    baseUrl: '/api/tasks',
    path: '/task-9',
    originalUrl: '/api/tasks/task-9?token=must-not-be-captured',
    ip: '10.10.0.8',
    targetTeamId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    headers: { 'user-agent': 'audit-service-test' },
    authContext: {
      userId: actorUserId,
      actorRole: permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN,
      mode: permissions.SESSION_MODES.TEAM,
      activeTeamId
    }
  };

  const persisted = await service.record({
    req,
    action: permissions.AUDIT_ACTIONS.UPDATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TASK,
    resourceId: 'task-9',
    targetTeamId,
    before: { status: 'draft' },
    after: { status: 'published' },
    session: mongooseSession
  });

  assert.equal(AuditLog.calls.length, 1);
  const [documents, options] = AuditLog.calls[0];
  assert.equal(documents.length, 1);
  assert.equal(options.session, mongooseSession);
  assert.equal(persisted, documents[0]);

  const payload = documents[0];
  assert.equal(payload.actorUserId, actorUserId);
  assert.equal(payload.actorRole, permissions.AUDIT_ACTOR_ROLES.PROJECT_ADMIN);
  assert.equal(payload.actorMode, permissions.SESSION_MODES.TEAM);
  assert.equal(payload.activeTeamId, activeTeamId);
  assert.equal(payload.targetTeamId, targetTeamId);
  assert.equal(payload.requestId, 'request-123');
  assert.equal(payload.requestMethod, 'PATCH');
  assert.equal(payload.requestPath, '/api/tasks/task-9');
  assert.equal(payload.ip, '10.10.0.8');
  assert.equal(payload.userAgent, 'audit-service-test');
  assert.doesNotMatch(payload.requestPath, /token/);
});

test('bulk system audits retain one sanitized insert per resource in the transaction', async () => {
  const AuditLog = fakeAuditModel();
  const service = createAuditService({ AuditLog });
  const session = { id: 'bulk-audit-session' };

  const result = await service.recordManySystem([
    {
      action: permissions.AUDIT_ACTIONS.DELETE,
      resourceType: permissions.AUDIT_RESOURCE_TYPES.MESSAGE,
      resourceId: 'message-1',
      before: { password: 'secret', state: 'old' },
      after: { deleted: true }
    },
    {
      action: permissions.AUDIT_ACTIONS.CORRECT,
      resourceType: permissions.AUDIT_RESOURCE_TYPES.MESSAGE,
      resourceId: 'message-2',
      before: { state: 'old' },
      after: { state: 'new' }
    }
  ], { session });

  assert.equal(result.insertedCount, 2);
  assert.equal(AuditLog.bulkCalls.length, 1);
  const [operations, options] = AuditLog.bulkCalls[0];
  assert.equal(options.session, session);
  assert.equal(operations.length, 2);
  assert.equal(operations[0].insertOne.document.actorRole, permissions.AUDIT_ACTOR_ROLES.SYSTEM);
  assert.equal(operations[0].insertOne.document.before.password, REDACTED_VALUE);
  assert.equal(operations[1].insertOne.document.resourceId, 'message-2');
});

test('redacts credentials from scalar fields before audit persistence', async () => {
  const secrets = [
    'request-secret',
    'user-agent-secret',
    'resource-secret',
    'reason-secret'
  ];
  const AuditLog = fakeAuditModel();
  const service = createAuditService({ AuditLog });

  await service.recordSystem({
    req: {
      id: 'trace token=request-secret;segment=7',
      method: 'POST',
      ip: '10.10.0.9',
      headers: {
        'user-agent': 'audit-client Bearer user-agent-secret; build/1'
      }
    },
    action: permissions.AUDIT_ACTIONS.UPDATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.SYSTEM,
    resourceId: 'system credential=resource-secret;revision=2',
    reason: 'normal reason; password=reason-secret; keep this'
  });

  const payload = AuditLog.calls[0][0];
  assert.equal(payload.requestId, 'trace token=[REDACTED];segment=7');
  assert.equal(payload.userAgent, 'audit-client Bearer [REDACTED]; build/1');
  assert.equal(payload.resourceId, 'system credential=[REDACTED];revision=2');
  assert.equal(payload.reason, 'normal reason; password=[REDACTED]; keep this');
  assert.equal(payload.ip, '10.10.0.9');

  const persistedText = JSON.stringify(payload);
  for (const secret of secrets) {
    assert.doesNotMatch(persistedText, new RegExp(secret));
  }
});

test('does not trust a request-level targetTeamId when none is explicitly supplied', async () => {
  const activeTeamId = '507f1f77bcf86cd799439012';
  const AuditLog = fakeAuditModel();
  const service = createAuditService({ AuditLog });

  await service.record({
    req: {
      method: 'POST',
      targetTeamId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      authContext: {
        userId: '507f1f77bcf86cd799439011',
        actorRole: permissions.AUDIT_ACTOR_ROLES.MEMBER,
        mode: permissions.SESSION_MODES.TEAM,
        activeTeamId
      }
    },
    action: permissions.AUDIT_ACTIONS.CREATE,
    resourceType: permissions.AUDIT_RESOURCE_TYPES.TASK
  });

  assert.equal(AuditLog.calls[0][0].targetTeamId, activeTeamId);
});
