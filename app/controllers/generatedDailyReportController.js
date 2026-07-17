'use strict';

const {
  createGeneratedDailyReportService
} = require('../services/generatedDailyReportService');

function createGeneratedDailyReportController({
  service = createGeneratedDailyReportService()
} = {}) {
  return Object.freeze({
    async generate(req, res, next) {
      try {
        const result = await service.generateDailyReport({
          authContext: req.authContext,
          req,
          reportDate: req.params.date,
          input: req.body || {}
        });
        return res.status(result.versionCreated ? 201 : 200).json({
          message: result.versionCreated
            ? 'Production daily report version generated'
            : 'Production daily report source is unchanged',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    },

    async get(req, res, next) {
      try {
        return res.json(await service.getDailyReport({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          reportDate: req.params.date,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async list(req, res, next) {
      try {
        return res.json(await service.listDailyReports({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createGeneratedDailyReportController(),
  createGeneratedDailyReportController
};
