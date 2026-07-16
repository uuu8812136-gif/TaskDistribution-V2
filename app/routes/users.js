'use strict';

const express = require('express');
const userController = require('../controllers/userController');
const {
  authenticateContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(authenticateContext, requireTeamContext, businessWriteGuard);

router.get('/', requirePermission('member.view'), userController.getAllUsers);
router.get('/:id', requirePermission('member.view'), userController.getUserById);

// Legacy writes are intentionally retained only as explicit migration errors.
// Canonical member changes must use /api/team-members and its audited service.
router.post('/', requirePermission('member.manage'), userController.createUser);
router.put('/:id', requirePermission('member.manage'), userController.updateUser);
router.delete('/:id', requirePermission('member.manage'), userController.deleteUser);
router.post(
  '/:id/reset-password',
  requirePermission('member.manage'),
  userController.resetPassword
);

module.exports = router;
