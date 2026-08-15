'use strict';

const express = require('express');
const multer = require('multer');
const { createContractController } = require('../controllers/contractController');
const {
  authenticateContext,
  requireBusinessContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');
const {
  ContractManagementError,
  EXCEL_MIME_TYPE,
  MAX_CONTRACT_PDF_ZIP_SIZE,
  MAX_IMPORT_FILE_SIZE,
  createContractManagementService
} = require('../services/contractManagementService');

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMPORT_FILE_SIZE,
    files: 1,
    fields: 5,
    parts: 6,
    fieldNameSize: 100,
    fieldSize: 16 * 1024
  },
  fileFilter(req, file, callback) {
    const isXlsx = file.mimetype === EXCEL_MIME_TYPE && /\.xlsx$/i.test(file.originalname || '');
    if (isXlsx) return callback(null, true);
    return callback(new ContractManagementError(
      415,
      'CONTRACT_IMPORT_FILE_UNSUPPORTED',
      '仅支持 .xlsx 格式的合同管理Excel文件'
    ));
  }
}).single('file');

const pdfZipUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CONTRACT_PDF_ZIP_SIZE,
    files: 1,
    fields: 5,
    parts: 6,
    fieldNameSize: 100,
    fieldSize: 16 * 1024
  },
  fileFilter(req, file, callback) {
    if (/\.zip$/i.test(file.originalname || '')) return callback(null, true);
    return callback(new ContractManagementError(
      415,
      'CONTRACT_PDF_ZIP_UNSUPPORTED',
      '仅支持包含PDF文件的 .zip 压缩包'
    ));
  }
}).single('file');

function importUploadMiddleware(req, res, next) {
  importUpload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof ContractManagementError) return next(error);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return next(new ContractManagementError(
        tooLarge ? 413 : 400,
        tooLarge ? 'CONTRACT_IMPORT_FILE_TOO_LARGE' : 'CONTRACT_IMPORT_UPLOAD_INVALID',
        tooLarge ? '合同管理Excel文件不能超过20MB' : '合同管理Excel上传内容不正确'
      ));
    }
    return next(error);
  });
}

function pdfZipUploadMiddleware(req, res, next) {
  pdfZipUpload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof ContractManagementError) return next(error);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return next(new ContractManagementError(
        tooLarge ? 413 : 400,
        tooLarge ? 'CONTRACT_PDF_ZIP_TOO_LARGE' : 'CONTRACT_PDF_ZIP_UPLOAD_INVALID',
        tooLarge ? 'PDF压缩包不能超过220MB' : 'PDF压缩包上传内容不正确'
      ));
    }
    return next(error);
  });
}

function rejectWriteTeamId(req, res, next) {
  if (
    Object.prototype.hasOwnProperty.call(req.query || {}, 'teamId') ||
    Object.prototype.hasOwnProperty.call(req.body || {}, 'teamId')
  ) {
    return next(new ContractManagementError(
      400,
      'CONTRACT_TEAM_ID_IMMUTABLE',
      'teamId由当前登录团队确定，写操作不能由客户端指定'
    ));
  }
  return next();
}

function createContractsRouter({ storageRoot, service } = {}) {
  const router = express.Router();
  const contractController = createContractController({
    service: service || createContractManagementService({ storageRoot })
  });

  router.use(
    authenticateContext,
    requireBusinessContext,
    businessWriteGuard
  );

  router.get(
    '/suppliers/export',
    requirePermission('contract.supplier.export'),
    contractController.exportSuppliers
  );
  router.post(
    '/suppliers/import',
    requireTeamContext,
    requirePermission('contract.supplier.import'),
    importUploadMiddleware,
    rejectWriteTeamId,
    contractController.importSuppliers
  );
  router.post(
    '/suppliers/contract-pdfs/import',
    requireTeamContext,
    requirePermission('contract.supplier.import'),
    pdfZipUploadMiddleware,
    rejectWriteTeamId,
    contractController.importContractPdfs
  );
  router.get(
    '/suppliers',
    requirePermission('contract.supplier.view'),
    contractController.listSuppliers
  );
  router.post(
    '/records',
    requireTeamContext,
    requirePermission('contract.supplier.manage'),
    rejectWriteTeamId,
    contractController.createFirstRecord
  );
  router.get(
    '/suppliers/:supplierId/records',
    requirePermission('contract.supplier.view'),
    contractController.listRecords
  );
  router.post(
    '/suppliers/:supplierId/records',
    requireTeamContext,
    requirePermission('contract.supplier.manage'),
    rejectWriteTeamId,
    contractController.createRecord
  );
  router.get(
    '/suppliers/:supplierId',
    requirePermission('contract.supplier.view'),
    contractController.getSupplier
  );
  router.patch(
    '/suppliers/:supplierId',
    requireTeamContext,
    requirePermission('contract.supplier.manage'),
    rejectWriteTeamId,
    contractController.updateSupplier
  );
  router.get(
    '/records/:recordId',
    requirePermission('contract.supplier.view'),
    contractController.getRecord
  );
  router.patch(
    '/records/:recordId',
    requireTeamContext,
    requirePermission('contract.supplier.manage'),
    rejectWriteTeamId,
    contractController.updateRecord
  );
  router.delete(
    '/records/:recordId',
    requireTeamContext,
    requirePermission('contract.supplier.manage'),
    rejectWriteTeamId,
    contractController.deleteRecord
  );

  router.get(
    '/expiry-alerts/export',
    requirePermission('contract.expiry.export'),
    contractController.exportExpiryAlerts
  );
  router.get(
    '/expiry-alerts',
    requirePermission('contract.expiry.view'),
    contractController.listExpiryAlerts
  );

  router.get(
    '/settlements/export',
    requirePermission('contract.settlement.export'),
    contractController.exportSettlements
  );
  router.post(
    '/settlements/import',
    requireTeamContext,
    requirePermission('contract.settlement.import'),
    importUploadMiddleware,
    rejectWriteTeamId,
    contractController.importSettlements
  );
  router.get(
    '/settlements',
    requirePermission('contract.settlement.view'),
    contractController.listSettlements
  );
  router.post(
    '/settlements',
    requireTeamContext,
    requirePermission('contract.settlement.manage'),
    rejectWriteTeamId,
    contractController.createSettlement
  );
  router.get(
    '/settlements/:settlementId',
    requirePermission('contract.settlement.view'),
    contractController.getSettlement
  );
  router.patch(
    '/settlements/:settlementId',
    requireTeamContext,
    requirePermission('contract.settlement.manage'),
    rejectWriteTeamId,
    contractController.updateSettlement
  );
  router.delete(
    '/settlements/:settlementId',
    requireTeamContext,
    requirePermission('contract.settlement.manage'),
    rejectWriteTeamId,
    contractController.deleteSettlement
  );

  return router;
}

module.exports = {
  createContractsRouter,
  importUploadMiddleware,
  pdfZipUploadMiddleware,
  rejectWriteTeamId
};
