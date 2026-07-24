'use strict';

const mongoose = require('mongoose');
const {
  isNaturalDate,
  isNaturalMonth,
  naturalMonthFromDate
} = require('../services/reportCalendarService');

function optionalQuantity() {
  return {
    type: Number,
    default: null,
    min: 0,
    max: 2147483647,
    validate: {
      validator: (value) => value === null || Number.isInteger(value),
      message: 'schedule quantity must be a non-negative integer or null'
    }
  };
}

const dailyEntrySchema = new mongoose.Schema({
  date: {
    type: String,
    required: true,
    validate: {
      validator: isNaturalDate,
      message: 'date must be a real calendar date in YYYY-MM-DD format'
    }
  },
  aLineDay: optionalQuantity(),
  aLineNight: optionalQuantity(),
  northLine: optionalQuantity(),
  transferCaseLine: optionalQuantity(),
  bLineDay: optionalQuantity(),
  bLineNight: optionalQuantity()
}, { _id: false, strict: 'throw' });

const monthlyTotalsSchema = new mongoose.Schema({
  aLine: optionalQuantity(),
  northLine: optionalQuantity(),
  transferCaseLine: optionalQuantity(),
  bLineDay: optionalQuantity(),
  bLineNight: optionalQuantity()
}, { _id: false, strict: 'throw' });

const productionScheduleSchema = new mongoose.Schema({
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
  month: {
    type: String,
    required: true,
    immutable: true,
    validate: {
      validator: isNaturalMonth,
      message: 'month must be a real calendar month in YYYY-MM format'
    }
  },
  dailyEntries: {
    type: [dailyEntrySchema],
    default: []
  },
  productionPlanForecast: optionalQuantity(),
  monthlyTotals: {
    type: monthlyTotalsSchema,
    required: true,
    default: () => ({})
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

productionScheduleSchema.pre('validate', function validateDailyEntryMonth(next) {
  const dates = this.dailyEntries.map((entry) => entry.date);
  if (new Set(dates).size !== dates.length) {
    this.invalidate('dailyEntries', 'dailyEntries must contain each date at most once');
  }
  for (const date of dates) {
    if (!isNaturalDate(date) || naturalMonthFromDate(date) !== this.month) {
      this.invalidate('dailyEntries', 'every daily entry must belong to schedule month');
      break;
    }
  }
  this.dailyEntries.sort((left, right) => left.date.localeCompare(right.date));
  next();
});

productionScheduleSchema.index(
  { teamId: 1, month: 1 },
  { unique: true, name: 'uq_production_schedule_team_month' }
);

module.exports = mongoose.model('ProductionSchedule', productionScheduleSchema);
