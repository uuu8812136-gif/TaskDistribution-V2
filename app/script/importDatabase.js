require('dotenv').config();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 查找 mongorestore 命令路径
 */
function findMongoRestore() {
  // 常见的 MongoDB 安装路径（Windows）
  const commonPaths = [
    'mongorestore', // 如果在 PATH 中
    'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongorestore.exe',
    'C:\\Program Files\\MongoDB\\Server\\6.0\\bin\\mongorestore.exe',
    'C:\\Program Files\\MongoDB\\Server\\5.0\\bin\\mongorestore.exe',
    'C:\\Program Files\\MongoDB\\Server\\4.4\\bin\\mongorestore.exe',
    'C:\\Program Files\\MongoDB\\Tools\\100\\bin\\mongorestore.exe',
  ];

  // 尝试每个路径
  for (const mongoPath of commonPaths) {
    try {
      if (mongoPath === 'mongorestore') {
        // 测试是否在 PATH 中
        execSync('mongorestore --version', { stdio: 'ignore' });
        return 'mongorestore';
      } else if (fs.existsSync(mongoPath)) {
        return mongoPath;
      }
    } catch (e) {
      // 继续尝试下一个
    }
  }

  return null;
}

/**
 * 使用 mongorestore 导入数据库
 */
async function importDatabase() {
  try {
    console.log('================================================');
    console.log('MongoDB 数据库导入工具（Node.js版）');
    console.log('================================================\n');

    const cliArgs = process.argv.slice(2);
    const isForced = cliArgs.includes('--force') || cliArgs.includes('-f');
    
    // 获取备份路径参数
    const backupArg = cliArgs.find(arg => arg.startsWith('--backup='));
    let backupPath;
    
    if (backupArg) {
      backupPath = backupArg.split('=')[1];
    } else {
      console.log('❌ 错误: 请指定备份文件夹路径\n');
      console.log('使用方法:');
      console.log('   node scripts/importDatabase.js --force --backup=<备份文件夹路径>\n');
      console.log('示例:');
      console.log('   node scripts/importDatabase.js --force --backup=backup_shangcheng_2025-01-09\n');
      console.log('或者使用批处理脚本（交互式）:');
      console.log('   双击运行 scripts/importDatabase.bat\n');
      process.exit(1);
    }

    // 检查备份路径是否存在
    if (!fs.existsSync(backupPath)) {
      console.error(`❌ 错误: 备份文件夹不存在！`);
      console.error(`   路径: ${backupPath}\n`);
      process.exit(1);
    }

    // 解析 MongoDB URI
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/task_distribution';
    const dbName = 'task_distribution';
    
    // 备份文件中的数据库路径
    const dbBackupPath = path.join(backupPath, dbName);
    
    if (!fs.existsSync(dbBackupPath)) {
      console.error(`❌ 错误: 备份中没有找到数据库 ${dbName}！`);
      console.error(`   期望路径: ${dbBackupPath}\n`);
      process.exit(1);
    }

    console.log('📊 导入信息:');
    console.log(`   源备份: ${backupPath}`);
    console.log(`   目标数据库: ${dbName}`);
    console.log(`   MongoDB URI: ${mongoUri.replace(/\/\/.*@/, '//***:***@')}\n`);

    // 统计备份中的集合
    const files = fs.readdirSync(dbBackupPath);
    const bsonFiles = files.filter(f => f.endsWith('.bson'));
    console.log(`📊 备份中包含 ${bsonFiles.length} 个集合\n`);

    if (!isForced) {
      console.log('⚠️  警告: 如果目标数据库已存在，同名集合将被覆盖！\n');
      console.log('如果确定要导入，请使用以下命令:');
      console.log(`   node scripts/importDatabase.js --force --backup=${backupPath}\n`);
      process.exit(0);
    }

    console.log('🚀 开始导入数据库...\n');

    // 构建 mongorestore 命令参数
    // 直接导入到指定数据库，避免使用 nsInclude 参数
    const restoreArgs = [
      '--db', dbName,
      dbBackupPath,
      '--drop'  // 导入前先删除已存在的集合，避免冲突
    ];
    
    // 如果需要指定 URI（远程数据库），添加 URI 参数
    if (mongoUri.includes('@') || !mongoUri.includes('localhost')) {
      restoreArgs.unshift('--uri', mongoUri);
      // 移除 --db 参数，因为 --uri 和 --db 可能冲突
      const dbIndex = restoreArgs.indexOf('--db');
      if (dbIndex !== -1) {
        restoreArgs.splice(dbIndex, 2);
      }
      // 添加 nsInclude 来指定数据库
      restoreArgs.push('--nsInclude', `${dbName}.*`);
    }

    console.log('💡 执行命令:', 'mongorestore', restoreArgs.join(' '), '\n');

    // 使用 spawn 执行导入命令（支持大数据量，无 buffer 限制）
    const mongorestore = spawn('mongorestore', restoreArgs);

    let hasError = false;

    // 实时输出标准输出
    mongorestore.stdout.on('data', (data) => {
      process.stdout.write(data);
    });

    // 实时输出错误信息
    mongorestore.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    // 监听错误事件
    mongorestore.on('error', (error) => {
      console.error('\n❌ 数据库导入失败:', error.message);
      console.error('\n💡 可能的原因:');
      console.error('   1. MongoDB 服务未启动');
      console.error('   2. mongorestore 命令未找到（请运行 checkMongoTools.bat 检测）');
      console.error('   3. 备份文件损坏或路径不正确');
      console.error('   4. 数据库连接失败\n');
      hasError = true;
      process.exit(1);
    });

    // 监听完成事件
    mongorestore.on('close', (code) => {
      if (code !== 0 && !hasError) {
        console.error(`\n❌ 导入进程退出，错误码: ${code}\n`);
        process.exit(1);
      } else if (code === 0) {
        console.log('\n✅ 数据库导入成功！\n');
        console.log('💡 提示:');
        console.log(`   - 数据已成功导入到数据库: ${dbName}`);
        console.log('   - 请检查应用程序配置，确保连接正确的数据库');
        console.log('   - 建议重启应用程序以确保连接新数据库\n');
      }
    });

  } catch (error) {
    console.error('❌ 导入过程出错:', error);
    process.exit(1);
  }
}

// 执行导入
importDatabase();
