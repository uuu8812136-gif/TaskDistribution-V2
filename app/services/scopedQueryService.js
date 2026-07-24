'use strict';

const { DATA_SCOPES, SESSION_MODES } = require('../config/permissions');
const { normalizeId } = require('./authSessionService');
const {
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SCOPED_QUERY_ERROR_CODES = Object.freeze({
  INVALID_FILTER: 'SCOPED_QUERY_INVALID_FILTER',
  INVALID_ID: 'SCOPED_QUERY_INVALID_ID',
  RELATED_RESOURCE_INVALID: 'RELATED_RESOURCE_INVALID'
});

function scopedQueryError(status, code, message) {
  return new AuthContextError(status, code, message);
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeFilter(filter) {
  if (filter === undefined || filter === null) return {};
  if (!isPlainObject(filter)) {
    throw scopedQueryError(
      400,
      SCOPED_QUERY_ERROR_CODES.INVALID_FILTER,
      'Query filter must be a plain object'
    );
  }
  return filter;
}

function normalizeObjectId(value, fieldName) {
  const normalized = normalizeId(value);
  if (!normalized || !OBJECT_ID_PATTERN.test(normalized)) {
    throw scopedQueryError(
      400,
      SCOPED_QUERY_ERROR_CODES.INVALID_ID,
      `${fieldName} must be a valid ObjectId`
    );
  }
  return normalized.toLowerCase();
}

function isReadMethod(method) {
  return READ_METHODS.has(String(method || '').toUpperCase());
}

function combineWithAnd(...filters) {
  const normalizedFilters = filters
    .filter((filter) => filter !== undefined && filter !== null)
    .map(normalizeFilter);

  if (normalizedFilters.length === 0) {
    throw scopedQueryError(
      400,
      SCOPED_QUERY_ERROR_CODES.INVALID_FILTER,
      'At least one query constraint is required'
    );
  }
  return { $and: normalizedFilters };
}

function resolveScopedOrgUnitIds(dataScope) {
  if (!dataScope || dataScope.scope !== DATA_SCOPES.ORG_UNIT) return Object.freeze([]);
  return Object.freeze([...new Set(
    (
      Array.isArray(dataScope.orgUnitIds) && dataScope.orgUnitIds.length > 0
        ? dataScope.orgUnitIds
        : [dataScope.orgUnitId]
    ).map((orgUnitId) => normalizeObjectId(orgUnitId, 'orgUnitId'))
  )]);
}

function buildScopedOrgUnitIdConstraint(dataScope) {
  const orgUnitIds = resolveScopedOrgUnitIds(dataScope);
  if (orgUnitIds.length === 0) return undefined;
  return orgUnitIds.length === 1 ? orgUnitIds[0] : { $in: [...orgUnitIds] };
}

function isOrgUnitInDataScope(dataScope, orgUnitId) {
  const normalizedOrgUnitId = normalizeObjectId(orgUnitId, 'orgUnitId');
  return resolveScopedOrgUnitIds(dataScope).includes(normalizedOrgUnitId);
}

function buildScopeConstraint({
  authContext,
  moduleKey,
  globalTeamId,
  method
}) {
  const dataScope = resolveModuleDataScope(authContext, moduleKey);

  if (authContext.mode === SESSION_MODES.GLOBAL_READ_ONLY) {
    if (!isReadMethod(method)) {
      throw scopedQueryError(
        403,
        AUTH_ERROR_CODES.GLOBAL_READ_ONLY,
        'Global mode is read-only'
      );
    }
    return globalTeamId === undefined || globalTeamId === null || globalTeamId === ''
      ? {}
      : { teamId: normalizeObjectId(globalTeamId, 'globalTeamId') };
  }

  const constraint = {
    teamId: normalizeObjectId(dataScope.teamId, 'activeTeamId')
  };
  if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
    constraint.orgUnitId = buildScopedOrgUnitIdConstraint(dataScope);
  }
  return constraint;
}

function buildScopedFilter({
  authContext,
  moduleKey,
  userFilter = {},
  globalTeamId,
  method
}) {
  const scopeConstraint = buildScopeConstraint({
    authContext,
    moduleKey,
    globalTeamId,
    method
  });
  return combineWithAnd(scopeConstraint, userFilter);
}

function buildRequestScopedFilter(req, options = {}) {
  if (!req || !req.authContext) {
    throw scopedQueryError(
      401,
      AUTH_ERROR_CODES.CONTEXT_REQUIRED,
      'Authentication context is required'
    );
  }

  return buildScopedFilter({
    authContext: req.authContext,
    moduleKey: options.moduleKey,
    userFilter: options.userFilter,
    globalTeamId: options.globalTeamId,
    method: req.method
  });
}

function buildScopedDetailFilter({
  authContext,
  moduleKey,
  id,
  userFilter = {},
  globalTeamId,
  method
}) {
  const scopeConstraint = buildScopeConstraint({
    authContext,
    moduleKey,
    globalTeamId,
    method
  });
  const identityAndScope = {
    _id: normalizeObjectId(id, 'id'),
    ...scopeConstraint
  };

  return combineWithAnd(identityAndScope, userFilter);
}

function readField(resource, fieldPath) {
  if (!resource) return undefined;
  if (typeof resource.get === 'function') return resource.get(fieldPath);
  return fieldPath.split('.').reduce(
    (value, segment) => (value === null || value === undefined ? undefined : value[segment]),
    resource
  );
}

function relatedResourceError() {
  return scopedQueryError(
    400,
    SCOPED_QUERY_ERROR_CODES.RELATED_RESOURCE_INVALID,
    'One or more related resources are invalid for the active team'
  );
}

function assertRelatedResourcesInActiveTeam(
  authContext,
  resources,
  { teamIdField = 'teamId' } = {}
) {
  const context = assertTeamContext(authContext);
  const resourceList = Array.isArray(resources) ? resources : [resources];

  if (
    resourceList.length === 0 ||
    resourceList.some(
      (resource) => !resource || !sameId(readField(resource, teamIdField), context.activeTeamId)
    )
  ) {
    throw relatedResourceError();
  }
  return resources;
}

async function loadRelatedResourcesInActiveTeam({
  authContext,
  resourceIds,
  findOne,
  teamIdField = 'teamId'
}) {
  const context = assertTeamContext(authContext);
  if (!Array.isArray(resourceIds) || resourceIds.length === 0 || typeof findOne !== 'function') {
    throw relatedResourceError();
  }

  let normalizedIds;
  try {
    normalizedIds = resourceIds.map((id) => normalizeObjectId(id, 'related resource id'));
  } catch {
    throw relatedResourceError();
  }

  const resources = await Promise.all(normalizedIds.map((id) => findOne({
    _id: id,
    [teamIdField]: context.activeTeamId
  })));
  assertRelatedResourcesInActiveTeam(context, resources, { teamIdField });
  return resources;
}

module.exports = {
  SCOPED_QUERY_ERROR_CODES,
  assertRelatedResourcesInActiveTeam,
  buildRequestScopedFilter,
  buildScopeConstraint,
  buildScopedDetailFilter,
  buildScopedFilter,
  buildScopedOrgUnitIdConstraint,
  combineWithAnd,
  isOrgUnitInDataScope,
  isReadMethod,
  loadRelatedResourcesInActiveTeam,
  normalizeFilter,
  normalizeObjectId,
  readField,
  resolveScopedOrgUnitIds
};
