'use strict';

const mongoose = require('mongoose');

const EQUIPMENT_RUNTIME_READING_SOURCES = Object.freeze({
  MANUAL: 'MANUAL',
  INSPECTION: 'INSPECTION',
  MAINTENANCE: 'MAINTENANCE'
});
const EQUIPMENT_RUNTIME_READING_SOURCE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_RUNTIME_READING_SOURCES)
);

const equipmentRuntimeReadingSchema = new mongoose.Schema({
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
  hours: {
    type: Number,
    required: true,
    min: 0,
    immutable: true,
    validate: {
      validator: Number.isFinite,
      message: 'hours must be a finite non-negative number'
    }
  },
  previousHours: {
    type: Number,
    min: 0,
    default: null,
    immutable: true,
    validate: {
      validator: (value) => value === null || Number.isFinite(value),
      message: 'previousHours must be a finite non-negative number or null'
    }
  },
  recordedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  },
  operatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  source: {
    type: String,
    enum: EQUIPMENT_RUNTIME_READING_SOURCE_VALUES,
    required: true,
    default: EQUIPMENT_RUNTIME_READING_SOURCES.MANUAL,
    immutable: true
  },
  sourceRecordId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRoutineRecord',
    default: null,
    immutable: true
  },
  reason: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: null,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  versionKey: false
});

equipmentRuntimeReadingSchema.pre('validate', function validateReading(next) {
  if (this.previousHours !== null && this.hours < this.previousHours) {
    this.invalidate('hours', 'hours cannot be less than previousHours');
  }

  if (
    this.source === EQUIPMENT_RUNTIME_READING_SOURCES.MANUAL &&
    this.sourceRecordId
  ) {
    this.invalidate('sourceRecordId', 'A MANUAL reading cannot have sourceRecordId');
  }

  if (
    this.source !== EQUIPMENT_RUNTIME_READING_SOURCES.MANUAL &&
    !this.sourceRecordId
  ) {
    this.invalidate('sourceRecordId', `${this.source} reading requires sourceRecordId`);
  }

  next();
});

function rejectMutation(next) {
  next(new Error('EquipmentRuntimeReading is append-only'));
}

equipmentRuntimeReadingSchema.pre('save', function rejectExistingSave(next) {
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
  equipmentRuntimeReadingSchema.pre(operation, rejectMutation);
}

equipmentRuntimeReadingSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

equipmentRuntimeReadingSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  if (operations.some((operation) => !operation.insertOne)) return rejectMutation(next);
  return next();
});

equipmentRuntimeReadingSchema.index(
  { teamId: 1, orgUnitId: 1, equipmentId: 1, recordedAt: -1 },
  { name: 'ix_equipment_runtime_reading_scope_asset_time' }
);
equipmentRuntimeReadingSchema.index(
  { teamId: 1, operatorId: 1, recordedAt: -1 },
  { name: 'ix_equipment_runtime_reading_team_operator_time' }
);
equipmentRuntimeReadingSchema.index(
  { teamId: 1, sourceRecordId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceRecordId: { $type: 'objectId' } },
    name: 'uq_equipment_runtime_reading_team_source_record'
  }
);

const EquipmentRuntimeReading = mongoose.model(
  'EquipmentRuntimeReading',
  equipmentRuntimeReadingSchema
);

module.exports = EquipmentRuntimeReading;
module.exports.EQUIPMENT_RUNTIME_READING_SOURCES = EQUIPMENT_RUNTIME_READING_SOURCES;
module.exports.EQUIPMENT_RUNTIME_READING_SOURCE_VALUES = EQUIPMENT_RUNTIME_READING_SOURCE_VALUES;
