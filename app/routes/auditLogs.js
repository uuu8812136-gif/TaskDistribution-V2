'use strict';

const express = require('express');
const auditLogController = require('../controllers/auditLogController');
const {
  authenticateContext,
  requirePermission
} = require('../middlewares/authContext');

const router = express.Router();

router.use(authenticateContext);
router.get('/', requirePermission('audit.view'), auditLogController.listAuditLogs);
router.get('/:id', requirePermission('audit.view'), auditLogController.getAuditLog);

module.exports = router;
