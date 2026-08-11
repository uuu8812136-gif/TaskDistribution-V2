'use strict';

const mongoose = require('mongoose');

const SUPPLIER_TRUSTEE_ATTRIBUTES = Object.freeze({
  HOSTED: 'HOSTED',
  NON_HOSTED: 'NON_HOSTED'
});

const supplierSchema = new mongoose.Schema({
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
    maxlength: 200
  },
  code: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  trusteeAttribute: {
    type: String,
    enum: Object.values(SUPPLIER_TRUSTEE_ATTRIBUTES),
    required: true
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

supplierSchema.index(
  { teamId: 1, code: 1 },
  { unique: true, name: 'uq_supplier_team_code' }
);
supplierSchema.index(
  { teamId: 1, name: 1, code: 1 },
  { name: 'ix_supplier_team_name_code' }
);

const Supplier = mongoose.model('Supplier', supplierSchema);

module.exports = Supplier;
module.exports.SUPPLIER_TRUSTEE_ATTRIBUTES = SUPPLIER_TRUSTEE_ATTRIBUTES;

