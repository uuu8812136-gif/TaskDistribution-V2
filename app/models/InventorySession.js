'use strict';

const mongoose = require('mongoose');

const INVENTORY_SESSION_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_SUB_DEPARTMENT_MANAGER: 'PENDING_SUB_DEPARTMENT_MANAGER',
  PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT: 'PENDING_DEPARTMENT_DEPUTY_OR_ASSISTANT',
  PENDING_DEPARTMENT_MANAGER: 'PENDING_DEPARTMENT_MANAGER',
  COMPLETED: 'COMPLETED',
  RETURNED: 'RETURNED'
});

const INVENTORY_SESSION_STATUS_VALUES = Object.freeze(
  Object.values(INVENTORY_SESSION_STATUSES)
);

const inventorySessionSchema = new mongoose.Schema({
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
  orgUnitNameSnapshot: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    immutable: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  inventoryPersonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  status: {
    type: String,
    enum: INVENTORY_SESSION_STATUS_VALUES,
    required: true,
    default: INVENTORY_SESSION_STATUSES.DRAFT
  },
  approvalStep: {
    type: Number,
    min: 0,
    max: 4,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'approvalStep must be an integer'
    }
  },
  reviewRound: {
    type: Number,
    min: 1,
    required: true,
    default: 1,
    validate: {
      validator: Number.isInteger,
      message: 'reviewRound must be an integer'
    }
  },
  correctionRevision: {
    type: Number,
    min: 0,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'correctionRevision must be an integer'
    }
  },
  returnedRevision: {
    type: Number,
    min: 0,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'returnedRevision must be an integer'
    }
  },
  itemCount: {
    type: Number,
    min: 1,
    required: true,
    validate: {
      validator: Number.isInteger,
      message: 'itemCount must be an integer'
    }
  },
  checkedCount: {
    type: Number,
    min: 0,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'checkedCount must be an integer'
    }
  },
  differenceCount: {
    type: Number,
    min: 0,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'differenceCount must be an integer'
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  returnedAt: { type: Date, default: null },
  lastTransitionAt: { type: Date, default: null }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
  collection: 'inventory_sessions'
});

inventorySessionSchema.pre('validate', function validateCountsAndTerminalState(next) {
  if (this.checkedCount > this.itemCount || this.differenceCount > this.itemCount) {
    this.invalidate('checkedCount', 'Inventory counters cannot exceed itemCount');
  }
  if (
    this.status === INVENTORY_SESSION_STATUSES.COMPLETED &&
    (!this.completedAt || this.approvalStep !== 4)
  ) {
    this.invalidate('completedAt', 'Completed inventory requires final approval metadata');
  }
  if (this.status === INVENTORY_SESSION_STATUSES.RETURNED && !this.returnedAt) {
    this.invalidate('returnedAt', 'Returned inventory requires returnedAt');
  }
  next();
});

inventorySessionSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1, createdAt: -1 },
  { name: 'ix_inventory_session_scope_status_created' }
);
inventorySessionSchema.index(
  { teamId: 1, inventoryPersonId: 1, status: 1, createdAt: -1 },
  { name: 'ix_inventory_session_person_status_created' }
);

const InventorySession = mongoose.model('InventorySession', inventorySessionSchema);

module.exports = InventorySession;
module.exports.INVENTORY_SESSION_STATUSES = INVENTORY_SESSION_STATUSES;
module.exports.INVENTORY_SESSION_STATUS_VALUES = INVENTORY_SESSION_STATUS_VALUES;
