'use strict';

const mongoose = require('mongoose');

const CONTRACT_RECORD_CATEGORIES = Object.freeze({
  SUPPLIER_INFO: 'SUPPLIER_INFO',
  MAIN_SERVICE_AGREEMENT: 'MAIN_SERVICE_AGREEMENT',
  LOGISTICS_FEE_AGREEMENT: 'LOGISTICS_FEE_AGREEMENT',
  TURNOVER_EQUIPMENT_SERVICE: 'TURNOVER_EQUIPMENT_SERVICE',
  EQUIPMENT_RENTAL: 'EQUIPMENT_RENTAL'
});

const CONTRACT_SIGNING_STATUSES = Object.freeze({
  SIGNED: 'SIGNED',
  UNSIGNED: 'UNSIGNED'
});

const CONTRACT_ATTACHMENT_PURPOSES = Object.freeze({
  INVOICE_INFO: 'INVOICE_INFO',
  CONTRACT_PDF: 'CONTRACT_PDF',
  PAYMENT_RECEIPT: 'PAYMENT_RECEIPT',
  GENERAL: 'GENERAL'
});

const SUPPLY_STATUSES = Object.freeze({
  NORMAL: 'NORMAL',
  STOPPED: 'STOPPED'
});

const OVERSTORAGE_DAY_OPTIONS = Object.freeze({
  NONE: 'NONE',
  DAYS_30_PLUS_15: '30+15',
  DAYS_60_PLUS_15: '60+15',
  DAYS_90_PLUS_15: '90+15'
});

const contactSchema = new mongoose.Schema({
  name: { type: String, trim: true, maxlength: 100, default: '' },
  phone: { type: String, trim: true, maxlength: 100, default: '' }
}, { _id: false, strict: 'throw' });

contactSchema.pre('validate', function validateContact(next) {
  if (!this.name && !this.phone) this.invalidate('name', 'A contact name or phone is required');
  next();
});

const attachmentSchema = new mongoose.Schema({
  fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FileAsset', required: true },
  originalName: { type: String, required: true, trim: true, maxlength: 255 },
  mimeType: { type: String, required: true, trim: true, maxlength: 150 },
  size: { type: Number, required: true, min: 0 },
  uploadTime: { type: Date, required: true },
  purpose: {
    type: String,
    enum: Object.values(CONTRACT_ATTACHMENT_PURPOSES),
    required: true
  }
}, { _id: false, strict: 'throw' });

const detailsSchema = new mongoose.Schema({
  supplyStatus: { type: String, enum: Object.values(SUPPLY_STATUSES), default: null },
  hasInvoiceInfo: { type: Boolean, default: null },
  invoiceInfoText: { type: String, trim: true, maxlength: 5000, default: '' },
  contacts: { type: [contactSchema], default: [] },
  reconciliationEmails: {
    type: [{ type: String, trim: true, maxlength: 254 }],
    default: []
  },
  unsignedReason: { type: String, trim: true, maxlength: 2000, default: '' },
  remarks: { type: String, trim: true, maxlength: 5000, default: '' },
  supplierSignedDate: { type: Date, default: null },
  companySignedDate: { type: Date, default: null },
  returnDate: { type: Date, default: null },
  courierNumber: { type: String, trim: true, maxlength: 200, default: '' },
  deliveredBusinessDate: { type: Date, default: null },
  deliveredFactoryDate: { type: Date, default: null },
  warehouseServiceRate: { type: String, trim: true, maxlength: 100, default: '' },
  overstorageServiceRate: { type: String, trim: true, maxlength: 100, default: '' },
  overstorageDays: {
    type: String,
    enum: [...Object.values(OVERSTORAGE_DAY_OPTIONS), null],
    default: null
  },
  settlementCycle: { type: String, trim: true, maxlength: 200, default: '' },
  equipmentType: { type: String, trim: true, maxlength: 200, default: '' },
  equipmentServicePrice: { type: String, trim: true, maxlength: 100, default: '' },
  specification: { type: String, trim: true, maxlength: 200, default: '' },
  productionBatch: { type: String, trim: true, maxlength: 200, default: '' },
  color: { type: String, trim: true, maxlength: 100, default: '' },
  quantity: { type: String, trim: true, maxlength: 100, default: '' }
}, { _id: false, strict: 'throw' });

const supplierContractRecordSchema = new mongoose.Schema({
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
  category: {
    type: String,
    enum: Object.values(CONTRACT_RECORD_CATEGORIES),
    required: true,
    immutable: true
  },
  signingStatus: {
    type: String,
    enum: [...Object.values(CONTRACT_SIGNING_STATUSES), null],
    default: null
  },
  contractNumber: { type: String, trim: true, maxlength: 200, default: '' },
  effectiveDate: { type: Date, default: null },
  expiryDate: { type: Date, default: null },
  autoRenew: { type: Boolean, required: true, default: false },
  details: { type: detailsSchema, required: true, default: () => ({}) },
  attachments: { type: [attachmentSchema], default: [] },
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

supplierContractRecordSchema.pre('validate', function validateCategoryFields(next) {
  const isSupplierInfo = this.category === CONTRACT_RECORD_CATEGORIES.SUPPLIER_INFO;
  if (isSupplierInfo) {
    if (this.signingStatus || this.contractNumber || this.effectiveDate || this.expiryDate || this.autoRenew) {
      this.invalidate('category', 'Supplier information records cannot contain contract status fields');
    }
  } else {
    if (!this.signingStatus) this.invalidate('signingStatus', 'Contract signing status is required');
    if (this.effectiveDate && this.expiryDate && this.effectiveDate > this.expiryDate) {
      this.invalidate('expiryDate', 'expiryDate must be on or after effectiveDate');
    }
  }
  next();
});

supplierContractRecordSchema.index(
  { teamId: 1, supplierId: 1, category: 1, effectiveDate: -1, expiryDate: -1, createdAt: -1 },
  { name: 'ix_supplier_contract_team_supplier_category_latest' }
);
supplierContractRecordSchema.index(
  { teamId: 1, category: 1, expiryDate: 1, autoRenew: 1 },
  { name: 'ix_supplier_contract_team_expiry' }
);

const SupplierContractRecord = mongoose.model(
  'SupplierContractRecord',
  supplierContractRecordSchema
);

module.exports = SupplierContractRecord;
module.exports.CONTRACT_ATTACHMENT_PURPOSES = CONTRACT_ATTACHMENT_PURPOSES;
module.exports.CONTRACT_RECORD_CATEGORIES = CONTRACT_RECORD_CATEGORIES;
module.exports.CONTRACT_SIGNING_STATUSES = CONTRACT_SIGNING_STATUSES;
module.exports.OVERSTORAGE_DAY_OPTIONS = OVERSTORAGE_DAY_OPTIONS;
module.exports.SUPPLY_STATUSES = SUPPLY_STATUSES;
