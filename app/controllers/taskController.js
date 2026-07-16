const Task = require('../models/Task');
const User = require('../models/User');
const TaskReview = require('../models/TaskReview');
const ExtensionRequest = require('../models/ExtensionRequest');
const XLSX = require('xlsx');
const {
  notifyTaskAssigned,
  notifyTaskUpdated,
  notifyTaskDeleted
} = require('../utils/notificationHelper');

// 创建任务（支持子任务）
exports.createTask = async (req, res) => {
  try {
    const {
      taskName,
      taskType,
      taskSource,
      description,
      executor,
      mainExecutor,
      ccUsers,
      plannedCompletionTime,
      tags,
      priority,
      remarks,
      subTasks  // 子任务数组
    } = req.body;
    
    // 验证必填字段
    if (!taskName || !plannedCompletionTime) {
      return res.status(400).json({ message: '任务名称和计划完成时间不能为空' });
    }
    
    // 验证执行人
    if (!executor || executor.length === 0) {
      return res.status(400).json({ message: '至少指定一个执行人' });
    }
    
    // 确保executor是数组
    const executorArray = Array.isArray(executor) ? executor : [executor];
    
    // 处理附件 - 支持两种方式
    let attachments = [];
    
    // 方式1: multer 上传的文件（从 req.files）
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        // 将 Windows 路径的反斜杠转换为正斜杠（URL 格式）
        const urlPath = file.path.replace(/\\/g, '/');
        // 处理中文文件名编码
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        attachments.push({
          filename: file.filename,
          originalName: originalName,  // 使用转码后的文件名
          path: urlPath,
          mimetype: file.mimetype,
          size: file.size
        });
      });
    }
    
    // 方式2: 前端已上传的附件信息（从 req.body.attachments）
    if (req.body.attachments && Array.isArray(req.body.attachments)) {
      attachments = req.body.attachments;
    }
    
    // 创建主任务
    const mainTask = new Task({
      taskName,
      taskType,
      taskSource,
      description,
      executor: executorArray,
      mainExecutor: mainExecutor || executorArray[0],  // 如果没指定主负责人，默认第一个执行人
      ccUsers,
      creator: req.user._id,
      plannedCompletionTime,
      attachments,
      tags,
      priority,
      remarks,
      isMainTask: true,
      status: 'in_progress'
    });
    
    // 初始化 executorCompletions（多执行人完成跟踪）
    mainTask.executorCompletions = executorArray.map(executorId => ({
      executor: executorId,
      status: 'pending',
      content: null,
      attachments: [],
      completedAt: null
    }));
    
    await mainTask.save();
    
    // 创建子任务
    const createdSubTasks = [];
    if (subTasks && Array.isArray(subTasks) && subTasks.length > 0) {
      for (const subTask of subTasks) {
        if (!subTask.taskName || !subTask.executor) {
          continue;  // 跳过无效子任务
        }
        
        const newSubTask = new Task({
          taskName: subTask.taskName,
          description: subTask.description,
          executor: [subTask.executor],  // 子任务只能有一个执行人
          mainExecutor: subTask.executor,
          ccUsers: mainTask.ccUsers,  // 继承主任务的抄送人
          creator: req.user._id,
          plannedCompletionTime: subTask.plannedCompletionTime || plannedCompletionTime,
          priority: subTask.priority || priority,
          remarks: subTask.remarks,
          parentTask: mainTask._id,
          isMainTask: false,
          status: 'in_progress'
        });
        
        // 初始化子任务的 executorCompletions
        newSubTask.executorCompletions = [{
          executor: subTask.executor,
          status: 'pending',
          content: null,
          attachments: [],
          completedAt: null
        }];
        
        await newSubTask.save();
        createdSubTasks.push(newSubTask);
      }
    }
    
    // 填充关联数据
    await mainTask.populate([
      { path: 'creator', select: 'name username' },
      { path: 'executor', select: 'name username' },
      { path: 'mainExecutor', select: 'name username' },
      { path: 'ccUsers', select: 'name username' }
    ]);
    
    // 发送任务分配通知
    try {
      // 通知所有执行人和抄送人
      // 从 populate 后的数据中提取有效的 ObjectId
      const executorIds = mainTask.executor.map(user => user._id);
      const ccUserIds = mainTask.ccUsers ? mainTask.ccUsers.map(user => user._id) : [];
      const allRecipients = [
        ...executorIds,
        ...ccUserIds
      ];
      console.log('📧 准备发送通知，接收人数量:', allRecipients.length);
      await notifyTaskAssigned(mainTask, allRecipients, req.user._id);
    } catch (notifyError) {
      console.error('❌ 发送任务分配通知失败:', notifyError);
      // 不影响主流程
    }
    
    res.status(201).json({
      message: '任务创建成功',
      task: mainTask,
      subTasks: createdSubTasks
    });
  } catch (error) {
    console.error('创建任务错误:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ message: messages.join(', ') });
    }
    
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取任务列表（根据权限）
exports.getTasks = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, priority, keyword, startDate, endDate } = req.query;
    
    // 构建查询条件
    const query = { isMainTask: true };  // 只查主任务
    
    // 权限过滤
    if (!req.user.roles.includes('admin')) {
      // 非管理员只能看到自己相关的任务
      query.$or = [
        { executor: req.user._id },
        { ccUsers: req.user._id }
      ];
    }
    
    if (status) {
      query.status = status;
    }
    
    if (priority) {
      query.priority = priority;
    }
    
    if (keyword) {
      query.$or = [
        { taskName: new RegExp(keyword, 'i') },
        { description: new RegExp(keyword, 'i') }
      ];
    }
    
    // 按创建时间范围查询
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        // 从开始日期的 00:00:00 开始
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        query.createdAt.$gte = start;
      }
      if (endDate) {
        // 到结束日期的 23:59:59 结束
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    
    // 分页查询
    const skip = (page - 1) * limit;
    const tasks = await Task.find(query)
      .populate('creator', 'name username')
      .populate('executor', 'name username')
      .populate('mainExecutor', 'name username')
      .populate('ccUsers', 'name username')
      .populate('subTasks')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    
    const total = await Task.countDocuments(query);
    
    res.json({
      tasks,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取任务列表错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取任务详情
exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('creator', 'name username phone')
      .populate('executor', 'name username phone')
      .populate('mainExecutor', 'name username phone')
      .populate('ccUsers', 'name username phone')
      .populate('completedBy', 'name username phone')
      .populate('confirmedBy', 'name username phone')
      .populate('executorCompletions.executor', 'name username phone realName')
      .populate('parentTask')
      .populate({
        path: 'subTasks',
        populate: {
          path: 'executor',
          select: 'name username'
        }
      });
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有任务相关人员可以查看
    const userId = req.user._id.toString();
    const isCreator = task.creator._id.toString() === userId;
    const isExecutor = task.executor.some(e => e._id.toString() === userId);
    const isCCUser = task.ccUsers.some(cc => cc._id.toString() === userId);
    const isAdmin = req.user.roles.includes('admin');
    
    if (!isCreator && !isExecutor && !isCCUser && !isAdmin) {
      return res.status(403).json({ message: '无权查看此任务' });
    }
    
    res.json({ task });
  } catch (error) {
    console.error('获取任务详情错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 更新任务信息
exports.updateTask = async (req, res) => {
  try {
    console.log('=== 更新任务请求 ===');
    console.log('任务ID:', req.params.id);
    console.log('req.body:', req.body);
    console.log('req.files:', req.files);
    
    const task = await Task.findById(req.params.id);
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有创建者（管理员）可以修改任务
    if (task.creator.toString() !== req.user._id.toString() && !req.user.roles.includes('admin')) {
      return res.status(403).json({ message: '无权修改此任务' });
    }
    
    // 更新允许的字段
    const {
      taskName,
      taskType,
      taskSource,
      description,
      executor,
      mainExecutor,
      ccUsers,
      plannedCompletionTime,
      tags,
      priority,
      remarks,
      subTasks
    } = req.body;
    
    if (taskName) task.taskName = taskName;
    if (taskType) task.taskType = taskType;
    if (taskSource) task.taskSource = taskSource;
    if (description) task.description = description;
    if (priority) task.priority = priority;
    if (remarks !== undefined) task.remarks = remarks;
    
    // 处理数组字段（FormData传递的可能是字符串或数组）
    if (executor) {
      const newExecutors = Array.isArray(executor) ? executor : [executor];
      
      // 如果执行人列表发生变化，需要更新 executorCompletions
      const oldExecutorIds = task.executor.map(e => e.toString());
      const newExecutorIds = newExecutors.map(e => e.toString());
      
      if (JSON.stringify(oldExecutorIds.sort()) !== JSON.stringify(newExecutorIds.sort())) {
        console.log('执行人列表变更，更新 executorCompletions');
        
        // 保留已完成的记录，为新增执行人创建pending记录
        const existingCompletions = task.executorCompletions || [];
        const updatedCompletions = [];
        
        newExecutorIds.forEach(executorId => {
          const existing = existingCompletions.find(ec => ec.executor.toString() === executorId);
          if (existing) {
            // 保留现有记录
            updatedCompletions.push(existing);
          } else {
            // 新增执行人
            updatedCompletions.push({
              executor: executorId,
              status: 'pending',
              content: null,
              attachments: [],
              completedAt: null
            });
          }
        });
        
        task.executorCompletions = updatedCompletions;
      }
      
      task.executor = newExecutors;
    }
    if (mainExecutor) {
      task.mainExecutor = mainExecutor;
    }
    if (ccUsers) {
      task.ccUsers = Array.isArray(ccUsers) ? ccUsers : (ccUsers ? [ccUsers] : []);
    }
    if (plannedCompletionTime) {
      task.plannedCompletionTime = plannedCompletionTime;
    }
    if (tags) {
      task.tags = Array.isArray(tags) ? tags : (tags ? [tags] : []);
    }
    
    // 处理子任务（如果传递了 JSON 字符串）
    if (subTasks) {
      try {
        const parsedSubTasks = typeof subTasks === 'string' ? JSON.parse(subTasks) : subTasks;
        console.log('解析的子任务:', parsedSubTasks);
        // 注意：如果需要更新子任务，需要额外的逻辑来处理子任务的增删改
      } catch (err) {
        console.error('解析子任务失败:', err);
      }
    }
    
    // 处理附件上传
    if (req.files && req.files.length > 0) {
      const newAttachments = req.files.map(file => {
        // 处理中文文件名编码
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        return {
          path: file.path.replace(/\\/g, '/'),  // 统一使用正斜杠
          originalName: originalName,  // 使用转码后的文件名
          mimetype: file.mimetype,
          size: file.size
        };
      });
      
      // 将新附件添加到现有附件数组
      task.attachments = [...(task.attachments || []), ...newAttachments];
      console.log('添加附件:', newAttachments);
    }
    
    console.log('保存前的任务数据:', {
      taskName: task.taskName,
      taskType: task.taskType,
      executor: task.executor,
      mainExecutor: task.mainExecutor
    });
    
    await task.save();
    
    console.log('任务保存成功');
    
    await task.populate([
      { path: 'creator', select: 'name username' },
      { path: 'executor', select: 'name username' },
      { path: 'mainExecutor', select: 'name username' },
      { path: 'ccUsers', select: 'name username' }
    ]);
    
    // 发送任务更新通知
    try {
      // 通知所有相关人员
      const allRecipients = [
        ...task.executor.map(e => e._id),
        ...task.ccUsers.map(cc => cc._id)
      ];
      await notifyTaskUpdated(task, allRecipients, req.user._id, '任务信息已更新');
    } catch (notifyError) {
      console.error('发送任务更新通知失败:', notifyError);
    }
    
    res.json({
      message: '任务更新成功',
      task
    });
  } catch (error) {
    console.error('更新任务错误:', error);
    res.status(500).json({ message: '服务器错误', error: error.message });
  }
};

// 删除任务
exports.deleteTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    
    if (!task) {
      return res.status(404).json({ message: '任务不存在' });
    }
    
    // 权限检查：只有创建者（管理员）可以删除任务
    if (task.creator.toString() !== req.user._id.toString() && !req.user.roles.includes('admin')) {
      return res.status(403).json({ message: '无权删除此任务' });
    }
    
    // 保存任务信息用于通知
    const taskName = task.taskName;
    // task.executor 和 task.ccUsers 此时已经是 ObjectId 数组
    const allRecipients = [
      ...task.executor,
      ...(task.ccUsers || [])
    ];
    
    // 如果是主任务，删除所有子任务
    if (task.isMainTask) {
      await Task.deleteMany({ parentTask: task._id });
    }
    
    await Task.findByIdAndDelete(req.params.id);
    
    // 发送任务删除通知
    try {
      console.log('📧 准备发送删除通知，接收人数量:', allRecipients.length);
      await notifyTaskDeleted(taskName, allRecipients, req.user._id);
    } catch (notifyError) {
      console.error('❌ 发送任务删除通知失败:', notifyError);
    }
    
    res.json({ message: '任务删除成功' });
  } catch (error) {
    console.error('删除任务错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 获取我的任务
exports.getMyTasks = async (req, res) => {
  try {
    const { type = 'executor', status } = req.query;
    
    const query = {};
    
    // 根据类型筛选
    if (type === 'executor') {
      // 我执行的任务
      query.executor = req.user._id;
    } else if (type === 'cc') {
      // 我抄送的任务
      query.ccUsers = req.user._id;
    } else if (type === 'created') {
      // 我创建的任务
      query.creator = req.user._id;
    }
    
    if (status) {
      query.status = status;
    }
    
    const tasks = await Task.find(query)
      .populate('creator', 'name username')
      .populate('executor', 'name username')
      .populate('mainExecutor', 'name username')
      .populate('ccUsers', 'name username')
      .populate('parentTask', 'taskName')
      .sort({ createdAt: -1 });
    
    res.json({ tasks });
  } catch (error) {
    console.error('获取我的任务错误:', error);
    res.status(500).json({ message: '服务器错误' });
  }
};

// 批量导出任务为Excel
exports.batchExportTasks = async (req, res) => {
  try {
    const { startDate, endDate, status, priority, keyword } = req.query;
    
    // 构建查询条件：默认查询所有主任务
    const query = {
      isMainTask: true
    };
    
    // 如果提供了时间范围，添加时间筛选
    if (startDate && endDate) {
      // 从开始日期的 00:00:00 到结束日期的 23:59:59
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      query.createdAt = {
        $gte: start,
        $lte: end
      };
    } else if (startDate || endDate) {
      // 如果只提供了一个时间，返回错误
      return res.status(400).json({ message: '请同时提供开始时间和结束时间，或都不提供' });
    }
    
    // 添加其他搜索条件
    if (status) {
      query.status = status;
    }
    
    if (priority) {
      query.priority = priority;
    }
    
    if (keyword) {
      query.$or = [
        { taskName: new RegExp(keyword, 'i') },
        { description: new RegExp(keyword, 'i') }
      ];
    }
    
    console.log('=== 导出任务查询条件 ===');
    console.log('query:', JSON.stringify(query, null, 2));
    
    // 查询主任务
    const mainTasks = await Task.find(query)
      .populate('creator', 'name username')
      .populate('executor', 'name username')
      .populate('mainExecutor', 'name username')
      .populate('ccUsers', 'name username')
      .populate('completedBy', 'name username')
      .sort({ createdAt: 1 });
    
    // 准备Excel数据
    const excelData = [];
    let rowIndex = 1;
    
    for (const task of mainTasks) {
      // 获取子任务
      const subTasks = await Task.find({ parentTask: task._id })
        .populate('executor', 'name username')
        .sort({ createdAt: 1 });
      
      // 获取审核记录
      const reviews = await TaskReview.find({ task: task._id })
        .populate('reviewer', 'name username')
        .sort({ createdAt: 1 });
      
      // 获取延期记录
      const extensions = await ExtensionRequest.find({ task: task._id })
        .sort({ applyTime: 1 });
      
      // 主任务行
      excelData.push({
        '序号': rowIndex++,
        '任务名称': task.taskName,
        '任务状态': getStatusText(task.status),
        '任务类型': task.taskType || '-',
        '任务来源': task.taskSource || '-',
        '优先级': getPriorityText(task.priority),
        '完成率': task.completionRate + '%',
        
        // 人员信息
        '创建人': task.creator ? task.creator.name : '-',
        '主负责人': task.mainExecutor ? task.mainExecutor.name : '-',
        '执行人': task.executor && task.executor.length > 0 
          ? task.executor.filter(e => e && e.name).map(e => e.name).join('、') 
          : '-',
        '抄送人': task.ccUsers && task.ccUsers.length > 0 
          ? task.ccUsers.filter(cc => cc && cc.name).map(cc => cc.name).join('、') 
          : '-',
        
        // 时间信息
        '创建时间': formatDate(task.createdAt),
        '开始时间': formatDate(task.startTime),
        '计划完成时间': formatDate(task.plannedCompletionTime),
        '实际完成时间': task.actualCompletionTime ? formatDate(task.actualCompletionTime) : '-',
        '是否超期': isOverdue(task) ? '是' : '否',
        
        // 任务描述和备注
        '任务描述': task.description || '-',
        '备注': task.remarks || '-',
        
        // 附件信息（只显示文件名）
        '任务附件': task.attachments && task.attachments.length > 0 
          ? task.attachments.filter(att => att && att.originalName).map(att => att.originalName).join('; ') 
          : '-',
        
        // 完成信息
        '完成人': task.completedBy ? task.completedBy.name : '-',
        '完成说明': task.completionNote || '-',
        '完成附件': task.completionAttachments && task.completionAttachments.length > 0
          ? task.completionAttachments.filter(att => att && att.originalName).map(att => att.originalName).join('; ')
          : '-',
        
        // 子任务统计
        '子任务数': subTasks.length,
        '已完成子任务': subTasks.filter(st => st.status === 'finished').length,
        
        // 延期信息
        '是否延期': task.hasExtensionRequest ? '是' : '否',
        '延期次数': extensions.length,
        '延期天数': extensions.filter(ext => ext.status === 'approved')
          .reduce((sum, ext) => sum + (ext.approvedDays || 0), 0),
        
        // 审核信息
        '审核次数': reviews.length,
        '审核人': reviews.map(r => r.reviewer?.name || '未知').join('、'),
        '审核评分': reviews.length > 0 
          ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1)
          : '-'
      });
      
      // 子任务行
      for (const subTask of subTasks) {
        excelData.push({
          '序号': rowIndex++,
          '任务名称': `└─ ${subTask.taskName} [子任务-${task.taskName}]`,
          '任务状态': getStatusText(subTask.status),
          '任务类型': subTask.taskType || '-',
          '任务来源': subTask.taskSource || '-',
          '优先级': getPriorityText(subTask.priority),
          '完成率': subTask.completionRate + '%',
          
          // 人员信息
          '创建人': task.creator ? task.creator.name : '-',
          '主负责人': '-',
          '执行人': subTask.executor && subTask.executor.length > 0 
            ? subTask.executor.filter(e => e && e.name).map(e => e.name).join('、') 
            : '-',
          '抄送人': '-',
          
          // 时间信息
          '创建时间': formatDate(subTask.createdAt),
          '开始时间': formatDate(subTask.startTime),
          '计划完成时间': formatDate(subTask.plannedCompletionTime),
          '实际完成时间': subTask.actualCompletionTime ? formatDate(subTask.actualCompletionTime) : '-',
          '是否超期': isOverdue(subTask) ? '是' : '否',
          
          // 任务描述和备注
          '任务描述': subTask.description || '-',
          '备注': subTask.remarks || '-',
          
          // 附件信息
          '任务附件': '-',
          
          // 完成信息
          '完成人': '-',
          '完成说明': subTask.completionNote || '-',
          '完成附件': '-',
          
          // 子任务统计
          '子任务数': 0,
          '已完成子任务': 0,
          
          // 延期信息
          '是否延期': '否',
          '延期次数': 0,
          '延期天数': 0,
          
          // 审核信息
          '审核次数': 0,
          '审核人': '-',
          '审核评分': '-'
        });
      }
    }
    
    // 创建工作簿
    const wb = XLSX.utils.book_new();
    
    // 创建工作表
    const ws = XLSX.utils.json_to_sheet(excelData);
    
    // 设置列宽
    ws['!cols'] = [
      { wch: 6 },   // 序号
      { wch: 30 },  // 任务名称
      { wch: 12 },  // 任务状态
      { wch: 12 },  // 任务类型
      { wch: 12 },  // 任务来源
      { wch: 10 },  // 优先级
      { wch: 10 },  // 完成率
      { wch: 12 },  // 创建人
      { wch: 12 },  // 主负责人
      { wch: 20 },  // 执行人
      { wch: 20 },  // 抄送人
      { wch: 18 },  // 创建时间
      { wch: 18 },  // 开始时间
      { wch: 18 },  // 计划完成时间
      { wch: 18 },  // 实际完成时间
      { wch: 10 },  // 是否超期
      { wch: 40 },  // 任务描述
      { wch: 30 },  // 备注
      { wch: 40 },  // 任务附件
      { wch: 12 },  // 完成人
      { wch: 40 },  // 完成说明
      { wch: 40 },  // 完成附件
      { wch: 10 },  // 子任务数
      { wch: 12 },  // 已完成子任务
      { wch: 10 },  // 是否延期
      { wch: 10 },  // 延期次数
      { wch: 10 },  // 延期天数
      { wch: 10 },  // 审核次数
      { wch: 30 },  // 审核人
      { wch: 10 }   // 审核评分
    ];
    
    // 添加工作表到工作簿
    XLSX.utils.book_append_sheet(wb, ws, '任务列表');
    
    // 生成Excel文件
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // 设置响应头
    let filename
    if (startDate && endDate) {
      filename = `任务列表_${startDate.substring(0, 10)}_${endDate.substring(0, 10)}_${new Date().getTime()}.xlsx`;
    } else {
      filename = `任务列表_全部_${new Date().getTime()}.xlsx`;
    }
    
    console.log('=== 导出文件信息 ===');
    console.log('查询到的任务数:', mainTasks.length);
    console.log('导出的行数:', excelData.length);
    console.log('文件名:', filename);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    
    res.send(buffer);
  } catch (error) {
    console.error('=== 批量导出任务错误 ===');
    console.error('错误:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({ message: '导出失败', error: error.message });
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
    'extension_pending': '延期待审批',
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

// 辅助函数：判断是否超期
function isOverdue(task) {
  if (task.status === 'finished' || task.status === 'pending_confirm') {
    return false;
  }
  if (!task.plannedCompletionTime) return false;
  const plannedTime = new Date(task.plannedCompletionTime);
  const now = new Date();
  return now.getTime() > plannedTime.getTime();
}
