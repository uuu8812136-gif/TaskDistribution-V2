'use strict';

const mongoose = require('mongoose');
const {
  EQUIPMENT_ROUTINE_TYPES,
  EQUIPMENT_ROUTINE_TYPE_VALUES
} = require('./EquipmentRoutineRule');

const EQUIPMENT_ROUTINE_ITEM_RESULTS = Object.freeze({
  NORMAL: 'NORMAL',
  ABNORMAL: 'ABNORMAL',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED'
});
const EQUIPMENT_ROUTINE_ITEM_RESULT_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_ITEM_RESULTS)
);

const EQUIPMENT_ROUTINE_OVERALL_RESULTS = Object.freeze({
  NORMAL: 'NORMAL',
  ABNORMAL: 'ABNORMAL',
  COMPLETED: 'COMPLETED'
});
const EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_OVERALL_RESULTS)
);

const itemResultSchema = new mongoose.Schema({
  itemKey: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 128,
    immutable: true
  },
  result: {
    type: String,
    enum: EQUIPMENT_ROUTINE_ITEM_RESULT_VALUES,
    required: true,
    immutable: true
  },
  note: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: '',
    immutable: true
  }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentRoutineRecordSchema = new mongoose.Schema({
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
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentCategory',
    required: true,
    immutable: true
  },
  ruleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRoutineRule',
    required: true,
    immutable: true
  },
  ruleVersion: {
    type: Number,
    min: 1,
    required: true,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'ruleVersion must be an integer'
    }
  },
  ruleSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    immutable: true
  },
  routineType: {
    type: String,
    enum: EQUIPMENT_ROUTINE_TYPE_VALUES,
    required: true,
    immutable: true
  },
  scheduledFor: {
    type: Date,
    default: null,
    immutable: true
  },
  dueRuntimeHours: {
    type: Number,
    min: 0,
    default: null,
    immutable: true,
    validate: {
      validator: (value) => value === null || Number.isFinite(value),
      message: 'dueRuntimeHours must be a finite non-negative number or null'
    }
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  performedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  },
  performedRuntimeHours: {
    type: Number,
    min: 0,
    default: null,
    immutable: true,
    validate: {
      validator: (value) => value === null || Number.isFinite(value),
      message: 'performedRuntimeHours must be a finite non-negative number or null'
    }
  },
  itemResults: {
    type: [itemResultSchema],
    required: true,
    immutable: true,
    validate: [
      {
        validator: (items) => Array.isArray(items) && items.length >= 1 && items.length <= 500,
        message: 'itemResults must contain between 1 and 500 items'
      },
      {
        validator: (items) => (
          Array.isArray(items) &&
          new Set(items.map((item) => item.itemKey)).size === items.length
        ),
        message: 'itemResults must contain each itemKey at most once'
      }
    ]
  },
  overallResult: {
    type: String,
    enum: EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES,
    required: true,
    immutable: true
  },
  abnormalSummary: {
    type: String,
    trim: true,
    maxlength: 5000,
    default: '',
    immutable: true
  },
  photoFileIds: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FileAsset',
      required: true
    }],
    default: [],
    immutable: true,
    validate: [
      {
        validator: (values) => (
          Array.isArray(values) &&
          values.every((value) => value instanceof mongoose.Types.ObjectId)
        ),
        message: 'photoFileIds must contain only ObjectIds'
      },
      {
        validator: (values) => Array.isArray(values) && values.length <= 50,
        message: 'photoFileIds cannot contain more than 50 files'
      },
      {
        validator: (values) => (
          Array.isArray(values) &&
          new Set(values.map(String)).size === values.length
        ),
        message: 'photoFileIds must not contain duplicates'
      }
    ]
  },
  idempotencyKey: {
    type: String,
    trim: true,
    maxlength: 128,
    default: null,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  versionKey: false
});

function rejectMutation(next) {
  next(new Error('EquipmentRoutineRecord is append-only'));
}

equipmentRoutineRecordSchema.pre('save', function rejectExistingSave(next) {
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
  equipmentRoutineRecordSchema.pre(operation, rejectMutation);
}

equipmentRoutineRecordSchema.pre(
  'deleteOne',
  { document: true, query: true },
  rejectMutation
);

equipmentRoutineRecordSchema.pre('bulkWrite', function allowInsertOnly(next, operations) {
  if (operations.some((operation) => !operation.insertOne)) return rejectMutation(next);
  return next();
});

equipmentRoutineRecordSchema.index(
  { teamId: 1, orgUnitId: 1, equipmentId: 1, performedAt: -1 },
  { name: 'ix_equipment_routine_record_scope_asset_time' }
);
equipmentRoutineRecordSchema.index(
  { teamId: 1, routineType: 1, performedAt: -1 },
  { name: 'ix_equipment_routine_record_team_type_time' }
);
equipmentRoutineRecordSchema.index(
  { teamId: 1, ruleId: 1, performedAt: -1 },
  { name: 'ix_equipment_routine_record_team_rule_time' }
);
equipmentRoutineRecordSchema.index(
  { teamId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    name: 'uq_equipment_routine_record_team_idempotency'
  }
);

const EquipmentRoutineRecord = mongoose.model(
  'EquipmentRoutineRecord',
  equipmentRoutineRecordSchema
);

module.exports = EquipmentRoutineRecord;
module.exports.EQUIPMENT_ROUTINE_TYPES = EQUIPMENT_ROUTINE_TYPES;
module.exports.EQUIPMENT_ROUTINE_TYPE_VALUES = EQUIPMENT_ROUTINE_TYPE_VALUES;
module.exports.EQUIPMENT_ROUTINE_ITEM_RESULTS = EQUIPMENT_ROUTINE_ITEM_RESULTS;
module.exports.EQUIPMENT_ROUTINE_ITEM_RESULT_VALUES = EQUIPMENT_ROUTINE_ITEM_RESULT_VALUES;
module.exports.EQUIPMENT_ROUTINE_OVERALL_RESULTS = EQUIPMENT_ROUTINE_OVERALL_RESULTS;
module.exports.EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES = EQUIPMENT_ROUTINE_OVERALL_RESULT_VALUES;
