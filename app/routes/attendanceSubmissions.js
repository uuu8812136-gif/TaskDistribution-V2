'use strict';

const express = require('express');
const attendanceSubmissionController = require('../controllers/attendanceSubmissionController');
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
  requireModuleDataScope('report.attendance')
);

router.get('/options', requirePermission('report.view'), attendanceSubmissionController.listOptions);
router.get(
  '/summary/daily',
  requirePermission('report.view'),
  attendanceSubmissionController.getDailySummary
);
router.get(
  '/summary/monthly',
  requirePermission('report.view'),
  attendanceSubmissionController.getMonthlySummary
);
router.get(
  '/summary/monthly/export',
  requirePermission('report.export'),
  attendanceSubmissionController.exportMonthlySummary
);
router.post(
  '/summary/daily/:date/review',
  requireTeamContext,
  requirePermission('report.review'),
  attendanceSubmissionController.reviewDailySummary
);
router.post(
  '/',
  requireTeamContext,
  requirePermission('report.submit'),
  attendanceSubmissionController.createSubmission
);
router.get('/', requirePermission('report.view'), attendanceSubmissionController.listSubmissions);
router.get(
  '/:attendanceSubmissionId',
  requirePermission('report.view'),
  attendanceSubmissionController.getSubmission
);
router.patch(
  '/:attendanceSubmissionId',
  requireTeamContext,
  requirePermission('report.submit'),
  attendanceSubmissionController.updateSubmission
);

module.exports = router;
