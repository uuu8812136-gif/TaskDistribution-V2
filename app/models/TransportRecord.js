'use strict';

const mongoose = require('mongoose');
const { isNaturalDate } = require('../services/reportCalendarService');

const TRANSPORT_SHIFTS = Object.freeze({
  DAY: '白班',
  NIGHT: '夜班',
  MIDDLE: '中班'
});
const TRANSPORT_SHIFT_VALUES = Object.freeze(Object.values(TRANSPORT_SHIFTS));

const TRANSPORT_DISPATCH_TYPES = Object.freeze({
  DELIVERY: '配送',
  RETURN_RACK: '返架'
});
const TRANSPORT_DISPATCH_TYPE_VALUES = Object.freeze(
  Object.values(TRANSPORT_DISPATCH_TYPES)
);

const TRANSPORT_LOAD_FIELDS = Object.freeze([
  Object.freeze({ key: 'standardPlasticPallet', label: '标准*塑料托盘' }),
  Object.freeze({ key: 'standardIronPallet', label: '标准*铁托盘' }),
  Object.freeze({ key: 'woodenPallet', label: '木托盘' }),
  Object.freeze({ key: 'woodenBox', label: '木箱' }),
  Object.freeze({ key: 'ironCage', label: '铁笼子' }),
  Object.freeze({ key: 'ironRack', label: '铁架子' }),
  Object.freeze({ key: 'housingPlasticPallet', label: '壳体专用*塑料托盘' }),
  Object.freeze({ key: 'housingIronPallet', label: '壳体专用*铁托盘' }),
  Object.freeze({ key: 'housingLinerPallet', label: '壳体专用*内衬托盘' }),
  Object.freeze({ key: 'housingBlackPlasticTray', label: '壳体专用*黑色塑盘' }),
  Object.freeze({ key: 'turnoverBoxBlue', label: '周转料盒（常用蓝色）' }),
  Object.freeze({ key: 'turnoverBoxGray', label: '周转料盒（质检灰色）' }),
  Object.freeze({ key: 'turnoverBoxWhite', label: '周转料盒（线下白色）' }),
  Object.freeze({ key: 'other', label: '其他' })
]);

const quantityField = () => ({
  type: Number,
  required: true,
  default: 0,
  min: 0,
  max: 2147483647,
  validate: {
    validator: Number.isInteger,
    message: 'load quantity must be an integer'
  }
});

const loadDetailsSchema = new mongoose.Schema(
  Object.fromEntries(TRANSPORT_LOAD_FIELDS.map(({ key }) => [key, quantityField()])),
  { _id: false, strict: 'throw' }
);

const transportRecordSchema = new mongoose.Schema({
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
  reportDate: {
    type: String,
    required: true,
    validate: {
      validator: isNaturalDate,
      message: 'reportDate must be a real calendar date in YYYY-MM-DD format'
    }
  },
  shift: {
    type: String,
    enum: TRANSPORT_SHIFT_VALUES,
    required: true
  },
  tripLabel: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: 50,
    required: true
  },
  route: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: 200,
    required: true
  },
  dispatchType: {
    type: String,
    enum: TRANSPORT_DISPATCH_TYPE_VALUES,
    required: true
  },
  vehiclePlate: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: 50,
    required: true
  },
  vehicleType: {
    type: String,
    trim: true,
    maxlength: 100,
    default: ''
  },
  driverName: {
    type: String,
    trim: true,
    minlength: 1,
    maxlength: 100,
    required: true
  },
  loadDetails: {
    type: loadDetailsSchema,
    required: true,
    default: () => ({})
  },
  photoFileIds: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FileAsset'
    }],
    default: [],
    validate: [
      {
        validator: (values) => values.length === 0 || (values.length >= 2 && values.length <= 10),
        message: 'photoFileIds must be empty while staged or contain 2 to 10 files'
      },
      {
        validator: (values) => new Set(values.map(String)).size === values.length,
        message: 'photoFileIds must not contain duplicates'
      }
    ]
  },
  remark: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  submittedAt: {
    type: Date,
    required: true,
    immutable: true,
    default: Date.now
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

transportRecordSchema.index(
  { teamId: 1, orgUnitId: 1, reportDate: -1, submittedAt: -1 },
  { name: 'ix_transport_scope_report_date' }
);
transportRecordSchema.index(
  { teamId: 1, reportDate: 1, driverName: 1, route: 1, vehiclePlate: 1, dispatchType: 1 },
  { name: 'ix_transport_monthly_summary' }
);
transportRecordSchema.index(
  { teamId: 1, vehiclePlate: 1, reportDate: -1 },
  { name: 'ix_transport_team_plate_date' }
);

const TransportRecord = mongoose.model('TransportRecord', transportRecordSchema);

module.exports = TransportRecord;
module.exports.TRANSPORT_DISPATCH_TYPES = TRANSPORT_DISPATCH_TYPES;
module.exports.TRANSPORT_DISPATCH_TYPE_VALUES = TRANSPORT_DISPATCH_TYPE_VALUES;
module.exports.TRANSPORT_LOAD_FIELDS = TRANSPORT_LOAD_FIELDS;
module.exports.TRANSPORT_SHIFTS = TRANSPORT_SHIFTS;
module.exports.TRANSPORT_SHIFT_VALUES = TRANSPORT_SHIFT_VALUES;
