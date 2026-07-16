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

module.exports = mongoose.model('OrgUnit', orgUnitSchema);
