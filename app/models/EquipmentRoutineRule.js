'use strict';

const mongoose = require('mongoose');

const EQUIPMENT_ROUTINE_TYPES = Object.freeze({
  INSPECTION: 'INSPECTION',
  MAINTENANCE: 'MAINTENANCE'
});
const EQUIPMENT_ROUTINE_TYPE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_TYPES)
);

const EQUIPMENT_ROUTINE_RULE_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
});
const EQUIPMENT_ROUTINE_RULE_STATUS_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_RULE_STATUSES)
);

const EQUIPMENT_ROUTINE_SCHEDULE_TYPES = Object.freeze({
  MANUAL: 'MANUAL',
  CALENDAR: 'CALENDAR',
  RUNTIME_HOURS: 'RUNTIME_HOURS',
  COMBINED: 'COMBINED'
});
const EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_SCHEDULE_TYPES)
);
const EQUIPMENT_ROUTINE_SCHEDULE_MODES = EQUIPMENT_ROUTINE_SCHEDULE_TYPES;
const EQUIPMENT_ROUTINE_SCHEDULE_MODE_VALUES = EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES;

const EQUIPMENT_ROUTINE_CALENDAR_UNITS = Object.freeze({
  DAY: 'DAY',
  WEEK: 'WEEK',
  MONTH: 'MONTH'
});
const EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_CALENDAR_UNITS)
);

const EQUIPMENT_ROUTINE_DUE_POLICIES = Object.freeze({
  ANY: 'ANY',
  ALL: 'ALL'
});
const EQUIPMENT_ROUTINE_DUE_POLICY_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_DUE_POLICIES)
);

const EQUIPMENT_ROUTINE_PHOTO_POLICIES = Object.freeze({
  NONE: 'NONE',
  ALWAYS: 'ALWAYS',
  ON_ABNORMAL: 'ON_ABNORMAL'
});
const EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_PHOTO_POLICIES)
);

const EQUIPMENT_ROUTINE_LOCATION_POLICIES = Object.freeze({
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  OPTIONAL: 'OPTIONAL',
  REQUIRED: 'REQUIRED'
});
const EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES = Object.freeze(
  Object.values(EQUIPMENT_ROUTINE_LOCATION_POLICIES)
);

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const executionWindowSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 50,
    match: /^[A-Z0-9](?:[A-Z0-9_-]{0,48}[A-Z0-9])?$/
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100
  },
  startTime: {
    type: String,
    required: true,
    match: TIME_PATTERN
  },
  endTime: {
    type: String,
    required: true,
    match: TIME_PATTERN
  },
  enabled: {
    type: Boolean,
    required: true,
    default: true
  }
}, {
  _id: false,
  strict: 'throw'
});

function defaultExecutionWindows() {
  return [
    { key: 'DAY_SHIFT', name: '白班', startTime: '07:00', endTime: '09:00', enabled: true },
    { key: 'NIGHT_SHIFT', name: '夜班', startTime: '19:00', endTime: '21:00', enabled: true }
  ];
}

const executionConfigSchema = new mongoose.Schema({
  timeZone: {
    type: String,
    required: true,
    trim: true,
    maxlength: 64,
    default: 'Asia/Shanghai'
  },
  windows: {
    type: [executionWindowSchema],
    required: true,
    default: defaultExecutionWindows,
    validate: [
      {
        validator: (values) => Array.isArray(values) && values.length >= 1 && values.length <= 8,
        message: 'execution windows must contain between 1 and 8 items'
      },
      {
        validator: (values) => (
          Array.isArray(values) && new Set(values.map(({ key }) => key)).size === values.length
        ),
        message: 'execution window keys must be unique'
      },
      {
        validator: (values) => Array.isArray(values) && values.some(({ enabled }) => enabled),
        message: 'at least one execution window must be enabled'
      }
    ]
  },
  weeklyDay: {
    type: Number,
    required: true,
    min: 1,
    max: 7,
    default: 1,
    validate: {
      validator: Number.isInteger,
      message: 'weeklyDay must be an integer'
    }
  },
  monthlyDay: {
    type: Number,
    required: true,
    min: 1,
    max: 31,
    default: 1,
    validate: {
      validator: Number.isInteger,
      message: 'monthlyDay must be an integer'
    }
  },
  inspectionEscalationMinutes: {
    type: Number,
    required: true,
    min: 1,
    max: 10080,
    default: 60,
    validate: {
      validator: Number.isInteger,
      message: 'inspectionEscalationMinutes must be an integer'
    }
  },
  locationPolicy: {
    type: String,
    enum: EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_LOCATION_POLICIES.PENDING_CONFIRMATION
  },
  locationPrecisionMeters: {
    type: Number,
    min: 1,
    max: 100000,
    default: null
  }
}, {
  _id: false,
  strict: 'throw'
});

const calendarScheduleSchema = new mongoose.Schema({
  unit: {
    type: String,
    enum: EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES,
    required: true
  },
  interval: {
    type: Number,
    required: true,
    min: 1,
    max: 10000,
    validate: {
      validator: Number.isInteger,
      message: 'calendar interval must be an integer'
    }
  },
  firstDueAt: {
    type: Date,
    required: true
  }
}, {
  _id: false,
  strict: 'throw'
});

const runtimeScheduleSchema = new mongoose.Schema({
  intervalHours: {
    type: Number,
    required: true,
    validate: {
      validator: (value) => Number.isFinite(value) && value > 0,
      message: 'runtime intervalHours must be greater than zero'
    }
  }
}, {
  _id: false,
  strict: 'throw'
});

const routineScheduleSchema = new mongoose.Schema({
  mode: {
    type: String,
    enum: EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES,
    required: true
  },
  calendar: {
    type: calendarScheduleSchema,
    default: undefined
  },
  runtime: {
    type: runtimeScheduleSchema,
    default: undefined
  },
  duePolicy: {
    type: String,
    enum: EQUIPMENT_ROUTINE_DUE_POLICY_VALUES,
    default: undefined
  }
}, {
  _id: false,
  strict: 'throw'
});

routineScheduleSchema.pre('validate', function validateScheduleShape(next) {
  const hasCalendar = this.calendar !== undefined && this.calendar !== null;
  const hasRuntime = this.runtime !== undefined && this.runtime !== null;
  const hasDuePolicy = this.duePolicy !== undefined && this.duePolicy !== null;

  switch (this.mode) {
    case EQUIPMENT_ROUTINE_SCHEDULE_TYPES.MANUAL:
      if (hasCalendar || hasRuntime || hasDuePolicy) {
        this.invalidate(
          'mode',
          'MANUAL schedule cannot define calendar, runtime, or duePolicy'
        );
      }
      break;
    case EQUIPMENT_ROUTINE_SCHEDULE_TYPES.CALENDAR:
      if (!hasCalendar || hasRuntime || hasDuePolicy) {
        this.invalidate(
          'mode',
          'CALENDAR schedule requires only calendar configuration'
        );
      }
      break;
    case EQUIPMENT_ROUTINE_SCHEDULE_TYPES.RUNTIME_HOURS:
      if (hasCalendar || !hasRuntime || hasDuePolicy) {
        this.invalidate(
          'mode',
          'RUNTIME_HOURS schedule requires only runtime configuration'
        );
      }
      break;
    case EQUIPMENT_ROUTINE_SCHEDULE_TYPES.COMBINED:
      if (!hasCalendar || !hasRuntime || !hasDuePolicy) {
        this.invalidate(
          'mode',
          'COMBINED schedule requires calendar, runtime, and duePolicy'
        );
      }
      break;
    default:
      break;
  }

  next();
});

const checklistItemSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 128
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  required: {
    type: Boolean,
    required: true,
    default: true
  },
  sortOrder: {
    type: Number,
    min: 0,
    max: 2147483647,
    required: true,
    default: 0,
    validate: {
      validator: Number.isInteger,
      message: 'checklist item sortOrder must be an integer'
    }
  }
}, {
  _id: false,
  strict: 'throw'
});

const equipmentRoutineRuleSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EquipmentCategory',
    required: true,
    immutable: true
  },
  routineType: {
    type: String,
    enum: EQUIPMENT_ROUTINE_TYPE_VALUES,
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
  description: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  status: {
    type: String,
    enum: EQUIPMENT_ROUTINE_RULE_STATUS_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_RULE_STATUSES.ACTIVE
  },
  version: {
    type: Number,
    required: true,
    min: 1,
    default: 1,
    validate: {
      validator: Number.isInteger,
      message: 'version must be an integer'
    }
  },
  schedule: {
    type: routineScheduleSchema,
    required: true
  },
  checklistItems: {
    type: [checklistItemSchema],
    required: true,
    validate: [
      {
        validator: (items) => Array.isArray(items) && items.length >= 1 && items.length <= 500,
        message: 'checklistItems must contain between 1 and 500 items'
      },
      {
        validator: (items) => (
          Array.isArray(items) &&
          new Set(items.map((item) => item.key)).size === items.length
        ),
        message: 'checklist item keys must be unique'
      }
    ]
  },
  photoPolicy: {
    type: String,
    enum: EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES,
    required: true,
    default: EQUIPMENT_ROUTINE_PHOTO_POLICIES.NONE
  },
  abnormalNoteRequired: {
    type: Boolean,
    required: true,
    default: true
  },
  executionConfig: {
    type: executionConfigSchema,
    required: true,
    default: () => ({})
  },
  materializationRevision: {
    type: Number,
    min: 0,
    required: true,
    default: 0
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

equipmentRoutineRuleSchema.index(
  { teamId: 1, categoryId: 1, routineType: 1, name: 1 },
  { unique: true, name: 'uq_equipment_routine_rule_scope_name' }
);
equipmentRoutineRuleSchema.index(
  { teamId: 1, categoryId: 1, routineType: 1, status: 1 },
  { name: 'ix_equipment_routine_rule_scope_type_status' }
);

const EquipmentRoutineRule = mongoose.model(
  'EquipmentRoutineRule',
  equipmentRoutineRuleSchema
);

module.exports = EquipmentRoutineRule;
module.exports.EQUIPMENT_ROUTINE_TYPES = EQUIPMENT_ROUTINE_TYPES;
module.exports.EQUIPMENT_ROUTINE_TYPE_VALUES = EQUIPMENT_ROUTINE_TYPE_VALUES;
module.exports.EQUIPMENT_ROUTINE_RULE_STATUSES = EQUIPMENT_ROUTINE_RULE_STATUSES;
module.exports.EQUIPMENT_ROUTINE_RULE_STATUS_VALUES = EQUIPMENT_ROUTINE_RULE_STATUS_VALUES;
module.exports.EQUIPMENT_ROUTINE_SCHEDULE_TYPES = EQUIPMENT_ROUTINE_SCHEDULE_TYPES;
module.exports.EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES = EQUIPMENT_ROUTINE_SCHEDULE_TYPE_VALUES;
module.exports.EQUIPMENT_ROUTINE_SCHEDULE_MODES = EQUIPMENT_ROUTINE_SCHEDULE_MODES;
module.exports.EQUIPMENT_ROUTINE_SCHEDULE_MODE_VALUES = EQUIPMENT_ROUTINE_SCHEDULE_MODE_VALUES;
module.exports.EQUIPMENT_ROUTINE_CALENDAR_UNITS = EQUIPMENT_ROUTINE_CALENDAR_UNITS;
module.exports.EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES = EQUIPMENT_ROUTINE_CALENDAR_UNIT_VALUES;
module.exports.EQUIPMENT_ROUTINE_DUE_POLICIES = EQUIPMENT_ROUTINE_DUE_POLICIES;
module.exports.EQUIPMENT_ROUTINE_DUE_POLICY_VALUES = EQUIPMENT_ROUTINE_DUE_POLICY_VALUES;
module.exports.EQUIPMENT_ROUTINE_PHOTO_POLICIES = EQUIPMENT_ROUTINE_PHOTO_POLICIES;
module.exports.EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES = EQUIPMENT_ROUTINE_PHOTO_POLICY_VALUES;
module.exports.EQUIPMENT_ROUTINE_LOCATION_POLICIES = EQUIPMENT_ROUTINE_LOCATION_POLICIES;
module.exports.EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES = EQUIPMENT_ROUTINE_LOCATION_POLICY_VALUES;
module.exports.defaultExecutionWindows = defaultExecutionWindows;
