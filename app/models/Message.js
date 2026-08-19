const mongoose = require('mongoose');

function requireTeamId(teamId) {
  if (!teamId || !mongoose.isValidObjectId(teamId)) {
    throw new TypeError('A trusted teamId is required for message operations');
  }
  return teamId;
}

const wechatDeliverySchema = new mongoose.Schema({
  status: {
    type: String,
    enum: [
      'PENDING',
      'PROCESSING',
      'RETRY',
      'SENT',
      'SKIPPED_UNBOUND',
      'SKIPPED_UNSUBSCRIBED',
      'FAILED'
    ],
    default: 'PENDING',
    required: true
  },
  attempts: {
    type: Number,
    default: 0,
    min: 0,
    required: true
  },
  nextAttemptAt: Date,
  leaseUntil: Date,
  leaseToken: {
    type: String,
    trim: true,
    maxlength: 64
  },
  sentAt: Date,
  lastErrorCode: {
    type: String,
    trim: true,
    maxlength: 100
  }
}, { _id: false });

/**
 * 消息模型
 * 用于系统内消息通知
 */
const messageSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  // 消息类型
  type: {
    type: String,
    required: true,
    enum: [
      'task_assigned',        // 任务分配
      'task_updated',         // 任务更新
      'task_completed',       // 任务完成（通知抄送人审核）
      'task_reviewed',        // 任务已审核（通知管理员确认）
      'task_confirmed',       // 任务已确认（通知执行人）
      'task_deleted',         // 任务删除
      'executor_completed',   // 执行人完成（通知其他执行人）
      'extension_applied',    // 延期申请（通知管理员）
      'extension_approved',   // 延期审批通过（通知申请人）
      'extension_rejected',   // 延期审批拒绝（通知申请人）
      'attendance_missing',   // 出勤日报缺报提醒
      'attendance_reviewed',  // 出勤日报审核完成
      'equipment_status',     // 设备状态申请与审批
      'system'                // 系统通知
    ]
  },

  // 消息标题
  title: {
    type: String,
    required: true,
    maxlength: 200
  },

  // 消息内容
  content: {
    type: String,
    required: true,
    maxlength: 1000
  },

  // 接收人
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // 发送人（可选，系统消息可能没有发送人）
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // 相关任务（可选）
  relatedTask: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task'
  },

  // 相关延期申请（可选）
  relatedExtension: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExtensionRequest'
  },

  // 是否已读
  isRead: {
    type: Boolean,
    default: false
  },

  // 读取时间
  readAt: {
    type: Date
  },

  // 额外数据（JSON格式存储其他信息）
  extraData: {
    type: mongoose.Schema.Types.Mixed
  },

  // 业务通知可使用稳定键实现重试去重；普通消息保持为空。
  deduplicationKey: {
    type: String,
    trim: true,
    maxlength: 300,
    default: null
  },

  // Internal delivery outbox. It is never selected by user-facing message APIs.
  wechatDelivery: {
    type: wechatDeliverySchema,
    default: () => ({ status: 'PENDING', attempts: 0 }),
    select: false
  }
}, {
  timestamps: true  // 自动添加 createdAt 和 updatedAt
});

// 索引优化
messageSchema.index({ teamId: 1, recipient: 1, isRead: 1 });
messageSchema.index({ teamId: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ teamId: 1, type: 1, recipient: 1 });
messageSchema.index(
  { teamId: 1, recipient: 1, deduplicationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { deduplicationKey: { $type: 'string' } },
    name: 'uq_message_team_recipient_deduplication'
  }
);
messageSchema.index(
  { teamId: 1, 'wechatDelivery.status': 1, 'wechatDelivery.nextAttemptAt': 1, createdAt: 1 },
  { name: 'ix_message_wechat_delivery' }
);

// 虚拟字段：格式化创建时间
messageSchema.virtual('createdAtFormatted').get(function() {
  return this.createdAt.toLocaleString('zh-CN');
});

// 实例方法：标记为已读
messageSchema.methods.markAsRead = async function() {
  if (!this.isRead) {
    this.isRead = true;
    this.readAt = new Date();
    await this.save();
  }
  return this;
};

// 静态方法：批量标记已读
messageSchema.statics.markMultipleAsRead = async function(messageIds, userId, teamId) {
  return await this.updateMany(
    {
      teamId: requireTeamId(teamId),
      _id: { $in: messageIds },
      recipient: userId,
      isRead: false
    },
    { $set: { isRead: true, readAt: new Date() } }
  );
};

// 静态方法：获取用户未读消息数量
messageSchema.statics.getUnreadCount = async function(userId, teamId) {
  return await this.countDocuments({
    teamId: requireTeamId(teamId),
    recipient: userId,
    isRead: false
  });
};

// 静态方法：删除用户的所有消息
messageSchema.statics.deleteUserMessages = async function(userId, teamId) {
  return await this.deleteMany({
    teamId: requireTeamId(teamId),
    recipient: userId
  });
};

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;

