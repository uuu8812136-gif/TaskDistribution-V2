'use strict';

const mongoose = require('mongoose');
const Message = require('../models/Message');
const { SESSION_MODES } = require('../config/permissions');

const MESSAGE_TYPES = new Set(Message.schema.path('type').enumValues);

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function teamConstraint(req, { write = false } = {}) {
  const context = req.authContext;
  if (!context) {
    const error = new Error('Authentication context is required');
    error.status = 401;
    throw error;
  }

  if (context.mode === SESSION_MODES.TEAM) {
    return { teamId: context.activeTeamId };
  }

  if (context.mode === SESSION_MODES.GLOBAL_READ_ONLY && !write) {
    if (!req.query.teamId) return {};
    if (!mongoose.isValidObjectId(req.query.teamId)) {
      const error = new Error('teamId格式无效');
      error.status = 400;
      throw error;
    }
    return { teamId: req.query.teamId };
  }

  const error = new Error('当前会话不能修改消息');
  error.status = 403;
  throw error;
}

function ownerFilter(req, extra = {}, options = {}) {
  return {
    $and: [
      teamConstraint(req, options),
      { recipient: req.authContext.userId },
      extra
    ]
  };
}

function sendError(res, error, fallbackMessage) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(fallbackMessage, error);
  return res.status(status).json({
    message: status >= 500 ? '服务器错误' : error.message
  });
}

function relatedPopulate(req) {
  const match = req.authContext.mode === SESSION_MODES.TEAM
    ? { teamId: req.authContext.activeTeamId }
    : undefined;
  return [
    { path: 'relatedTask', select: 'taskName status', match },
    { path: 'relatedExtension', select: 'status requestedDays approvedDays', match }
  ];
}

exports.getMessages = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const extra = {};
    if (req.query.isRead !== undefined) extra.isRead = req.query.isRead === 'true';
    if (req.query.type) {
      if (!MESSAGE_TYPES.has(req.query.type)) {
        return res.status(400).json({ message: '消息类型无效' });
      }
      extra.type = req.query.type;
    }
    const query = ownerFilter(req, extra);

    const [messages, total] = await Promise.all([
      Message.find(query)
        .populate(relatedPopulate(req))
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Message.countDocuments(query)
    ]);

    return res.json({
      messages,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    return sendError(res, error, '获取消息列表错误:');
  }
};

exports.getMessageById = async (req, res) => {
  try {
    const message = await Message.findOne(ownerFilter(req, { _id: req.params.id }))
      .populate(relatedPopulate(req));
    if (!message) return res.status(404).json({ message: '消息不存在' });

    // GET is intentionally side-effect free. Use PUT /:id/read to mark it read.
    return res.json({ message });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ message: '消息不存在' });
    return sendError(res, error, '获取消息详情错误:');
  }
};

exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Message.countDocuments(ownerFilter(req, { isRead: false }));
    return res.json({ count });
  } catch (error) {
    return sendError(res, error, '获取未读数量错误:');
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const message = await Message.findOne(ownerFilter(
      req,
      { _id: req.params.id },
      { write: true }
    ));
    if (!message) return res.status(404).json({ message: '消息不存在' });

    await message.markAsRead();
    return res.json({ message: '标记成功', data: message });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ message: '消息不存在' });
    return sendError(res, error, '标记已读错误:');
  }
};

exports.markMultipleAsRead = async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 500) {
      return res.status(400).json({ message: '请提供1至500个消息ID' });
    }
    const result = await Message.updateMany(
      ownerFilter(
        req,
        { _id: { $in: messageIds }, isRead: false },
        { write: true }
      ),
      { $set: { isRead: true, readAt: new Date() } }
    );
    return res.json({ message: '批量标记成功', modifiedCount: result.modifiedCount });
  } catch (error) {
    return sendError(res, error, '批量标记已读错误:');
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const result = await Message.updateMany(
      ownerFilter(req, { isRead: false }, { write: true }),
      { $set: { isRead: true, readAt: new Date() } }
    );
    return res.json({ message: '全部标记为已读', modifiedCount: result.modifiedCount });
  } catch (error) {
    return sendError(res, error, '全部标记已读错误:');
  }
};

exports.deleteMessage = async (req, res) => {
  try {
    const result = await Message.deleteOne(ownerFilter(
      req,
      { _id: req.params.id },
      { write: true }
    ));
    if (result.deletedCount === 0) return res.status(404).json({ message: '消息不存在' });
    return res.json({ message: '删除成功' });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ message: '消息不存在' });
    return sendError(res, error, '删除消息错误:');
  }
};

exports.deleteMultipleMessages = async (req, res) => {
  try {
    const { messageIds } = req.body;
    if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 500) {
      return res.status(400).json({ message: '请提供1至500个消息ID' });
    }
    const result = await Message.deleteMany(ownerFilter(
      req,
      { _id: { $in: messageIds } },
      { write: true }
    ));
    return res.json({ message: '批量删除成功', deletedCount: result.deletedCount });
  } catch (error) {
    return sendError(res, error, '批量删除消息错误:');
  }
};

exports.clearReadMessages = async (req, res) => {
  try {
    const result = await Message.deleteMany(ownerFilter(
      req,
      { isRead: true },
      { write: true }
    ));
    return res.json({ message: '已清空所有已读消息', deletedCount: result.deletedCount });
  } catch (error) {
    return sendError(res, error, '清空已读消息错误:');
  }
};

exports.createMessage = async (messageData) => {
  if (!messageData || !messageData.teamId) {
    throw new TypeError('A trusted teamId is required to create a message');
  }
  return Message.create(messageData);
};

exports.createMultipleMessages = async (recipients, messageTemplate) => {
  if (!messageTemplate || !messageTemplate.teamId) {
    throw new TypeError('A trusted teamId is required to create messages');
  }
  const messages = recipients.map((recipient) => ({
    ...messageTemplate,
    recipient
  }));
  return messages.length === 0 ? [] : Message.insertMany(messages);
};

exports.ownerFilter = ownerFilter;
