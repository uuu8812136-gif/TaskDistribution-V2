'use strict';

const express = require('express');
const orgUnitController = require('../controllers/orgUnitController');
const {
  authenticateContext,
  requirePermission,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

const router = express.Router();

router.use(authenticateContext, requireTeamContext, requirePermission('org.manage'));

router.get('/', orgUnitController.listOrgUnits);
router.post('/', businessWriteGuard, orgUnitController.createOrgUnit);
router.patch('/:orgUnitId', businessWriteGuard, orgUnitController.updateOrgUnit);
router.delete('/:orgUnitId', businessWriteGuard, orgUnitController.deleteOrgUnit);

module.exports = router;
