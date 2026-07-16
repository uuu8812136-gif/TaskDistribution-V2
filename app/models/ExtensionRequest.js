const mongoose = require('mongoose');

const extensionRequestSchema = new mongoose.Schema({
  // 关联任务
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  
  // 申请人
  applicant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // 申请类型
  requestType: {
    type: String,
    enum: ['main_task', 'sub_task'],  // main_task-主任务延期, sub_task-子任务延期
    required: true
  },
  
  // 申请原因
  reason: {
    type: String,
    required: [true, '申请原因不能为空'],
    trim: true
  },
  
  // 申请时间
  applyTime: {
    type: Date,
    default: Date.now
  },
  
  // 原计划完成时间
  originalCompletionTime: {
    type: Date,
    required: true
  },
  
  // 请求延期天数（用户选择的）
  requestedDays: {
    type: Number,
    min: 1
  },
  
  // 审批人（任务创建者/管理员）
  approver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // 审批状态
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  
  // 审批时间
  approvalTime: {
    type: Date
  },
  
  // 实际批准的延期天数
  approvedDays: {
    type: Number,
    min: 1
  },
  
  // 新的完成时间（审批通过后）
  newCompletionTime: {
    type: Date
  },
  
  // 审批备注
  approvalNote: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// 索引
extensionRequestSchema.index({ task: 1 });
extensionRequestSchema.index({ applicant: 1 });
extensionRequestSchema.index({ approver: 1, status: 1 });
extensionRequestSchema.index({ applyTime: -1 });

module.exports = mongoose.model('ExtensionRequest', extensionRequestSchema);

