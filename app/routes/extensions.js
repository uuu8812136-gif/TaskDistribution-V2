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
const {
  requireTaskPermissionOrLeadershipCandidate
} = require('../middlewares/taskLeadershipAuthorization');

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
  requireTaskPermissionOrLeadershipCandidate('task.review'),
  extensionController.approveExtension
);
const taskViewOrLeader = requireTaskPermissionOrLeadershipCandidate('task.view');

router.get('/', taskViewOrLeader, extensionController.getExtensionRequests);
router.get(
  '/history/:taskId',
  taskViewOrLeader,
  extensionController.getTaskExtensionHistory
);
router.get(
  '/:id',
  taskViewOrLeader,
  extensionController.getExtensionRequestById
);

module.exports = router;
