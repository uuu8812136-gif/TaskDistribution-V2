'use strict';

const fs = require('node:fs');
const { createFileAssetService } = require('../services/fileAssetService');

function rfc5987Value(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function contentDisposition(originalName) {
  const fallback = originalName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .slice(0, 150) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Value(originalName)}`;
}

function createFileController({ storageRoot } = {}) {
  const service = createFileAssetService({ storageRoot });

  return Object.freeze({
    async uploadTemporary(req, res, next) {
      try {
        const file = await service.uploadTemporary({
          authContext: req.authContext,
          req,
          upload: req.file,
          requestedOriginalName: req.body?.originalName
        });
        return res.status(201).json({ message: 'File uploaded', file });
      } catch (error) {
        return next(error);
      }
    },

    async getMetadata(req, res, next) {
      try {
        const file = await service.getMetadata({
          authContext: req.authContext,
          fileId: req.params.fileId,
          requestedTeamId: req.query.teamId,
          method: req.method
        });
        return res.json({ file });
      } catch (error) {
        return next(error);
      }
    },

    async download(req, res, next) {
      try {
        const { file, storagePath } = await service.getDownload({
          authContext: req.authContext,
          fileId: req.params.fileId,
          requestedTeamId: req.query.teamId,
          method: req.method
        });
        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('Content-Length', String(file.size));
        res.setHeader('Content-Disposition', contentDisposition(file.originalName));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const stream = fs.createReadStream(storagePath);
        stream.on('error', next);
        return stream.pipe(res);
      } catch (error) {
        return next(error);
      }
    },

    async bind(req, res, next) {
      try {
        const file = await service.bindFile({
          authContext: req.authContext,
          req,
          fileId: req.params.fileId,
          ownerType: req.body?.ownerType,
          ownerId: req.body?.ownerId
        });
        return res.json({ message: 'File bound', file });
      } catch (error) {
        return next(error);
      }
    },

    async remove(req, res, next) {
      try {
        const file = await service.deleteFile({
          authContext: req.authContext,
          req,
          fileId: req.params.fileId,
          reason: req.body?.reason || null
        });
        return res.json({ message: 'File deleted', file });
      } catch (error) {
        return next(error);
      }
    }
  });
}

module.exports = {
  contentDisposition,
  createFileController
};
