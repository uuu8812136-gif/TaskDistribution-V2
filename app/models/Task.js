const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  // 任务基本信息
  taskName: {
    type: String,
    required: [true, '任务名称不能为空'],
    trim: true
  },
  taskType: {
    type: String,
    trim: true,
    default: '常规任务'
  },
  taskSource: {
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  
  // 任务层级关系
  parentTask: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },
  isMainTask: {
    type: Boolean,
    default: true  // true-主任务, false-子任务
  },
  
  // 任务创建者（管理员）
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // 任务执行人
  // 单人任务：executor数组只有1个人
  // 团队任务：executor数组有多人，通过子任务分配
  executor: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  
  // 主负责人（团队任务必填）
  mainExecutor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // 抄送人（可多人）
  ccUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  
  // 时间信息
  startTime: {
    type: Date,
    default: Date.now
  },
  plannedCompletionTime: {
    type: Date,
    required: [true, '计划完成时间不能为空']
  },
  actualCompletionTime: {
    type: Date
  },
  
  // 延期信息
  hasExtensionRequest: {
    type: Boolean,
    default: false  // 是否已申请过延期（只能申请一次）
  },
  extendedCompletionTime: {
    type: Date  // 延期后的完成时间
  },
  
  // 任务状态
  // pending-待开始, in_progress-进行中, partial_completed-部分完成,
  // extension_pending-待延期审批, extension_approved-延期通过,
  // completed-已完成（执行人）, pending_review-待审核（抄送人）,
  // pending_confirm-待确认（管理员）, finished-已完结
  status: {
    type: String,
    enum: [
      'pending', 
      'in_progress', 
      'partial_completed',
      'extension_pending',
      'extension_approved',
      'completed',
      'pending_review',
      'pending_confirm',
      'finished'
    ],
    default: 'in_progress'
  },
  
  // 附件和图片
  attachments: [{
    filename: String,
    originalName: String,
    path: String,
    mimetype: String,
    size: Number,
    uploadTime: {
      type: Date,
      default: Date.now
    }
  }],
  
  // 标签
  tags: [{
    type: String,
    trim: true
  }],
  
  // 优先级
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  
  // 完成情况（仅主任务）
  completionRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  
  // 完成说明和附件（旧版，保留兼容性）
  completionNote: {
    type: String
  },
  completionAttachments: [{
    filename: String,
    originalName: String,
    path: String,
    mimetype: String,
    size: Number,
    uploadTime: {
      type: Date,
      default: Date.now
    }
  }],
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // 确认人（管理员确认任务完成）
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // 多执行人完成情况跟踪（新版）
  executorCompletions: [{
    executor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'completed'],
      default: 'pending'
    },
    content: {
      type: String,
      trim: true
    },
    attachments: [{
      filename: String,
      originalName: String,
      path: String,
      mimetype: String,
      size: Number,
      uploadTime: {
        type: Date,
        default: Date.now
      }
    }],
    completedAt: {
      type: Date
    }
  }],
  
  // 备注
  remarks: {
    type: String
  }
}, {
  timestamps: true
});

// 索引
taskSchema.index({ creator: 1, status: 1 });
taskSchema.index({ executor: 1, status: 1 });
taskSchema.index({ ccUsers: 1 });
taskSchema.index({ parentTask: 1 });
taskSchema.index({ plannedCompletionTime: 1 });

// 虚拟字段：获取子任务
taskSchema.virtual('subTasks', {
  ref: 'Task',
  localField: '_id',
  foreignField: 'parentTask'
});

// 启用虚拟字段
taskSchema.set('toJSON', { virtuals: true });
taskSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Task', taskSchema);

