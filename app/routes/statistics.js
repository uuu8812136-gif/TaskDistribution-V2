const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/statisticsController');
const { authenticate, isAdmin } = require('../middlewares/auth');

// 所有路由都需要登录
router.use(authenticate);

// 获取统计概览
router.get('/overview', statisticsController.getStatisticsOverview);

// 导出任务统计（管理员）
router.get('/export/tasks', isAdmin, statisticsController.exportTasksToExcel);

// 导出人员统计（管理员）
router.get('/export/users', isAdmin, statisticsController.exportUserStatistics);

module.exports = router;

