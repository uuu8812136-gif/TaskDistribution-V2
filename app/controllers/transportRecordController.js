'use strict';

const { createTransportRecordService } = require('../services/transportRecordService');
const {
  createTransportMasterDataService
} = require('../services/transportMasterDataService');

function createTransportRecordController({
  service = createTransportRecordService(),
  masterDataService = createTransportMasterDataService()
} = {}) {
  return Object.freeze({
    async listMasterData(req, res, next) {
      try {
        const result = await masterDataService.listMasterData({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async createMasterData(req, res, next) {
      try {
        const masterData = await masterDataService.createMasterData({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Transport master data created',
          masterData
        });
      } catch (error) {
        return next(error);
      }
    },

    async updateMasterData(req, res, next) {
      try {
        const masterData = await masterDataService.updateMasterData({
          authContext: req.authContext,
          req,
          masterDataId: req.params.masterDataId,
          input: req.body || {}
        });
        return res.json({
          message: 'Transport master data updated',
          masterData
        });
      } catch (error) {
        return next(error);
      }
    },

    async setMasterDataStatus(req, res, next) {
      try {
        const masterData = await masterDataService.setMasterDataStatus({
          authContext: req.authContext,
          req,
          masterDataId: req.params.masterDataId,
          input: req.body || {}
        });
        return res.json({
          message: 'Transport master data status updated',
          masterData
        });
      } catch (error) {
        return next(error);
      }
    },

    async deleteMasterData(req, res, next) {
      try {
        const masterData = await masterDataService.deleteMasterData({
          authContext: req.authContext,
          req,
          masterDataId: req.params.masterDataId
        });
        return res.json({
          message: 'Transport load type deleted',
          masterData
        });
      } catch (error) {
        return next(error);
      }
    },

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

    async listRecords(req, res, next) {
      try {
        const result = await service.listRecords({
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

    async getRecord(req, res, next) {
      try {
        const transportRecord = await service.getRecord({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          transportRecordId: req.params.transportRecordId
        });
        return res.json({ transportRecord });
      } catch (error) {
        return next(error);
      }
    },

    async getHistory(req, res, next) {
      try {
        const result = await service.getHistory({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          transportRecordId: req.params.transportRecordId,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async createRecord(req, res, next) {
      try {
        const transportRecord = await service.createRecord({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Transport record created',
          transportRecord
        });
      } catch (error) {
        return next(error);
      }
    },

    async updateRecord(req, res, next) {
      try {
        const transportRecord = await service.updateRecord({
          authContext: req.authContext,
          req,
          transportRecordId: req.params.transportRecordId,
          input: req.body || {}
        });
        return res.json({
          message: 'Transport record updated',
          transportRecord
        });
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
          `attachment; filename="transport-summary-${result.month}.xlsx"`
        );
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Exported-Count', String(result.count));
        res.setHeader('X-Exported-Group-Count', String(result.groupCount));
        return res.send(result.buffer);
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createTransportRecordController(),
  createTransportRecordController
};
