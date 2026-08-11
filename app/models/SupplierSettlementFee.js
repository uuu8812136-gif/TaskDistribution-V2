'use strict';

const mongoose = require('mongoose');

const supplierSettlementFeeSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    immutable: true
  },
  month: {
    type: String,
    required: true,
    match: /^\d{4}-(?:0[1-9]|1[0-2])$/
  },
  supplierName: { type: String, required: true, trim: true, maxlength: 200 },
  supplierCode: { type: String, required: true, trim: true, maxlength: 100 },
  productLaunchAmount: { type: Number, required: true, min: 0, default: 0 },
  warehousingLogisticsFee: { type: Number, required: true, min: 0, default: 0 },
  overstorageProductAmount: { type: Number, required: true, min: 0, default: 0 },
  overstorageLogisticsFee: { type: Number, required: true, min: 0, default: 0 },
  remarks: { type: String, trim: true, maxlength: 5000, default: '' },
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

supplierSettlementFeeSchema.index(
  { teamId: 1, month: 1, supplierCode: 1 },
  { unique: true, name: 'uq_supplier_settlement_team_month_code' }
);
supplierSettlementFeeSchema.index(
  { teamId: 1, month: -1, supplierName: 1, supplierCode: 1 },
  { name: 'ix_supplier_settlement_team_month_supplier' }
);

module.exports = mongoose.model('SupplierSettlementFee', supplierSettlementFeeSchema);

