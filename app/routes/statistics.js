'use strict';

const express = require('express');
const statisticsController = require('../controllers/statisticsController');
const {
  authenticateContext,
  requireBusinessContext,
  requireModuleDataScope,
  requirePermission
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(
  authenticateContext,
  requireBusinessContext,
  businessWriteGuard,
  requireModuleDataScope('task')
);

router.get(
  '/overview',
  requirePermission('task.view'),
  statisticsController.getStatisticsOverview
);
router.get(
  '/export/tasks',
  requirePermission('task.export'),
  statisticsController.exportTasksToExcel
);
router.get(
  '/export/users',
  requirePermission('task.export'),
  requirePermission('member.view'),
  statisticsController.exportUserStatistics
);

module.exports = router;
