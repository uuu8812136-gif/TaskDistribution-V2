'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { authenticate, isAdmin, requireTeamContext } = require('../middlewares/auth');

const router = express.Router();

router.post('/login', authController.login);
router.get('/teams', authenticate, authController.listTeams);
router.post('/switch-team', authenticate, authController.switchTeam);
router.post('/global-readonly', authenticate, authController.enterGlobalReadOnly);
router.get('/me', authenticate, authController.getCurrentUser);
router.post('/logout', authenticate, authController.logout);
router.post('/change-password', authenticate, authController.changePassword);

// Legacy registration can no longer create global identities or assign roles.
router.post(
  '/register',
  authenticate,
  requireTeamContext,
  isAdmin,
  authController.register
);

module.exports = router;
