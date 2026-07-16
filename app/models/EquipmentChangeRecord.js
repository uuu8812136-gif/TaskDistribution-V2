'use strict';

const mongoose = require('mongoose');

const EQUIPMENT_CHANGE_TYPES = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE'
});
const EQUIPMENT_CHANGE_TYPE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_CHANGE_TYPES)
);

const equipmentChangeRecordSchema = new mongoose.Schema({
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
  changeType: {
    type: String,
    enum: EQUIPMENT_CHANGE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    immutable: true
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  reason: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: null,
    immutable: true
  },
  occurredAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  }
}, {
  timestamps: false,
  strict: 'throw',
  versionKey: false
});

equipmentChangeRecordSchema.index(
  { teamId: 1, orgUnitId: 1, equipmentId: 1, occurredAt: -1 },
  { name: 'ix_equipment_change_scope_asset_time' }
);
equipmentChangeRecordSchema.index(
  { teamId: 1, operatorId: 1, occurredAt: -1 },
  { name: 'ix_equipment_change_team_operator_time' }
);

function rejectMutation(next) {
  next(new Error('EquipmentChangeRecord is append-only'));
}

equipmentChangeRecordSchema.pre('save', function rejectExistingSave(next) {
  if (!this.isNew) return rejectMutation(next);
  return next();
});

equipmentChangeRecordSchema.pre('save', function rejectExistingDocumentSave(next) {
  if (!this.isNew) return rejectMutation(next);
  next();
});

for (const hook of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteMany',
  'findOneAndDelete'
]) {
  equipmentChangeRecordSchema.pre(hook, rejectMutation);
}

equipmentChangeRecordSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  const containsMutation = operations.some((operation) => !operation.insertOne);
  if (containsMutation) return rejectMutation(next);
  return next();
});

equipmentChangeRecordSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

equipmentChangeRecordSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  if (operations.some((operation) => !operation.insertOne)) return rejectMutation(next);
  next();
});

const EquipmentChangeRecord = mongoose.model(
  'EquipmentChangeRecord',
  equipmentChangeRecordSchema
);

module.exports = EquipmentChangeRecord;
module.exports.EQUIPMENT_CHANGE_TYPES = EQUIPMENT_CHANGE_TYPES;
module.exports.EQUIPMENT_CHANGE_TYPE_VALUES = EQUIPMENT_CHANGE_TYPE_VALUES;
