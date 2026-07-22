const mongoose = require('mongoose');
const fileAttachmentSchema = require('./schemas/fileAttachmentSchema');

const TASK_REVIEW_STAGES = Object.freeze({
  REVIEW: 'review',
  CONFIRMATION: 'confirmation'
});

const TASK_REVIEW_STAGE_VALUES = Object.freeze(Object.values(TASK_REVIEW_STAGES));

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

  // 抄送审核与管理员最终确认是两个独立阶段，同一用户可以分别执行一次。
  stage: {
    type: String,
    enum: TASK_REVIEW_STAGE_VALUES,
    default: TASK_REVIEW_STAGES.REVIEW,
    required: true,
    immutable: true
  },

  reviewRound: {
    type: Number,
    default: 1,
    min: 1,
    required: true,
    immutable: true,
    validate: {
      validator: Number.isInteger,
      message: 'reviewRound must be an integer'
    }
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

// 同一用户在每个任务流程阶段只能提交一次。
taskReviewSchema.index(
  { teamId: 1, task: 1, reviewer: 1, stage: 1, reviewRound: 1 },
  { unique: true, name: 'uq_task_review_stage_round' }
);

const TaskReview = mongoose.model('TaskReview', taskReviewSchema);

module.exports = TaskReview;
module.exports.TASK_REVIEW_STAGES = TASK_REVIEW_STAGES;
module.exports.TASK_REVIEW_STAGE_VALUES = TASK_REVIEW_STAGE_VALUES;

