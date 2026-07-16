const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const taskFlowController = require('../controllers/taskFlowController');
const { authenticate, isAdmin } = require('../middlewares/auth');
const upload = require('../middlewares/upload');

// 所有路由都需要登录
router.use(authenticate);

// ========== 任务管理 ==========

// 批量导出任务为Excel（放在/:id之前，避免被/:id路由捕获）
router.get('/export', taskController.batchExportTasks);

// 创建任务（管理员，支持附件上传）
router.post('/', isAdmin, upload.array('attachments', 10), taskController.createTask);

// 获取任务列表
router.get('/', taskController.getTasks);

// 获取我的任务（执行人/抄送人/创建者）
router.get('/my-tasks', taskController.getMyTasks);

// 获取任务详情
router.get('/:id', taskController.getTaskById);

// 更新任务（管理员，支持附件上传）
router.put('/:id', isAdmin, upload.array('attachments', 10), taskController.updateTask);

// 删除任务（管理员）
router.delete('/:id', isAdmin, taskController.deleteTask);

// ========== 任务执行流程 ==========

// 完成任务（执行人）
router.post('/:id/complete', taskFlowController.completeTask);

// 修改完成提交（执行人）
router.put('/:id/complete', taskFlowController.updateCompletion);

// 审核任务（抄送人）
router.post('/:id/review', taskFlowController.reviewTask);

// 确认任务（管理员）
router.post('/:id/confirm', taskFlowController.confirmTask);

// 获取任务审核记录
router.get('/:id/reviews', taskFlowController.getTaskReviews);

module.exports = router;

