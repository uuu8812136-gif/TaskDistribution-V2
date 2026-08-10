'use strict';

const { createEquipmentRoutineService } = require('../services/equipmentRoutineService');
const {
  createEquipmentRoutineWorkflowService
} = require('../services/equipmentRoutineWorkflowService');
const {
  createEquipmentRoutineWorkerService
} = require('../services/equipmentRoutineWorkerService');

function createEquipmentRoutineController({
  service = createEquipmentRoutineService(),
  workflowService = createEquipmentRoutineWorkflowService(),
  workerService = createEquipmentRoutineWorkerService()
} = {}) {
  return Object.freeze({
    async listRules(req, res, next) {
      try {
        return res.json(await service.listRules({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getRule(req, res, next) {
      try {
        const rule = await service.getRule({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          ruleId: req.params.ruleId,
          query: req.query
        });
        return res.json({ rule });
      } catch (error) {
        return next(error);
      }
    },

    async createRule(req, res, next) {
      try {
        const rule = await service.createRule({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Equipment routine rule created', rule });
      } catch (error) {
        return next(error);
      }
    },

    async updateRule(req, res, next) {
      try {
        const rule = await service.updateRule({
          authContext: req.authContext,
          req,
          ruleId: req.params.ruleId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment routine rule updated', rule });
      } catch (error) {
        return next(error);
      }
    },

    async disableRule(req, res, next) {
      try {
        const rule = await service.disableRule({
          authContext: req.authContext,
          req,
          ruleId: req.params.ruleId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment routine rule disabled', rule });
      } catch (error) {
        return next(error);
      }
    },

    async deleteRule(req, res, next) {
      try {
        const rule = await service.deleteRule({
          authContext: req.authContext,
          req,
          ruleId: req.params.ruleId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment routine rule deleted', rule });
      } catch (error) {
        return next(error);
      }
    },

    async getSchedule(req, res, next) {
      try {
        return res.json(await service.getSchedule({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          equipmentId: req.params.equipmentId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getInspectionCalendar(req, res, next) {
      try {
        return res.json(await service.getInspectionCalendar({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          equipmentId: req.params.equipmentId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async listRecords(req, res, next) {
      try {
        return res.json(await service.listRecords({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getRecord(req, res, next) {
      try {
        const record = await service.getRecord({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          recordId: req.params.recordId,
          query: req.query
        });
        return res.json({ record });
      } catch (error) {
        return next(error);
      }
    },

    async exportRecords(req, res, next) {
      try {
        const exported = await workflowService.exportRecords({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
        res.setHeader('X-Export-Count', String(exported.count));
        return res.send(exported.buffer);
      } catch (error) {
        return next(error);
      }
    },

    async listPlans(req, res, next) {
      try {
        return res.json(await workflowService.listPlans({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getPlan(req, res, next) {
      try {
        const plan = await workflowService.getPlan({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          planId: req.params.planId,
          query: req.query
        });
        return res.json({ plan });
      } catch (error) {
        return next(error);
      }
    },

    async markPlansRestDay(req, res, next) {
      try {
        const result = await workflowService.markPlansRestDay({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.json({
          message: 'Inspection plans marked as equipment rest day',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    },

    async listExceptions(req, res, next) {
      try {
        return res.json(await workflowService.listExceptions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getException(req, res, next) {
      try {
        const exception = await workflowService.getException({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          exceptionId: req.params.exceptionId,
          query: req.query
        });
        return res.json({ exception });
      } catch (error) {
        return next(error);
      }
    },

    async transitionException(req, res, next) {
      try {
        const exception = await workflowService.transitionException({
          authContext: req.authContext,
          req,
          exceptionId: req.params.exceptionId,
          input: req.body || {}
        });
        return res.json({ message: 'Routine exception updated', exception });
      } catch (error) {
        return next(error);
      }
    },

    async runWorker(req, res, next) {
      try {
        const input = req.body || {};
        const now = process.env.NODE_ENV === 'production' ? undefined : input.now;
        const result = await workerService.runOnce({
          teamId: req.authContext.activeTeamId,
          ...(now ? { now } : {})
        });
        return res.json({ message: 'Routine worker completed', result });
      } catch (error) {
        return next(error);
      }
    },

    async createRecord(req, res, next) {
      try {
        const record = await service.createRecord({
          authContext: req.authContext,
          req,
          equipmentId: req.params.equipmentId,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Equipment routine record submitted', record });
      } catch (error) {
        return next(error);
      }
    },

    async listRuntimeReadings(req, res, next) {
      try {
        return res.json(await service.listRuntimeReadings({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          equipmentId: req.params.equipmentId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async createRuntimeReading(req, res, next) {
      try {
        const reading = await service.createRuntimeReading({
          authContext: req.authContext,
          req,
          equipmentId: req.params.equipmentId,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Equipment runtime reading recorded', reading });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createEquipmentRoutineController(),
  createEquipmentRoutineController
};
