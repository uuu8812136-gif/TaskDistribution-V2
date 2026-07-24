'use strict';

const mongoose = require('mongoose');
const FileAsset = require('../models/FileAsset');
const OrgUnit = require('../models/OrgUnit');
const ProjectTeam = require('../models/ProjectTeam');
const {
  DATA_SCOPES,
  ORG_UNIT_STATUSES,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { normalizeId } = require('./authSessionService');
const {
  buildScopedDetailFilter,
  buildScopedFilter,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  assertPermission,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { lockActiveOrgUnitReference } = require('./orgUnitReferenceService');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

class ReportingServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ReportingServiceError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function reportError(status, code, message) {
  return new ReportingServiceError(status, code, message);
}

function notFound(resource = 'Report record') {
  return reportError(404, 'REPORT_RECORD_NOT_FOUND', `${resource} does not exist`);
}

function relatedInvalid() {
  return reportError(
    400,
    'REPORT_RELATED_RESOURCE_INVALID',
    'One or more related resources are invalid for the active team and organization unit'
  );
}

function normalizeDetailId(value, resource) {
  try {
    return normalizeObjectId(value, 'id');
  } catch {
    throw notFound(resource);
  }
}

function normalizeRelatedId(value, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  try {
    return normalizeObjectId(value, 'related resource id');
  } catch {
    throw relatedInvalid();
  }
}

function requiredString(value, field, max) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} is too long`);
  }
  return normalized;
}

function optionalString(value, field, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw reportError(400, 'REPORT_INPUT_INVALID', `${field} is too long`);
  }
  return normalized;
}

function integer(value, field, {
  min = 0,
  max = 2147483647,
  fallback = 0,
  nullable = false
} = {}) {
  if (value === undefined || value === '') return fallback;
  if (value === null && nullable) return null;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw reportError(
      400,
      'REPORT_INPUT_INVALID',
      `${field} must be ${nullable ? 'null or ' : ''}an integer between ${min} and ${max}`
    );
  }
  return parsed;
}

function pagination(query = {}) {
  const page = integer(query.page, 'page', { min: 1, max: 1000000, fallback: 1 });
  const pageSize = integer(query.pageSize, 'pageSize', {
    min: 1,
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE
  });
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function plain(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject({ depopulate: true, versionKey: false })
    : document;
}

function formulaSafe(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function assertNoClientTeamId(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'teamId')) {
    throw reportError(
      400,
      'REPORT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    );
  }
}

function assertNoLegacyPhotoFields(input) {
  for (const field of ['photoPaths', 'photoUrls', 'attachments', 'files', 'path', 'url']) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) {
      throw reportError(
        400,
        'REPORT_LEGACY_FILE_REFERENCE_REJECTED',
        'Only authenticated FileAsset IDs are accepted for transport photos'
      );
    }
  }
}

async function execute(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function createOne(Model, payload, session) {
  if (!session) return Model.create(payload);
  const documents = await Model.create([payload], { session });
  return documents[0];
}

function normalizePersistenceError(error, duplicateCode = 'REPORT_DUPLICATE') {
  if (error?.code === 11000) {
    return reportError(409, duplicateCode, 'A record with the same scoped business key already exists');
  }
  if (error?.name === 'ValidationError' || error?.name === 'StrictModeError') {
    return reportError(400, 'REPORT_INPUT_INVALID', error.message);
  }
  return error;
}

async function resolveReadTeamId({
  authContext,
  requestedTeamId,
  ProjectTeamModel = ProjectTeam
}) {
  const context = assertBusinessContext(authContext);
  if (context.mode === SESSION_MODES.TEAM) {
    return normalizeObjectId(context.activeTeamId, 'activeTeamId');
  }
  if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
    throw reportError(403, 'REPORT_TEAM_CONTEXT_REQUIRED', 'Select a team first');
  }

  let teamId;
  try {
    teamId = normalizeObjectId(requestedTeamId, 'teamId');
  } catch {
    throw reportError(
      400,
      'REPORT_TEAM_REQUIRED',
      'A valid teamId is required in global read-only mode'
    );
  }
  const exists = await ProjectTeamModel.exists({
    _id: teamId,
    status: TEAM_STATUSES.ACTIVE
  });
  if (!exists) throw notFound('Project team');
  return teamId;
}

async function listScopedOrgUnits({
  authContext,
  requestedTeamId,
  moduleKey,
  permissionKey = 'report.view',
  OrgUnitModel = OrgUnit,
  ProjectTeamModel = ProjectTeam
}) {
  assertPermission(authContext, permissionKey);
  const teamId = await resolveReadTeamId({
    authContext,
    requestedTeamId,
    ProjectTeamModel
  });
  const dataScope = resolveModuleDataScope(authContext, moduleKey);
  const filter = {
    teamId,
    status: ORG_UNIT_STATUSES.ACTIVE
  };
  if (dataScope.scope === DATA_SCOPES.ORG_UNIT) {
    filter._id = normalizeRelatedId(dataScope.orgUnitId);
  }
  const orgUnits = await OrgUnitModel.find(filter)
    .sort({ level: 1, sortOrder: 1, name: 1, _id: 1 })
    .lean();
  return {
    orgUnits: orgUnits.map((orgUnit) => ({
      _id: normalizeId(orgUnit._id),
      parentId: normalizeId(orgUnit.parentId),
      code: orgUnit.code,
      name: orgUnit.name,
      type: orgUnit.type,
      level: orgUnit.level,
      path: orgUnit.path
    }))
  };
}

async function buildReadFilter({
  authContext,
  requestedTeamId,
  method = 'GET',
  moduleKey,
  permissionKey,
  id,
  resourceName,
  userFilter = {},
  ProjectTeamModel = ProjectTeam
}) {
  assertPermission(authContext, permissionKey);
  const teamId = await resolveReadTeamId({
    authContext,
    requestedTeamId,
    ProjectTeamModel
  });
  if (id) {
    return {
      teamId,
      filter: buildScopedDetailFilter({
        authContext,
        moduleKey,
        id: normalizeDetailId(id, resourceName),
        userFilter,
        globalTeamId: teamId,
        method
      })
    };
  }
  return {
    teamId,
    filter: buildScopedFilter({
      authContext,
      moduleKey,
      userFilter,
      globalTeamId: teamId,
      method
    })
  };
}

async function resolveWritableOrgUnit({
  context,
  moduleKey,
  requestedOrgUnitId,
  fallbackOrgUnitId,
  OrgUnitModel = OrgUnit,
  session
}) {
  const scope = resolveModuleDataScope(context, moduleKey);
  let orgUnitId;
  if (scope.scope === DATA_SCOPES.ORG_UNIT) {
    orgUnitId = normalizeRelatedId(scope.orgUnitId);
    if (
      requestedOrgUnitId !== undefined &&
      requestedOrgUnitId !== null &&
      requestedOrgUnitId !== '' &&
      !sameId(requestedOrgUnitId, orgUnitId)
    ) {
      throw relatedInvalid();
    }
  } else {
    orgUnitId = normalizeRelatedId(
      requestedOrgUnitId === undefined ? fallbackOrgUnitId : requestedOrgUnitId
    );
  }

  const orgUnit = await lockActiveOrgUnitReference({
    OrgUnitModel,
    teamId: context.activeTeamId,
    orgUnitId,
    session
  });
  if (!orgUnit) throw relatedInvalid();
  return orgUnit;
}

async function validateTransportPhotoFiles({
  context,
  values,
  transportRecordId,
  FileAssetModel = FileAsset,
  session
}) {
  if (!Array.isArray(values)) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'photoFileIds must be an array');
  }
  if (values.length < 2 || values.length > 10) {
    throw reportError(400, 'REPORT_PHOTO_COUNT_INVALID', 'Transport photos must contain 2 to 10 files');
  }
  let ids;
  try {
    ids = values.map((value) => normalizeObjectId(value, 'photoFileId'));
  } catch {
    throw relatedInvalid();
  }
  if (new Set(ids).size !== ids.length) {
    throw reportError(400, 'REPORT_INPUT_INVALID', 'photoFileIds must not contain duplicates');
  }

  const files = await execute(FileAssetModel.find({
    _id: { $in: ids },
    teamId: context.activeTeamId,
    status: { $ne: FileAsset.FILE_STATUSES.DELETED }
  }), session);
  if (files.length !== ids.length) throw relatedInvalid();

  const isAllowed = files.every((file) => {
    if (file.status === FileAsset.FILE_STATUSES.TEMPORARY) {
      return sameId(file.uploaderId, context.userId);
    }
    return (
      file.status === FileAsset.FILE_STATUSES.ACTIVE &&
      file.ownerType === FileAsset.FILE_OWNER_TYPES.TRANSPORT_REPORT &&
      sameId(file.ownerId, transportRecordId)
    );
  });
  if (!isAllowed) throw relatedInvalid();
  return ids;
}

function objectId() {
  return new mongoose.Types.ObjectId();
}

function normalizeReason(value) {
  return optionalString(value, 'reason', 2000, null) || null;
}

module.exports = {
  ReportingServiceError,
  assertNoClientTeamId,
  assertNoLegacyPhotoFields,
  buildReadFilter,
  createOne,
  escapeRegex,
  execute,
  formulaSafe,
  integer,
  listScopedOrgUnits,
  normalizeDetailId,
  normalizeId,
  normalizePersistenceError,
  normalizeReason,
  normalizeRelatedId,
  notFound,
  objectId,
  optionalString,
  pagination,
  plain,
  relatedInvalid,
  reportError,
  requiredString,
  resolveReadTeamId,
  resolveWritableOrgUnit,
  validateTransportPhotoFiles
};
