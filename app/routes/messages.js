const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const {
  authenticateContext,
  requireBusinessContext
} = require('../middlewares/authContext');
const { businessWriteGuard } = require('../middlewares/businessWriteGuard');

// 所有消息路由都需要认证
router.use(authenticateContext, requireBusinessContext, businessWriteGuard);

/**
 * @route   GET /api/messages
 * @desc    获取消息列表（支持分页、筛选）
 * @access  Private
 * @query   page, limit, isRead, type
 */
router.get('/', messageController.getMessages);

/**
 * @route   GET /api/messages/unread-count
 * @desc    获取未读消息数量
 * @access  Private
 */
router.get('/unread-count', messageController.getUnreadCount);

/**
 * @route   GET /api/messages/:id
 * @desc    获取单个消息详情（自动标记为已读）
 * @access  Private
 */
router.get('/:id', messageController.getMessageById);

/**
 * @route   PUT /api/messages/:id/read
 * @desc    标记单条消息为已读
 * @access  Private
 */
router.put('/:id/read', messageController.markAsRead);

/**
 * @route   PUT /api/messages/read-multiple
 * @desc    批量标记消息为已读
 * @access  Private
 * @body    { messageIds: [] }
 */
router.put('/read-multiple', messageController.markMultipleAsRead);

/**
 * @route   PUT /api/messages/read-all
 * @desc    全部标记为已读
 * @access  Private
 */
router.put('/read-all', messageController.markAllAsRead);

/**
 * @route   DELETE /api/messages/delete-multiple
 * @desc    批量删除消息
 * @access  Private
 * @body    { messageIds: [] }
 */
router.delete('/delete-multiple', messageController.deleteMultipleMessages);

/**
 * @route   DELETE /api/messages/clear-read
 * @desc    清空所有已读消息
 * @access  Private
 */
router.delete('/clear-read', messageController.clearReadMessages);

/**
 * @route   DELETE /api/messages/:id
 * @desc    删除单条消息
 * @access  Private
 */
router.delete('/:id', messageController.deleteMessage);

module.exports = router;

