'use strict';

const mongoose = require('mongoose');
const {
  TEAM_STATUSES,
  TEAM_STATUS_VALUES
} = require('../config/permissions');

const projectTeamSettingsSchema = new mongoose.Schema({
  timeZone: {
    type: String,
    required: true,
    trim: true,
    maxlength: 64,
    default: 'Asia/Shanghai'
  },
  repairLocations: {
    type: [{
      type: String,
      trim: true,
      minlength: 1,
      maxlength: 500
    }],
    default: [],
    validate: [
      {
        validator: (values) => values.length <= 100,
        message: 'repairLocations cannot contain more than 100 entries'
      },
      {
        validator: (values) => new Set(values).size === values.length,
        message: 'repairLocations must not contain duplicates'
      }
    ]
  }
}, {
  _id: false,
  strict: 'throw'
});

const projectTeamSchema = new mongoose.Schema({
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
    enum: TEAM_STATUS_VALUES,
    default: TEAM_STATUSES.ACTIVE,
    required: true
  },
  settings: {
    type: projectTeamSettingsSchema,
    default: () => ({})
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

projectTeamSchema.index({ code: 1 }, { unique: true, name: 'uq_project_team_code' });
projectTeamSchema.index({ status: 1, name: 1 }, { name: 'ix_project_team_status_name' });

module.exports = mongoose.model('ProjectTeam', projectTeamSchema);
