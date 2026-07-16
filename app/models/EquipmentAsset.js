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
  originalValue: {
    type: Number,
    min: 0,
    default: null
  },
  custodianUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
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
module.exports.generateQrToken = generateQrToken;
