'use strict';

const mongoose = require('mongoose');
const EquipmentStatusApplication = require('./EquipmentStatusApplication');

const {
  EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES,
  EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES
} = EquipmentStatusApplication;

const equipmentStatusApprovalSchema = new mongoose.Schema({
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
  equipmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentAsset',
    required: true,
    immutable: true
  },
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentStatusApplication',
    required: true,
    immutable: true
  },
  applicationRevision: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'applicationRevision must be an integer'
    }
  },
  action: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_ACTION_VALUES,
    required: true,
    immutable: true
  },
  fromStatus: {
    type: String,
    enum: [...EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES, null],
    default: null,
    immutable: true
  },
  toStatus: {
    type: String,
    enum: EQUIPMENT_STATUS_APPLICATION_STATUS_VALUES,
    required: true,
    immutable: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  actorPositionKey: {
    type: String,
    trim: true,
    maxlength: 100,
    default: '',
    immutable: true
  },
  opinion: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: '',
    immutable: true
  },
  applicationSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  actedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  versionKey: false
});

function rejectHistoryMutation(next) {
  const error = new Error('Equipment status approval history is append-only');
  error.status = 409;
  error.code = 'EQUIPMENT_STATUS_APPROVAL_APPEND_ONLY';
  next(error);
}

for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndDelete']) {
  equipmentStatusApprovalSchema.pre(hook, rejectHistoryMutation);
}

equipmentStatusApprovalSchema.index(
  { teamId: 1, applicationId: 1, actedAt: 1, _id: 1 },
  { name: 'ix_equipment_status_approval_application_history' }
);
equipmentStatusApprovalSchema.index(
  { teamId: 1, actorId: 1, actedAt: -1 },
  { name: 'ix_equipment_status_approval_actor_time' }
);

module.exports = mongoose.model('EquipmentStatusApproval', equipmentStatusApprovalSchema);
