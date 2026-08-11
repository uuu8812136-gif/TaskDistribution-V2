'use strict';

const {
  createContractManagementService
} = require('../services/contractManagementService');

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendWorkbook(res, { buffer, count, filename, extraHeaders = {} }) {
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Exported-Count', String(count));
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, String(value));
  }
  return res.send(buffer);
}

function createContractController({
  service = createContractManagementService()
} = {}) {
  return Object.freeze({
    async listSuppliers(req, res, next) {
      try {
        return res.json(await service.listSuppliers({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getSupplier(req, res, next) {
      try {
        const supplier = await service.getSupplier({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          supplierId: req.params.supplierId
        });
        return res.json({ supplier });
      } catch (error) {
        return next(error);
      }
    },

    async updateSupplier(req, res, next) {
      try {
        const supplier = await service.updateSupplier({
          authContext: req.authContext,
          req,
          supplierId: req.params.supplierId,
          input: req.body || {}
        });
        return res.json({ supplier });
      } catch (error) {
        return next(error);
      }
    },

    async importSuppliers(req, res, next) {
      try {
        const result = await service.importSuppliers({
          authContext: req.authContext,
          req,
          file: req.file,
          supplierId: req.query.supplierId
        });
        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    },

    async exportSuppliers(req, res, next) {
      try {
        const result = await service.supplierExport({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          query: req.query
        });
        return sendWorkbook(res, {
          buffer: result.buffer,
          count: result.recordCount,
          filename: 'supplier-contracts.xlsx',
          extraHeaders: {
            'X-Exported-Supplier-Count': result.supplierCount
          }
        });
      } catch (error) {
        return next(error);
      }
    },

    async listRecords(req, res, next) {
      try {
        return res.json(await service.listRecords({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          supplierId: req.params.supplierId,
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
          recordId: req.params.recordId
        });
        return res.json({ record });
      } catch (error) {
        return next(error);
      }
    },

    async createRecord(req, res, next) {
      try {
        const record = await service.createRecord({
          authContext: req.authContext,
          req,
          supplierId: req.params.supplierId,
          input: req.body || {}
        });
        return res.status(201).json({ record });
      } catch (error) {
        return next(error);
      }
    },

    async createFirstRecord(req, res, next) {
      try {
        const result = await service.createFirstRecord({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    },

    async updateRecord(req, res, next) {
      try {
        const record = await service.updateRecord({
          authContext: req.authContext,
          req,
          recordId: req.params.recordId,
          input: req.body || {}
        });
        return res.json({ record });
      } catch (error) {
        return next(error);
      }
    },

    async deleteRecord(req, res, next) {
      try {
        const record = await service.deleteRecord({
          authContext: req.authContext,
          req,
          recordId: req.params.recordId
        });
        return res.json({ record });
      } catch (error) {
        return next(error);
      }
    },

    async listExpiryAlerts(req, res, next) {
      try {
        return res.json(await service.listExpiryAlerts({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async exportExpiryAlerts(req, res, next) {
      try {
        const result = await service.expiryExport({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          query: req.query
        });
        return sendWorkbook(res, {
          buffer: result.buffer,
          count: result.count,
          filename: 'contract-expiry-alerts.xlsx'
        });
      } catch (error) {
        return next(error);
      }
    },

    async listSettlements(req, res, next) {
      try {
        return res.json(await service.listSettlements({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          query: req.query
        }));
      } catch (error) {
        return next(error);
      }
    },

    async getSettlement(req, res, next) {
      try {
        const settlement = await service.getSettlement({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          settlementId: req.params.settlementId
        });
        return res.json({ settlement });
      } catch (error) {
        return next(error);
      }
    },

    async createSettlement(req, res, next) {
      try {
        const settlement = await service.createSettlement({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({ settlement });
      } catch (error) {
        return next(error);
      }
    },

    async updateSettlement(req, res, next) {
      try {
        const settlement = await service.updateSettlement({
          authContext: req.authContext,
          req,
          settlementId: req.params.settlementId,
          input: req.body || {}
        });
        return res.json({ settlement });
      } catch (error) {
        return next(error);
      }
    },

    async deleteSettlement(req, res, next) {
      try {
        const settlement = await service.deleteSettlement({
          authContext: req.authContext,
          req,
          settlementId: req.params.settlementId
        });
        return res.json({ settlement });
      } catch (error) {
        return next(error);
      }
    },

    async importSettlements(req, res, next) {
      try {
        const result = await service.importSettlements({
          authContext: req.authContext,
          req,
          file: req.file
        });
        return res.status(201).json(result);
      } catch (error) {
        return next(error);
      }
    },

    async exportSettlements(req, res, next) {
      try {
        const result = await service.settlementExport({
          authContext: req.authContext,
          req,
          requestedTeamId: req.query.teamId,
          query: req.query
        });
        return sendWorkbook(res, {
          buffer: result.buffer,
          count: result.count,
          filename: 'supplier-settlement-fees.xlsx'
        });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  createContractController,
  sendWorkbook
};
