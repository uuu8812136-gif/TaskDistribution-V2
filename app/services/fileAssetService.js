'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const FileAsset = require('../models/FileAsset');
const Task = require('../models/Task');
const TransportRecord = require('../models/TransportRecord');
const EquipmentAsset = require('../models/EquipmentAsset');
const ImportJob = require('../models/ImportJob');
const EquipmentRoutineRecord = require('../models/EquipmentRoutineRecord');
const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const EquipmentStatusApplication = require('../models/EquipmentStatusApplication');
const InventoryItem = require('../models/InventoryItem');
const SupplierContractRecord = require('../models/SupplierContractRecord');
const ProjectTeam = require('../models/ProjectTeam');
const {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPES,
  DATA_SCOPE_MODULES,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { createAuditService } = require('./auditService');
const { normalizeId } = require('./authSessionService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');
const {
  createStorageKey,
  normalizeOriginalName,
  resolveStoragePath,
  validateFileContent,
  validatedExtension
} = require('./fileStorageService');
const {
  buildScopedDetailFilter,
  normalizeObjectId
} = require('./scopedQueryService');
const {
  assertBusinessContext,
  hasEffectivePermission,
  assertPermission,
  assertTeamContext,
  resolveModuleDataScope,
  sameId
} = require('./teamContextService');
const { runWithOptionalTransaction } = require('./transactionService');

const { FILE_OWNER_TYPES, FILE_STATUSES } = FileAsset;
const TEMPORARY_UPLOAD_PERMISSIONS = Object.freeze([
  // A task executor may have view-only module permissions; the owning task
  // endpoint performs the resource-level check before a temporary file binds.
  'task.view',
  'task.create',
  'task.edit',
  'task.review',
  'report.submit',
  'equipment.create',
  'equipment.edit',
  'equipment.import',
  'equipment.inventory',
  'equipment.inspect',
  'equipment.repair',
  'equipment.maintain',
  'equipment.status.apply',
  'contract.supplier.manage'
]);
const OWNER_ACCESS_POLICIES = Object.freeze({
  [FILE_OWNER_TYPES.TASK]: Object.freeze({
    resourceModel: 'TASK',
    moduleKey: DATA_SCOPE_MODULES.TASK,
    readPermission: 'task.view',
    writePermission: 'task.edit'
  }),
  [FILE_OWNER_TYPES.TASK_COMPLETION]: Object.freeze({
    resourceModel: 'TASK',
    moduleKey: DATA_SCOPE_MODULES.TASK,
    readPermission: 'task.view',
    // The task flow controller has already verified the current executor.
    // Keep completion evidence separate from general task editing authority.
    writePermission: 'task.view'
  }),
  [FILE_OWNER_TYPES.TASK_REVIEW]: Object.freeze({
    resourceModel: 'TASK',
    moduleKey: DATA_SCOPE_MODULES.TASK,
    readPermission: 'task.view',
    // Review and confirmation controllers enforce their distinct resource roles.
    // Final confirmation intentionally does not require the task.review permission.
    writePermissionsAny: Object.freeze(['task.review', 'task.view'])
  }),
  [FILE_OWNER_TYPES.TRANSPORT_REPORT]: Object.freeze({
    resourceModel: 'TRANSPORT_RECORD',
    moduleKey: DATA_SCOPE_MODULES.REPORT_TRANSPORT,
    readPermission: 'report.view',
    writePermission: 'report.submit'
  }),
  [FILE_OWNER_TYPES.EQUIPMENT]: Object.freeze({
    resourceModel: 'EQUIPMENT_ASSET',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.view',
    writePermissionsAny: Object.freeze(['equipment.create', 'equipment.edit'])
  }),
  [FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE]: Object.freeze({
    resourceModel: 'IMPORT_JOB',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.import',
    writePermission: 'equipment.import'
  }),
  [FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA]: Object.freeze({
    resourceModel: 'IMPORT_JOB',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.import',
    writePermission: 'equipment.import'
  }),
  [FILE_OWNER_TYPES.INVENTORY]: Object.freeze({
    resourceModel: 'INVENTORY_ITEM',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.inventory',
    writePermission: 'equipment.inventory'
  }),
  [FILE_OWNER_TYPES.INSPECTION]: Object.freeze({
    resourceModel: 'EQUIPMENT_ROUTINE_RECORD',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.view',
    writePermission: 'equipment.inspect',
    userFilter: Object.freeze({ routineType: 'INSPECTION' })
  }),
  [FILE_OWNER_TYPES.REPAIR]: Object.freeze({
    resourceModel: 'EQUIPMENT_REPAIR_ORDER',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.view',
    writePermission: 'equipment.repair'
  }),
  [FILE_OWNER_TYPES.MAINTENANCE]: Object.freeze({
    resourceModel: 'EQUIPMENT_ROUTINE_RECORD',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.view',
    writePermission: 'equipment.maintain',
    userFilter: Object.freeze({ routineType: 'MAINTENANCE' })
  }),
  [FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION]: Object.freeze({
    resourceModel: 'EQUIPMENT_STATUS_APPLICATION',
    moduleKey: DATA_SCOPE_MODULES.EQUIPMENT,
    readPermission: 'equipment.view',
    writePermission: 'equipment.status.apply'
  }),
  [FILE_OWNER_TYPES.SUPPLIER_PROFILE]: Object.freeze({
    resourceModel: 'SUPPLIER_CONTRACT_RECORD',
    teamOnly: true,
    readPermission: 'contract.supplier.view',
    writePermission: 'contract.supplier.manage',
    userFilter: Object.freeze({ category: 'SUPPLIER_INFO' })
  }),
  [FILE_OWNER_TYPES.SUPPLIER_CONTRACT]: Object.freeze({
    resourceModel: 'SUPPLIER_CONTRACT_RECORD',
    teamOnly: true,
    readPermission: 'contract.supplier.view',
    writePermission: 'contract.supplier.manage',
    userFilter: Object.freeze({ category: { $ne: 'SUPPLIER_INFO' } })
  })
});
const WORKFLOW_MANAGED_OWNER_TYPES = new Set([
  FILE_OWNER_TYPES.TASK,
  FILE_OWNER_TYPES.TASK_COMPLETION,
  FILE_OWNER_TYPES.TASK_REVIEW,
  FILE_OWNER_TYPES.TRANSPORT_REPORT,
  FILE_OWNER_TYPES.EQUIPMENT,
  FILE_OWNER_TYPES.EQUIPMENT_IMPORT_SOURCE,
  FILE_OWNER_TYPES.EQUIPMENT_IMPORT_MEDIA,
  FILE_OWNER_TYPES.INVENTORY,
  FILE_OWNER_TYPES.INSPECTION,
  FILE_OWNER_TYPES.REPAIR,
  FILE_OWNER_TYPES.MAINTENANCE,
  FILE_OWNER_TYPES.EQUIPMENT_STATUS_APPLICATION,
  FILE_OWNER_TYPES.SUPPLIER_PROFILE,
  FILE_OWNER_TYPES.SUPPLIER_CONTRACT
]);
const MAX_OWNER_FILES = 10;
const DEFAULT_TEMPORARY_FILE_LIMITS = Object.freeze({
  userMaxCount: 20,
  userMaxBytes: 100 * 1024 * 1024,
  teamMaxCount: 200,
  teamMaxBytes: 1024 * 1024 * 1024
});
const QUOTA_COUNTED_STATUSES = Object.freeze([
  FILE_STATUSES.TEMPORARY,
  FILE_STATUSES.PURGING
]);
const temporaryUploadQueues = new Map();

class FileAssetError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FileAssetError';
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function fileError(status, code, message) {
  return new FileAssetError(status, code, message);
}

function normalizeTemporaryFileLimits(limits = {}) {
  const normalized = Object.fromEntries(Object.entries(DEFAULT_TEMPORARY_FILE_LIMITS).map(
    ([key, fallback]) => [key, limits?.[key] ?? fallback]
  ));
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${key} must be a positive safe integer`);
    }
  }
  if (normalized.teamMaxCount < normalized.userMaxCount) {
    throw new TypeError('teamMaxCount must be at least userMaxCount');
  }
  if (normalized.teamMaxBytes < normalized.userMaxBytes) {
    throw new TypeError('teamMaxBytes must be at least userMaxBytes');
  }
  return Object.freeze(normalized);
}

function normalizeQuotaUsage(usage, name) {
  if (
    !usage ||
    !Number.isSafeInteger(usage.count) ||
    usage.count < 0 ||
    !Number.isSafeInteger(usage.bytes) ||
    usage.bytes < 0
  ) {
    throw new TypeError(`${name} must contain non-negative safe integer count and bytes`);
  }
  return usage;
}

function assertTemporaryQuotaUsage({ userUsage, teamUsage, incomingBytes, limits }) {
  const normalizedLimits = normalizeTemporaryFileLimits(limits);
  const user = normalizeQuotaUsage(userUsage, 'userUsage');
  const team = normalizeQuotaUsage(teamUsage, 'teamUsage');
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 1) {
    throw new TypeError('incomingBytes must be a positive safe integer');
  }
  if (user.count + 1 > normalizedLimits.userMaxCount) {
    throw fileError(
      429,
      'TEMPORARY_FILE_USER_COUNT_LIMIT',
      'Bind or remove an existing temporary file before uploading another file'
    );
  }
  if (user.bytes + incomingBytes > normalizedLimits.userMaxBytes) {
    throw fileError(
      429,
      'TEMPORARY_FILE_USER_BYTES_LIMIT',
      'Temporary file storage for this user is full'
    );
  }
  if (team.count + 1 > normalizedLimits.teamMaxCount) {
    throw fileError(
      429,
      'TEMPORARY_FILE_TEAM_COUNT_LIMIT',
      'Temporary file storage for this team is full'
    );
  }
  if (team.bytes + incomingBytes > normalizedLimits.teamMaxBytes) {
    throw fileError(
      429,
      'TEMPORARY_FILE_TEAM_BYTES_LIMIT',
      'Temporary file storage for this team is full'
    );
  }
}

async function withTemporaryUploadLock(teamId, operation) {
  const key = String(teamId);
  const previous = temporaryUploadQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  temporaryUploadQueues.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (temporaryUploadQueues.get(key) === current) temporaryUploadQueues.delete(key);
  }
}

function notFound() {
  return fileError(404, 'FILE_NOT_FOUND', 'File does not exist');
}

function normalizeFileId(value) {
  try {
    return normalizeObjectId(value, 'fileId');
  } catch {
    throw notFound();
  }
}

function serializeFile(file) {
  const value = typeof file.toObject === 'function' ? file.toObject() : file;
  return {
    _id: normalizeId(value._id),
    teamId: normalizeId(value.teamId),
    ownerType: value.ownerType,
    ownerId: normalizeId(value.ownerId),
    originalName: value.originalName,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    uploaderId: normalizeId(value.uploaderId),
    status: value.status,
    deletedAt: value.deletedAt || null,
    deletedBy: normalizeId(value.deletedBy),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function auditSnapshot(file) {
  const value = serializeFile(file);
  return {
    _id: value._id,
    teamId: value.teamId,
    ownerType: value.ownerType,
    ownerId: value.ownerId,
    originalName: value.originalName,
    mimeType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    uploaderId: value.uploaderId,
    status: value.status,
    deletedAt: value.deletedAt,
    deletedBy: value.deletedBy
  };
}

function assertTemporaryUploadPermission(authContext) {
  assertTeamContext(authContext);
  if (!TEMPORARY_UPLOAD_PERMISSIONS.some(
    (permissionKey) => hasEffectivePermission(authContext, permissionKey)
  )) {
    throw new AuthContextError(
      403,
      AUTH_ERROR_CODES.PERMISSION_DENIED,
      'Permission denied'
    );
  }
}

function normalizeOwnerInput(ownerType, ownerId) {
  if (!Object.prototype.hasOwnProperty.call(OWNER_ACCESS_POLICIES, ownerType)) {
    throw fileError(400, 'FILE_OWNER_TYPE_UNSUPPORTED', 'Unsupported file owner type');
  }
  try {
    return {
      ownerType,
      ownerId: normalizeObjectId(ownerId, 'ownerId')
    };
  } catch {
    throw notFound();
  }
}

function assertGenericOwnerMutationAllowed(ownerType) {
  if (WORKFLOW_MANAGED_OWNER_TYPES.has(ownerType)) {
    throw fileError(
      409,
      'FILE_WORKFLOW_OWNER_MANAGED',
      'Workflow attachments must be changed through their owning business endpoint'
    );
  }
}

function normalizeAttachmentInput(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments) || attachments.length > MAX_OWNER_FILES) {
    throw fileError(
      400,
      'FILE_ATTACHMENT_INVALID',
      `attachments must be an array containing at most ${MAX_OWNER_FILES} files`
    );
  }

  const fileIds = attachments.map((attachment) => {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      Array.isArray(attachment) ||
      Object.keys(attachment).some((key) => key !== 'fileId') ||
      !Object.prototype.hasOwnProperty.call(attachment, 'fileId')
    ) {
      throw fileError(
        400,
        'FILE_ATTACHMENT_INVALID',
        'Each new attachment must contain only a fileId'
      );
    }
    try {
      return normalizeObjectId(attachment.fileId, 'fileId');
    } catch {
      throw fileError(400, 'FILE_ATTACHMENT_INVALID', 'Attachment fileId is invalid');
    }
  });

  if (new Set(fileIds).size !== fileIds.length) {
    throw fileError(400, 'FILE_ATTACHMENT_INVALID', 'Attachment fileIds must be unique');
  }
  return fileIds;
}

function managedAttachmentIds(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => normalizeId(attachment?.fileId))
    .filter((fileId) => /^[0-9a-fA-F]{24}$/.test(fileId || ''))
    .map((fileId) => fileId.toLowerCase());
}

function preserveLegacyAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).filter(
    (attachment) => !normalizeId(attachment?.fileId)
  );
}

function attachmentReference(file) {
  return {
    fileId: normalizeId(file._id),
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    uploadTime: file.createdAt
  };
}

async function createOne(Model, values, session) {
  if (!session) return Model.create(values);
  const created = await Model.create([values], { session });
  return created[0];
}

function createFileAssetService({
  storageRoot,
  FileAssetModel = FileAsset,
  TaskModel = Task,
  TransportRecordModel = TransportRecord,
  EquipmentAssetModel = EquipmentAsset,
  ImportJobModel = ImportJob,
  EquipmentRoutineRecordModel = EquipmentRoutineRecord,
  EquipmentRepairOrderModel = EquipmentRepairOrder,
  EquipmentStatusApplicationModel = EquipmentStatusApplication,
  InventoryItemModel = InventoryItem,
  SupplierContractRecordModel = SupplierContractRecord,
  ProjectTeamModel = ProjectTeam,
  auditService = createAuditService(),
  connection = mongoose.connection,
  temporaryFileLimits = DEFAULT_TEMPORARY_FILE_LIMITS
} = {}) {
  const resolvedStorageRoot = typeof storageRoot === 'string' && storageRoot.trim()
    ? path.resolve(storageRoot)
    : null;
  const normalizedTemporaryFileLimits = normalizeTemporaryFileLimits(temporaryFileLimits);

  function requireStorageRoot() {
    if (!resolvedStorageRoot) throw new TypeError('A private file storage root is required');
    return resolvedStorageRoot;
  }

  async function temporaryUsage(filter, session = null) {
    const aggregation = FileAssetModel.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          bytes: { $sum: '$size' }
        }
      }
    ]);
    if (session && typeof aggregation.session === 'function') aggregation.session(session);
    const [usage] = await aggregation;
    return {
      count: Number(usage?.count || 0),
      bytes: Number(usage?.bytes || 0)
    };
  }

  async function assertTemporaryUploadCapacity({ authContext, incomingBytes, session = null }) {
    const context = assertTeamContext(authContext);
    assertTemporaryUploadPermission(context);
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 1) {
      throw new TypeError('incomingBytes must be a positive safe integer');
    }
    const teamId = new mongoose.Types.ObjectId(
      normalizeObjectId(context.activeTeamId, 'activeTeamId')
    );
    const uploaderId = new mongoose.Types.ObjectId(
      normalizeObjectId(context.userId, 'userId')
    );
    const baseFilter = {
      ownerType: FILE_OWNER_TYPES.TEMPORARY,
      ownerId: null,
      status: { $in: QUOTA_COUNTED_STATUSES }
    };
    const userUsage = await temporaryUsage({ ...baseFilter, teamId, uploaderId }, session);
    const teamUsage = await temporaryUsage({ ...baseFilter, teamId }, session);
    assertTemporaryQuotaUsage({
      userUsage,
      teamUsage,
      incomingBytes,
      limits: normalizedTemporaryFileLimits
    });
    return { userUsage, teamUsage };
  }

  async function resolveReadTeamId(authContext, requestedTeamId) {
    const context = assertBusinessContext(authContext);
    if (context.mode === SESSION_MODES.TEAM) return normalizeObjectId(
      context.activeTeamId,
      'activeTeamId'
    );

    if (context.mode !== SESSION_MODES.GLOBAL_READ_ONLY) {
      throw new AuthContextError(
        403,
        AUTH_ERROR_CODES.BUSINESS_CONTEXT_REQUIRED,
        'Select a team before accessing business data'
      );
    }

    let teamId;
    try {
      teamId = normalizeObjectId(requestedTeamId, 'teamId');
    } catch {
      throw fileError(
        400,
        'FILE_TEAM_REQUIRED',
        'A valid teamId is required in global read-only mode'
      );
    }
    const activeTeam = await ProjectTeamModel.exists({
      _id: teamId,
      status: TEAM_STATUSES.ACTIVE
    });
    if (!activeTeam) throw notFound();
    return teamId;
  }

  async function assertOwnerAccess({
    authContext,
    ownerType,
    ownerId,
    teamId,
    method,
    write,
    session = null
  }) {
    const policy = OWNER_ACCESS_POLICIES[ownerType];
    if (!policy) throw notFound();
    const permissionKeys = write && Array.isArray(policy.writePermissionsAny)
      ? policy.writePermissionsAny
      : [write ? policy.writePermission : policy.readPermission];
    if (!permissionKeys.some((permissionKey) => hasEffectivePermission(authContext, permissionKey))) {
      assertPermission(authContext, permissionKeys[0]);
    }
    let ownerFilter;
    if (policy.teamOnly) {
      ownerFilter = {
        _id: normalizeObjectId(ownerId, 'ownerId'),
        teamId,
        ...(policy.userFilter || {})
      };
    } else if (policy.resourceModel === 'IMPORT_JOB') {
      ownerFilter = { _id: normalizeObjectId(ownerId, 'ownerId'), teamId };
      if (authContext.mode === SESSION_MODES.TEAM) {
        const scope = resolveModuleDataScope(authContext, policy.moduleKey);
        if (scope.scope === DATA_SCOPES.ORG_UNIT) ownerFilter.scopeOrgUnitId = scope.orgUnitId;
      }
    } else {
      ownerFilter = buildScopedDetailFilter({
        authContext,
        moduleKey: policy.moduleKey,
        id: ownerId,
        userFilter: policy.userFilter || {},
        globalTeamId: teamId,
        method
      });
    }
    const OwnerModel = policy.resourceModel === 'TRANSPORT_RECORD'
      ? TransportRecordModel
      : policy.resourceModel === 'EQUIPMENT_ASSET'
        ? EquipmentAssetModel
        : policy.resourceModel === 'IMPORT_JOB'
          ? ImportJobModel
          : policy.resourceModel === 'EQUIPMENT_ROUTINE_RECORD'
            ? EquipmentRoutineRecordModel
            : policy.resourceModel === 'EQUIPMENT_REPAIR_ORDER'
              ? EquipmentRepairOrderModel
            : policy.resourceModel === 'EQUIPMENT_STATUS_APPLICATION'
              ? EquipmentStatusApplicationModel
            : policy.resourceModel === 'INVENTORY_ITEM'
              ? InventoryItemModel
            : policy.resourceModel === 'SUPPLIER_CONTRACT_RECORD'
              ? SupplierContractRecordModel
            : TaskModel;
    const query = OwnerModel.findOne(ownerFilter).select('_id teamId orgUnitId');
    if (session) query.session(session);
    const owner = await query.lean();
    if (!owner || !sameId(owner.teamId, teamId)) throw notFound();
    return owner;
  }

  async function assertFileAccess({ authContext, file, teamId, method, write = false }) {
    if (file.status === FILE_STATUSES.TEMPORARY) {
      if (
        authContext.mode !== SESSION_MODES.TEAM ||
        !sameId(file.uploaderId, authContext.userId)
      ) {
        throw notFound();
      }
      assertTemporaryUploadPermission(authContext);
      return;
    }
    if (
      file.status !== FILE_STATUSES.ACTIVE ||
      !OWNER_ACCESS_POLICIES[file.ownerType]
    ) {
      throw notFound();
    }
    await assertOwnerAccess({
      authContext,
      ownerType: file.ownerType,
      ownerId: file.ownerId,
      teamId,
      method,
      write
    });
  }

  async function findAccessibleFile({ authContext, fileId, requestedTeamId, method, write }) {
    const teamId = write
      ? normalizeObjectId(assertTeamContext(authContext).activeTeamId, 'activeTeamId')
      : await resolveReadTeamId(authContext, requestedTeamId);
    const file = await FileAssetModel.findOne({
      _id: normalizeFileId(fileId),
      teamId,
      status: { $ne: FILE_STATUSES.DELETED }
    });
    if (!file) throw notFound();
    await assertFileAccess({ authContext, file, teamId, method, write });
    return { file, teamId };
  }

  async function uploadTemporary({ authContext, req, upload, requestedOriginalName }) {
    assertTemporaryUploadPermission(authContext);
    if (!upload || !Buffer.isBuffer(upload.buffer)) {
      throw fileError(400, 'FILE_REQUIRED', 'A single file upload is required');
    }

    let originalName;
    try {
      originalName = normalizeOriginalName(requestedOriginalName || upload.originalname);
      validatedExtension(originalName, upload.mimetype);
      validateFileContent(upload.buffer, upload.mimetype);
    } catch (error) {
      throw fileError(415, 'FILE_CONTENT_INVALID', error.message);
    }

    const teamId = normalizeObjectId(authContext.activeTeamId, 'activeTeamId');
    const storageKey = createStorageKey({
      teamId,
      originalName,
      mimeType: upload.mimetype
    });
    const storagePath = resolveStoragePath(requireStorageRoot(), storageKey);
    await fs.promises.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });

    let file = null;
    let persistedFile = null;
    try {
      await fs.promises.writeFile(storagePath, upload.buffer, {
        flag: 'wx',
        mode: 0o600
      });
      const sha256 = crypto.createHash('sha256').update(upload.buffer).digest('hex');
      file = await withTemporaryUploadLock(teamId, () => runWithOptionalTransaction(
        async (session) => {
          await assertTemporaryUploadCapacity({
            authContext,
            incomingBytes: upload.buffer.length,
            session
          });
          const created = await createOne(FileAssetModel, {
            teamId,
            ownerType: FILE_OWNER_TYPES.TEMPORARY,
            ownerId: null,
            storageKey,
            originalName,
            mimeType: upload.mimetype,
            size: upload.buffer.length,
            sha256,
            uploaderId: authContext.userId,
            status: FILE_STATUSES.TEMPORARY
          }, session);
          persistedFile = created;
          await auditService.record({
            req,
            authContext,
            action: AUDIT_ACTIONS.CREATE,
            resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
            resourceId: created._id,
            after: auditSnapshot(created),
            targetTeamId: teamId,
            session
          });
          return created;
        },
        connection
      ));
      return serializeFile(file);
    } catch (error) {
      await fs.promises.rm(storagePath, { force: true }).catch(() => {});
      if (persistedFile?._id) {
        await FileAssetModel.deleteOne({ _id: persistedFile._id, teamId }).catch(() => {});
      }
      throw error;
    }
  }

  async function getMetadata({ authContext, fileId, requestedTeamId, method = 'GET' }) {
    const { file } = await findAccessibleFile({
      authContext,
      fileId,
      requestedTeamId,
      method,
      write: false
    });
    return serializeFile(file);
  }

  async function getDownload({ authContext, fileId, requestedTeamId, method = 'GET' }) {
    const { file } = await findAccessibleFile({
      authContext,
      fileId,
      requestedTeamId,
      method,
      write: false
    });
    const storagePath = resolveStoragePath(requireStorageRoot(), file.storageKey);
    let stat;
    try {
      stat = await fs.promises.stat(storagePath);
    } catch {
      throw notFound();
    }
    if (!stat.isFile() || stat.size !== file.size) throw notFound();
    return { file: serializeFile(file), storagePath };
  }

  async function reconcileOwnerFiles({
    authContext,
    req,
    attachments,
    previousAttachments = [],
    ownerType,
    ownerId,
    method = 'PATCH',
    allowedMimeTypes = null,
    session = null
  }) {
    const context = assertTeamContext(authContext);
    const normalizedOwner = normalizeOwnerInput(ownerType, ownerId);
    const teamId = normalizeObjectId(context.activeTeamId, 'activeTeamId');
    const fileIds = normalizeAttachmentInput(attachments);
    const previousIds = new Set(managedAttachmentIds(previousAttachments));
    let allowedMimeTypeSet = null;
    if (allowedMimeTypes !== null) {
      if (
        !Array.isArray(allowedMimeTypes) ||
        allowedMimeTypes.length === 0 ||
        allowedMimeTypes.some((mimeType) => typeof mimeType !== 'string' || !mimeType.trim())
      ) {
        throw new TypeError('allowedMimeTypes must be null or a non-empty array of MIME types');
      }
      allowedMimeTypeSet = new Set(allowedMimeTypes.map((mimeType) => mimeType.trim().toLowerCase()));
    }

    await assertOwnerAccess({
      authContext: context,
      ownerType: normalizedOwner.ownerType,
      ownerId: normalizedOwner.ownerId,
      teamId,
      method,
      write: true,
      session
    });

    const query = FileAssetModel.find({
      _id: { $in: fileIds },
      teamId,
      status: { $in: [FILE_STATUSES.TEMPORARY, FILE_STATUSES.ACTIVE] }
    });
    if (session) query.session(session);
    const files = fileIds.length > 0 ? await query : [];
    if (files.length !== fileIds.length) throw notFound();

    const filesById = new Map(files.map((file) => [String(file._id), file]));
    const orderedFiles = fileIds.map((fileId) => filesById.get(fileId));
    if (orderedFiles.some((file) => !file)) throw notFound();
    if (
      allowedMimeTypeSet &&
      orderedFiles.some((file) => !allowedMimeTypeSet.has(String(file.mimeType).toLowerCase()))
    ) {
      throw fileError(415, 'FILE_MIME_TYPE_NOT_ALLOWED', 'One or more files use a disallowed MIME type');
    }

    for (const file of orderedFiles) {
      const normalizedFileId = String(file._id);
      if (file.status === FILE_STATUSES.TEMPORARY) {
        if (!sameId(file.uploaderId, context.userId)) throw notFound();
        continue;
      }

      if (
        !previousIds.has(normalizedFileId) ||
        file.ownerType !== normalizedOwner.ownerType ||
        !sameId(file.ownerId, normalizedOwner.ownerId)
      ) {
        throw notFound();
      }
    }

    for (const file of orderedFiles.filter(
      (candidate) => candidate.status === FILE_STATUSES.TEMPORARY
    )) {
      const before = auditSnapshot(file);
      file.ownerType = normalizedOwner.ownerType;
      file.ownerId = normalizedOwner.ownerId;
      file.status = FILE_STATUSES.ACTIVE;
      await file.save({ session: session || undefined });
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.ASSIGN,
        resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
        resourceId: file._id,
        before,
        after: auditSnapshot(file),
        targetTeamId: teamId,
        session
      });
    }

    const removedIds = [...previousIds].filter((fileId) => !fileIds.includes(fileId));
    if (removedIds.length > 0) {
      const removedQuery = FileAssetModel.find({
        _id: { $in: removedIds },
        teamId,
        ownerType: normalizedOwner.ownerType,
        ownerId: normalizedOwner.ownerId,
        status: FILE_STATUSES.ACTIVE
      });
      if (session) removedQuery.session(session);
      const removedFiles = await removedQuery;
      for (const file of removedFiles) {
        const before = auditSnapshot(file);
        file.status = FILE_STATUSES.DELETED;
        file.deletedAt = new Date();
        file.deletedBy = context.userId;
        await file.save({ session: session || undefined });
        await auditService.record({
          req,
          authContext: context,
          action: AUDIT_ACTIONS.FILE_DELETE,
          resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
          resourceId: file._id,
          before,
          after: auditSnapshot(file),
          reason: 'Business attachment replaced',
          targetTeamId: teamId,
          session
        });
      }
    }

    return orderedFiles.map(attachmentReference);
  }

  async function bindFile({ authContext, req, fileId, ownerType, ownerId }) {
    const normalizedFileId = normalizeFileId(fileId);
    const context = assertTeamContext(authContext);
    // Preserve the non-disclosure boundary before reporting that an owner type
    // is managed by its business workflow. A caller must first be able to see
    // the source file (including ownership of a temporary upload).
    await findAccessibleFile({
      authContext: context,
      fileId: normalizedFileId,
      method: 'PATCH',
      write: true
    });
    assertGenericOwnerMutationAllowed(ownerType);
    return runWithOptionalTransaction(async (session) => {
      await reconcileOwnerFiles({
        authContext,
        req,
        attachments: [{ fileId: normalizedFileId }],
        previousAttachments: [],
        ownerType,
        ownerId,
        method: 'PATCH',
        session
      });
      const query = FileAssetModel.findOne({
        _id: normalizedFileId,
        teamId: context.activeTeamId,
        status: FILE_STATUSES.ACTIVE
      });
      if (session) query.session(session);
      const file = await query;
      if (!file) throw notFound();
      return serializeFile(file);
    }, connection);
  }

  async function deleteFile({ authContext, req, fileId, reason = null }) {
    const context = assertTeamContext(authContext);
    const { file, teamId } = await findAccessibleFile({
      authContext: context,
      fileId,
      method: 'DELETE',
      write: true
    });
    assertGenericOwnerMutationAllowed(file.ownerType);
    return runWithOptionalTransaction(async (session) => {
      if (session) file.$session(session);
      const before = auditSnapshot(file);
      file.status = FILE_STATUSES.DELETED;
      file.deletedAt = new Date();
      file.deletedBy = context.userId;
      await file.save({ session: session || undefined });
      await auditService.record({
        req,
        authContext: context,
        action: AUDIT_ACTIONS.FILE_DELETE,
        resourceType: AUDIT_RESOURCE_TYPES.FILE_ASSET,
        resourceId: file._id,
        before,
        after: auditSnapshot(file),
        reason,
        targetTeamId: teamId,
        session
      });
      return serializeFile(file);
    }, connection);
  }

  return Object.freeze({
    assertTemporaryUploadCapacity,
    bindFile,
    deleteFile,
    getDownload,
    getMetadata,
    reconcileOwnerFiles,
    uploadTemporary
  });
}

module.exports = {
  DEFAULT_TEMPORARY_FILE_LIMITS,
  FileAssetError,
  attachmentReference,
  assertTemporaryQuotaUsage,
  assertTemporaryUploadPermission,
  createFileAssetService,
  managedAttachmentIds,
  normalizeTemporaryFileLimits,
  normalizeAttachmentInput,
  preserveLegacyAttachments,
  serializeFile
};
