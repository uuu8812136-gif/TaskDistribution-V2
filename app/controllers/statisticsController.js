const XLSX = require('xlsx');
const Task = require('../models/Task');
const User = require('../models/User');
const TaskReview = require('../models/TaskReview');
const ExtensionRequest = require('../models/ExtensionRequest');

// 导出任务统计到Excel
exports.exportTasksToExcel = async (req, res) => {
  try {
    const { startDate, endDate, status, executor } = req.query;
    
    // 构建查询条件
    const query = { isMainTask: true };
    
    if (status) {
      query.status = status;
    }
    
    if (executor) {
      query.executor = executor;
    }
    
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }
    
    // 查询任务
    const tasks = await Task.find(query)
      .populate('creator', 'name username')
      .populate('executor', 'name username')
      .populate('mainExecutor', 'name username')
      .populate('ccUsers', 'name username')
      .sort({ createdAt: -1 });
    
    // 准备Excel数据
    const excelData = [];
    
    for (const task of tasks) {
      // 获取子任务
      const subTasks = await Task.find({ parentTask: task._id })
        .populate('executor', 'name username');
      
      // 获取审核记录
      const reviews = await TaskReview.find({ task: task._id })
        .populate('reviewer', 'name username');
      
      // 获取延期记录
      const extensions = await ExtensionRequest.find({ task: task._id })
        .sort({ applyTime: -1 })
        .limit(1);
      
      const row = {
        '任务名称': task.taskName,
        '任务类型': task.taskType || '',
        '任务来源': task.taskSource || '',
        '创建人': task.creator ? task.creator.name : '',
        '执行人': task.executor.map(e => e.name).join(', '),
        '主负责人': task.mainExecutor ? task.mainExecutor.name : '',
        '抄送人': task.ccUsers.map(cc => cc.name).join(', '),
        '开始时间': formatDate(task.startTime),
        '计划完成时间': formatDate(task.plannedCompletionTime),
        '实际完成时间': task.actualCompletionTime ? formatDate(task.actualCompletionTime) : '',
        '任务状态': getStatusText(task.status),
        '完成率': task.completionRate + '%',
        '优先级': getPriorityText(task.priority),
        '子任务数': subTasks.length,
        '已完成子任务': subTasks.filter(st => st.status === 'finished').length,
        '是否延期': task.hasExtensionRequest ? '是' : '否',
        '延期天数': extensions.length > 0 && extensions[0].approvedDays ? extensions[0].approvedDays : '',
        '审核人': reviews.map(r => r.reviewer.name).join(', '),
        '审核评价': reviews.map(r => r.content).join('; '),
        '创建时间': formatDate(task.createdAt),
        '备注': task.remarks || ''
      };
      
      excelData.push(row);
    }
    
    // 创建工作簿
    const wb = XLSX.utils.book_new();
    
    // 创建工作表
    const ws = XLSX.utils.json_to_sheet(excelData);
    
    // 设置列宽
    const colWidths = [
      { wch: 20 },  // 任务名称
      { wch: 12 },  // 任务类型
      { wch: 12 },  // 任务来源
      { wch: 10 },  // 创建人
      { wch: 15 },  // 执行人
      { wch: 10 },  // 主负责人
      { wch: 15 },  // 抄送人
      { wch: 18 },  // 开始时间
      { wch: 18 },  // 计划完成时间
      { wch: 18 },  // 实际完成时间
      { wch: 12 },  // 任务状态
      { wch: 10 },  // 完成率
      { wch: 10 },  // 优先级
      { wch: 10 },  // 子任务数
      { wch: 12 },  // 已完成子任务
      { wch: 10 },  // 是否延期
      { wch: 10 },  // 延期天数
      { wch: 15 },  // 审核人
      { wch: 30 },  // 审核评价
      { wch: 18 },  // 创建时间
      { wch: 20 }   // 备注
    ];
    ws['!cols'] = colWidths;
    
    // 添加工作表到工作簿
    XLSX.utils.book_append_sheet(wb, ws, '任务统计');
    
    // 生成Excel文件
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // 设置响应头
    const filename = `任务统计_${new Date().getTime()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    
    res.send(buffer);
  } catch (error) {
    console.error('导出Excel错误:', error);
    res.status(500).json({ message: '导出失败' });
  }
};

// 导出用户任务统计
exports.exportUserStatistics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // 查询条件
    const dateQuery = {};
    if (startDate || endDate) {
      dateQuery.createdAt = {};
      if (startDate) {
        dateQuery.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        dateQuery.createdAt.$lte = new Date(endDate);
      }
    }
    
    // 获取所有用户
    const users = await User.find({ status: 'active' }).select('name username department');
    
    const statisticsData = [];
    
    for (const user of users) {
      // 执行的任务
      const executedTasks = await Task.find({
        ...dateQuery,
        executor: user._id
      });
      
      // 抄送的任务
      const ccTasks = await Task.find({
        ...dateQuery,
        ccUsers: user._id
      });
      
      // 创建的任务
      const createdTasks = await Task.find({
        ...dateQuery,
        creator: user._id
      });
      
      // 完成的任务
      const finishedTasks = executedTasks.filter(t => t.status === 'finished');
      
      // 延期的任务
      const delayedTasks = await Task.find({
        ...dateQuery,
        executor: user._id,
        hasExtensionRequest: true
      });
      
      // 审核的任务
      const reviewedTasks = await TaskReview.find({
        reviewer: user._id
      }).populate('task');
      
      const row = {
        '姓名': user.name,
        '用户名': user.username,
        '部门': user.department || '',
        '执行任务数': executedTasks.length,
        '已完成任务数': finishedTasks.length,
        '完成率': executedTasks.length > 0 ? 
          `${Math.round(finishedTasks.length / executedTasks.length * 100)}%` : '0%',
        '延期任务数': delayedTasks.length,
        '抄送任务数': ccTasks.length,
        '已审核任务数': reviewedTasks.length,
        '创建任务数': createdTasks.length
      };
      
      statisticsData.push(row);
    }
    
    // 创建工作簿
    const wb = XLSX.utils.book_new();
    
    // 创建工作表
    const ws = XLSX.utils.json_to_sheet(statisticsData);
    
    // 设置列宽
    const colWidths = [
      { wch: 10 },  // 姓名
      { wch: 15 },  // 用户名
      { wch: 12 },  // 部门
      { wch: 12 },  // 执行任务数
      { wch: 14 },  // 已完成任务数
      { wch: 10 },  // 完成率
      { wch: 12 },  // 延期任务数
      { wch: 12 },  // 抄送任务数
      { wch: 14 },  // 已审核任务数
      { wch: 12 }   // 创建任务数
    ];
    ws['!cols'] = colWidths;
    
    // 添加工作表到工作簿
    XLSX.utils.book_append_sheet(wb, ws, '人员统计');
    
    // 生成Excel文件
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // 设置响应头
    const filename = `人员统计_${new Date().getTime()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    
    res.send(buffer);
  } catch (error) {
    console.error('导出用户统计错误:', error);
    res.status(500).json({ message: '导出失败' });
  }
};

// 获取统计概览
exports.getStatisticsOverview = async (req, res) => {
  try {
    // 总任务数
    const totalTasks = await Task.countDocuments({ isMainTask: true });
    
    // 进行中的任务
    const inProgressTasks = await Task.countDocuments({ 
      isMainTask: true,
      status: { $in: ['in_progress', 'partial_completed'] }
    });
    
    // 已完成的任务
    const finishedTasks = await Task.countDocuments({ 
      isMainTask: true,
      status: 'finished'
    });
    
    // 延期的任务
    const delayedTasks = await Task.countDocuments({ 
      isMainTask: true,
      hasExtensionRequest: true
    });
    
    // 待审核的任务
    const pendingReviewTasks = await Task.countDocuments({ 
      status: 'pending_review'
    });
    
    // 待确认的任务
    const pendingConfirmTasks = await Task.countDocuments({ 
      status: 'pending_confirm'
    });
    
    // 待审批延期的申请
    const pendingExtensions = await ExtensionRequest.countDocuments({ 
      status: 'pending'
    });
    
    // 总用户数
    const totalUsers = await User.countDocuments({ status: 'active' });
    
    // 优先级统计
    const lowPriorityTasks = await Task.countDocuments({ 
      isMainTask: true,
      priority: 'low'
    });
    const normalPriorityTasks = await Task.countDocuments({ 
      isMainTask: true,
      priority: 'normal'
    });
    const highPriorityTasks = await Task.countDocuments({ 
      isMainTask: true,
      priority: 'high'
    });
    const urgentPriorityTasks = await Task.countDocuments({ 
      isMainTask: true,
      priority: 'urgent'
    });
    
    res.json({
      overview: {
        totalTasks,
        inProgressTasks,
        finishedTasks,
        delayedTasks,
        pendingReviewTasks,
        pendingConfirmTasks,
        pendingExtensions,
        totalUsers,
        completionRate: totalTasks > 0 ? 
          Math.round(finishedTasks / totalTasks * 100) : 0,
        priorityStats: {
          low: lowPriorityTasks,
          normal: normalPriorityTasks,
          high: highPriorityTasks,
          urgent: urgentPriorityTasks
        }
      }
    });
  } catch (error) {
    console.error('获取统计概览错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 辅助函数：格式化日期
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

// 辅助函数：状态文本
function getStatusText(status) {
  const statusMap = {
    'pending': '待开始',
    'in_progress': '进行中',
    'partial_completed': '部分完成',
    'extension_pending': '待延期审批',
    'extension_approved': '延期通过',
    'completed': '已完成',
    'pending_review': '待审核',
    'pending_confirm': '待确认',
    'finished': '已完结'
  };
  return statusMap[status] || status;
}

// 辅助函数：优先级文本
function getPriorityText(priority) {
  const priorityMap = {
    'low': '低',
    'normal': '普通',
    'high': '高',
    'urgent': '紧急'
  };
  return priorityMap[priority] || priority;
}
