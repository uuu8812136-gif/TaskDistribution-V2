'use strict';

const express = require('express');
const multer = require('multer');
const { createFileController } = require('../controllers/fileController');
const {
  authenticateContext,
  requireBusinessContext,
  requireTeamContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');
const {
  FileAssetError,
  assertTemporaryUploadPermission,
  createFileAssetService
} = require('../services/fileAssetService');
const {
  resolveTaskTemporaryUploadContext
} = require('../services/taskLeadershipAccessService');
const { validatedExtension } = require('../services/fileStorageService');
const { denyReadOnlyDemoFileDownload } = require('../middlewares/readOnlyDemoDataMasking');

function createUpload(maxFileSize) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSize,
      files: 1,
      fields: 10,
      parts: 11,
      fieldNameSize: 100,
      fieldSize: 16 * 1024
    },
    fileFilter(req, file, callback) {
      try {
        validatedExtension(file.originalname, file.mimetype);
        callback(null, true);
      } catch (error) {
        callback(new FileAssetError(415, 'FILE_TYPE_UNSUPPORTED', error.message));
      }
    }
  }).single('file');
}

function uploadMiddleware(upload) {
  return function handleUpload(req, res, next) {
    upload(req, res, (error) => {
      if (!error) return next();
      if (error instanceof FileAssetError) return next(error);
      if (error instanceof multer.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        return next(new FileAssetError(
          tooLarge ? 413 : 400,
          tooLarge ? 'FILE_TOO_LARGE' : 'FILE_UPLOAD_INVALID',
          tooLarge ? 'File exceeds the configured size limit' : 'Invalid file upload'
        ));
      }
      return next(error);
    });
  };
}

function requireTemporaryUploadPermission(req, res, next) {
  try {
    assertTemporaryUploadPermission(req.authContext);
    return next();
  } catch (error) {
    return next(error);
  }
}

function createFilesRouter({ storageRoot, maxFileSize, temporaryFileLimits } = {}) {
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize <= 0) {
    throw new TypeError('maxFileSize must be a positive safe integer');
  }
  const router = express.Router();
  const service = createFileAssetService({ storageRoot, temporaryFileLimits });
  const controller = createFileController({ service });
  const upload = createUpload(maxFileSize);

  async function requireTemporaryUploadCapacity(req, res, next) {
    try {
      await service.assertTemporaryUploadCapacity({
        authContext: req.temporaryUploadAuthContext || req.authContext,
        incomingBytes: 1
      });
      return next();
    } catch (error) {
      return next(error);
    }
  }

  async function requireTaskTemporaryUploadPermission(req, res, next) {
    try {
      req.temporaryUploadAuthContext = await resolveTaskTemporaryUploadContext({
        authContext: req.authContext,
        taskId: req.query?.taskId,
        orgUnitId: req.query?.orgUnitId
      });
      return next();
    } catch (error) {
      return next(error);
    }
  }

  router.use(authenticateContext, requireBusinessContext);
  router.post(
    '/',
    requireTeamContext,
    businessWriteGuard,
    requireTemporaryUploadPermission,
    requireTemporaryUploadCapacity,
    uploadMiddleware(upload),
    controller.uploadTemporary
  );
  router.post(
    '/task-temporary',
    requireTeamContext,
    businessWriteGuard,
    requireTaskTemporaryUploadPermission,
    requireTemporaryUploadCapacity,
    uploadMiddleware(upload),
    controller.uploadTemporary
  );
  router.get('/:fileId', controller.getMetadata);
  router.get('/:fileId/download', denyReadOnlyDemoFileDownload, controller.download);
  router.patch('/:fileId/bind', requireTeamContext, businessWriteGuard, controller.bind);
  router.delete('/:fileId', requireTeamContext, businessWriteGuard, controller.remove);

  return router;
}

module.exports = { createFilesRouter };
