'use strict';

const { createEquipmentInventoryService } = require('../services/equipmentInventoryService');

function createEquipmentInventoryController({ service = createEquipmentInventoryService() } = {}) {
  return Object.freeze({
    async listOptions(req, res, next) {
      try {
        return res.json(await service.listOptions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method
        }));
      } catch (error) {
        return next(error);
      }
    },

    async listSessions(req, res, next) {
      try {
        return res.json(await service.listSessions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async createSession(req, res, next) {
      try {
        const inventorySession = await service.createSession({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Inventory batch created',
          inventorySession
        });
      } catch (error) {
        return next(error);
      }
    },

    async getSession(req, res, next) {
      try {
        return res.json(await service.getSession({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          inventorySessionId: req.params.inventorySessionId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async updateItem(req, res, next) {
      try {
        const item = await service.updateItem({
          authContext: req.authContext,
          req,
          inventorySessionId: req.params.inventorySessionId,
          inventoryItemId: req.params.inventoryItemId,
          input: req.body || {}
        });
        return res.json({ message: 'Inventory item recorded', item });
      } catch (error) {
        return next(error);
      }
    },

    async scanItem(req, res, next) {
      try {
        return res.json(await service.scanItem({
          authContext: req.authContext,
          inventorySessionId: req.params.inventorySessionId,
          input: req.body || {}
        }));
      } catch (error) {
        return next(error);
      }
    },

    async submitSession(req, res, next) {
      try {
        const inventorySession = await service.submitSession({
          authContext: req.authContext,
          req,
          inventorySessionId: req.params.inventorySessionId,
          input: req.body || {}
        });
        return res.json({ message: 'Inventory batch submitted', inventorySession });
      } catch (error) {
        return next(error);
      }
    },

    async reviewSession(req, res, next) {
      try {
        const inventorySession = await service.reviewSession({
          authContext: req.authContext,
          req,
          inventorySessionId: req.params.inventorySessionId,
          input: req.body || {}
        });
        return res.json({ message: 'Inventory approval recorded', inventorySession });
      } catch (error) {
        return next(error);
      }
    },

    async exportSession(req, res, next) {
      try {
        const result = await service.exportSession({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          method: req.method,
          inventorySessionId: req.params.inventorySessionId
        });
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Exported-Count', String(result.count));
        return res.send(result.buffer);
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createEquipmentInventoryController(),
  createEquipmentInventoryController
};
