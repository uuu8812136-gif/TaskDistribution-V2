/**
 * 数据库迁移脚本：为现有任务初始化 executorCompletions 字段
 * 
 * 用途：将旧版的单一完成记录迁移到新版的多执行人完成跟踪系统
 * 
 * 执行方式：node migrate-executor-completions.js
 */

const mongoose = require('mongoose');
const Task = require('./models/Task');
const User = require('./models/User');  // 添加 User 模型引入
require('dotenv').config();

async function migrateExecutorCompletions() {
  try {
    // 连接数据库
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/task_distribution');
    console.log('✅ 数据库连接成功');

    // 查找所有任务
    const tasks = await Task.find({}).populate('executor', 'username realName');
    console.log(`\n📊 共找到 ${tasks.length} 个任务\n`);

    let updatedCount = 0;
    let skippedCount = 0;

    for (const task of tasks) {
      // 如果已经有 executorCompletions 数据，跳过
      if (task.executorCompletions && task.executorCompletions.length > 0) {
        console.log(`⏭️  跳过任务: ${task.taskName} (已有 executorCompletions 数据)`);
        skippedCount++;
        continue;
      }

      // 为每个执行人创建完成记录
      const executorCompletions = task.executor.map(executor => {
        // 判断是否已完成
        const isCompleted = task.status === 'completed' || 
                           task.status === 'pending_review' || 
                           task.status === 'pending_confirm' || 
                           task.status === 'finished';

        return {
          executor: executor._id,
          status: isCompleted ? 'completed' : 'pending',
          content: isCompleted ? task.completionNote : null,
          attachments: isCompleted ? (task.completionAttachments || []) : [],
          completedAt: isCompleted ? (task.actualCompletionTime || task.updatedAt) : null
        };
      });

      // 更新任务
      task.executorCompletions = executorCompletions;
      await task.save();

      console.log(`✅ 已更新任务: ${task.taskName}`);
      console.log(`   执行人数: ${executorCompletions.length}`);
      console.log(`   完成状态: ${executorCompletions.filter(ec => ec.status === 'completed').length}/${executorCompletions.length} 已完成`);
      console.log('');

      updatedCount++;
    }

    console.log('\n🎉 迁移完成！');
    console.log(`   ✅ 已更新: ${updatedCount} 个任务`);
    console.log(`   ⏭️  已跳过: ${skippedCount} 个任务`);

    process.exit(0);
  } catch (error) {
    console.error('❌ 迁移失败:', error);
    process.exit(1);
  }
}

// 执行迁移
migrateExecutorCompletions();
