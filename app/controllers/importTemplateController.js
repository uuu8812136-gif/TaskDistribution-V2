'use strict';

const { createImportTemplateService } = require('../services/importTemplateService');

function rfc5987Value(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function contentDisposition(fileName) {
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .slice(0, 150) || 'template.xlsx';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Value(fileName)}`;
}

function createImportTemplateController({ service = createImportTemplateService() } = {}) {
  return Object.freeze({
    async list(req, res, next) {
      try {
        return res.json(service.list({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId
        }));
      } catch (error) {
        return next(error);
      }
    },

    async download(req, res, next) {
      try {
        const template = await service.download({
          authContext: req.authContext,
          requestedTeamId: req.query.teamId,
          templateId: req.params.templateId
        });
        res.setHeader('Content-Type', template.contentType);
        res.setHeader('Content-Disposition', contentDisposition(template.fileName));
        res.setHeader('Cache-Control', 'private, no-store');
        return res.send(template.buffer);
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  contentDisposition,
  createImportTemplateController
};
