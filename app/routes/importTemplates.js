'use strict';

const express = require('express');
const {
  authenticateContext,
  requireBusinessContext,
  requireTeamContext
} = require('../middlewares/authContext');
const { createImportTemplateController } = require('../controllers/importTemplateController');

function createImportTemplatesRouter({ service } = {}) {
  const router = express.Router();
  const controller = createImportTemplateController({ service });

  router.use(authenticateContext, requireBusinessContext, requireTeamContext);
  router.get('/', controller.list);
  router.get('/:templateId/download', controller.download);
  return router;
}

module.exports = {
  createImportTemplatesRouter
};
