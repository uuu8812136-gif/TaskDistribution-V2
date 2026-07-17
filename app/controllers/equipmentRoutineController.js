'use strict';

const { createEquipmentRoutineService } = require('../services/equipmentRoutineService');

function createEquipmentRoutineController({ service = createEquipmentRoutineService() } = {}) {
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
