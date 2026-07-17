'use strict';

const express = require('express');
const multer = require('multer');
const equipmentController = require('../controllers/equipmentController');
const equipmentInventoryController = require('../controllers/equipmentInventoryController');
const equipmentRepairController = require('../controllers/equipmentRepairController');
const equipmentStatusApplicationController = require('../controllers/equipmentStatusApplicationController');
const equipmentRoutineController = require('../controllers/equipmentRoutineController');
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
const { EquipmentRegistryError } = require('../services/equipmentRegistryService');

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
const equipmentInventory = requirePermission('equipment.inventory');
const equipmentQrCode = requirePermission('equipment.qrcode');
const equipmentRepair = requirePermission('equipment.repair');
const equipmentStatusApply = requirePermission('equipment.status.apply');

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

function rejectRoutineWriteTeamId(req, res, next) {
  if (Object.prototype.hasOwnProperty.call(req.query || {}, 'teamId')) {
    return next(new EquipmentRegistryError(
      400,
      'EQUIPMENT_TEAM_ID_IMMUTABLE',
      'teamId is derived from the authenticated team and cannot be supplied by the client'
    ));
  }
  return next();
}

function requireRoutineWorkerManager(req, res, next) {
  const context = req.authContext || {};
  const membership = context.membership || {};
  const fixedIdentityAllowed = (
    context.isSuperAdmin === true ||
    membership.positionKey === 'DEPARTMENT_MANAGER' ||
    membership.functionalRoleKeys?.includes('ASSET_ADMIN')
  );
  if (!fixedIdentityAllowed || context.moduleDataScopes?.equipment !== 'TEAM') {
    return next(new EquipmentRegistryError(
      403,
      'EQUIPMENT_ROUTINE_MANAGER_REQUIRED',
      'Only a team-scoped department manager or equipment administrator can run routine reminders'
    ));
  }
  return next();
}

router.get('/options', equipmentView, equipmentController.listOptions);

router.get('/routine-rules', equipmentView, equipmentRoutineController.listRules);
router.post(
  '/routine-rules',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentEdit,
  equipmentRoutineController.createRule
);
router.get('/routine-rules/:ruleId', equipmentView, equipmentRoutineController.getRule);
router.patch(
  '/routine-rules/:ruleId',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentEdit,
  equipmentRoutineController.updateRule
);
router.delete(
  '/routine-rules/:ruleId',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentEdit,
  equipmentRoutineController.disableRule
);
router.get('/routine-records', equipmentView, equipmentRoutineController.listRecords);
router.get('/routine-records/export', equipmentExport, equipmentRoutineController.exportRecords);
router.get('/routine-plans', equipmentView, equipmentRoutineController.listPlans);
router.get('/routine-exceptions', equipmentView, equipmentRoutineController.listExceptions);
router.get('/routine-exceptions/:exceptionId', equipmentView, equipmentRoutineController.getException);
router.post(
  '/routine-exceptions/:exceptionId/actions',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentView,
  equipmentRoutineController.transitionException
);
router.post(
  '/routine-worker/run',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentEdit,
  requireRoutineWorkerManager,
  equipmentRoutineController.runWorker
);

router.get('/repairs/export', equipmentExport, equipmentRepairController.export);
router.get('/repairs', equipmentView, equipmentRepairController.list);
router.post(
  '/repairs',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentRepair,
  equipmentRepairController.create
);
router.get('/repairs/:repairId', equipmentView, equipmentRepairController.get);
router.post(
  '/repairs/:repairId/actions',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentRepair,
  equipmentRepairController.transition
);

router.get(
  '/status-applications',
  equipmentView,
  equipmentStatusApplicationController.list
);
router.post(
  '/status-applications',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentStatusApply,
  equipmentStatusApplicationController.create
);
router.get(
  '/status-applications/:applicationId',
  equipmentView,
  equipmentStatusApplicationController.get
);
router.post(
  '/status-applications/:applicationId/actions',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentStatusApplicationController.transition
);

router.get('/inventories/options', equipmentInventory, equipmentInventoryController.listOptions);
router.get('/inventories', equipmentInventory, equipmentInventoryController.listSessions);
router.post(
  '/inventories',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentInventory,
  equipmentInventoryController.createSession
);
router.get(
  '/inventories/:inventorySessionId/export',
  equipmentInventory,
  equipmentInventoryController.exportSession
);
router.get(
  '/inventories/:inventorySessionId',
  equipmentInventory,
  equipmentInventoryController.getSession
);
router.patch(
  '/inventories/:inventorySessionId/items/:inventoryItemId',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentInventory,
  equipmentInventoryController.updateItem
);
router.post(
  '/inventories/:inventorySessionId/scan',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentInventory,
  equipmentInventoryController.scanItem
);
router.post(
  '/inventories/:inventorySessionId/submit',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentInventory,
  equipmentInventoryController.submitSession
);
router.post(
  '/inventories/:inventorySessionId/review',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentInventory,
  equipmentInventoryController.reviewSession
);

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
router.post(
  '/imports/:importJobId/cancel',
  requireTeamContext,
  equipmentImport,
  equipmentController.cancelImport
);
router.post(
  '/imports/:importJobId/cleanup',
  requireTeamContext,
  equipmentImport,
  equipmentController.retryImportCleanup
);

router.post('/', requireTeamContext, equipmentCreate, equipmentController.createAsset);
router.get('/', equipmentView, equipmentController.listAssets);
router.get('/:equipmentId/history', equipmentView, equipmentController.getHistory);
router.get(
  '/:equipmentId/routine-schedule',
  equipmentView,
  equipmentRoutineController.getSchedule
);
router.post(
  '/:equipmentId/routine-records',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentRoutineController.createRecord
);
router.get(
  '/:equipmentId/runtime-readings',
  equipmentView,
  equipmentRoutineController.listRuntimeReadings
);
router.post(
  '/:equipmentId/runtime-readings',
  requireTeamContext,
  rejectRoutineWriteTeamId,
  equipmentEdit,
  equipmentRoutineController.createRuntimeReading
);
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
