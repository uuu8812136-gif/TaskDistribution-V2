/**
 * MongoDB 连接测试脚本
 * 用于检查 MongoDB 是否正常运行和配置是否正确
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function checkMongoDB() {
  console.log('\n🔍 检查 MongoDB 连接...\n');
  
  try {
    // 获取连接字符串
    const mongoUri = process.env.MONGODB_URI;
    
    if (!mongoUri) {
      console.error('❌ 错误: MONGODB_URI 未在 .env 文件中配置');
      console.log('\n💡 解决方案:');
      console.log('   1. 确认是否存在 .env 文件');
      console.log('   2. 在 .env 文件中添加: MONGODB_URI=mongodb://localhost:27017/task_distribution');
      console.log('   3. 参考 .env.example 文件\n');
      process.exit(1);
    }
    
    console.log(`📡 连接地址: ${mongoUri}`);
    console.log('⏳ 正在连接...\n');
    
    // 尝试连接
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000 // 5秒超时
    });
    
    console.log('✅ MongoDB 连接成功！\n');
    
    // 获取数据库信息
    const db = mongoose.connection.db;
    const admin = db.admin();
    const info = await admin.serverInfo();
    
    console.log('📊 MongoDB 服务器信息:');
    console.log(`   版本: ${info.version}`);
    console.log(`   数据库名: ${db.databaseName}`);
    
    // 列出所有集合
    const collections = await db.listCollections().toArray();
    console.log(`\n📁 现有集合 (${collections.length}):`);
    if (collections.length === 0) {
      console.log('   (暂无集合，数据库为空)');
    } else {
      for (const coll of collections) {
        const count = await db.collection(coll.name).countDocuments();
        console.log(`   - ${coll.name}: ${count} 条记录`);
      }
    }
    
    console.log('\n✅ 检查完成！MongoDB 运行正常。');
    console.log('\n💡 下一步:');
    console.log('   - 运行 npm run init 初始化数据库');
    console.log('   - 运行 npm run dev 启动开发服务器\n');
    
    await mongoose.connection.close();
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ MongoDB 连接失败！\n');
    console.error('错误信息:', error.message);
    
    console.log('\n💡 常见问题排查:\n');
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('❌ 无法连接到 MongoDB 服务器');
      console.log('\n解决方案:');
      console.log('   1. 确认 MongoDB 是否已启动:');
      console.log('      Windows: net start MongoDB');
      console.log('      或手动启动: mongod');
      console.log('   2. 检查端口是否正确（默认 27017）');
      console.log('   3. 检查防火墙设置');
    } else if (error.message.includes('authentication failed')) {
      console.log('❌ 认证失败');
      console.log('\n解决方案:');
      console.log('   1. 检查 MONGODB_URI 中的用户名和密码');
      console.log('   2. 确认用户在 MongoDB 中是否存在');
      console.log('   3. 如果不需要认证，使用: mongodb://localhost:27017/task_distribution');
    } else if (error.message.includes('timeout')) {
      console.log('❌ 连接超时');
      console.log('\n解决方案:');
      console.log('   1. 检查网络连接');
      console.log('   2. 确认 MongoDB 服务器地址是否正确');
      console.log('   3. 如果是远程服务器，检查防火墙和安全组设置');
    } else {
      console.log('其他错误，请检查:');
      console.log('   1. .env 文件中的 MONGODB_URI 配置');
      console.log('   2. MongoDB 服务状态');
      console.log('   3. 网络连接');
    }
    
    console.log('\n📖 详细配置指南请查看: SETUP.md\n');
    
    process.exit(1);
  }
}

checkMongoDB();

