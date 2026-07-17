'use strict';

const {
  createEquipmentStatusApplicationService
} = require('../services/equipmentStatusApplicationService');

function createEquipmentStatusApplicationController({
  service = createEquipmentStatusApplicationService()
} = {}) {
  return Object.freeze({
    async list(req, res, next) {
      try {
        return res.json(await service.listApplications({
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
        return res.json(await service.getApplication({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          applicationId: req.params.applicationId
        }));
      } catch (error) {
        return next(error);
      }
    },

    async create(req, res, next) {
      try {
        const application = await service.createApplication({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Equipment status application created',
          application
        });
      } catch (error) {
        return next(error);
      }
    },

    async transition(req, res, next) {
      try {
        const application = await service.transitionApplication({
          authContext: req.authContext,
          req,
          applicationId: req.params.applicationId,
          input: req.body || {}
        });
        return res.json({
          message: 'Equipment status application updated',
          application
        });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createEquipmentStatusApplicationController(),
  createEquipmentStatusApplicationController
};
