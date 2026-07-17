'use strict';

const express = require('express');
const generatedDailyReportController = require('../controllers/generatedDailyReportController');
const {
  authenticateContext,
  requireBusinessContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(authenticateContext, requireBusinessContext, businessWriteGuard);

router.get('/', requirePermission('report.view'), generatedDailyReportController.list);
router.get('/:date', requirePermission('report.view'), generatedDailyReportController.get);
router.post(
  '/:date/generate',
  requireTeamContext,
  requirePermission('report.daily.generate'),
  generatedDailyReportController.generate
);

module.exports = router;
