'use strict';

const AttendanceDailyReview = require('../models/AttendanceDailyReview');
const AttendanceSubmission = require('../models/AttendanceSubmission');
const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentChangeRecord = require('../models/EquipmentChangeRecord');
const EquipmentRepairOrder = require('../models/EquipmentRepairOrder');
const EquipmentRoutineException = require('../models/EquipmentRoutineException');
const EquipmentRoutinePlan = require('../models/EquipmentRoutinePlan');
const EquipmentRoutineRecord = require('../models/EquipmentRoutineRecord');
const EquipmentRuntimeReading = require('../models/EquipmentRuntimeReading');
const EquipmentStatusApplication = require('../models/EquipmentStatusApplication');
const EquipmentStatusApproval = require('../models/EquipmentStatusApproval');
const ImportException = require('../models/ImportException');
const ImportJob = require('../models/ImportJob');
const InventoryApproval = require('../models/InventoryApproval');
const InventoryItem = require('../models/InventoryItem');
const InventorySession = require('../models/InventorySession');
const ProductionSchedule = require('../models/ProductionSchedule');
const ReportChangeRecord = require('../models/ReportChangeRecord');
const Task = require('../models/Task');
const TeamMembership = require('../models/TeamMembership');
const TransportRecord = require('../models/TransportRecord');

const DEFAULT_DEPENDENCY_SOURCES = Object.freeze([
  Object.freeze({ model: AttendanceDailyReview, fields: ['expectedOrgUnitIds'] }),
  Object.freeze({ model: AttendanceSubmission, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentAsset, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentChangeRecord, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentRepairOrder, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentRoutineException, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentRoutinePlan, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentRoutineRecord, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentRuntimeReading, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentStatusApplication, fields: ['orgUnitId'] }),
  Object.freeze({ model: EquipmentStatusApproval, fields: ['orgUnitId'] }),
  Object.freeze({ model: ImportException, fields: ['orgUnitId'] }),
  Object.freeze({
    model: ImportJob,
    fields: ['scopeOrgUnitId', 'stagedRows.candidate.orgUnitId']
  }),
  Object.freeze({ model: InventoryApproval, fields: ['orgUnitId'] }),
  Object.freeze({ model: InventoryItem, fields: ['orgUnitId'] }),
  Object.freeze({ model: InventorySession, fields: ['orgUnitId'] }),
  Object.freeze({ model: ProductionSchedule, fields: ['orgUnitId'] }),
  Object.freeze({ model: ReportChangeRecord, fields: ['orgUnitId'] }),
  Object.freeze({ model: Task, fields: ['orgUnitId'] }),
  Object.freeze({ model: TeamMembership, fields: ['orgUnitId'] }),
  Object.freeze({ model: TransportRecord, fields: ['orgUnitId'] })
]);

function normalizeSources(sources) {
  if (!Array.isArray(sources)) throw new TypeError('dependency sources must be an array');
  return sources.map((source) => {
    if (!source?.model?.exists || !Array.isArray(source.fields) || source.fields.length === 0) {
      throw new TypeError('each dependency source requires a model and fields');
    }
    return source;
  });
}

async function findOrgUnitDependency({
  teamId,
  orgUnitId,
  session = null,
  sources = DEFAULT_DEPENDENCY_SOURCES
} = {}) {
  if (!teamId || !orgUnitId) throw new TypeError('teamId and orgUnitId are required');
  for (const source of normalizeSources(sources)) {
    const fieldFilters = source.fields.map((field) => ({ [field]: orgUnitId }));
    const query = source.model.exists({
      teamId,
      ...(fieldFilters.length === 1 ? fieldFilters[0] : { $or: fieldFilters })
    });
    if (session && typeof query.session === 'function') query.session(session);
    if (await query) return source.model.modelName || 'Unknown';
  }
  return null;
}

module.exports = {
  DEFAULT_DEPENDENCY_SOURCES,
  findOrgUnitDependency
};
