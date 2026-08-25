const { randomUUID } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { readOnlyDemoDataMasking } = require('./middlewares/readOnlyDemoDataMasking');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MONGOOSE_CONNECTED_STATE = 1;

function requestIdMiddleware(req, res, next) {
  const supplied = req.get('x-request-id');
  req.id = typeof supplied === 'string' && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  return next();
}

function createCorsOptions(config) {
  return {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      const error = new Error('Origin is not allowed by CORS');
      error.status = 403;
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    },
    credentials: false
  };
}

function isDatabaseConnected(connection) {
  return connection?.readyState === MONGOOSE_CONNECTED_STATE;
}

function createApp(config, {
  databaseConnection = mongoose.connection,
  wechatServiceNotificationService
} = {}) {
  if (!config) {
    throw new Error('createApp requires validated environment configuration');
  }

  process.env.UPLOAD_PATH = config.uploadPath;
  process.env.MAX_FILE_SIZE = String(config.maxFileSize);
  process.env.TEMPORARY_FILE_TTL_HOURS = String(config.temporaryFileTtlHours || 24);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  // The middleware decides at response time, after route authentication has
  // populated req.authContext. Normal accounts and public health responses are
  // returned byte-for-byte unchanged.
  app.use(readOnlyDemoDataMasking);

  if (config.enableLegacyPublicUploads) {
    app.use('/uploads', express.static(config.uploadPath));
  }

  app.get('/', (req, res) => {
    res.json({
      message: 'Horselink management system API',
      version: '2.0.0',
      instance: config.instanceName,
      status: 'running'
    });
  });

  app.get('/health', (req, res) => {
    if (!isDatabaseConnected(databaseConnection)) {
      return res.status(503).json({
        status: 'degraded',
        instance: config.instanceName,
        database: 'unavailable'
      });
    }
    res.json({ status: 'ok', instance: config.instanceName });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/teams', require('./routes/teams'));
  app.use('/api/org-units', require('./routes/orgUnits'));
  app.use('/api/team-members', require('./routes/teamMembers'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/extensions', require('./routes/extensions'));
  app.use('/api/statistics', require('./routes/statistics'));
  app.use('/api/messages', require('./routes/messages'));
  const { createWechatServiceNotificationService } = require('./services/wechatServiceNotificationService');
  const { createWechatServiceNotificationsRouter } = require('./routes/wechatServiceNotifications');
  const wechatService = wechatServiceNotificationService || createWechatServiceNotificationService(
    config.wechatServiceNotification || { enabled: false }
  );
  app.use('/api/wechat-service-notifications', createWechatServiceNotificationsRouter(wechatService));
  app.use('/api/equipment', require('./routes/equipment'));
  app.use('/api/transport-records', require('./routes/transportRecords'));
  app.use('/api/attendance-submissions', require('./routes/attendanceSubmissions'));
  app.use('/api/production-schedules', require('./routes/productionSchedules'));
  app.use('/api/generated-daily-reports', require('./routes/generatedDailyReports'));
  app.use('/api/audit-logs', require('./routes/auditLogs'));
  const { createImportTemplatesRouter } = require('./routes/importTemplates');
  app.use('/api/import-templates', createImportTemplatesRouter());
  const { createContractsRouter } = require('./routes/contracts');
  app.use('/api/contracts', createContractsRouter({ storageRoot: config.uploadPath }));
  const { createFilesRouter } = require('./routes/files');
  app.use('/api/files', createFilesRouter({
    storageRoot: config.uploadPath,
    maxFileSize: config.maxFileSize,
    temporaryFileLimits: {
      userMaxCount: config.temporaryFileUserMaxCount,
      userMaxBytes: config.temporaryFileUserMaxBytes,
      teamMaxCount: config.temporaryFileTeamMaxCount,
      teamMaxBytes: config.temporaryFileTeamMaxBytes
    }
  }));

  const { authenticate } = require('./middlewares/auth');
  app.post('/api/upload', authenticate, (req, res) => {
    return res.status(410).json({
      message: '旧上传接口已停用，请使用团队鉴权文件接口',
      code: 'LEGACY_UPLOAD_DISABLED'
    });
  });

  app.use((req, res) => {
    res.status(404).json({ message: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(err.stack || err);
    const response = {
      message: status >= 500 ? '服务器内部错误' : err.message,
      code: err.code,
      error: status >= 500 && config.nodeEnv === 'development' ? err.message : undefined
    };
    // Import validators attach safe worksheet coordinates for customer correction.
    // Only explicitly exposed errors may return structured details to the client.
    if (err.expose === true && err.details && typeof err.details === 'object') {
      response.details = err.details;
    }
    return res.status(status).json(response);
  });

  return app;
}

module.exports = { createApp, isDatabaseConnected, requestIdMiddleware };
