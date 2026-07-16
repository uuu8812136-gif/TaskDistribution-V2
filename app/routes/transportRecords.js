'use strict';

const express = require('express');
const transportRecordController = require('../controllers/transportRecordController');
const {
  authenticateContext,
  requireBusinessContext,
  requireModuleDataScope,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(
  authenticateContext,
  requireBusinessContext,
  businessWriteGuard,
  requireModuleDataScope('report.transport')
);

router.get('/options', requirePermission('report.view'), transportRecordController.listOptions);

router.get(
  '/export',
  requirePermission('report.export'),
  transportRecordController.exportMonthlySummary
);
router.post(
  '/',
  requireTeamContext,
  requirePermission('report.submit'),
  transportRecordController.createRecord
);
router.get('/', requirePermission('report.view'), transportRecordController.listRecords);
router.get(
  '/:transportRecordId/history',
  requirePermission('report.view'),
  transportRecordController.getHistory
);
router.get(
  '/:transportRecordId',
  requirePermission('report.view'),
  transportRecordController.getRecord
);
router.patch(
  '/:transportRecordId',
  requireTeamContext,
  requirePermission('report.submit'),
  transportRecordController.updateRecord
);

module.exports = router;
