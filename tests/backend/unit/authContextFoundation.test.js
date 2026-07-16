'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DATA_SCOPE_MODULE_VALUES,
  DATA_SCOPES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../../../app/config/permissions');
const {
  buildPersistableSession,
  createAuthSessionService,
  hashJti,
  validateTokenClaims
} = require('../../../app/services/authSessionService');
const {
  GLOBAL_READ_ONLY_SCOPE,
  assertBusinessContext,
  assertPermission,
  createTeamContextService,
  resolveModuleDataScope
} = require('../../../app/services/teamContextService');
const {
  createBusinessWriteGuard,
  markControlPlaneOperation
} = require('../../../app/middlewares/businessWriteGuard');
const {
  createAuthContextMiddleware,
  getTrustedActiveTeamId,
  requirePermission
} = require('../../../app/middlewares/authContext');

const IDS = Object.freeze({
  user: '111111111111111111111111',
  team: '222222222222222222222222',
  orgUnit: '333333333333333333333333',
  session: '444444444444444444444444'
});

function claims(mode = SESSION_MODES.TEAM) {
  return {
    sub: IDS.user,
    jti: '8b31cff9-6bef-4a4c-b508-106af51ee40a',
    mode,
    activeTeamId: mode === SESSION_MODES.TEAM ? IDS.team : null,
    tokenVersion: 3
  };
}

function session(mode = SESSION_MODES.TEAM) {
  return {
    _id: IDS.session,
    userId: IDS.user,
    mode,
    activeTeamId: mode === SESSION_MODES.TEAM ? IDS.team : null,
    tokenVersion: 3,
    expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    revokedAt: null
  };
}

function membership(overrides = {}) {
  return {
    _id: '555555555555555555555555',
    teamId: IDS.team,
    userId: IDS.user,
    orgUnitId: IDS.orgUnit,
    role: MEMBERSHIP_ROLES.PROJECT_ADMIN,
    positionLevel: 3,
    positionKey: 'SUB_DEPARTMENT_MANAGER',
    functionalRoleKeys: [],
    permissionKeys: ['task.view', 'task.create'],
    moduleDataScopes: DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
      moduleKey,
      scope: DATA_SCOPES.ORG_UNIT
    })),
    status: MEMBERSHIP_STATUSES.ACTIVE,
    ...overrides
  };
}

function serviceFor({
  userOverrides,
  teamOverrides,
  membershipOverrides,
  findTeamById,
  findMembership,
  findOrgUnitById
} = {}) {
  return createTeamContextService({
    findUserById: async () => ({
      _id: IDS.user,
      username: 'test-user',
      name: 'Test User',
      status: 'active',
      roles: ['executor'],
      isSuperAdmin: false,
      tokenVersion: 3,
      ...userOverrides
    }),
    findTeamById: findTeamById || (async () => ({
      _id: IDS.team,
      name: 'Team A',
      code: 'TEAM_A',
      status: TEAM_STATUSES.ACTIVE,
      ...teamOverrides
    })),
    findMembership: findMembership || (async () => membership(membershipOverrides)),
    findOrgUnitById: findOrgUnitById || (async () => ({
      _id: IDS.orgUnit,
      teamId: IDS.team,
      status: ORG_UNIT_STATUSES.ACTIVE,
      level: 3,
      path: '/'
    }))
  });
}

async function invokeMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body, next: false });
      }
    };
    middleware(req, res, (error) => {
      if (error) reject(error);
      else resolve({ statusCode: res.statusCode, next: true });
    });
  });
}

test('validates the new JWT claims and requires a team only in TEAM mode', () => {
  assert.equal(validateTokenClaims(claims()).activeTeamId, IDS.team);
  assert.equal(
    validateTokenClaims(claims(SESSION_MODES.TEAM_SELECTION)).activeTeamId,
    null
  );
  assert.throws(
    () => validateTokenClaims({ ...claims(), activeTeamId: null }),
    (error) => error.code === 'AUTH_TOKEN_CLAIMS_INVALID'
  );
  assert.throws(
    () => validateTokenClaims({ ...claims(SESSION_MODES.TEAM_SELECTION), activeTeamId: IDS.team }),
    (error) => error.code === 'AUTH_TOKEN_CLAIMS_INVALID'
  );
});

test('queries an auth session by sha256 jti and never builds a raw-jti DB record', async () => {
  let receivedHash;
  const authSessionService = createAuthSessionService({
    findSessionByJtiHash: async (jtiHash) => {
      receivedHash = jtiHash;
      return session();
    },
    now: () => new Date('2030-01-01T00:00:00.000Z')
  });

  await authSessionService.resolveSession(claims());
  assert.equal(receivedHash, hashJti(claims().jti));
  assert.match(receivedHash, /^[a-f0-9]{64}$/);
  assert.notEqual(receivedHash, claims().jti);

  const record = buildPersistableSession({
    claims: claims(),
    issuedAt: new Date('2030-01-01T00:00:00.000Z'),
    expiresAt: new Date('2030-01-02T00:00:00.000Z')
  });
  assert.equal(record.jti, undefined);
  assert.equal(record.jtiHash, receivedHash);
});

test('rejects a session tokenVersion mismatch before building user context', async () => {
  const authSessionService = createAuthSessionService({
    findSessionByJtiHash: async () => session(),
    now: () => new Date('2030-01-01T00:00:00.000Z')
  });

  await assert.rejects(
    authSessionService.resolveSession({ ...claims(), tokenVersion: 4 }),
    (error) => error.code === 'AUTH_SESSION_MISMATCH' && error.status === 401
  );
});

test('auth middleware is dependency-injectable and publishes only server context', async () => {
  const request = {
    headers: { authorization: 'Bearer signed-token' },
    body: { teamId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }
  };
  const expectedContext = Object.freeze({
    authenticated: true,
    activeTeamId: IDS.team,
    user: Object.freeze({ _id: IDS.user })
  });
  const middleware = createAuthContextMiddleware({
    verifyToken: async (token) => {
      assert.equal(token, 'signed-token');
      return claims();
    },
    sessionService: {
      resolveSession: async (decoded) => ({
        claims: validateTokenClaims(decoded),
        session: session()
      })
    },
    teamContextService: {
      resolveContext: async () => expectedContext
    }
  });

  const result = await invokeMiddleware(middleware, request);
  assert.equal(result.next, true);
  assert.equal(request.authContext, expectedContext);
  assert.equal(request.user, expectedContext.user);
  assert.equal(request.authContext.activeTeamId, IDS.team);
  assert.equal(request.body.teamId, 'aaaaaaaaaaaaaaaaaaaaaaaa');
});

test('auth middleware returns a stable code when the bearer token is absent', async () => {
  const middleware = createAuthContextMiddleware({
    verifyToken: async () => {
      throw new Error('must not be called');
    },
    sessionService: { resolveSession: async () => null },
    teamContextService: { resolveContext: async () => null }
  });
  const result = await invokeMiddleware(middleware, { headers: {} });

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.code, 'AUTH_TOKEN_REQUIRED');
});

test('builds TEAM context from server-side membership and ignores request team fields', async () => {
  const context = await serviceFor().resolveContext({
    claims: validateTokenClaims(claims()),
    session: session()
  });

  assert.equal(context.activeTeamId, IDS.team);
  assert.equal(context.membership.orgUnitId, IDS.orgUnit);
  assert.equal(context.moduleDataScopes.task, DATA_SCOPES.ORG_UNIT);
  assert.equal(
    getTrustedActiveTeamId({
      authContext: context,
      headers: { 'x-team-id': 'aaaaaaaaaaaaaaaaaaaaaaaa' },
      query: { teamId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      body: { teamId: 'cccccccccccccccccccccccc' }
    }),
    IDS.team
  );
});

test('rejects a token whose version no longer matches the user', async () => {
  const service = serviceFor({ userOverrides: { tokenVersion: 4 } });
  await assert.rejects(
    service.resolveContext({
      claims: validateTokenClaims(claims()),
      session: session()
    }),
    (error) => error.code === 'AUTH_TOKEN_VERSION_MISMATCH' && error.status === 401
  );
});

test('TEAM_SELECTION cannot pass a business guard', async () => {
  const context = await serviceFor().resolveContext({
    claims: validateTokenClaims(claims(SESSION_MODES.TEAM_SELECTION)),
    session: session(SESSION_MODES.TEAM_SELECTION)
  });
  assert.throws(
    () => assertBusinessContext(context),
    (error) => error.code === 'BUSINESS_CONTEXT_REQUIRED'
  );

  const result = await invokeMiddleware(
    createBusinessWriteGuard(),
    { method: 'GET', authContext: context }
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'BUSINESS_CONTEXT_REQUIRED');
});

test('GLOBAL_READ_ONLY permits configured reads but blocks business writes', async () => {
  const context = await serviceFor({
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    userOverrides: { isSuperAdmin: true }
  }).resolveContext({
    claims: validateTokenClaims(claims(SESSION_MODES.GLOBAL_READ_ONLY)),
    session: session(SESSION_MODES.GLOBAL_READ_ONLY)
  });

  assert.doesNotThrow(() => assertPermission(context, 'task.view'));
  assert.throws(
    () => assertPermission(context, 'task.create'),
    (error) => error.code === 'PERMISSION_DENIED'
  );
  assert.equal(resolveModuleDataScope(context, 'task').scope, GLOBAL_READ_ONLY_SCOPE);

  const result = await invokeMiddleware(
    createBusinessWriteGuard(),
    { method: 'POST', authContext: context }
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'GLOBAL_READ_ONLY');
});

test('legacy admin role does not grant global access by default', async () => {
  await assert.rejects(
    serviceFor({
      userOverrides: { roles: ['admin'], isSuperAdmin: false }
    }).resolveContext({
      claims: validateTokenClaims(claims(SESSION_MODES.GLOBAL_READ_ONLY)),
      session: session(SESSION_MODES.GLOBAL_READ_ONLY)
    }),
    (error) => error.code === 'AUTH_SUPER_ADMIN_REQUIRED' && error.status === 403
  );
});

test('a super administrator enters any active team with server-derived full access', async () => {
  let membershipLookupCount = 0;
  const context = await serviceFor({
    userOverrides: { isSuperAdmin: true },
    findMembership: async () => {
      membershipLookupCount += 1;
      throw new Error('super administrators must not depend on membership');
    }
  }).resolveContext({
    claims: validateTokenClaims(claims()),
    session: session()
  });

  assert.equal(membershipLookupCount, 0);
  assert.equal(context.membership, null);
  assert.equal(context.orgUnit, null);
  assert.equal(context.readOnly, false);
  assert.doesNotThrow(() => assertPermission(context, 'equipment.status.approve'));
  for (const moduleKey of DATA_SCOPE_MODULE_VALUES) {
    assert.equal(context.moduleDataScopes[moduleKey], DATA_SCOPES.TEAM);
    assert.equal(resolveModuleDataScope(context, moduleKey).teamId, IDS.team);
  }

  const write = await invokeMiddleware(
    createBusinessWriteGuard(),
    { method: 'PATCH', authContext: context }
  );
  assert.equal(write.next, true);
});

test('disabled users, teams and memberships invalidate existing tokens with 401', async () => {
  const cases = [
    {
      service: serviceFor({ userOverrides: { status: 'inactive' } }),
      code: 'AUTH_USER_DISABLED'
    },
    {
      service: serviceFor({ teamOverrides: { status: TEAM_STATUSES.DISABLED } }),
      code: 'AUTH_TEAM_DISABLED'
    },
    {
      service: serviceFor({
        membershipOverrides: { status: MEMBERSHIP_STATUSES.DISABLED }
      }),
      code: 'AUTH_MEMBERSHIP_DISABLED'
    }
  ];

  for (const item of cases) {
    await assert.rejects(
      item.service.resolveContext({
        claims: validateTokenClaims(claims()),
        session: session()
      }),
      (error) => error.code === item.code && error.status === 401
    );
  }
});

test('missing TEAM authorization records invalidate existing tokens with 401', async () => {
  const cases = [
    {
      service: serviceFor({ findTeamById: async () => null }),
      code: 'AUTH_TEAM_NOT_FOUND'
    },
    {
      service: serviceFor({ findMembership: async () => null }),
      code: 'AUTH_MEMBERSHIP_REQUIRED'
    },
    {
      service: serviceFor({ findOrgUnitById: async () => null }),
      code: 'AUTH_ORG_UNIT_INVALID'
    }
  ];

  for (const item of cases) {
    await assert.rejects(
      item.service.resolveContext({
        claims: validateTokenClaims(claims()),
        session: session()
      }),
      (error) => error.code === item.code && error.status === 401
    );
  }
});

test('unknown permission keys fail during route middleware construction', () => {
  assert.throws(
    () => requirePermission('task.not-configured'),
    /Unknown permission key/
  );
  assert.equal(typeof requirePermission('task.view'), 'function');
});

test('only an explicitly allowlisted control-plane operation bypasses the write block', async () => {
  const context = await serviceFor({
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    userOverrides: { isSuperAdmin: true }
  }).resolveContext({
    claims: validateTokenClaims(claims(SESSION_MODES.GLOBAL_READ_ONLY)),
    session: session(SESSION_MODES.GLOBAL_READ_ONLY)
  });
  const req = { method: 'POST', authContext: context };

  await invokeMiddleware(markControlPlaneOperation('auth.enterTeam'), req);
  const allowed = await invokeMiddleware(
    createBusinessWriteGuard({
      allowedControlPlaneOperations: ['auth.enterTeam']
    }),
    req
  );
  assert.equal(allowed.next, true);

  const denied = await invokeMiddleware(createBusinessWriteGuard(), req);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'CONTROL_PLANE_OPERATION_DENIED');
});

test('invalid permission and module-scope records fail closed', async () => {
  await assert.rejects(
    serviceFor({
      membershipOverrides: { permissionKeys: ['task.view', 'not.configured'] }
    }).resolveContext({
      claims: validateTokenClaims(claims()),
      session: session()
    }),
    (error) => error.code === 'AUTH_MEMBERSHIP_INVALID'
  );

  await assert.rejects(
    serviceFor({
      membershipOverrides: {
        moduleDataScopes: [{ moduleKey: 'task', scope: DATA_SCOPES.TEAM }]
      }
    }).resolveContext({
      claims: validateTokenClaims(claims()),
      session: session()
    }),
    (error) => error.code === 'DATA_SCOPE_INVALID'
  );
});
