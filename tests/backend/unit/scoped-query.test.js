'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DATA_SCOPES,
  DATA_SCOPE_MODULE_VALUES,
  SESSION_MODES
} = require('../../../app/config/permissions');
const {
  assertRelatedResourcesInActiveTeam,
  buildRequestScopedFilter,
  buildScopedDetailFilter,
  buildScopedFilter,
  loadRelatedResourcesInActiveTeam
} = require('../../../app/services/scopedQueryService');
const { buildTaskDetailFilter } = require('../../../app/services/taskAccessService');

const IDS = Object.freeze({
  team: '111111111111111111111111',
  otherTeam: '222222222222222222222222',
  orgUnit: '333333333333333333333333',
  resource: '444444444444444444444444',
  related: '555555555555555555555555'
});

function teamContext(scope = DATA_SCOPES.TEAM, equipmentOrgUnitScopeIds = undefined) {
  return Object.freeze({
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    activeTeamId: IDS.team,
    membership: Object.freeze({ orgUnitId: IDS.orgUnit }),
    moduleDataScopes: Object.freeze(Object.fromEntries(
      DATA_SCOPE_MODULE_VALUES.map((moduleKey) => [moduleKey, scope])
    )),
    ...(equipmentOrgUnitScopeIds
      ? { equipmentOrgUnitScopeIds: Object.freeze([...equipmentOrgUnitScopeIds]) }
      : {})
  });
}

function globalContext() {
  return Object.freeze({
    authenticated: true,
    mode: SESSION_MODES.GLOBAL_READ_ONLY,
    activeTeamId: null,
    membership: null,
    moduleDataScopes: Object.freeze({})
  });
}

test('ORG_UNIT scope stays outside a keyword $or and cannot be bypassed', () => {
  const keywordFilter = {
    $or: [
      { title: /pump/i },
      { teamId: IDS.otherTeam }
    ]
  };
  const filter = buildScopedFilter({
    authContext: teamContext(DATA_SCOPES.ORG_UNIT),
    moduleKey: 'equipment',
    userFilter: keywordFilter
  });

  assert.deepEqual(filter, {
    $and: [
      { teamId: IDS.team, orgUnitId: IDS.orgUnit },
      keywordFilter
    ]
  });
  assert.equal(filter.$and[0].teamId, IDS.team);
  assert.equal(filter.$and[0].orgUnitId, IDS.orgUnit);
});

test('equipment ORG_UNIT branch scope uses a trusted id set and retains the team boundary', () => {
  const childOrgUnitId = '666666666666666666666666';
  const siblingGroupId = '777777777777777777777777';
  const filter = buildScopedFilter({
    authContext: teamContext(DATA_SCOPES.ORG_UNIT, [
      IDS.orgUnit,
      childOrgUnitId,
      siblingGroupId
    ]),
    moduleKey: 'equipment',
    userFilter: {
      $or: [
        { status: 'IN_USE' },
        { teamId: IDS.otherTeam }
      ]
    }
  });

  assert.deepEqual(filter.$and[0], {
    teamId: IDS.team,
    orgUnitId: { $in: [IDS.orgUnit, childOrgUnitId, siblingGroupId] }
  });
  assert.equal(filter.$and[0].teamId, IDS.team);
  assert.equal(JSON.stringify(filter.$and[0]).includes(IDS.otherTeam), false);
});

test('TEAM scope forces teamId without adding an organization restriction', () => {
  const filter = buildScopedFilter({
    authContext: teamContext(DATA_SCOPES.TEAM),
    moduleKey: 'task',
    userFilter: { status: 'open' }
  });

  assert.deepEqual(filter, {
    $and: [
      { teamId: IDS.team },
      { status: 'open' }
    ]
  });
  assert.equal(filter.$and[0].orgUnitId, undefined);
});

test('request body, query and headers cannot override the active team', () => {
  const filter = buildRequestScopedFilter({
    method: 'GET',
    authContext: teamContext(DATA_SCOPES.TEAM),
    headers: { 'x-team-id': IDS.otherTeam },
    query: { teamId: IDS.otherTeam },
    body: { teamId: IDS.otherTeam }
  }, {
    moduleKey: 'task',
    userFilter: { status: 'open' },
    globalTeamId: IDS.otherTeam
  });

  assert.deepEqual(filter, {
    $and: [
      { teamId: IDS.team },
      { status: 'open' }
    ]
  });
  assert.equal(JSON.stringify(filter).includes(IDS.otherTeam), false);
});

test('detail filters bind _id and teamId in the same trusted constraint', () => {
  const filter = buildScopedDetailFilter({
    authContext: teamContext(DATA_SCOPES.ORG_UNIT),
    moduleKey: 'equipment',
    id: IDS.resource,
    userFilter: { deletedAt: null }
  });

  assert.deepEqual(filter, {
    $and: [
      {
        _id: IDS.resource,
        teamId: IDS.team,
        orgUnitId: IDS.orgUnit
      },
      { deletedAt: null }
    ]
  });
});

test('GLOBAL_READ_ONLY accepts only an explicit optional team constraint', () => {
  assert.throws(
    () => buildScopedFilter({
      authContext: globalContext(),
      moduleKey: 'task'
    }),
    (error) => error.code === 'GLOBAL_READ_ONLY'
  );

  const unfiltered = buildRequestScopedFilter({
    method: 'GET',
    authContext: globalContext(),
    query: { teamId: IDS.otherTeam },
    body: { teamId: IDS.otherTeam },
    headers: { 'x-team-id': IDS.otherTeam }
  }, {
    moduleKey: 'task',
    userFilter: { status: 'open' }
  });
  assert.deepEqual(unfiltered, {
    $and: [{}, { status: 'open' }]
  });

  const explicitlyFiltered = buildRequestScopedFilter({
    method: 'GET',
    authContext: globalContext(),
    query: { teamId: IDS.team }
  }, {
    moduleKey: 'task',
    userFilter: { status: 'open' },
    globalTeamId: IDS.otherTeam
  });
  assert.deepEqual(explicitlyFiltered, {
    $and: [
      { teamId: IDS.otherTeam },
      { status: 'open' }
    ]
  });

  assert.throws(
    () => buildRequestScopedFilter({
      method: 'POST',
      authContext: globalContext()
    }, {
      moduleKey: 'task'
    }),
    (error) => error.code === 'GLOBAL_READ_ONLY' && error.status === 403
  );
});

test('task detail helpers preserve the explicit GLOBAL_READ_ONLY team filter', () => {
  const filter = buildTaskDetailFilter({
    method: 'GET',
    authContext: globalContext(),
    query: { teamId: IDS.otherTeam }
  }, IDS.resource);

  assert.deepEqual(filter, {
    $and: [
      { _id: IDS.resource, teamId: IDS.otherTeam },
      {}
    ]
  });
});

test('TEAM_SELECTION and unknown modules fail closed', () => {
  assert.throws(
    () => buildScopedFilter({
      authContext: {
        authenticated: true,
        mode: SESSION_MODES.TEAM_SELECTION,
        activeTeamId: null
      },
      moduleKey: 'task'
    }),
    (error) => error.code === 'BUSINESS_CONTEXT_REQUIRED'
  );

  assert.throws(
    () => buildScopedFilter({
      authContext: teamContext(),
      moduleKey: 'not-configured'
    }),
    (error) => error.code === 'DATA_SCOPE_MODULE_UNKNOWN'
  );
});

test('missing and cross-team related objects return the same 400 error', () => {
  const context = teamContext();
  const assertInvalid = (resource) => assert.throws(
    () => assertRelatedResourcesInActiveTeam(context, resource),
    (error) => (
      error.status === 400 &&
      error.code === 'RELATED_RESOURCE_INVALID' &&
      error.message === 'One or more related resources are invalid for the active team'
    )
  );

  assertInvalid(null);
  assertInvalid({ _id: IDS.related, teamId: IDS.otherTeam });
  const valid = { _id: IDS.related, teamId: IDS.team };
  assert.equal(assertRelatedResourcesInActiveTeam(context, valid), valid);
});

test('related-resource loader queries by both id and active team', async () => {
  const receivedFilters = [];
  const resources = await loadRelatedResourcesInActiveTeam({
    authContext: teamContext(),
    resourceIds: [IDS.related],
    findOne: async (filter) => {
      receivedFilters.push(filter);
      return { _id: filter._id, teamId: filter.teamId };
    }
  });

  assert.deepEqual(receivedFilters, [{
    _id: IDS.related,
    teamId: IDS.team
  }]);
  assert.equal(resources[0].teamId, IDS.team);
});
