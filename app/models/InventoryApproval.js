'use strict';

const mongoose = require('mongoose');
const InventorySession = require('./InventorySession');
const { POSITION_KEY_VALUES } = require('../config/permissions');

const INVENTORY_APPROVAL_STAGES = Object.freeze({
  INVENTORY_PERSON: 'INVENTORY_PERSON',
  SUB_DEPARTMENT_MANAGER: 'SUB_DEPARTMENT_MANAGER',
  DEPARTMENT_DEPUTY_OR_ASSISTANT: 'DEPARTMENT_DEPUTY_OR_ASSISTANT',
  DEPARTMENT_MANAGER: 'DEPARTMENT_MANAGER'
});
const INVENTORY_APPROVAL_STAGE_VALUES = Object.freeze(
  Object.values(INVENTORY_APPROVAL_STAGES)
);

const INVENTORY_APPROVAL_DECISIONS = Object.freeze({
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  RETURN: 'RETURN'
});
const INVENTORY_APPROVAL_DECISION_VALUES = Object.freeze(
  Object.values(INVENTORY_APPROVAL_DECISIONS)
);

const inventoryApprovalSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    required: true,
    immutable: true
  },
  inventorySessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InventorySession',
    required: true,
    immutable: true
  },
  stage: {
    type: String,
    enum: INVENTORY_APPROVAL_STAGE_VALUES,
    required: true,
    immutable: true
  },
  reviewRound: {
    type: Number,
    min: 1,
    required: true,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'reviewRound must be an integer'
    }
  },
  sequence: {
    type: Number,
    min: 1,
    max: 4,
    required: true,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'sequence must be an integer'
    }
  },
  decision: {
    type: String,
    enum: INVENTORY_APPROVAL_DECISION_VALUES,
    required: true,
    immutable: true
  },
  actorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  actorPositionKey: {
    type: String,
    enum: [...POSITION_KEY_VALUES, null],
    default: null,
    immutable: true
  },
  comment: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: '',
    immutable: true
  },
  statusBefore: {
    type: String,
    enum: InventorySession.INVENTORY_SESSION_STATUS_VALUES,
    required: true,
    immutable: true
  },
  statusAfter: {
    type: String,
    enum: InventorySession.INVENTORY_SESSION_STATUS_VALUES,
    required: true,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  versionKey: false,
  collection: 'inventory_approvals'
});

function rejectMutation(next) {
  next(new Error('InventoryApproval is append-only'));
}

inventoryApprovalSchema.pre('save', function rejectExistingSave(next) {
  if (!this.isNew) return rejectMutation(next);
  return next();
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
  inventoryApprovalSchema.pre(operation, rejectMutation);
}

inventoryApprovalSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

inventoryApprovalSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  if (operations.some((operation) => !operation.insertOne)) return rejectMutation(next);
  return next();
});

inventoryApprovalSchema.index(
  { teamId: 1, inventorySessionId: 1, reviewRound: 1, stage: 1 },
  { unique: true, name: 'uq_inventory_approval_session_round_stage' }
);
inventoryApprovalSchema.index(
  { teamId: 1, actorUserId: 1, createdAt: -1 },
  { name: 'ix_inventory_approval_actor_time' }
);

const InventoryApproval = mongoose.model('InventoryApproval', inventoryApprovalSchema);

module.exports = InventoryApproval;
module.exports.INVENTORY_APPROVAL_STAGES = INVENTORY_APPROVAL_STAGES;
module.exports.INVENTORY_APPROVAL_STAGE_VALUES = INVENTORY_APPROVAL_STAGE_VALUES;
module.exports.INVENTORY_APPROVAL_DECISIONS = INVENTORY_APPROVAL_DECISIONS;
module.exports.INVENTORY_APPROVAL_DECISION_VALUES = INVENTORY_APPROVAL_DECISION_VALUES;
