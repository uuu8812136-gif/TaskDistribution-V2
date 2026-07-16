'use strict';

const express = require('express');
const teamController = require('../controllers/teamController');
const {
  authenticateContext,
  requireTeamContext
} = require('../middlewares/authContext');
const {
  businessWriteGuard,
  createBusinessWriteGuard,
  markControlPlaneOperation
} = require('../middlewares/businessWriteGuard');

const router = express.Router();
const CREATE_TEAM_OPERATION = 'team.create';
const ENABLE_TEAM_OPERATION = 'team.enable';
const teamControlPlaneGuard = createBusinessWriteGuard({
  allowedControlPlaneOperations: [CREATE_TEAM_OPERATION, ENABLE_TEAM_OPERATION]
});

router.use(authenticateContext);

router.get('/', teamController.listTeams);
router.post(
  '/',
  markControlPlaneOperation(CREATE_TEAM_OPERATION),
  teamControlPlaneGuard,
  teamController.createTeam
);
router.post(
  '/:teamId/enable',
  markControlPlaneOperation(ENABLE_TEAM_OPERATION),
  teamControlPlaneGuard,
  teamController.enableTeam
);
router.patch(
  '/:teamId/status',
  requireTeamContext,
  businessWriteGuard,
  teamController.updateTeamStatus
);

module.exports = router;
