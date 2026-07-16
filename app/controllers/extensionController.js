const Task = require('../models/Task');
const ExtensionRequest = require('../models/ExtensionRequest');
const {
  notifyExtensionApplied,
  notifyExtensionApproved,
  notifyExtensionRejected
} = require('../utils/notificationHelper');

// 申请延期
exports.applyExtension = async (req, res) => {
  try {
    const { reason, requestedDays } = req.body;
    
    if (!reason || !requestedDays) {
      return res.status(400).json({ message: '申请原因和延期天数不能为空' });
    }
    
    if (requestedDays < 1) {
      return res.status(400).json({ message: '延期天数至少为1天' });
    }
    
    const task = await Task.findById(req.params.id).populate('parentTask');
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查
    let canApply = false;
    
    if (task.isMainTask) {
      // 主任务：只有主负责人可以申请
      if (task.mainExecutor && task.mainExecutor.toString() === req.user._id.toString()) {
        canApply = true;
      }
    } else {
      // 子任务：需要是团队主负责人
      if (task.parentTask) {
        const parentTask = await Task.findById(task.parentTask._id);
        if (parentTask.mainExecutor && parentTask.mainExecutor.toString() === req.user._id.toString()) {
          canApply = true;
        }
      }
    }
    
    if (!canApply) {
      return res.status(403).json({ message: '只有主负责人可以申请延期' });
    }
    
    // 检查任务状态：只有未完成的任务可以申请延期
    if (task.status === 'finished' || task.status === 'pending_confirm') {
      return res.status(400).json({ message: '任务已完成，无法申请延期' });
    }
    
    // 检查是否已申请过延期
    if (task.hasExtensionRequest) {
      return res.status(400).json({ message: '该任务已申请过延期，不能重复申请' });
    }
    
    // 注意：允许过期任务申请延期，以便通过正规流程延长期限
    
    // 创建延期申请
    const extensionRequest = new ExtensionRequest({
      task: task._id,
      applicant: req.user._id,
      requestType: task.isMainTask ? 'main_task' : 'sub_task',
      reason,
      requestedDays,
      originalCompletionTime: task.plannedCompletionTime,
      approver: task.creator  // 审批人为任务创建者
    });
    
    await extensionRequest.save();
    
    // 更新任务状态
    task.status = 'extension_pending';
    task.hasExtensionRequest = true;
    await task.save();
    
    await extensionRequest.populate([
      { path: 'applicant', select: 'name username' },
      { path: 'approver', select: 'name username' },
      { path: 'task', select: 'taskName' }
    ]);
    
    // 发送延期申请通知给管理员
    try {
      await task.populate('creator');
      await notifyExtensionApplied(task, extensionRequest, task.creator._id, req.user._id);
    } catch (notifyError) {
      console.error('发送延期申请通知失败:', notifyError);
    }
    
    res.status(201).json({
      message: '延期申请已提交',
      extensionRequest
    });
  } catch (error) {
    console.error('申请延期错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 审批延期申请
exports.approveExtension = async (req, res) => {
  try {
    const { status, approvedDays, approvalNote } = req.body;
    
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: '审批状态无效' });
    }
    
    if (status === 'approved' && !approvedDays) {
      return res.status(400).json({ message: '批准延期需要指定延期天数' });
    }
    
    const extensionRequest = await ExtensionRequest.findById(req.params.id)
      .populate('task');
    
    if (!extensionRequest) {
      return res.status(404).json({ message: '延期申请不存在' });
    }
    
    // 权限检查：只有任务创建者（管理员）可以审批
    const task = extensionRequest.task;
    if (task.creator.toString() !== req.user._id.toString() && !req.user.roles.includes('admin')) {
      return res.status(403).json({ message: '只有任务创建者可以审批延期申请' });
    }
    
    // 检查申请状态
    if (extensionRequest.status !== 'pending') {
      return res.status(400).json({ message: '该申请已处理' });
    }
    
    // 更新申请记录
    extensionRequest.status = status;
    extensionRequest.approvalTime = new Date();
    extensionRequest.approvalNote = approvalNote;
    
    if (status === 'approved') {
      // 批准：计算新的完成时间
      const originalTime = new Date(extensionRequest.originalCompletionTime);
      const newTime = new Date(originalTime.getTime() + approvedDays * 24 * 60 * 60 * 1000);
      
      extensionRequest.approvedDays = approvedDays;
      extensionRequest.newCompletionTime = newTime;
      
      // 更新任务
      task.plannedCompletionTime = newTime;
      task.extendedCompletionTime = newTime;
      task.status = 'in_progress';  // 恢复进行中状态
      
      // 如果是主任务延期，同时延期所有子任务
      if (task.isMainTask) {
        const subTasks = await Task.find({ parentTask: task._id });
        for (const subTask of subTasks) {
          const subOriginalTime = new Date(subTask.plannedCompletionTime);
          const subNewTime = new Date(subOriginalTime.getTime() + approvedDays * 24 * 60 * 60 * 1000);
          
          subTask.plannedCompletionTime = subNewTime;
          subTask.extendedCompletionTime = subNewTime;
          await subTask.save();
        }
      }
      
      await task.save();
    } else {
      // 拒绝：任务状态恢复
      task.status = 'in_progress';
      await task.save();
    }
    
    await extensionRequest.save();
    
    await extensionRequest.populate([
      { path: 'applicant', select: 'name username' },
      { path: 'approver', select: 'name username' }
    ]);
    
    // 发送审批结果通知给申请人
    try {
      if (status === 'approved') {
        await notifyExtensionApproved(task, extensionRequest, extensionRequest.applicant._id, req.user._id);
      } else {
        await notifyExtensionRejected(task, extensionRequest, extensionRequest.applicant._id, req.user._id);
      }
    } catch (notifyError) {
      console.error('发送审批通知失败:', notifyError);
    }
    
    res.json({
      message: status === 'approved' ? '延期申请已批准' : '延期申请已拒绝',
      extensionRequest
    });
  } catch (error) {
    console.error('审批延期错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取延期申请列表
exports.getExtensionRequests = async (req, res) => {
  try {
    const { status, taskId } = req.query;
    
    const query = {};
    
    if (status) {
      query.status = status;
    }
    
    if (taskId) {
      query.task = taskId;
    }
    
    // 权限过滤：管理员看所有，普通用户只看自己相关的
    if (!req.user.roles.includes('admin')) {
      query.$or = [
        { applicant: req.user._id },
        { approver: req.user._id }
      ];
    }
    
    const requests = await ExtensionRequest.find(query)
      .populate('task', 'taskName status')
      .populate('applicant', 'name username')
      .populate('approver', 'name username')
      .sort({ applyTime: -1 });
    
    res.json({ requests });
  } catch (error) {
    console.error('获取延期申请列表错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取延期申请详情
exports.getExtensionRequestById = async (req, res) => {
  try {
    const request = await ExtensionRequest.findById(req.params.id)
      .populate('task')
      .populate('applicant', 'name username phone')
      .populate('approver', 'name username phone');
    
    if (!request) {
      return res.status(404).json({ message: '延期申请不存在' });
    }
    
    res.json({ request });
  } catch (error) {
    console.error('获取延期申请详情错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取任务的延期历史
exports.getTaskExtensionHistory = async (req, res) => {
  try {
    const history = await ExtensionRequest.find({ task: req.params.taskId })
      .populate('applicant', 'name username')
      .populate('approver', 'name username')
      .sort({ applyTime: -1 });
    
    res.json({ history });
  } catch (error) {
    console.error('获取延期历史错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};


