const mongoose = require('mongoose');
const fileAttachmentSchema = require('./schemas/fileAttachmentSchema');

const taskReviewSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  // 关联任务
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  
  // 评价人（抄送人）
  reviewer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // 评价内容
  content: {
    type: String,
    required: [true, '评价内容不能为空'],
    trim: true
  },
  
  // 评价结果
  result: {
    type: String,
    enum: ['approved', 'rejected', 'pending'],  // approved-通过, rejected-不通过, pending-待处理
    default: 'approved'
  },
  
  // 评分（可选）
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  
  // 评价时间
  reviewTime: {
    type: Date,
    default: Date.now
  },
  
  // 附件
  attachments: [fileAttachmentSchema]
}, {
  timestamps: true
});

// 索引
taskReviewSchema.index({ teamId: 1, task: 1 });
taskReviewSchema.index({ teamId: 1, reviewer: 1 });
taskReviewSchema.index({ teamId: 1, reviewTime: -1 });

// 一个任务的同一个抄送人只能评价一次
taskReviewSchema.index({ teamId: 1, task: 1, reviewer: 1 }, { unique: true });

module.exports = mongoose.model('TaskReview', taskReviewSchema);

