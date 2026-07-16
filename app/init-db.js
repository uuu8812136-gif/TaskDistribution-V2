/**
 * 数据库初始化脚本
 * 功能：
 * 1. 连接 MongoDB
 * 2. 创建数据库和集合
 * 3. 创建索引
 * 4. 初始化测试数据
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Task = require('./models/Task');
const TaskReview = require('./models/TaskReview');
const ExtensionRequest = require('./models/ExtensionRequest');
const Message = require('./models/Message');

// 加载环境变量
dotenv.config();

console.log('\n🚀 开始初始化数据库...\n');

// 测试用户数据
const testUsers = [
  {
    username: 'admin',
    password: '123456',
    name: '管理员',
    phone: '13800000000',
    email: 'admin@example.com',
    roles: ['admin', 'executor', 'cc'],
    department: '管理部'
  },
  {
    username: 'zhangsan',
    password: '123456',
    name: '张三',
    phone: '13800000001',
    email: 'zhangsan@example.com',
    roles: ['executor'],
    department: '技术部'
  },
  {
    username: 'lisi',
    password: '123456',
    name: '李四',
    phone: '13800000002',
    email: 'lisi@example.com',
    roles: ['executor'],
    department: '技术部'
  },
  {
    username: 'wangwu',
    password: '123456',
    name: '王五',
    phone: '13800000003',
    email: 'wangwu@example.com',
    roles: ['executor', 'cc'],
    department: '产品部'
  },
  {
    username: 'zhaoliu',
    password: '123456',
    name: '赵六',
    phone: '13800000004',
    email: 'zhaoliu@example.com',
    roles: ['cc'],
    department: '测试部'
  }
];

async function initDatabase() {
  try {
    // 1. 连接数据库
    console.log('📡 正在连接 MongoDB...');
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/task_distribution';
    console.log(`   连接地址: ${mongoUri}`);
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB 连接成功\n');

    // 2. 清空现有数据（可选）
    const answer = process.argv.includes('--clear');
    if (answer) {
      console.log('🗑️  清空现有数据...');
      await User.deleteMany({});
      await Task.deleteMany({});
      await TaskReview.deleteMany({});
      await ExtensionRequest.deleteMany({});
      await Message.deleteMany({});
      console.log('✅ 数据清空完成\n');
    }

    // 3. 创建索引
    console.log('📇 创建数据库索引...');
    await createIndexes();
    console.log('✅ 索引创建完成\n');

    // 4. 创建测试用户
    console.log('👥 创建测试用户...');
    const users = [];
    for (const userData of testUsers) {
      // 检查用户是否已存在
      let user = await User.findOne({ username: userData.username });
      if (!user) {
        user = new User(userData);
        await user.save();
        console.log(`   ✓ 创建用户: ${user.name} (${user.username})`);
      } else {
        console.log(`   ○ 用户已存在: ${user.name} (${user.username})`);
      }
      users.push(user);
    }
    console.log('✅ 用户创建完成\n');

    // 5. 创建测试任务
    console.log('📋 创建测试任务...');
    await createTestTasks(users);
    console.log('✅ 任务创建完成\n');

    // 6. 显示初始化结果
    await showStatistics();

    console.log('\n🎉 数据库初始化完成！\n');
    console.log('=' .repeat(60));
    console.log('📝 测试账号信息：');
    console.log('=' .repeat(60));
    console.log('管理员账号: admin / 123456 (拥有所有权限)');
    console.log('执行人账号: zhangsan / 123456 (技术部)');
    console.log('执行人账号: lisi / 123456 (技术部)');
    console.log('执行人+抄送: wangwu / 123456 (产品部)');
    console.log('抄送人账号: zhaoliu / 123456 (测试部)');
    console.log('=' .repeat(60));
    console.log('\n💡 提示: 现在可以启动服务器 npm run dev\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ 初始化失败:', error);
    console.error('\n💡 常见问题排查:');
    console.error('   1. 确认 MongoDB 服务是否已启动');
    console.error('   2. 检查 .env 文件中的 MONGODB_URI 配置');
    console.error('   3. 确认 MongoDB 连接地址和端口是否正确');
    console.error('   4. 检查 MongoDB 用户权限（如果需要认证）\n');
    process.exit(1);
  }
}

// 创建数据库索引
async function createIndexes() {
  try {
    // 用户索引
    await User.collection.createIndex({ username: 1 }, { unique: true });
    await User.collection.createIndex({ email: 1 });
    await User.collection.createIndex({ phone: 1 });
    console.log('   ✓ User 索引');

    // 任务索引
    await Task.collection.createIndex({ taskName: 1 });
    await Task.collection.createIndex({ status: 1 });
    await Task.collection.createIndex({ creator: 1 });
    await Task.collection.createIndex({ executor: 1 });
    await Task.collection.createIndex({ parentTask: 1 });
    await Task.collection.createIndex({ createdAt: -1 });
    console.log('   ✓ Task 索引');

    // 任务审核索引
    await TaskReview.collection.createIndex({ task: 1, reviewer: 1 }, { unique: true });
    console.log('   ✓ TaskReview 索引');

    // 延期申请索引
    await ExtensionRequest.collection.createIndex({ task: 1 });
    await ExtensionRequest.collection.createIndex({ applicant: 1 });
    console.log('   ✓ ExtensionRequest 索引');
  } catch (error) {
    console.warn('   ⚠ 索引创建警告:', error.message);
  }
}

// 创建测试任务
async function createTestTasks(users) {
  const [admin, zhangsan, lisi, wangwu, zhaoliu] = users;

  // 检查是否已有任务
  const existingTaskCount = await Task.countDocuments();
  if (existingTaskCount > 0) {
    console.log(`   ○ 已存在 ${existingTaskCount} 个任务，跳过创建测试任务`);
    return;
  }

  // 任务1: 进行中的单人任务
  const task1 = new Task({
    taskName: '优化系统性能',
    taskType: '技术优化',
    taskSource: '技术部需求',
    description: '对现有系统进行性能优化，提升响应速度。包括数据库查询优化、代码重构、缓存策略等。',
    executor: [zhangsan._id],
    mainExecutor: zhangsan._id,
    ccUsers: [wangwu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-25'),
    priority: 'high',
    tags: ['性能优化', '技术'],
    status: 'in_progress'
  });
  await task1.save();
  console.log(`   ✓ ${task1.taskName}`);

  // 任务2: 有子任务的团队任务
  const task2 = new Task({
    taskName: '开发用户管理模块',
    taskType: '功能开发',
    taskSource: '产品需求',
    description: '开发完整的用户管理功能，包括用户增删改查、权限管理、部门管理等功能。',
    executor: [zhangsan._id, lisi._id],
    mainExecutor: zhangsan._id,
    ccUsers: [wangwu._id, zhaoliu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-31'),
    priority: 'urgent',
    tags: ['功能开发', '用户管理'],
    status: 'in_progress',
    isMainTask: true,
    completionRate: 0
  });
  await task2.save();
  console.log(`   ✓ ${task2.taskName}`);

  // 子任务2-1
  const subtask21 = new Task({
    taskName: '设计数据库表结构',
    taskType: '设计',
    taskSource: '技术需求',
    description: '设计用户、角色、权限相关的数据库表结构',
    executor: [zhangsan._id],
    mainExecutor: zhangsan._id,
    ccUsers: [wangwu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-20'),
    priority: 'high',
    tags: ['数据库', '设计'],
    parentTask: task2._id,
    isMainTask: false,
    status: 'in_progress'
  });
  await subtask21.save();
  console.log(`      ✓ ${subtask21.taskName}`);

  // 子任务2-2
  const subtask22 = new Task({
    taskName: '开发后端API',
    taskType: '开发',
    taskSource: '技术需求',
    description: '开发用户管理相关的API接口，包括增删改查、认证授权等',
    executor: [lisi._id],
    mainExecutor: lisi._id,
    ccUsers: [wangwu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-25'),
    priority: 'high',
    tags: ['API', '后端'],
    parentTask: task2._id,
    isMainTask: false,
    status: 'pending'
  });
  await subtask22.save();
  console.log(`      ✓ ${subtask22.taskName}`);

  // 子任务2-3
  const subtask23 = new Task({
    taskName: '开发前端页面',
    taskType: '开发',
    taskSource: '技术需求',
    description: '开发用户管理相关的前端页面和交互功能',
    executor: [zhangsan._id],
    mainExecutor: zhangsan._id,
    ccUsers: [wangwu._id, zhaoliu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-28'),
    priority: 'high',
    tags: ['前端', 'UI'],
    parentTask: task2._id,
    isMainTask: false,
    status: 'pending'
  });
  await subtask23.save();
  console.log(`      ✓ ${subtask23.taskName}`);

  // 任务3: 已完成的任务
  const task3 = new Task({
    taskName: '修复登录bug',
    taskType: 'Bug修复',
    taskSource: '测试反馈',
    description: '修复用户登录时的验证码校验问题',
    executor: [lisi._id],
    mainExecutor: lisi._id,
    ccUsers: [zhaoliu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-15'),
    actualCompletionTime: new Date('2025-12-14'),
    priority: 'urgent',
    tags: ['Bug修复', '紧急'],
    status: 'finished',
    completionRate: 100
  });
  await task3.save();
  console.log(`   ✓ ${task3.taskName} (已完成)`);

  // 任务4: 待审核任务
  const task4 = new Task({
    taskName: '编写接口文档',
    taskType: '文档编写',
    taskSource: '技术部需求',
    description: '为所有API接口编写详细的接口文档，包括请求参数、返回值、示例等',
    executor: [zhangsan._id],
    mainExecutor: zhangsan._id,
    ccUsers: [wangwu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-18'),
    actualCompletionTime: new Date('2025-12-17'),
    priority: 'normal',
    tags: ['文档'],
    status: 'pending_review',
    completionRate: 100
  });
  await task4.save();
  console.log(`   ✓ ${task4.taskName} (待审核)`);

  // 任务5: 待确认任务
  const task5 = new Task({
    taskName: '系统部署方案设计',
    taskType: '方案设计',
    taskSource: '运维需求',
    description: '设计系统的部署方案，包括服务器配置、负载均衡、备份策略等',
    executor: [lisi._id],
    mainExecutor: lisi._id,
    ccUsers: [wangwu._id, zhaoliu._id],
    creator: admin._id,
    plannedCompletionTime: new Date('2025-12-20'),
    actualCompletionTime: new Date('2025-12-19'),
    priority: 'high',
    tags: ['部署', '运维'],
    status: 'pending_confirm',
    completionRate: 100
  });
  await task5.save();
  console.log(`   ✓ ${task5.taskName} (待确认)`);
}

// 显示统计信息
async function showStatistics() {
  const userCount = await User.countDocuments();
  const taskCount = await Task.countDocuments();
  const mainTaskCount = await Task.countDocuments({ isMainTask: true });
  const subTaskCount = await Task.countDocuments({ isMainTask: false });

  console.log('📊 数据统计：');
  console.log(`   用户总数: ${userCount}`);
  console.log(`   任务总数: ${taskCount}`);
  console.log(`   主任务: ${mainTaskCount}`);
  console.log(`   子任务: ${subTaskCount}`);
}

// 运行初始化
initDatabase();

