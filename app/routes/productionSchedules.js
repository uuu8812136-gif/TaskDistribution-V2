'use strict';

const express = require('express');
const productionScheduleController = require('../controllers/productionScheduleController');
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
  requireModuleDataScope('report.production')
);

router.get('/options', requirePermission('report.view'), productionScheduleController.listOptions);

router.get(
  '/daily/:slot/export',
  requirePermission('report.export'),
  productionScheduleController.exportDailySlot
);
router.get(
  '/daily/:slot',
  requirePermission('report.view'),
  productionScheduleController.getDailySlot
);
router.put(
  '/daily/:slot',
  requireTeamContext,
  requirePermission('report.schedule.manage'),
  productionScheduleController.maintainDailySlot
);
router.get(
  '/monthly/export',
  requirePermission('report.export'),
  productionScheduleController.exportMonthlySchedules
);
router.get(
  '/monthly',
  requirePermission('report.view'),
  productionScheduleController.listMonthlySchedules
);
router.put(
  '/monthly/:month',
  requireTeamContext,
  requirePermission('report.schedule.manage'),
  productionScheduleController.maintainMonthlySchedule
);

module.exports = router;
