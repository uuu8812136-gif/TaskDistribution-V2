'use strict';

const { createAuditQueryService } = require('../services/auditQueryService');

const auditQueryService = createAuditQueryService();

exports.listAuditLogs = async (req, res, next) => {
  try {
    const result = await auditQueryService.listAuditLogs({
      authContext: req.authContext,
      query: req.query || {}
    });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
};

exports.getAuditLog = async (req, res, next) => {
  try {
    const auditLog = await auditQueryService.getAuditLog({
      authContext: req.authContext,
      auditLogId: req.params.id
    });
    return res.json({ auditLog });
  } catch (error) {
    return next(error);
  }
};
