const Message = require('../models/Message');

/**
 * 消息通知工具函数
 * 用于在各个业务流程中发送消息通知
 */

/**
 * 任务分配通知
 * @param {Object} task - 任务对象
 * @param {Array} recipients - 接收人ID数组
 * @param {String} sender - 发送人ID
 */
async function notifyTaskAssigned(task, recipients, sender) {
  try {
    const messages = recipients.map(recipientId => ({
      type: 'task_assigned',
      title: '新任务分配',
      content: `您有新的任务「${task.taskName}」待处理，计划完成时间：${formatDate(task.plannedCompletionTime)}`,
      recipient: recipientId,
      sender: sender,
      relatedTask: task._id
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送任务分配通知给 ${recipients.length} 人`);
  } catch (error) {
    console.error('发送任务分配通知失败:', error);
  }
}

/**
 * 任务更新通知
 * @param {Object} task - 任务对象
 * @param {Array} recipients - 接收人ID数组
 * @param {String} sender - 发送人ID
 * @param {String} updateInfo - 更新信息
 */
async function notifyTaskUpdated(task, recipients, sender, updateInfo = '任务信息已更新') {
  try {
    const messages = recipients.map(recipientId => ({
      type: 'task_updated',
      title: '任务更新',
      content: `任务「${task.taskName}」${updateInfo}`,
      recipient: recipientId,
      sender: sender,
      relatedTask: task._id
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送任务更新通知给 ${recipients.length} 人`);
  } catch (error) {
    console.error('发送任务更新通知失败:', error);
  }
}

/**
 * 任务删除通知
 * @param {String} taskName - 任务名称
 * @param {Array} recipients - 接收人ID数组
 * @param {String} sender - 发送人ID
 */
async function notifyTaskDeleted(taskName, recipients, sender) {
  try {
    const messages = recipients.map(recipientId => ({
      type: 'task_deleted',
      title: '任务删除',
      content: `任务「${taskName}」已被删除`,
      recipient: recipientId,
      sender: sender
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送任务删除通知给 ${recipients.length} 人`);
  } catch (error) {
    console.error('发送任务删除通知失败:', error);
  }
}

/**
 * 任务完成通知（通知抄送人审核）
 * @param {Object} task - 任务对象
 * @param {Array} ccUsers - 抄送人ID数组
 * @param {String} executor - 执行人ID
 */
async function notifyTaskCompleted(task, ccUsers, executor) {
  try {
    const messages = ccUsers.map(recipientId => ({
      type: 'task_completed',
      title: '任务待审核',
      content: `任务「${task.taskName}」已完成，请您审核`,
      recipient: recipientId,
      sender: executor,
      relatedTask: task._id
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送任务完成通知给 ${ccUsers.length} 位抄送人`);
  } catch (error) {
    console.error('发送任务完成通知失败:', error);
  }
}

/**
 * 执行人提交完成通知（通知其他未完成的执行人）
 * @param {Object} task - 任务对象
 * @param {Array} uncompletedExecutors - 未完成的执行人ID数组
 * @param {String} completedExecutor - 已完成的执行人ID
 * @param {Number} completedCount - 已完成人数
 * @param {Number} totalCount - 总人数
 */
async function notifyExecutorCompleted(task, uncompletedExecutors, completedExecutor, completedCount, totalCount) {
  try {
    const messages = uncompletedExecutors.map(recipientId => ({
      type: 'executor_completed',
      title: '任务进度提醒',
      content: `任务「${task.taskName}」已有 ${completedCount}/${totalCount} 人完成提交，请尽快完成您的任务`,
      recipient: recipientId,
      sender: completedExecutor,
      relatedTask: task._id
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送执行人完成通知给 ${uncompletedExecutors.length} 位未完成的执行人`);
  } catch (error) {
    console.error('发送执行人完成通知失败:', error);
  }
}

/**
 * 任务审核完成通知（通知管理员确认）
 * @param {Object} task - 任务对象
 * @param {String} creator - 创建人ID（管理员）
 * @param {String} reviewer - 审核人ID
 */
async function notifyTaskReviewed(task, creator, reviewer) {
  try {
    const message = new Message({
      type: 'task_reviewed',
      title: '任务待确认',
      content: `任务「${task.taskName}」已通过审核，请您确认完成`,
      recipient: creator,
      sender: reviewer,
      relatedTask: task._id
    });

    await message.save();
    console.log(`✅ 已发送任务审核通知给管理员`);
  } catch (error) {
    console.error('发送任务审核通知失败:', error);
  }
}

/**
 * 任务确认完成通知（通知执行人）
 * @param {Object} task - 任务对象
 * @param {Array} executors - 执行人ID数组
 * @param {String} admin - 管理员ID
 */
async function notifyTaskConfirmed(task, executors, admin) {
  try {
    const messages = executors.map(recipientId => ({
      type: 'task_confirmed',
      title: '任务已完结',
      content: `恭喜！任务「${task.taskName}」已确认完成`,
      recipient: recipientId,
      sender: admin,
      relatedTask: task._id
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送任务确认通知给 ${executors.length} 位执行人`);
  } catch (error) {
    console.error('发送任务确认通知失败:', error);
  }
}

/**
 * 延期申请通知（通知管理员）
 * @param {Object} task - 任务对象
 * @param {Object} extensionRequest - 延期申请对象
 * @param {String} admin - 管理员ID
 * @param {String} applicant - 申请人ID
 */
async function notifyExtensionApplied(task, extensionRequest, admin, applicant) {
  try {
    const message = new Message({
      type: 'extension_applied',
      title: '延期申请待审批',
      content: `任务「${task.taskName}」有延期申请，请求延期 ${extensionRequest.requestedDays} 天`,
      recipient: admin,
      sender: applicant,
      relatedTask: task._id,
      relatedExtension: extensionRequest._id,
      extraData: {
        reason: extensionRequest.reason,
        requestedDays: extensionRequest.requestedDays
      }
    });

    await message.save();
    console.log(`✅ 已发送延期申请通知给管理员`);
  } catch (error) {
    console.error('发送延期申请通知失败:', error);
  }
}

/**
 * 延期审批通过通知（通知申请人）
 * @param {Object} task - 任务对象
 * @param {Object} extensionRequest - 延期申请对象
 * @param {String} applicant - 申请人ID
 * @param {String} admin - 管理员ID
 */
async function notifyExtensionApproved(task, extensionRequest, applicant, admin) {
  try {
    const message = new Message({
      type: 'extension_approved',
      title: '延期申请已批准',
      content: `您的延期申请已批准，任务「${task.taskName}」延期 ${extensionRequest.approvedDays} 天，新的完成时间：${formatDate(extensionRequest.newCompletionTime)}`,
      recipient: applicant,
      sender: admin,
      relatedTask: task._id,
      relatedExtension: extensionRequest._id,
      extraData: {
        approvedDays: extensionRequest.approvedDays,
        newCompletionTime: extensionRequest.newCompletionTime
      }
    });

    await message.save();
    console.log(`✅ 已发送延期批准通知给申请人`);
  } catch (error) {
    console.error('发送延期批准通知失败:', error);
  }
}

/**
 * 延期审批拒绝通知（通知申请人）
 * @param {Object} task - 任务对象
 * @param {Object} extensionRequest - 延期申请对象
 * @param {String} applicant - 申请人ID
 * @param {String} admin - 管理员ID
 */
async function notifyExtensionRejected(task, extensionRequest, applicant, admin) {
  try {
    const message = new Message({
      type: 'extension_rejected',
      title: '延期申请已拒绝',
      content: `您的延期申请已被拒绝，任务「${task.taskName}」保持原计划时间`,
      recipient: applicant,
      sender: admin,
      relatedTask: task._id,
      relatedExtension: extensionRequest._id,
      extraData: {
        approvalNote: extensionRequest.approvalNote
      }
    });

    await message.save();
    console.log(`✅ 已发送延期拒绝通知给申请人`);
  } catch (error) {
    console.error('发送延期拒绝通知失败:', error);
  }
}

/**
 * 系统通知（通用）
 * @param {String} title - 通知标题
 * @param {String} content - 通知内容
 * @param {Array|String} recipients - 接收人ID或ID数组
 */
async function sendSystemNotification(title, content, recipients) {
  try {
    // 如果是单个接收人，转为数组
    const recipientArray = Array.isArray(recipients) ? recipients : [recipients];

    const messages = recipientArray.map(recipientId => ({
      type: 'system',
      title: title,
      content: content,
      recipient: recipientId
    }));

    await Message.insertMany(messages);
    console.log(`✅ 已发送系统通知给 ${recipientArray.length} 人`);
  } catch (error) {
    console.error('发送系统通知失败:', error);
  }
}

/**
 * 辅助函数：格式化日期
 */
function formatDate(date) {
  if (!date) return '未设置';
  const d = new Date(date);
  return d.toLocaleDateString('zh-CN', { 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
  });
}

module.exports = {
  notifyTaskAssigned,
  notifyTaskUpdated,
  notifyTaskDeleted,
  notifyTaskCompleted,
  notifyExecutorCompleted,
  notifyTaskReviewed,
  notifyTaskConfirmed,
  notifyExtensionApplied,
  notifyExtensionApproved,
  notifyExtensionRejected,
  sendSystemNotification
};

