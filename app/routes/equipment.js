'use strict';

const express = require('express');
const multer = require('multer');
const equipmentController = require('../controllers/equipmentController');
const {
  authenticateContext,
  requireBusinessContext,
  requireModuleDataScope,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');
const {
  EXCEL_MIME_TYPE,
  EquipmentImportError,
  MAX_EQUIPMENT_IMPORT_FILE_SIZE
} = require('../services/equipmentImportService');

const router = express.Router();

router.use(
  authenticateContext,
  requireBusinessContext,
  businessWriteGuard,
  requireModuleDataScope('equipment')
);

const equipmentView = requirePermission('equipment.view');
const equipmentCreate = requirePermission('equipment.create');
const equipmentEdit = requirePermission('equipment.edit');
const equipmentExport = requirePermission('equipment.export');
const equipmentImport = requirePermission('equipment.import');
const equipmentQrCode = requirePermission('equipment.qrcode');

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_EQUIPMENT_IMPORT_FILE_SIZE,
    files: 1,
    fields: 5,
    parts: 6,
    fieldNameSize: 100,
    fieldSize: 16 * 1024
  },
  fileFilter(req, file, callback) {
    const isXlsx = file.mimetype === EXCEL_MIME_TYPE && /\.xlsx$/i.test(file.originalname || '');
    if (isXlsx) return callback(null, true);
    return callback(new EquipmentImportError(
      415,
      'EQUIPMENT_IMPORT_FILE_UNSUPPORTED',
      'Only .xlsx workbooks are supported'
    ));
  }
}).single('file');

function importUploadMiddleware(req, res, next) {
  importUpload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof EquipmentImportError) return next(error);
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return next(new EquipmentImportError(
        tooLarge ? 413 : 400,
        tooLarge ? 'EQUIPMENT_IMPORT_FILE_TOO_LARGE' : 'EQUIPMENT_IMPORT_UPLOAD_INVALID',
        tooLarge ? 'The Excel file exceeds 128 MB' : 'Invalid equipment import upload'
      ));
    }
    return next(error);
  });
}

router.get('/options', equipmentView, equipmentController.listOptions);
router.get('/categories', equipmentView, equipmentController.listCategories);
router.post(
  '/categories',
  requireTeamContext,
  equipmentCreate,
  equipmentController.createCategory
);
router.get('/categories/:categoryId', equipmentView, equipmentController.getCategory);
router.patch(
  '/categories/:categoryId',
  requireTeamContext,
  equipmentEdit,
  equipmentController.updateCategory
);
router.delete(
  '/categories/:categoryId',
  requireTeamContext,
  equipmentEdit,
  equipmentController.disableCategory
);

// Static routes stay before the equipment identity route.
router.get('/export', equipmentExport, equipmentController.exportAssets);
router.get('/qr/:qrToken', equipmentView, equipmentController.getAssetByQrToken);
router.post(
  '/imports',
  requireTeamContext,
  equipmentImport,
  importUploadMiddleware,
  equipmentController.createImportPreview
);
router.get(
  '/imports/:importJobId',
  requireTeamContext,
  equipmentImport,
  equipmentController.getImportJob
);
router.get(
  '/imports/:importJobId/exceptions',
  requireTeamContext,
  equipmentImport,
  equipmentController.listImportExceptions
);
router.post(
  '/imports/:importJobId/confirm',
  requireTeamContext,
  equipmentImport,
  equipmentController.confirmImport
);

router.post('/', requireTeamContext, equipmentCreate, equipmentController.createAsset);
router.get('/', equipmentView, equipmentController.listAssets);
router.get('/:equipmentId/history', equipmentView, equipmentController.getHistory);
router.post(
  '/:equipmentId/qrcode',
  requireTeamContext,
  equipmentQrCode,
  equipmentController.getQrPayload
);
router.get('/:equipmentId', equipmentView, equipmentController.getAsset);
router.patch(
  '/:equipmentId',
  requireTeamContext,
  equipmentEdit,
  equipmentController.updateAsset
);

module.exports = router;
module.exports.importUploadMiddleware = importUploadMiddleware;
