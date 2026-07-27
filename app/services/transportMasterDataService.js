'use strict';

const mongoose = require('mongoose');
const ProjectTeam = require('../models/ProjectTeam');
const TransportMasterData = require('../models/TransportMasterData');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const {
  assertNoClientTeamId,
  execute,
  integer,
  normalizeId,
  normalizeRelatedId,
  optionalString,
  plain,
  reportError,
  requiredString,
  resolveReadTeamId
} = require('./reportingServiceSupport');
const { assertPermission, assertTeamContext } = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const {
  TRANSPORT_MASTER_KINDS,
  TRANSPORT_MASTER_KIND_VALUES,
  TRANSPORT_MASTER_NAME_MAX_LENGTHS,
  TRANSPORT_MASTER_STATUSES,
  TRANSPORT_MASTER_STATUS_VALUES
} = TransportMasterData;

const MASTER_LABELS = Object.freeze({
  [TRANSPORT_MASTER_KINDS.TRIP]: '趟次',
  [TRANSPORT_MASTER_KINDS.ROUTE]: '路线',
  [TRANSPORT_MASTER_KINDS.VEHICLE_PLATE]: '车牌号',
  [TRANSPORT_MASTER_KINDS.VEHICLE_TYPE]: '车型',
  [TRANSPORT_MASTER_KINDS.DRIVER]: '司机姓名',
  [TRANSPORT_MASTER_KINDS.LOAD_TYPE]: '装载明细类型'
});

function masterError(status, code, message) {
  return reportError(status, code, message);
}

function enumValue(value, values, field) {
  if (!values.includes(value)) {
    throw masterError(400, 'TRANSPORT_MASTER_INPUT_INVALID', `${field} 的值无效`);
  }
  return value;
}

function booleanQuery(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw masterError(400, 'TRANSPORT_MASTER_INPUT_INVALID', 'includeDisabled 的值无效');
}

function serializeTransportMasterData(document) {
  const value = plain(document);
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    kind: value.kind,
    name: value.name || '',
    status: value.status,
    sortOrder: value.sortOrder || 0,
    createdBy: normalizeId(value.createdBy),
    updatedBy: normalizeId(value.updatedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function assertTransportMasterWriter(context) {
  assertTeamContext(context);
  assertPermission(context, 'report.transport.master.manage');
  return context;
}

function normalizedMasterPayload(input, existing = null) {
  const kind = existing
    ? existing.kind
    : enumValue(input.kind, TRANSPORT_MASTER_KIND_VALUES, 'kind');
  if (existing && input.kind !== undefined && input.kind !== kind) {
    throw masterError(400, 'TRANSPORT_MASTER_KIND_IMMUTABLE', '基础资料类型不可修改');
  }

  const payload = {
    kind,
    sortOrder: Object.prototype.hasOwnProperty.call(input, 'sortOrder')
      ? integer(input.sortOrder, 'sortOrder', { min: 0, fallback: 0 })
      : existing?.sortOrder || 0
  };
  const max = TRANSPORT_MASTER_NAME_MAX_LENGTHS[kind];
  payload.name = Object.prototype.hasOwnProperty.call(input, 'name') || !existing
    ? requiredString(input.name, 'name', max)
    : existing.name;
  return payload;
}

function normalizeMasterPersistenceError(error, kind) {
  if (error?.code === 11000) {
    return masterError(
      409,
      'TRANSPORT_MASTER_DUPLICATE',
      `同一团队内已存在相同的${MASTER_LABELS[kind] || '运输基础资料'}`
    );
  }
  if (error?.name === 'ValidationError' || error?.name === 'StrictModeError') {
    return masterError(400, 'TRANSPORT_MASTER_INPUT_INVALID', error.message);
  }
  return error;
}

function createTransportMasterDataService({
  TransportMasterDataModel = TransportMasterData,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  connection = mongoose.connection
} = {}) {
  async function listMasterData({
    authContext,
    requestedTeamId,
    query = {}
  }) {
    assertPermission(authContext, 'report.view');
    const teamId = await resolveReadTeamId({
      authContext,
      requestedTeamId,
      ProjectTeamModel
    });
    const filter = { teamId };
    if (query.kind !== undefined && query.kind !== '') {
      filter.kind = enumValue(query.kind, TRANSPORT_MASTER_KIND_VALUES, 'kind');
    }
    if (!booleanQuery(query.includeDisabled)) {
      filter.status = TRANSPORT_MASTER_STATUSES.ACTIVE;
    }
    const documents = await TransportMasterDataModel.find(filter)
      .sort({ kind: 1, status: 1, sortOrder: 1, normalizedKey: 1, _id: 1 })
      .lean();
    return { masterData: documents.map(serializeTransportMasterData) };
  }

  async function createMasterData({ authContext, req, input = {} }) {
    const context = assertTransportMasterWriter(authContext);
    assertNoClientTeamId(input);
    const payload = normalizedMasterPayload(input);
    try {
      return await runWithOptionalTransaction(async (session) => {
        const document = await (session
          ? TransportMasterDataModel.create([{
              teamId: context.activeTeamId,
              ...payload,
              status: TRANSPORT_MASTER_STATUSES.ACTIVE,
              createdBy: context.userId,
              updatedBy: context.userId
            }], { session }).then(([created]) => created)
          : TransportMasterDataModel.create({
              teamId: context.activeTeamId,
              ...payload,
              status: TRANSPORT_MASTER_STATUSES.ACTIVE,
              createdBy: context.userId,
              updatedBy: context.userId
            }));
        const after = serializeTransportMasterData(document);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.CREATE,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
          resourceId: document._id,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizeMasterPersistenceError(error, payload.kind);
    }
  }

  async function updateMasterData({
    authContext,
    req,
    masterDataId,
    input = {}
  }) {
    const context = assertTransportMasterWriter(authContext);
    assertNoClientTeamId(input);
    let kind;
    try {
      return await runWithOptionalTransaction(async (session) => {
        const id = normalizeRelatedId(masterDataId);
        const document = await execute(TransportMasterDataModel.findOne({
          _id: id,
          teamId: context.activeTeamId
        }), session);
        if (!document) {
          throw masterError(404, 'TRANSPORT_MASTER_NOT_FOUND', '运输基础资料不存在');
        }
        kind = document.kind;
        const before = serializeTransportMasterData(document);
        const payload = normalizedMasterPayload(input, document);
        for (const [field, value] of Object.entries(payload)) {
          if (field !== 'kind') document[field] = value;
        }
        document.updatedBy = context.userId;
        await document.save({ session: session || undefined });
        const after = serializeTransportMasterData(document);
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
          resourceId: document._id,
          before,
          after,
          targetTeamId: context.activeTeamId,
          session
        });
        return after;
      }, connection);
    } catch (error) {
      throw normalizeMasterPersistenceError(error, kind);
    }
  }

  async function setMasterDataStatus({
    authContext,
    req,
    masterDataId,
    input = {}
  }) {
    const context = assertTransportMasterWriter(authContext);
    assertNoClientTeamId(input);
    const status = enumValue(input.status, TRANSPORT_MASTER_STATUS_VALUES, 'status');
    return runWithOptionalTransaction(async (session) => {
      const id = normalizeRelatedId(masterDataId);
      const document = await execute(TransportMasterDataModel.findOne({
        _id: id,
        teamId: context.activeTeamId
      }), session);
      if (!document) {
        throw masterError(404, 'TRANSPORT_MASTER_NOT_FOUND', '运输基础资料不存在');
      }
      const before = serializeTransportMasterData(document);
      document.status = status;
      document.updatedBy = context.userId;
      await document.save({ session: session || undefined });
      const after = serializeTransportMasterData(document);
      await auditService.record({
        req,
        authContext: context,
        action: status === TRANSPORT_MASTER_STATUSES.ACTIVE
          ? AUDIT_ACTIONS.ENABLE
          : AUDIT_ACTIONS.DISABLE,
        resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
        resourceId: document._id,
        before,
        after,
        targetTeamId: context.activeTeamId,
        session
      });
      return after;
    }, connection);
  }

  async function deleteMasterData({ authContext, req, masterDataId }) {
    const context = assertTransportMasterWriter(authContext);
    return runWithOptionalTransaction(async (session) => {
      const id = normalizeRelatedId(masterDataId);
      const document = await execute(TransportMasterDataModel.findOne({
        _id: id,
        teamId: context.activeTeamId
      }), session);
      if (!document) {
        throw masterError(404, 'TRANSPORT_MASTER_NOT_FOUND', '运输基础资料不存在');
      }
      if (document.kind !== TRANSPORT_MASTER_KINDS.LOAD_TYPE) {
        throw masterError(
          400,
          'TRANSPORT_MASTER_DELETE_UNSUPPORTED',
          '只有装载明细类型支持删除，其他基础资料请使用停用'
        );
      }
      const before = serializeTransportMasterData(document);
      await execute(TransportMasterDataModel.deleteOne({
        _id: document._id,
        teamId: context.activeTeamId
      }), session);
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.DELETE,
        resourceType: AUDIT_RESOURCE_TYPES.TRANSPORT_MASTER_DATA,
        resourceId: document._id,
        before,
        targetTeamId: context.activeTeamId,
        session
      });
      return before;
    }, connection);
  }

  return Object.freeze({
    listMasterData,
    createMasterData,
    updateMasterData,
    setMasterDataStatus,
    deleteMasterData
  });
}

module.exports = {
  assertTransportMasterWriter,
  createTransportMasterDataService,
  serializeTransportMasterData
};
