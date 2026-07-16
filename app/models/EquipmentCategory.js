'use strict';

const mongoose = require('mongoose');

const EQUIPMENT_CATEGORY_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
});
const EQUIPMENT_CATEGORY_STATUS_VALUES = Object.freeze(
  Object.values(EQUIPMENT_CATEGORY_STATUSES)
);

const equipmentCategorySchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentCategory',
    default: null
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
  status: {
    type: String,
    enum: EQUIPMENT_CATEGORY_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_CATEGORY_STATUSES.ACTIVE
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

equipmentCategorySchema.pre('validate', function validateParent(next) {
  if (this.parentId && this._id && this.parentId.equals(this._id)) {
    this.invalidate('parentId', 'An equipment category cannot be its own parent');
  }
  next();
});

equipmentCategorySchema.index(
  { teamId: 1, name: 1 },
  { unique: true, name: 'uq_equipment_category_team_name' }
);
equipmentCategorySchema.index(
  { teamId: 1, parentId: 1, status: 1, sortOrder: 1 },
  { name: 'ix_equipment_category_team_parent_status_sort' }
);

const EquipmentCategory = mongoose.model('EquipmentCategory', equipmentCategorySchema);

module.exports = EquipmentCategory;
module.exports.EQUIPMENT_CATEGORY_STATUSES = EQUIPMENT_CATEGORY_STATUSES;
module.exports.EQUIPMENT_CATEGORY_STATUS_VALUES = EQUIPMENT_CATEGORY_STATUS_VALUES;
