'use strict';

const { createEquipmentRepairService } = require('../services/equipmentRepairService');

function createEquipmentRepairController({ service = createEquipmentRepairService() } = {}) {
  return Object.freeze({
    async list(req, res, next) {
      try {
        return res.json(await service.listRepairs({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async get(req, res, next) {
      try {
        const repair = await service.getRepair({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          repairId: req.params.repairId
        });
        return res.json({ repair });
      } catch (error) {
        return next(error);
      }
    },

    async listLocations(req, res, next) {
      try {
        return res.json(await service.listRepairLocations({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method
        }));
      } catch (error) {
        return next(error);
      }
    },

    async updateLocations(req, res, next) {
      try {
        const locations = await service.updateRepairLocations({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.json({ message: 'Repair locations updated', locations });
      } catch (error) {
        return next(error);
      }
    },

    async create(req, res, next) {
      try {
        const repair = await service.createRepair({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Repair order created', repair });
      } catch (error) {
        return next(error);
      }
    },

    async transition(req, res, next) {
      try {
        const repair = await service.transitionRepair({
          authContext: req.authContext,
          req,
          repairId: req.params.repairId,
          input: req.body || {}
        });
        return res.json({ message: 'Repair order updated', repair });
      } catch (error) {
        return next(error);
      }
    },

    async export(req, res, next) {
      try {
        const workbook = await service.exportRepairs({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        });
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', 'attachment; filename="equipment-repairs.xlsx"');
        return res.send(workbook);
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createEquipmentRepairController(),
  createEquipmentRepairController
};
