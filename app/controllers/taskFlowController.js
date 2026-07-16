const Task = require('../models/Task');
const TaskReview = require('../models/TaskReview');
const {
  notifyTaskCompleted,
  notifyTaskReviewed,
  notifyTaskConfirmed
} = require('../utils/notificationHelper');

// 完成任务（执行人）- 支持多执行人
exports.completeTask = async (req, res) => {
  try {
    const { completionNote, attachments } = req.body;
    const task = await Task.findById(req.params.id)
      .populate('parentTask')
      .populate('executor', 'username realName')
      .populate('ccUsers', 'username realName')
      .populate('creator', 'username realName');
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有执行人可以完成任务
    const isExecutor = task.executor.some(e => e._id.toString() === req.user._id.toString());
    if (!isExecutor) {
      return res.status(403).json({ message: '只有执行人可以完成任务' });
    }
    
    // 检查任务状态
    if (task.status === 'finished') {
      return res.status(400).json({ message: '任务已完成' });
    }
    
    // 如果是主任务，检查所有子任务是否完成
    if (task.isMainTask) {
      const subTasks = await Task.find({ parentTask: task._id });
      const allSubTasksCompleted = subTasks.every(st => 
        st.status === 'finished' || st.status === 'pending_review' || st.status === 'pending_confirm'
      );
      
      if (subTasks.length > 0 && !allSubTasksCompleted) {
        return res.status(400).json({ message: '请先完成所有子任务' });
      }
    }
    
    // 处理完成附件
    const completionAttachments = [];
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(att => {
        if (att.path) {
          completionAttachments.push({
            path: att.path,
            originalName: att.originalName || 'unknown',
            mimetype: att.mimetype || 'application/octet-stream',
            size: att.size || 0
          });
        }
      });
    }
    
    // 初始化 executorCompletions（如果不存在）
    if (!task.executorCompletions || task.executorCompletions.length === 0) {
      task.executorCompletions = task.executor.map(executor => ({
        executor: executor._id,
        status: 'pending',
        content: null,
        attachments: [],
        completedAt: null
      }));
    }
    
    // 查找当前执行人的完成记录
    const executorCompletion = task.executorCompletions.find(
      ec => ec.executor.toString() === req.user._id.toString()
    );
    
    if (!executorCompletion) {
      return res.status(400).json({ message: '未找到当前执行人的完成记录' });
    }
    
    // 更新当前执行人的完成记录
    executorCompletion.status = 'completed';
    executorCompletion.content = completionNote;
    executorCompletion.attachments = completionAttachments;
    executorCompletion.completedAt = new Date();
    
    // 检查是否所有执行人都完成了
    const allExecutorsCompleted = task.executorCompletions.every(
      ec => ec.status === 'completed'
    );
    
    const completedCount = task.executorCompletions.filter(ec => ec.status === 'completed').length;
    const totalCount = task.executorCompletions.length;
    
    console.log(`📊 任务 ${task.taskName} 完成进度: ${completedCount}/${totalCount}`);
    
    // 更新任务状态
    if (allExecutorsCompleted) {
      // 所有执行人都完成了
      task.status = task.ccUsers && task.ccUsers.length > 0 ? 'pending_review' : 'pending_confirm';
      task.actualCompletionTime = new Date();
      
      // 兼容旧版字段
      task.completionNote = completionNote;
      task.completionAttachments = completionAttachments;
      task.completedBy = req.user._id;
      
      console.log(`✅ 所有执行人已完成，任务状态变更为: ${task.status}`);
    } else {
      // 还有执行人未完成，保持进行中状态
      task.status = 'in_progress';
      console.log(`⏳ 还有 ${totalCount - completedCount} 个执行人未完成，任务保持进行中状态`);
    }
    
    await task.save();
    
    // 如果是子任务，更新主任务的完成率
    if (!task.isMainTask && task.parentTask) {
      await updateMainTaskProgress(task.parentTask._id);
    }
    
    // 发送通知
    try {
      if (allExecutorsCompleted) {
        // 所有人都完成了
        if (task.ccUsers && task.ccUsers.length > 0) {
          // 有抄送人，通知抄送人审核
          const ccUserIds = task.ccUsers.map(cc => cc._id);
          await notifyTaskCompleted(task, ccUserIds, req.user._id);
          console.log(`📧 已通知 ${ccUserIds.length} 个抄送人审核任务`);
        } else {
          // 没有抄送人，直接通知管理员确认
          await notifyTaskReviewed(task, task.creator._id, req.user._id);
          console.log(`📧 已通知管理员确认任务`);
        }
      } else {
        // 还有人未完成，通知其他未完成的执行人
        const uncompletedExecutors = task.executorCompletions
          .filter(ec => ec.status === 'pending')
          .map(ec => ec.executor);
        
        if (uncompletedExecutors.length > 0) {
          const { notifyExecutorCompleted } = require('../utils/notificationHelper');
          await notifyExecutorCompleted(task, uncompletedExecutors, req.user._id, completedCount, totalCount);
          console.log(`📧 已通知 ${uncompletedExecutors.length} 个未完成的执行人`);
        }
      }
    } catch (notifyError) {
      console.error('发送任务完成通知失败:', notifyError);
    }
    
    res.json({
      message: allExecutorsCompleted ? '任务已标记为完成' : `已提交完成 (${completedCount}/${totalCount})`,
      task,
      completionStatus: {
        completed: completedCount,
        total: totalCount,
        allCompleted: allExecutorsCompleted
      }
    });
  } catch (error) {
    console.error('完成任务错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 抄送人审核任务
exports.reviewTask = async (req, res) => {
  try {
    console.log('=== reviewTask 收到请求 ===');
    console.log('req.body:', JSON.stringify(req.body, null, 2));
    
    const { content, result, rating, attachments } = req.body;
    
    console.log('提取的参数:');
    console.log('content:', content);
    console.log('result:', result);
    console.log('rating:', rating);
    console.log('attachments:', attachments);
    console.log('attachments 类型:', typeof attachments);
    console.log('attachments 是否为数组:', Array.isArray(attachments));
    if (Array.isArray(attachments)) {
      console.log('attachments 长度:', attachments.length);
    }
    
    if (!content) {
      return res.status(400).json({ message: '评价内容不能为空' });
    }
    
    const task = await Task.findById(req.params.id);
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有抄送人可以审核
    const isCCUser = task.ccUsers.some(cc => cc.toString() === req.user._id.toString());
    if (!isCCUser) {
      return res.status(403).json({ message: '只有抄送人可以审核任务' });
    }
    
    // 检查任务状态
    if (task.status !== 'pending_review' && task.status !== 'completed') {
      return res.status(400).json({ message: '任务未处于待审核状态' });
    }
    
    // 检查是否已经审核过
    const existingReview = await TaskReview.findOne({
      task: task._id,
      reviewer: req.user._id
    });
    
    if (existingReview) {
      return res.status(400).json({ message: '您已经审核过此任务' });
    }
    
    // 处理附件数据
    console.log('=== 开始处理附件 ===');
    const reviewAttachments = [];
    if (attachments && Array.isArray(attachments)) {
      console.log('attachments 是有效数组，长度:', attachments.length);
      attachments.forEach((att, index) => {
        console.log(`附件 ${index}:`, att);
        if (att.path) {
          const attachmentObj = {
            path: att.path,
            originalName: att.originalName || 'unknown',
            mimetype: att.mimetype || 'application/octet-stream',
            size: att.size || 0
          };
          console.log(`处理后的附件 ${index}:`, attachmentObj);
          reviewAttachments.push(attachmentObj);
        } else {
          console.log(`附件 ${index} 没有 path，跳过`);
        }
      });
    } else {
      console.log('attachments 不是有效数组');
    }
    console.log('最终的 reviewAttachments:', reviewAttachments);
    console.log('reviewAttachments 长度:', reviewAttachments.length);
    
    // 创建审核记录
    const review = new TaskReview({
      task: task._id,
      reviewer: req.user._id,
      content,
      result: result || 'approved',
      rating,
      attachments: reviewAttachments
    });
    
    await review.save();
    
    // 更新任务状态：任意一个抄送人审核后，进入待管理员确认状态
    task.status = 'pending_confirm';
    await task.save();
    
    await review.populate('reviewer', 'name username');
    await task.populate('creator');
    
    // 发送审核完成通知给管理员
    try {
      await notifyTaskReviewed(task, task.creator._id, req.user._id);
    } catch (notifyError) {
      console.error('发送审核通知失败:', notifyError);
    }
    
    res.json({
      message: '审核成功',
      review,
      task
    });
  } catch (error) {
    console.error('审核任务错误:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({ message: '您已经审核过此任务' });
    }
    
    res.status(500).json({ message: '服务器错误' });
  }
};

// 管理员确认任务完成
exports.confirmTask = async (req, res) => {
  try {
    const { content, rating, attachments } = req.body;

    const task = await Task.findById(req.params.id);
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有任务创建者（管理员）可以确认
    if (task.creator.toString() !== req.user._id.toString() && !req.user.roles.includes('admin')) {
      return res.status(403).json({ message: '只有任务创建者可以确认任务' });
    }
    
    // 检查任务状态
    if (task.status !== 'pending_confirm' && task.status !== 'completed' && task.status !== 'pending_review') {
      return res.status(400).json({ message: '任务未处于待确认状态' });
    }

    // 处理附件数据
    const confirmAttachments = [];
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(att => {
        if (att.path) {
          confirmAttachments.push({
            path: att.path,
            originalName: att.originalName || 'unknown',
            mimetype: att.mimetype || 'application/octet-stream',
            size: att.size || 0
          });
        }
      });
    }

    // 如果有评价内容，保存为审核记录
    if (content) {
      const review = new TaskReview({
        task: task._id,
        reviewer: req.user._id,
        content,
        result: 'approved',
        rating: rating || null,
        attachments: confirmAttachments
      });
      await review.save();
    }
    
    // 更新任务状态为已完结
    task.status = 'finished';
    if (!task.actualCompletionTime) {
      task.actualCompletionTime = new Date();
    }
    // 记录确认人
    task.confirmedBy = req.user._id;
    
    await task.save();
    await task.populate('executor');
    
    // 如果是子任务，更新主任务状态
    if (!task.isMainTask && task.parentTask) {
      await updateMainTaskProgress(task.parentTask);
      
      // 检查主任务的所有子任务是否都完成
      const parentTask = await Task.findById(task.parentTask);
      const subTasks = await Task.find({ parentTask: task.parentTask });
      const allFinished = subTasks.every(st => st.status === 'finished');
      
      if (allFinished && parentTask.status === 'pending_confirm') {
        // 主任务也可以标记为完结
        parentTask.status = 'finished';
        parentTask.actualCompletionTime = new Date();
        await parentTask.save();
      }
    }
    
    // 发送确认通知给所有执行人
    try {
      const executorIds = task.executor.map(e => e._id);
      await notifyTaskConfirmed(task, executorIds, req.user._id);
    } catch (notifyError) {
      console.error('发送确认通知失败:', notifyError);
    }
    
    res.json({
      message: '任务已确认完成',
      task
    });
  } catch (error) {
    console.error('确认任务错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取任务审核记录
exports.getTaskReviews = async (req, res) => {
  try {
    const reviews = await TaskReview.find({ task: req.params.id })
      .populate('reviewer', 'name username')
      .sort({ reviewTime: -1 });
    
    res.json({ reviews });
  } catch (error) {
    console.error('获取审核记录错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 修改执行人完成提交（执行人）
exports.updateCompletion = async (req, res) => {
  try {
    const { completionNote, attachments } = req.body;
    const task = await Task.findById(req.params.id)
      .populate('executor', 'username realName');
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有执行人可以修改
    const isExecutor = task.executor.some(e => e._id.toString() === req.user._id.toString());
    if (!isExecutor) {
      return res.status(403).json({ message: '只有执行人可以修改完成提交' });
    }
    
    // 检查任务状态：只有在所有人都未完成之前才能修改
    if (task.status === 'pending_review' || task.status === 'pending_confirm' || task.status === 'finished') {
      return res.status(400).json({ message: '任务已进入审核/确认阶段，无法修改提交' });
    }
    
    // 查找当前执行人的完成记录
    const executorCompletion = task.executorCompletions.find(
      ec => ec.executor.toString() === req.user._id.toString()
    );
    
    if (!executorCompletion) {
      return res.status(400).json({ message: '未找到当前执行人的完成记录' });
    }
    
    // 检查是否已提交
    if (executorCompletion.status !== 'completed') {
      return res.status(400).json({ message: '请先提交完成再进行修改' });
    }
    
    // 处理完成附件
    const completionAttachments = [];
    if (attachments && Array.isArray(attachments)) {
      attachments.forEach(att => {
        if (att.path) {
          completionAttachments.push({
            path: att.path,
            originalName: att.originalName || 'unknown',
            mimetype: att.mimetype || 'application/octet-stream',
            size: att.size || 0
          });
        }
      });
    }
    
    // 更新完成记录
    executorCompletion.content = completionNote;
    executorCompletion.attachments = completionAttachments;
    executorCompletion.completedAt = new Date(); // 更新修改时间
    
    await task.save();
    
    console.log(`✅ 执行人 ${req.user.username} 已修改任务 ${task.taskName} 的完成提交`);
    
    res.json({
      message: '已成功修改完成提交',
      task,
      executorCompletion
    });
  } catch (error) {
    console.error('修改完成提交错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 辅助函数：更新主任务进度
async function updateMainTaskProgress(mainTaskId) {
  try {
    const subTasks = await Task.find({ parentTask: mainTaskId });
    
    if (subTasks.length === 0) {
      return;
    }
    
    const finishedCount = subTasks.filter(st => st.status === 'finished').length;
    const completionRate = Math.round((finishedCount / subTasks.length) * 100);
    
    const mainTask = await Task.findById(mainTaskId);
    mainTask.completionRate = completionRate;
    
    // 更新主任务状态
    if (completionRate > 0 && completionRate < 100) {
      mainTask.status = 'partial_completed';
    } else if (completionRate === 100) {
      // 所有子任务完成，检查主任务本身是否也完成
      if (mainTask.actualCompletionTime) {
        mainTask.status = mainTask.ccUsers && mainTask.ccUsers.length > 0 ? 'pending_review' : 'pending_confirm';
      }
    }
    
    await mainTask.save();
  } catch (error) {
    console.error('更新主任务进度错误:', error);
  }
}

