const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Task = require('./models/Task');

dotenv.config();

// 测试数据
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

async function seedData() {
  try {
    // 连接数据库
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB连接成功');

    // 清空现有数据
    console.log('🗑️  清空现有数据...');
    await User.deleteMany({});
    await Task.deleteMany({});
    console.log('✅ 数据清空完成');

    // 创建用户
    console.log('👥 创建测试用户...');
    const users = [];
    for (const userData of testUsers) {
      const user = new User(userData);
      await user.save();
      users.push(user);
      console.log(`   ✓ 创建用户: ${user.name} (${user.username})`);
    }
    console.log('✅ 用户创建完成');

    // 获取用户引用
    const admin = users[0];
    const zhangsan = users[1];
    const lisi = users[2];
    const wangwu = users[3];
    const zhaoliu = users[4];

    // 创建测试任务
    console.log('📋 创建测试任务...');

    // 任务1: 单人任务，无子任务
    const task1 = new Task({
      taskName: '优化系统性能',
      taskType: '技术优化',
      taskSource: '技术部需求',
      description: '对现有系统进行性能优化，提升响应速度',
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
    console.log(`   ✓ 创建任务: ${task1.taskName}`);

    // 任务2: 团队任务，有子任务
    const task2 = new Task({
      taskName: '开发用户管理模块',
      taskType: '功能开发',
      taskSource: '产品需求',
      description: '开发完整的用户管理功能，包括增删改查',
      executor: [zhangsan._id, lisi._id],
      mainExecutor: zhangsan._id,
      ccUsers: [wangwu._id, zhaoliu._id],
      creator: admin._id,
      plannedCompletionTime: new Date('2025-12-31'),
      priority: 'urgent',
      tags: ['功能开发', '用户管理'],
      status: 'in_progress',
      completionRate: 0
    });
    await task2.save();
    console.log(`   ✓ 创建任务: ${task2.taskName}`);

    // 子任务2-1
    const subtask21 = new Task({
      taskName: '设计数据库表结构',
      description: '设计用户相关的数据库表',
      executor: [zhangsan._id],
      mainExecutor: zhangsan._id,
      ccUsers: [wangwu._id, zhaoliu._id],
      creator: admin._id,
      plannedCompletionTime: new Date('2025-12-20'),
      priority: 'high',
      parentTask: task2._id,
      isMainTask: false,
      status: 'in_progress'
    });
    await subtask21.save();
    console.log(`      ✓ 创建子任务: ${subtask21.taskName}`);

    // 子任务2-2
    const subtask22 = new Task({
      taskName: '开发后端API',
      description: '开发用户管理相关的API接口',
      executor: [lisi._id],
      mainExecutor: lisi._id,
      ccUsers: [wangwu._id, zhaoliu._id],
      creator: admin._id,
      plannedCompletionTime: new Date('2025-12-25'),
      priority: 'high',
      parentTask: task2._id,
      isMainTask: false,
      status: 'in_progress'
    });
    await subtask22.save();
    console.log(`      ✓ 创建子任务: ${subtask22.taskName}`);

    // 任务3: 已完成的任务
    const task3 = new Task({
      taskName: '修复登录bug',
      taskType: 'Bug修复',
      taskSource: '测试反馈',
      description: '修复用户登录时的验证码问题',
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
    console.log(`   ✓ 创建任务: ${task3.taskName}`);

    // 任务4: 待审核任务
    const task4 = new Task({
      taskName: '编写接口文档',
      taskType: '文档编写',
      taskSource: '技术部需求',
      description: '为所有API接口编写详细文档',
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
    console.log(`   ✓ 创建任务: ${task4.taskName}`);

    console.log('✅ 任务创建完成');

    console.log('\n🎉 测试数据初始化完成！\n');
    console.log('📝 测试账号信息：');
    console.log('==========================================');
    console.log('管理员账号: admin / 123456');
    console.log('执行人账号: zhangsan / 123456');
    console.log('执行人账号: lisi / 123456');
    console.log('抄送人账号: wangwu / 123456');
    console.log('抄送人账号: zhaoliu / 123456');
    console.log('==========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ 初始化数据失败:', error);
    process.exit(1);
  }
}

seedData();

