'use strict';

const mongoose = require('mongoose');
const {
  ORG_UNIT_TYPES,
  ORG_UNIT_TYPE_VALUES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_STATUS_VALUES,
  ORG_UNIT_LEVEL_VALUES
} = require('../config/permissions');

const MATERIALIZED_PATH_PATTERN = /^\/(?:[0-9a-fA-F]{24}\/)*$/;
const INCLUDE_DELETED_QUERY = Symbol('includeDeletedOrgUnits');

function lifecycleError(code, message) {
  const error = new Error(message);
  error.name = 'OrgUnitLifecycleError';
  error.code = code;
  return error;
}

function nonDeletedFilter(filter = {}) {
  return {
    $and: [
      filter,
      { status: { $ne: ORG_UNIT_STATUSES.DELETED } }
    ]
  };
}

function touchesDeletionLifecycle(update = {}) {
  const candidates = [
    update,
    update.$set,
    update.$unset,
    update.$rename,
    update.$setOnInsert
  ].filter((value) => value && typeof value === 'object');
  return candidates.some((value) => (
    value.status === ORG_UNIT_STATUSES.DELETED ||
    Object.prototype.hasOwnProperty.call(value, 'deletedAt') ||
    Object.prototype.hasOwnProperty.call(value, 'deletedBy') ||
    Object.prototype.hasOwnProperty.call(value, 'deletionReason')
  ));
}

const orgUnitSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    default: null
  },
  type: {
    type: String,
    enum: ORG_UNIT_TYPE_VALUES,
    required: true,
    default: ORG_UNIT_TYPES.SUB_DEPARTMENT
  },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    minlength: 1,
    maxlength: 50,
    match: /^[A-Z0-9](?:[A-Z0-9_-]{0,48}[A-Z0-9])?$/
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  status: {
    type: String,
    enum: ORG_UNIT_STATUS_VALUES,
    required: true,
    default: ORG_UNIT_STATUSES.ACTIVE
  },
  sortOrder: {
    type: Number,
    min: 0,
    max: 2147483647,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'sortOrder must be an integer'
    }
  },
  // Reference writers increment this inside their transaction. Organization
  // deletion writes the same document, so MongoDB serializes both operations.
  referenceRevision: {
    type: Number,
    min: 0,
    default: 0,
    required: true,
    validate: {
      validator: Number.isInteger,
      message: 'referenceRevision must be an integer'
    }
  },
  // Membership leadership changes and sub-department approvals increment the
  // same branch document in their transactions. This prevents snapshot
  // write-skew between supervisor fallback checks and leader restoration.
  leadershipRevision: {
    type: Number,
    min: 0,
    default: 0,
    required: true,
    validate: {
      validator: Number.isInteger,
      message: 'leadershipRevision must be an integer'
    }
  },
  level: {
    type: Number,
    enum: ORG_UNIT_LEVEL_VALUES,
    required: true
  },
  // Root path is "/"; descendants store ancestor ObjectIds with trailing slashes.
  path: {
    type: String,
    required: true,
    trim: true,
    maxlength: 2048,
    default: '/',
    validate: {
      validator: (value) => MATERIALIZED_PATH_PATTERN.test(value),
      message: 'path must be a materialized ObjectId ancestor path'
    }
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  deletionReason: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: 2000,
    default: null
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

orgUnitSchema.pre('validate', function validateHierarchyShape(next) {
  if (this.parentId && this._id && this.parentId.equals(this._id)) {
    this.invalidate('parentId', 'An organization unit cannot be its own parent');
  }
  if (!this.parentId && this.path !== '/') {
    this.invalidate('path', 'A root organization unit must use path "/"');
  }
  if (this.parentId && this.path === '/') {
    this.invalidate('path', 'A child organization unit must include its ancestor path');
  }
  const deleted = this.status === ORG_UNIT_STATUSES.DELETED;
  if (deleted) {
    if (!(this.deletedAt instanceof Date) || Number.isNaN(this.deletedAt.getTime())) {
      this.invalidate('deletedAt', 'A deleted organization unit requires deletedAt');
    }
    if (!this.deletedBy) {
      this.invalidate('deletedBy', 'A deleted organization unit requires deletedBy');
    }
    if (typeof this.deletionReason !== 'string' || !this.deletionReason.trim()) {
      this.invalidate('deletionReason', 'A deleted organization unit requires deletionReason');
    }
  } else if (this.deletedAt || this.deletedBy || this.deletionReason) {
    this.invalidate('status', 'Deletion metadata is valid only for a deleted organization unit');
  }
  next();
});

orgUnitSchema.post('init', function rememberPersistedLifecycle(document) {
  document.$locals.orgUnitWasDeleted = document.status === ORG_UNIT_STATUSES.DELETED;
});

orgUnitSchema.pre('save', function rejectTombstoneMutation(next) {
  if (this.$locals.orgUnitWasDeleted === true) {
    return next(lifecycleError(
      'ORG_UNIT_TOMBSTONE_IMMUTABLE',
      'Deleted organization units are immutable'
    ));
  }
  if (
    this.status === ORG_UNIT_STATUSES.DELETED &&
    this.$locals.allowOrgUnitSoftDelete !== true
  ) {
    return next(lifecycleError(
      'ORG_UNIT_DELETE_TRANSITION_REQUIRED',
      'Organization units can enter DELETED only through the deletion service'
    ));
  }
  next();
});

orgUnitSchema.post('save', function rememberSavedLifecycle(document) {
  document.$locals.orgUnitWasDeleted = document.status === ORG_UNIT_STATUSES.DELETED;
  delete document.$locals.allowOrgUnitSoftDelete;
});

orgUnitSchema.query.withDeleted = function withDeleted() {
  this[INCLUDE_DELETED_QUERY] = true;
  return this;
};

orgUnitSchema.pre('insertMany', function preventInsertedTombstones(next, documents) {
  if ((documents || []).some((document) => document?.status === ORG_UNIT_STATUSES.DELETED)) {
    return next(lifecycleError(
      'ORG_UNIT_DELETE_TRANSITION_REQUIRED',
      'Organization units can enter DELETED only through the deletion service'
    ));
  }
  next();
});

for (const operation of ['find', 'findOne', 'countDocuments', 'distinct']) {
  orgUnitSchema.pre(operation, function hideDeletedOrgUnits(next) {
    if (this[INCLUDE_DELETED_QUERY] !== true) {
      this.setQuery(nonDeletedFilter(this.getFilter()));
    }
    next();
  });
}

orgUnitSchema.pre('aggregate', function hideDeletedOrgUnitAggregates(next) {
  const pipeline = this.pipeline();
  const firstStageMustRemainFirst = Boolean(pipeline[0]?.$geoNear || pipeline[0]?.$search);
  pipeline.splice(firstStageMustRemainFirst ? 1 : 0, 0, {
    $match: { status: { $ne: ORG_UNIT_STATUSES.DELETED } }
  });
  next();
});

for (const operation of [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace'
]) {
  orgUnitSchema.pre(operation, function preventTombstoneQueryMutation(next) {
    if (touchesDeletionLifecycle(this.getUpdate())) {
      return next(lifecycleError(
        'ORG_UNIT_LIFECYCLE_UPDATE_FORBIDDEN',
        'Deletion lifecycle fields cannot be changed through query updates'
      ));
    }
    this.setQuery(nonDeletedFilter(this.getFilter()));
    next();
  });
}

function rejectHardDelete(next) {
  next(lifecycleError(
    'ORG_UNIT_HARD_DELETE_FORBIDDEN',
    'Organization units must be retained as deletion tombstones'
  ));
}

for (const operation of ['deleteMany', 'findOneAndDelete']) {
  orgUnitSchema.pre(operation, rejectHardDelete);
}
orgUnitSchema.pre('deleteOne', { document: true, query: true }, rejectHardDelete);

orgUnitSchema.pre('bulkWrite', function guardBulkLifecycle(next, operations) {
  for (const operation of operations || []) {
    if (operation.deleteOne || operation.deleteMany) return rejectHardDelete(next);
    const write = operation.updateOne || operation.updateMany || operation.replaceOne;
    if (!write) {
      if (operation.insertOne?.document?.status === ORG_UNIT_STATUSES.DELETED) {
        return next(lifecycleError(
          'ORG_UNIT_DELETE_TRANSITION_REQUIRED',
          'Organization units can enter DELETED only through the deletion service'
        ));
      }
      continue;
    }
    const update = write.update || write.replacement;
    if (touchesDeletionLifecycle(update)) {
      return next(lifecycleError(
        'ORG_UNIT_LIFECYCLE_UPDATE_FORBIDDEN',
        'Deletion lifecycle fields cannot be changed through bulk updates'
      ));
    }
    write.filter = nonDeletedFilter(write.filter || {});
  }
  next();
});

orgUnitSchema.index(
  { teamId: 1, code: 1 },
  { unique: true, name: 'uq_org_unit_team_code' }
);
orgUnitSchema.index(
  { teamId: 1, parentId: 1, status: 1, sortOrder: 1 },
  { name: 'ix_org_unit_team_parent_status_sort' }
);
orgUnitSchema.index(
  { teamId: 1, path: 1, status: 1 },
  { name: 'ix_org_unit_team_path_status' }
);
orgUnitSchema.index(
  { teamId: 1, status: 1, deletedAt: -1 },
  { name: 'ix_org_unit_team_status_deleted_at' }
);

module.exports = mongoose.model('OrgUnit', orgUnitSchema);
