'use strict';

const express = require('express');
const { authenticate } = require('../middlewares/auth');
const { createWechatServiceNotificationController } = require('../controllers/wechatServiceNotificationController');

function createWechatServiceNotificationsRouter(service) {
  const router = express.Router();
  const controller = createWechatServiceNotificationController(service);
  router.use(authenticate);
  router.get('/config', controller.getConfig);
  router.get('/status', controller.getStatus);
  router.post('/bind', controller.bind);
  router.post('/authorization', controller.authorize);
  return router;
}

module.exports = { createWechatServiceNotificationsRouter };
