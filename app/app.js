const express = require('express');
const cors = require('cors');

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

function createApp(config) {
  if (!config) {
    throw new Error('createApp requires validated environment configuration');
  }

  process.env.UPLOAD_PATH = config.uploadPath;
  process.env.MAX_FILE_SIZE = String(config.maxFileSize);

  const app = express();
  app.disable('x-powered-by');
  app.use(cors(createCorsOptions(config)));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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

  const upload = require('./middlewares/upload');
  const { authenticate } = require('./middlewares/auth');
  app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: '没有上传文件' });
      }

      const originalName = req.body.friendlyName
        ? req.body.friendlyName
        : Buffer.from(req.file.originalname, 'latin1').toString('utf8');

      return res.json({
        message: '文件上传成功',
        filePath: `/uploads/${req.file.filename}`,
        originalName,
        size: req.file.size,
        mimetype: req.file.mimetype
      });
    } catch (error) {
      console.error('文件上传错误:', error);
      return res.status(500).json({ message: '文件上传失败' });
    }
  });

  app.use((req, res) => {
    res.status(404).json({ message: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error(err.stack || err);
    return res.status(status).json({
      message: status >= 500 ? '服务器内部错误' : err.message,
      code: err.code,
      error: status >= 500 && config.nodeEnv === 'development' ? err.message : undefined
    });
  });

  return app;
}

module.exports = { createApp };
