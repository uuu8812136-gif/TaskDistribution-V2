'use strict';

const mongoose = require('mongoose');
const {
  AUDIT_ACTOR_ROLES,
  AUDIT_ACTOR_ROLE_VALUES,
  AUDIT_ACTOR_MODES,
  AUDIT_ACTOR_MODE_VALUES,
  AUDIT_ACTION_VALUES,
  AUDIT_RESOURCE_TYPE_VALUES
} = require('../config/permissions');

const auditLogSchema = new mongoose.Schema({
  actorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    immutable: true
  },
  actorRole: {
    type: String,
    enum: AUDIT_ACTOR_ROLE_VALUES,
    required: true,
    immutable: true
  },
  actorMode: {
    type: String,
    enum: AUDIT_ACTOR_MODE_VALUES,
    required: true,
    immutable: true
  },
  activeTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    default: null,
    immutable: true
  },
  targetTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    default: null,
    immutable: true
  },
  action: {
    type: String,
    enum: AUDIT_ACTION_VALUES,
    required: true,
    immutable: true
  },
  resourceType: {
    type: String,
    enum: AUDIT_RESOURCE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  resourceId: {
    type: String,
    trim: true,
    maxlength: 128,
    default: null,
    immutable: true
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined,
    immutable: true
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined,
    immutable: true
  },
  reason: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: null,
    immutable: true
  },
  requestId: {
    type: String,
    trim: true,
    maxlength: 128,
    default: null,
    immutable: true
  },
  requestMethod: {
    type: String,
    trim: true,
    uppercase: true,
    enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    default: null,
    immutable: true
  },
  requestPath: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: null,
    immutable: true
  },
  ip: {
    type: String,
    trim: true,
    maxlength: 64,
    default: null,
    immutable: true
  },
  userAgent: {
    type: String,
    trim: true,
    maxlength: 1000,
    default: null,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  collection: 'audit_logs'
});

auditLogSchema.pre('validate', function validateActorContext(next) {
  const isSystemActor = this.actorRole === AUDIT_ACTOR_ROLES.SYSTEM;
  if (!isSystemActor && !this.actorUserId) {
    this.invalidate('actorUserId', 'A user audit actor requires actorUserId');
  }
  if (isSystemActor && this.actorMode !== AUDIT_ACTOR_MODES.SYSTEM) {
    this.invalidate('actorMode', 'A system actor must use SYSTEM mode');
  }
  if (!isSystemActor && this.actorMode === AUDIT_ACTOR_MODES.SYSTEM) {
    this.invalidate('actorMode', 'A user actor cannot use SYSTEM mode');
  }
  if (this.actorMode === AUDIT_ACTOR_MODES.TEAM && !this.activeTeamId) {
    this.invalidate('activeTeamId', 'TEAM actor mode requires activeTeamId');
  }
  if (
    this.actorMode !== AUDIT_ACTOR_MODES.TEAM &&
    this.actorMode !== AUDIT_ACTOR_MODES.SYSTEM &&
    this.activeTeamId
  ) {
    this.invalidate('activeTeamId', `${this.actorMode} actor mode cannot have activeTeamId`);
  }
  next();
});

function rejectAuditMutation(next) {
  next(new Error('AuditLog is append-only'));
}

auditLogSchema.pre('save', function rejectExistingDocumentSave(next) {
  if (!this.isNew) {
    return rejectAuditMutation(next);
  }
  next();
});

for (const operation of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteMany'
]) {
  auditLogSchema.pre(operation, rejectAuditMutation);
}

auditLogSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectAuditMutation
);

auditLogSchema.pre('bulkWrite', function allowInsertOnlyBulkWrite(next, operations) {
  const containsMutation = operations.some((operation) => !operation.insertOne);
  if (containsMutation) {
    return rejectAuditMutation(next);
  }
  next();
});

auditLogSchema.index(
  { createdAt: -1 },
  { name: 'ix_audit_created_at' }
);
auditLogSchema.index(
  { targetTeamId: 1, createdAt: -1 },
  { name: 'ix_audit_target_team_created_at' }
);
auditLogSchema.index(
  { actorUserId: 1, createdAt: -1 },
  { name: 'ix_audit_actor_created_at' }
);
auditLogSchema.index(
  { resourceType: 1, resourceId: 1, createdAt: -1 },
  { name: 'ix_audit_resource_created_at' }
);
auditLogSchema.index(
  { action: 1, createdAt: -1 },
  { name: 'ix_audit_action_created_at' }
);
auditLogSchema.index(
  { requestId: 1 },
  { sparse: true, name: 'ix_audit_request_id' }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
