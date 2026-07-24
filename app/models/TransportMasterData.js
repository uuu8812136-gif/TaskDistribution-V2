'use strict';

const mongoose = require('mongoose');

const TRANSPORT_MASTER_KINDS = Object.freeze({
  TRIP: 'TRIP',
  ROUTE: 'ROUTE',
  VEHICLE_PLATE: 'VEHICLE_PLATE',
  VEHICLE_TYPE: 'VEHICLE_TYPE',
  DRIVER: 'DRIVER'
});
const TRANSPORT_MASTER_KIND_VALUES = Object.freeze(Object.values(TRANSPORT_MASTER_KINDS));
const TRANSPORT_MASTER_NAME_MAX_LENGTHS = Object.freeze({
  [TRANSPORT_MASTER_KINDS.TRIP]: 50,
  [TRANSPORT_MASTER_KINDS.ROUTE]: 200,
  [TRANSPORT_MASTER_KINDS.VEHICLE_PLATE]: 50,
  [TRANSPORT_MASTER_KINDS.VEHICLE_TYPE]: 100,
  [TRANSPORT_MASTER_KINDS.DRIVER]: 100
});
const TRANSPORT_MASTER_NAME_MAX_LENGTH = Math.max(
  ...Object.values(TRANSPORT_MASTER_NAME_MAX_LENGTHS)
);

const TRANSPORT_MASTER_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
});
const TRANSPORT_MASTER_STATUS_VALUES = Object.freeze(
  Object.values(TRANSPORT_MASTER_STATUSES)
);

function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

function normalizedPlate(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function transportMasterNormalizedKey(kind, value) {
  return kind === TRANSPORT_MASTER_KINDS.VEHICLE_PLATE
    ? normalizedPlate(value)
    : normalizedText(value);
}

const transportMasterDataSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  kind: {
    type: String,
    enum: TRANSPORT_MASTER_KIND_VALUES,
    required: true,
    immutable: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: TRANSPORT_MASTER_NAME_MAX_LENGTH,
    default: undefined
  },
  normalizedKey: {
    type: String,
    required: true,
    maxlength: 200
  },
  status: {
    type: String,
    enum: TRANSPORT_MASTER_STATUS_VALUES,
    required: true,
    default: TRANSPORT_MASTER_STATUSES.ACTIVE
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    immutable: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
  collection: 'transport_master_data'
});

transportMasterDataSchema.pre('validate', function normalizeBusinessKey(next) {
  this.name = String(this.name || '').trim();
  if (!this.name) this.invalidate('name', 'name is required');
  const maxLength = TRANSPORT_MASTER_NAME_MAX_LENGTHS[this.kind];
  if (maxLength && this.name.length > maxLength) {
    this.invalidate('name', `name cannot exceed ${maxLength} characters for kind ${this.kind}`);
  }
  this.normalizedKey = transportMasterNormalizedKey(this.kind, this.name);
  next();
});

transportMasterDataSchema.index(
  { teamId: 1, kind: 1, normalizedKey: 1 },
  { unique: true, name: 'uq_transport_master_team_kind_key' }
);
transportMasterDataSchema.index(
  { teamId: 1, kind: 1, status: 1, sortOrder: 1, normalizedKey: 1 },
  { name: 'ix_transport_master_team_kind_status_sort' }
);

const TransportMasterData = mongoose.model('TransportMasterData', transportMasterDataSchema);

module.exports = TransportMasterData;
module.exports.TRANSPORT_MASTER_KINDS = TRANSPORT_MASTER_KINDS;
module.exports.TRANSPORT_MASTER_KIND_VALUES = TRANSPORT_MASTER_KIND_VALUES;
module.exports.TRANSPORT_MASTER_NAME_MAX_LENGTHS = TRANSPORT_MASTER_NAME_MAX_LENGTHS;
module.exports.TRANSPORT_MASTER_STATUSES = TRANSPORT_MASTER_STATUSES;
module.exports.TRANSPORT_MASTER_STATUS_VALUES = TRANSPORT_MASTER_STATUS_VALUES;
module.exports.transportMasterNormalizedKey = transportMasterNormalizedKey;
