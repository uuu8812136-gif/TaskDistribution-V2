'use strict';

function sendError(res, next, error) {
  if (Number.isInteger(error?.status)) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  return next(error);
}

function createWechatServiceNotificationController(service) {
  return Object.freeze({
    getConfig(_req, res) {
      return res.json(service.publicConfig());
    },

    async getStatus(req, res, next) {
      try {
        return res.json(await service.getStatus(req.authContext.userId));
      } catch (error) {
        return sendError(res, next, error);
      }
    },

    async bind(req, res, next) {
      try {
        return res.json(await service.bindUser({
          userId: req.authContext.userId,
          code: req.body?.code
        }));
      } catch (error) {
        return sendError(res, next, error);
      }
    },

    async authorize(req, res, next) {
      try {
        return res.json(await service.recordAuthorization({
          userId: req.authContext.userId,
          templateId: req.body?.templateId,
          result: req.body?.result
        }));
      } catch (error) {
        return sendError(res, next, error);
      }
    }
  });
}

module.exports = { createWechatServiceNotificationController };
