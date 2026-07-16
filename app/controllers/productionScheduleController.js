'use strict';

const { createProductionScheduleService } = require('../services/productionScheduleService');

function createProductionScheduleController({ service = createProductionScheduleService() } = {}) {
  return Object.freeze({
    async listOptions(req, res, next) {
      try {
        const result = await service.listOptions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async getDailySlot(req, res, next) {
      try {
        const result = await service.getDailySlot({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          slot: req.params.slot,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async maintainDailySlot(req, res, next) {
      try {
        const result = await service.maintainDailySlot({
          authContext: req.authContext,
          req,
          slot: req.params.slot,
          input: req.body || {}
        });
        return res.json({ message: 'Daily production schedule maintained', ...result });
      } catch (error) {
        return next(error);
      }
    },

    async listMonthlySchedules(req, res, next) {
      try {
        const result = await service.listMonthlySchedules({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async maintainMonthlySchedule(req, res, next) {
      try {
        const productionSchedule = await service.maintainMonthlySchedule({
          authContext: req.authContext,
          req,
          month: req.params.month,
          input: req.body || {}
        });
        return res.json({
          message: 'Monthly production schedule maintained',
          productionSchedule
        });
      } catch (error) {
        return next(error);
      }
    },

    async exportDailySlot(req, res, next) {
      try {
        const result = await service.exportDailySlot({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          method: req.method,
          slot: req.params.slot,
          query: req.query
        });
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="production-daily-${result.slot}-${result.month}.xlsx"`
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Exported-Count', String(result.count));
        return res.send(result.buffer);
      } catch (error) {
        return next(error);
      }
    },

    async exportMonthlySchedules(req, res, next) {
      try {
        const result = await service.exportMonthlySchedules({
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
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="production-monthly.xlsx"'
        );
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
  ...createProductionScheduleController(),
  createProductionScheduleController
};
