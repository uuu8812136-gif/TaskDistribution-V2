'use strict';

const {
  isReadOnlyDemoContext,
  maskDemoResponse
} = require('../services/readOnlyDemoDataMaskingService');

function readOnlyDemoDataMasking(req, res, next) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = (body) => originalJson(
    isReadOnlyDemoContext(req.authContext) ? maskDemoResponse(body) : body
  );
  res.send = (body) => {
    if (isReadOnlyDemoContext(req.authContext) && Buffer.isBuffer(body)) {
      return res.status(403).json({
        code: 'READ_ONLY_DEMO_EXPORT_HIDDEN',
        message: '演示账号仅可查看脱敏页面数据'
      });
    }
    return originalSend(body);
  };
  return next();
}

function denyReadOnlyDemoFileDownload(req, res, next) {
  if (isReadOnlyDemoContext(req.authContext)) {
    return res.status(403).json({
      code: 'READ_ONLY_DEMO_FILE_HIDDEN',
      message: '演示账号仅可查看脱敏附件信息'
    });
  }
  return next();
}

module.exports = {
  denyReadOnlyDemoFileDownload,
  readOnlyDemoDataMasking
};
