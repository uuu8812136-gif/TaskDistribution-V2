'use strict';

const { createEquipmentRegistryService } = require('../services/equipmentRegistryService');
const { createEquipmentImportService } = require('../services/equipmentImportService');

function createEquipmentController({
  service = createEquipmentRegistryService(),
  importService = createEquipmentImportService()
} = {}) {
  return Object.freeze({
    async listCategories(req, res, next) {
      try {
        const result = await service.listCategories({
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

    async getCategory(req, res, next) {
      try {
        const category = await service.getCategory({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          categoryId: req.params.categoryId
        });
        return res.json({ category });
      } catch (error) {
        return next(error);
      }
    },

    async createCategory(req, res, next) {
      try {
        const category = await service.createCategory({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Equipment category created', category });
      } catch (error) {
        return next(error);
      }
    },

    async updateCategory(req, res, next) {
      try {
        const category = await service.updateCategory({
          authContext: req.authContext,
          req,
          categoryId: req.params.categoryId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment category updated', category });
      } catch (error) {
        return next(error);
      }
    },

    async disableCategory(req, res, next) {
      try {
        const category = await service.disableCategory({
          authContext: req.authContext,
          req,
          categoryId: req.params.categoryId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment category disabled', category });
      } catch (error) {
        return next(error);
      }
    },

    async deleteCategory(req, res, next) {
      try {
        const category = await service.deleteCategory({
          authContext: req.authContext,
          req,
          categoryId: req.params.categoryId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment category deleted', category });
      } catch (error) {
        return next(error);
      }
    },

    async listAssets(req, res, next) {
      try {
        const result = await service.listAssets({
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

    async listOptions(req, res, next) {
      try {
        const result = await service.listOptions({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async getAsset(req, res, next) {
      try {
        const equipment = await service.getAsset({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          equipmentId: req.params.equipmentId
        });
        return res.json({ equipment });
      } catch (error) {
        return next(error);
      }
    },

    async createAsset(req, res, next) {
      try {
        const equipment = await service.createAsset({
          authContext: req.authContext,
          req,
          input: req.body || {}
        });
        return res.status(201).json({ message: 'Equipment created', equipment });
      } catch (error) {
        return next(error);
      }
    },

    async updateAsset(req, res, next) {
      try {
        const equipment = await service.updateAsset({
          authContext: req.authContext,
          req,
          equipmentId: req.params.equipmentId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment updated', equipment });
      } catch (error) {
        return next(error);
      }
    },

    async deleteAsset(req, res, next) {
      try {
        const equipment = await service.deleteAsset({
          authContext: req.authContext,
          req,
          equipmentId: req.params.equipmentId,
          input: req.body || {}
        });
        return res.json({ message: 'Equipment deleted', equipment });
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
          equipmentId: req.params.equipmentId,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async getQrPayload(req, res, next) {
      try {
        const qrCode = await service.getQrPayload({
          authContext: req.authContext,
          req,
          equipmentId: req.params.equipmentId
        });
        return res.json({ qrCode });
      } catch (error) {
        return next(error);
      }
    },

    async getAssetByQrToken(req, res, next) {
      try {
        const equipment = await service.getAssetByQrToken({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          method: req.method,
          qrToken: req.params.qrToken
        });
        return res.json({ equipment });
      } catch (error) {
        return next(error);
      }
    },

    async exportAssets(req, res, next) {
      try {
        const result = await service.exportAssets({
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
        res.setHeader('Content-Disposition', 'attachment; filename="equipment.xlsx"');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Exported-Count', String(result.count));
        return res.send(result.buffer);
      } catch (error) {
        return next(error);
      }
    },

    async createImportPreview(req, res, next) {
      try {
        const result = await importService.createPreview({
          authContext: req.authContext,
          req,
          upload: req.file,
          input: req.body || {}
        });
        return res.status(201).json({
          message: 'Equipment import preview created',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    },

    async getImportJob(req, res, next) {
      try {
        const importJob = await importService.getImportJob({
          authContext: req.authContext,
          importJobId: req.params.importJobId,
          query: req.query
        });
        return res.json({ importJob });
      } catch (error) {
        return next(error);
      }
    },

    async listImportExceptions(req, res, next) {
      try {
        const result = await importService.listExceptions({
          authContext: req.authContext,
          importJobId: req.params.importJobId,
          query: req.query
        });
        return res.json(result);
      } catch (error) {
        return next(error);
      }
    },

    async confirmImport(req, res, next) {
      try {
        const result = await importService.confirmImport({
          authContext: req.authContext,
          req,
          importJobId: req.params.importJobId,
          input: req.body || {}
        });
        return res.json({
          message: 'Equipment import confirmed and published',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    },

    async cancelImport(req, res, next) {
      try {
        const result = await importService.cancelImport({
          authContext: req.authContext,
          req,
          importJobId: req.params.importJobId,
          input: req.body || {}
        });
        return res.json({
          message: 'Equipment import cancelled',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    },

    async retryImportCleanup(req, res, next) {
      try {
        const result = await importService.retryImportCleanup({
          authContext: req.authContext,
          req,
          importJobId: req.params.importJobId
        });
        return res.json({
          message: 'Equipment import staging cleanup retried',
          ...result
        });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  ...createEquipmentController(),
  createEquipmentController
};
