'use strict';

const express = require('express');
const teamMemberController = require('../controllers/teamMemberController');
const {
  authenticateContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(authenticateContext, requireTeamContext);

router.get('/', requirePermission('member.view'), teamMemberController.listMembers);
router.post(
  '/',
  requirePermission('member.manage'),
  businessWriteGuard,
  teamMemberController.createMember
);
router.patch(
  '/:membershipId',
  requirePermission('member.manage'),
  businessWriteGuard,
  teamMemberController.updateMember
);
router.delete(
  '/:membershipId',
  requirePermission('member.manage'),
  businessWriteGuard,
  teamMemberController.disableMember
);

module.exports = router;

