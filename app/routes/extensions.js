'use strict';

const express = require('express');
const extensionController = require('../controllers/extensionController');
const {
  authenticateContext,
  requireBusinessContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(authenticateContext, requireBusinessContext, businessWriteGuard);

router.post(
  '/apply/:id',
  requireTeamContext,
  requirePermission('task.view'),
  extensionController.applyExtension
);
router.post(
  '/approve/:id',
  requireTeamContext,
  requirePermission('task.review'),
  extensionController.approveExtension
);
router.get('/', requirePermission('task.view'), extensionController.getExtensionRequests);
router.get(
  '/history/:taskId',
  requirePermission('task.view'),
  extensionController.getTaskExtensionHistory
);
router.get(
  '/:id',
  requirePermission('task.view'),
  extensionController.getExtensionRequestById
);

module.exports = router;
