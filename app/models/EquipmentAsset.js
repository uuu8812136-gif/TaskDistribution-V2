'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const EQUIPMENT_STATUSES = Object.freeze({
  IN_USE: 'IN_USE',
  IDLE: 'IDLE',
  STOPPED: 'STOPPED',
  SCRAPPED: 'SCRAPPED'
});
const EQUIPMENT_STATUS_VALUES = Object.freeze(Object.values(EQUIPMENT_STATUSES));

const DATE_PRECISIONS = Object.freeze({
  DAY: 'DAY',
  MONTH: 'MONTH',
  YEAR: 'YEAR'
});
const DATE_PRECISION_VALUES = Object.freeze(Object.values(DATE_PRECISIONS));

function generateQrToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const equipmentAssetSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    required: true
  },
  assetCode: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  sourceAssetCode: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  sourceSequence: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  assetType: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  sourceSheetName: {
    type: String,
    trim: true,
    maxlength: 100,
    immutable: true
  },
  sourceRowNumber: {
    type: Number,
    min: 1,
    immutable: true
  },
  sourceRawValues: {
    type: mongoose.Schema.Types.Mixed,
    immutable: true
  },
  sourceImageRefs: {
    type: [{ type: String, maxlength: 200 }],
    default: undefined,
    immutable: true
  },
  productCode: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  plateNumber: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  serialNumber: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  brandSerialNumber: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 200
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentCategory',
    required: true
  },
  specification: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  manufacturer: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  brand: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  vehicleLength: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  ratedCapacityText: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  quantity: {
    type: Number,
    min: 0,
    required: true,
    default: 1
  },
  unit: {
    type: String,
    trim: true,
    maxlength: 50,
    default: ''
  },
  acquisitionDate: {
    type: Date,
    default: null
  },
  productionDate: {
    type: Date,
    default: null
  },
  productionDatePrecision: {
    type: String,
    enum: [...DATE_PRECISION_VALUES, null],
    default: null
  },
  productionDateRaw: {
    type: String,
    maxlength: 200,
    default: ''
  },
  productionDateDisplay: {
    type: String,
    maxlength: 200,
    default: ''
  },
  activationDate: {
    type: Date,
    default: null
  },
  activationDatePrecision: {
    type: String,
    enum: [...DATE_PRECISION_VALUES, null],
    default: null
  },
  activationDateRaw: {
    type: String,
    maxlength: 200,
    default: ''
  },
  activationDateDisplay: {
    type: String,
    maxlength: 200,
    default: ''
  },
  idlePlacedAt: {
    type: Date,
    default: null
  },
  idlePlacedAtRaw: {
    type: String,
    maxlength: 200,
    default: ''
  },
  idlePlacedAtDisplay: {
    type: String,
    maxlength: 200,
    default: ''
  },
  bookQuantity: {
    type: Number,
    min: 0,
    default: null
  },
  physicalQuantity: {
    type: Number,
    min: 0,
    default: null
  },
  originalValue: {
    type: Number,
    min: 0,
    default: null
  },
  currentRuntimeHours: {
    type: Number,
    min: 0,
    default: null,
    validate: {
      validator: (value) => value === null || Number.isFinite(value),
      message: 'currentRuntimeHours must be a finite non-negative number or null'
    }
  },
  runtimeHoursUpdatedAt: {
    type: Date,
    default: null
  },
  lastRuntimeReadingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentRuntimeReading',
    default: null
  },
  custodianUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  custodianDisplayName: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  orgUnitNameSnapshot: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  location: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  status: {
    type: String,
    enum: EQUIPMENT_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_STATUSES.IN_USE
  },
  conditionText: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  forkliftPosition: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  environmentalRegistrationCode: {
    type: String,
    trim: true,
    maxlength: 200,
    default: ''
  },
  photoFileIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FileAsset' }],
    default: [],
    validate: [
      {
        validator: (values) => values.length <= 500,
        message: 'photoFileIds cannot contain more than 500 files'
      },
      {
        validator: (values) => new Set(values.map(String)).size === values.length,
        message: 'photoFileIds must not contain duplicates'
      }
    ]
  },
  dataQuality: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  sourceImportJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportJob',
    default: null,
    immutable: true
  },
  qrToken: {
    type: String,
    required: true,
    immutable: true,
    unique: true,
    select: false,
    default: generateQrToken,
    minlength: 43,
    maxlength: 86,
    match: /^[A-Za-z0-9_-]+$/
  },
  remark: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

equipmentAssetSchema.index(
  { teamId: 1, assetCode: 1 },
  { unique: true, name: 'uq_equipment_asset_team_code' }
);
equipmentAssetSchema.index(
  { teamId: 1, sourceSheetName: 1, sourceRowNumber: 1 },
  { name: 'ix_equipment_asset_source_row' }
);
equipmentAssetSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1, categoryId: 1 },
  { name: 'ix_equipment_asset_scope_status_category' }
);
equipmentAssetSchema.index(
  { teamId: 1, orgUnitId: 1, custodianUserId: 1 },
  { name: 'ix_equipment_asset_scope_custodian' }
);

const EquipmentAsset = mongoose.model('EquipmentAsset', equipmentAssetSchema);

module.exports = EquipmentAsset;
module.exports.EQUIPMENT_STATUSES = EQUIPMENT_STATUSES;
module.exports.EQUIPMENT_STATUS_VALUES = EQUIPMENT_STATUS_VALUES;
module.exports.DATE_PRECISIONS = DATE_PRECISIONS;
module.exports.DATE_PRECISION_VALUES = DATE_PRECISION_VALUES;
module.exports.generateQrToken = generateQrToken;
