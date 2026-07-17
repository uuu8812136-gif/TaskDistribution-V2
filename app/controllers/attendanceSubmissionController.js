'use strict';

const {
  createAttendanceSubmissionService
} = require('../services/attendanceSubmissionService');

function createAttendanceSubmissionController({
  service = createAttendanceSubmissionService()
} = {}) {
  return Object.freeze({
    async listOptions(req, res, next) {
      try {
        return res.json(await service.listOptions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId
        }));
      } catch (error) {
        return next(error);
      }
    },

    async listSubmissions(req, res, next) {
      try {
        return res.json(await service.listSubmissions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getSubmission(req, res, next) {
      try {
        const attendanceSubmission = await service.getSubmission({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          attendanceSubmissionId: req.params.attendanceSubmissionId
        });
        return res.json({ attendanceSubmission });
      } catch (error) {
        return next(error);
      }
    },

    async createSubmission(req, res, next) {
      try {
        const attendanceSubmission = await service.createSubmission({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Attendance submission created',
          attendanceSubmission
        });
      } catch (error) {
        return next(error);
      }
    },

    async updateSubmission(req, res, next) {
      try {
        const attendanceSubmission = await service.updateSubmission({
          authContext: req.authContext,
          req,
          attendanceSubmissionId: req.params.attendanceSubmissionId,
          input: req.body || {}
        });
        return res.json({
          message: 'Attendance submission updated',
          attendanceSubmission
        });
      } catch (error) {
        return next(error);
      }
    },

    async getDailySummary(req, res, next) {
      try {
        return res.json(await service.getDailySummary({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getMonthlySummary(req, res, next) {
      try {
        return res.json(await service.getMonthlySummary({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async exportMonthlySummary(req, res, next) {
      try {
        const result = await service.exportMonthlySummary({
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
          `attachment; filename="attendance-monthly-${result.month}.xlsx"`
        );
        return res.send(result.buffer);
      } catch (error) {
        return next(error);
      }
    },

    async reviewDailySummary(req, res, next) {
      try {
        const result = await service.reviewDailySummary({
          authContext: req.authContext,
          req,
          reportDate: req.params.date,
          input: req.body || {}
        });
        return res.json({ message: 'Attendance daily summary reviewed', ...result });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createAttendanceSubmissionController(),
  createAttendanceSubmissionController
};
