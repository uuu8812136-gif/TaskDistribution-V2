const express = require('express');
const router = express.Router();
const extensionController = require('../controllers/extensionController');
const { authenticate, isAdmin } = require('../middlewares/auth');

// 所有路由都需要登录
router.use(authenticate);

// 申请延期
router.post('/apply/:id', extensionController.applyExtension);

// 审批延期（管理员）
router.post('/approve/:id', isAdmin, extensionController.approveExtension);

// 获取延期申请列表
router.get('/', extensionController.getExtensionRequests);

// 获取延期申请详情
router.get('/:id', extensionController.getExtensionRequestById);

// 获取任务的延期历史
router.get('/history/:taskId', extensionController.getTaskExtensionHistory);

module.exports = router;

