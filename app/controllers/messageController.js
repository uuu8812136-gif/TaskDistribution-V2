const Message = require('../models/Message');
const User = require('../models/User');

/**
 * 获取消息列表
 * 支持分页、筛选（已读/未读）
 */
exports.getMessages = async (req, res) => {
  try {
    const { page = 1, limit = 20, isRead, type } = req.query;
    const userId = req.user._id;

    // 构建查询条件
    const query = { recipient: userId };
    
    if (isRead !== undefined) {
      query.isRead = isRead === 'true';
    }
    
    if (type) {
      query.type = type;
    }

    // 计算分页
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // 查询消息
    const messages = await Message.find(query)
      .populate('sender', 'name username')
      .populate('relatedTask', 'taskName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // 获取总数
    const total = await Message.countDocuments(query);

    res.json({
      messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('获取消息列表错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 获取单个消息详情
 */
exports.getMessageById = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id)
      .populate('sender', 'name username')
      .populate('recipient', 'name username')
      .populate('relatedTask', 'taskName status')
      .populate('relatedExtension');

    if (!message) {
      return res.status(404).json({ message: '消息不存在' });
    }

    // 权限检查：只能查看自己的消息
    if (message.recipient._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: '无权查看此消息' });
    }

    // 自动标记为已读
    if (!message.isRead) {
      await message.markAsRead();
    }

    res.json({ message });
  } catch (error) {
    console.error('获取消息详情错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 获取未读消息数量
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Message.getUnreadCount(req.user._id);
    res.json({ count });
  } catch (error) {
    console.error('获取未读数量错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 标记单条消息为已读
 */
exports.markAsRead = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: '消息不存在' });
    }

    // 权限检查
    if (message.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: '无权操作此消息' });
    }

    await message.markAsRead();

    res.json({ 
      message: '标记成功',
      data: message
    });
  } catch (error) {
    console.error('标记已读错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 批量标记消息为已读
 */
exports.markMultipleAsRead = async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ message: '请提供消息ID数组' });
    }

    const result = await Message.markMultipleAsRead(messageIds, req.user._id);

    res.json({ 
      message: '批量标记成功',
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('批量标记已读错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 全部标记为已读
 */
exports.markAllAsRead = async (req, res) => {
  try {
    const result = await Message.updateMany(
      { recipient: req.user._id, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );

    res.json({ 
      message: '全部标记为已读',
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('全部标记已读错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 删除单条消息
 */
exports.deleteMessage = async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ message: '消息不存在' });
    }

    // 权限检查
    if (message.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: '无权删除此消息' });
    }

    await message.deleteOne();

    res.json({ message: '删除成功' });
  } catch (error) {
    console.error('删除消息错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 批量删除消息
 */
exports.deleteMultipleMessages = async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ message: '请提供消息ID数组' });
    }

    const result = await Message.deleteMany({
      _id: { $in: messageIds },
      recipient: req.user._id
    });

    res.json({ 
      message: '批量删除成功',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('批量删除消息错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 清空所有已读消息
 */
exports.clearReadMessages = async (req, res) => {
  try {
    const result = await Message.deleteMany({
      recipient: req.user._id,
      isRead: true
    });

    res.json({ 
      message: '已清空所有已读消息',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('清空已读消息错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

/**
 * 创建消息（内部使用，不暴露为路由）
 * 此方法供其他controller调用
 */
exports.createMessage = async (messageData) => {
  try {
    const message = new Message(messageData);
    await message.save();
    return message;
  } catch (error) {
    console.error('创建消息错误:', error);
    throw error;
  }
};

/**
 * 批量创建消息（内部使用）
 * 用于一次性给多个用户发送消息
 */
exports.createMultipleMessages = async (recipients, messageTemplate) => {
  try {
    const messages = recipients.map(recipientId => ({
      ...messageTemplate,
      recipient: recipientId
    }));

    const result = await Message.insertMany(messages);
    return result;
  } catch (error) {
    console.error('批量创建消息错误:', error);
    throw error;
  }
};

