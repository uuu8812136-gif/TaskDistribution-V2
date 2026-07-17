'use strict';

const mongoose = require('mongoose');
const EquipmentAsset = require('./EquipmentAsset');

const INVENTORY_DIFFERENCE_TYPES = Object.freeze({
  MISSING: 'MISSING',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  QUANTITY_MISMATCH: 'QUANTITY_MISMATCH',
  LOCATION_MISMATCH: 'LOCATION_MISMATCH'
});
const INVENTORY_DIFFERENCE_TYPE_VALUES = Object.freeze(
  Object.values(INVENTORY_DIFFERENCE_TYPES)
);

const INVENTORY_DIFFERENCE_STATUSES = Object.freeze({
  NONE: 'NONE',
  PENDING_REVIEW: 'PENDING_REVIEW',
  CONFIRMED: 'CONFIRMED',
  RETURNED: 'RETURNED'
});
const INVENTORY_DIFFERENCE_STATUS_VALUES = Object.freeze(
  Object.values(INVENTORY_DIFFERENCE_STATUSES)
);

const inventoryItemSchema = new mongoose.Schema({
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
  inventorySessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InventorySession',
    required: true,
    immutable: true
  },
  equipmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentAsset',
    required: true,
    immutable: true
  },
  assetCodeSnapshot: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    immutable: true
  },
  equipmentNameSnapshot: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
    immutable: true
  },
  specificationSnapshot: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  bookStatus: {
    type: String,
    enum: EquipmentAsset.EQUIPMENT_STATUS_VALUES,
    required: true,
    immutable: true
  },
  bookQuantity: {
    type: Number,
    min: 0,
    default: null,
    immutable: true
  },
  bookLocation: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  actualPresent: { type: Boolean, default: null },
  actualStatus: {
    type: String,
    enum: [...EquipmentAsset.EQUIPMENT_STATUS_VALUES, null],
    default: null
  },
  actualQuantity: { type: Number, min: 0, default: null },
  actualLocation: { type: String, trim: true, maxlength: 500, default: '' },
  differenceTypes: {
    type: [{ type: String, enum: INVENTORY_DIFFERENCE_TYPE_VALUES }],
    default: [],
    validate: {
      validator: (values) => new Set(values).size === values.length,
      message: 'differenceTypes must not contain duplicates'
    }
  },
  differenceStatus: {
    type: String,
    enum: INVENTORY_DIFFERENCE_STATUS_VALUES,
    required: true,
    default: INVENTORY_DIFFERENCE_STATUSES.NONE
  },
  differenceNote: { type: String, trim: true, maxlength: 5000, default: '' },
  photoFileIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FileAsset' }],
    default: [],
    validate: [
      {
        validator: (values) => Array.isArray(values) && values.length <= 10,
        message: 'photoFileIds cannot contain more than 10 files'
      },
      {
        validator: (values) => new Set(values.map(String)).size === values.length,
        message: 'photoFileIds must not contain duplicates'
      }
    ]
  },
  checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  checkedAt: { type: Date, default: null }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
  collection: 'inventory_items'
});

inventoryItemSchema.pre('validate', function validateInventoryResult(next) {
  if (this.actualPresent === null) {
    if (this.checkedAt || this.checkedBy || this.differenceTypes.length > 0) {
      this.invalidate('actualPresent', 'Unchecked inventory item cannot contain a result');
    }
    return next();
  }
  if (!this.checkedAt || !this.checkedBy) {
    this.invalidate('checkedAt', 'Checked inventory item requires checker metadata');
  }
  const hasDifference = this.differenceTypes.length > 0;
  if (hasDifference && (!this.differenceNote || this.photoFileIds.length < 1)) {
    this.invalidate('differenceNote', 'Inventory differences require a note and at least one photo');
  }
  if (!hasDifference && this.differenceStatus !== INVENTORY_DIFFERENCE_STATUSES.NONE) {
    this.invalidate('differenceStatus', 'Matching inventory item must use NONE difference status');
  }
  if (hasDifference && this.differenceStatus === INVENTORY_DIFFERENCE_STATUSES.NONE) {
    this.invalidate('differenceStatus', 'Inventory difference requires a review status');
  }
  next();
});

inventoryItemSchema.index(
  { teamId: 1, inventorySessionId: 1, equipmentId: 1 },
  { unique: true, name: 'uq_inventory_item_session_equipment' }
);
inventoryItemSchema.index(
  { teamId: 1, orgUnitId: 1, inventorySessionId: 1, differenceStatus: 1 },
  { name: 'ix_inventory_item_scope_session_difference' }
);

const InventoryItem = mongoose.model('InventoryItem', inventoryItemSchema);

module.exports = InventoryItem;
module.exports.INVENTORY_DIFFERENCE_TYPES = INVENTORY_DIFFERENCE_TYPES;
module.exports.INVENTORY_DIFFERENCE_TYPE_VALUES = INVENTORY_DIFFERENCE_TYPE_VALUES;
module.exports.INVENTORY_DIFFERENCE_STATUSES = INVENTORY_DIFFERENCE_STATUSES;
module.exports.INVENTORY_DIFFERENCE_STATUS_VALUES = INVENTORY_DIFFERENCE_STATUS_VALUES;
