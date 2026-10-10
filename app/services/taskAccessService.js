'use strict';

const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES
} = require('../config/permissions');
const {
  SCOPED_QUERY_ERROR_CODES,
  buildRequestScopedFilter,
  buildScopedDetailFilter,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { lockActiveOrgUnitReference } = require('./orgUnitReferenceService');
const { AuthContextError } = require('./authContextError');

function relatedResourceError() {
  return new AuthContextError(
    400,
    SCOPED_QUERY_ERROR_CODES.RELATED_RESOURCE_INVALID,
    'One or more related resources are invalid for the active team'
  );
}

function taskScopeForMembership(membership) {
  const configuredScope = (membership?.moduleDataScopes || []).find(
    (entry) => entry?.moduleKey === DATA_SCOPE_MODULES.TASK
  )?.scope;
  return configuredScope === DATA_SCOPES.TEAM
    ? DATA_SCOPES.TEAM
    : DATA_SCOPES.ORG_UNIT;
}

function assertTaskParticipantOrgUnits({
  authContext,
  memberships,
  allowedOrgUnitIds = null,
  taskOrgUnitId = null,
  enforceActorOrgScope = true
} = {}) {
  const context = assertTeamContext(authContext);
  const participantMemberships = Array.isArray(memberships) ? memberships : [];
  const actorScope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.TASK);

  // Organization-scoped operators cannot assign anyone outside their own unit,
  // including a team-wide manager whose primary membership is elsewhere.
  if (
    enforceActorOrgScope &&
    actorScope.scope === DATA_SCOPES.ORG_UNIT &&
    participantMemberships.some(
      (membership) => !sameId(membership.orgUnitId, actorScope.orgUnitId)
    )
  ) {
    throw relatedResourceError();
  }

  if (!allowedOrgUnitIds && !taskOrgUnitId) return participantMemberships;

  // Prefer the precomputed task organization subtree; fall back to the exact
  // task organization unit when no subtree was resolved.
  const allowedSet = new Set(
    (Array.isArray(allowedOrgUnitIds) ? allowedOrgUnitIds : [taskOrgUnitId])
      .map((orgUnitId) => String(orgUnitId).toLowerCase())
  );
  if (taskOrgUnitId) {
    let normalizedTaskOrgUnitId;
    try {
      normalizedTaskOrgUnitId = normalizeObjectId(taskOrgUnitId, 'taskOrgUnitId');
    } catch {
      throw relatedResourceError();
    }
    allowedSet.add(normalizedTaskOrgUnitId);
  }

  // Team-wide participants can see every unit. Everyone else must belong to
  // the task organization subtree, otherwise the assignment would be invisible.
  if (participantMemberships.some((membership) => (
    taskScopeForMembership(membership) !== DATA_SCOPES.TEAM &&
    !allowedSet.has(String(membership.orgUnitId).toLowerCase())
  ))) {
    throw relatedResourceError();
  }
  return participantMemberships;
}

async function resolveTaskOrgUnitSubtreeIds({
  teamId,
  orgUnitId,
  session = null
} = {}) {
  if (orgUnitId === null || orgUnitId === undefined) return null;
  let normalizedOrgUnitId;
  try {
    normalizedOrgUnitId = normalizeObjectId(orgUnitId, 'orgUnitId');
  } catch {
    return null;
  }
  const unit = await withSession(OrgUnit.findOne({
    _id: normalizedOrgUnitId,
    teamId,
    status: ORG_UNIT_STATUSES.ACTIVE
  }).select('path'), session);
  if (!unit) return null;

  const subtreePrefix = `${unit.path}${normalizedOrgUnitId}/`;
  const descendants = await withSession(OrgUnit.find({
    teamId,
    status: ORG_UNIT_STATUSES.ACTIVE,
    path: { $regex: `^${subtreePrefix}` }
  }).select('_id'), session);
  return [
    normalizedOrgUnitId,
    ...descendants.map((descendant) => String(descendant._id).toLowerCase())
  ];
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function buildTaskDetailFilter(req, id, userFilter = {}) {
  if (!req || !req.authContext) throw relatedResourceError();
  return buildScopedDetailFilter({
    authContext: req.authContext,
    moduleKey: DATA_SCOPE_MODULES.TASK,
    id,
    userFilter,
    globalTeamId: req.authContext.activeTeamId ? undefined : req.query?.teamId,
    method: req.method
  });
}

function buildTaskScopedFilter(req, userFilter = {}) {
  return buildRequestScopedFilter(req, {
    moduleKey: DATA_SCOPE_MODULES.TASK,
    userFilter
  });
}

async function resolveTrustedTaskOrgUnit({
  authContext,
  requestedOrgUnitId,
  session = null
} = {}) {
  const context = assertTeamContext(authContext);
  const dataScope = resolveModuleDataScope(context, DATA_SCOPE_MODULES.TASK);
  let trustedOrgUnitId;
  if (dataScope.scope === DATA_SCOPES.TEAM) {
    if (!requestedOrgUnitId) throw relatedResourceError();
    trustedOrgUnitId = requestedOrgUnitId;
  } else {
    trustedOrgUnitId = dataScope.orgUnitId;
    if (requestedOrgUnitId && !sameId(requestedOrgUnitId, trustedOrgUnitId)) {
      throw relatedResourceError();
    }
  }

  let normalizedOrgUnitId;
  try {
    normalizedOrgUnitId = normalizeObjectId(trustedOrgUnitId, 'orgUnitId');
  } catch {
    throw relatedResourceError();
  }

  const orgUnit = await lockActiveOrgUnitReference({
    teamId: context.activeTeamId,
    orgUnitId: normalizedOrgUnitId,
    session
  });
  if (!orgUnit) throw relatedResourceError();
  return orgUnit._id;
}

async function validateActiveTeamUsers({
  authContext,
  userIds,
  taskOrgUnitId = null,
  enforceActorOrgScope = true,
  session = null
} = {}) {
  const context = assertTeamContext(authContext);
  if (!Array.isArray(userIds)) throw relatedResourceError();
  if (userIds.length === 0) {
    return { users: [], memberships: [], orgUnits: [] };
  }

  let normalizedUserIds;
  try {
    normalizedUserIds = [...new Set(
      userIds.map((userId) => normalizeObjectId(userId, 'userId'))
    )];
  } catch {
    throw relatedResourceError();
  }

  const [users, memberships] = await Promise.all([
    withSession(User.find({
      _id: { $in: normalizedUserIds },
      status: 'active'
    }), session),
    withSession(TeamMembership.find({
      teamId: context.activeTeamId,
      userId: { $in: normalizedUserIds },
      status: MEMBERSHIP_STATUSES.ACTIVE
    }), session)
  ]);

  if (users.length !== normalizedUserIds.length ||
      memberships.length !== normalizedUserIds.length) {
    throw relatedResourceError();
  }

  let allowedOrgUnitIds = null;
  if (taskOrgUnitId) {
    allowedOrgUnitIds = await resolveTaskOrgUnitSubtreeIds({
      teamId: context.activeTeamId,
      orgUnitId: taskOrgUnitId,
      session
    });
  }

  assertTaskParticipantOrgUnits({
    authContext: context,
    memberships,
    allowedOrgUnitIds,
    taskOrgUnitId,
    enforceActorOrgScope
  });

  const orgUnitIds = [...new Set(memberships.map(
    (membership) => String(membership.orgUnitId)
  ))];
  const orgUnits = await withSession(OrgUnit.find({
    _id: { $in: orgUnitIds },
    teamId: context.activeTeamId,
    status: ORG_UNIT_STATUSES.ACTIVE
  }), session);
  if (orgUnits.length !== orgUnitIds.length) throw relatedResourceError();

  return { users, memberships, orgUnits };
}

module.exports = {
  assertTaskParticipantOrgUnits,
  buildTaskDetailFilter,
  buildTaskScopedFilter,
  resolveTaskOrgUnitSubtreeIds,
  resolveTrustedTaskOrgUnit,
  taskScopeForMembership,
  validateActiveTeamUsers,
  withSession
};
