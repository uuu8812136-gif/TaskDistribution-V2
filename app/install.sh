#!/bin/bash

echo ""
echo "===================================="
echo "   任务分配系统 - 快速安装"
echo "===================================="
echo ""

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js"
    echo "📥 下载地址: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js 已安装"
node --version
echo ""

# 检查 .env 文件是否存在
if [ -f .env ]; then
    echo "✅ .env 配置文件已存在"
else
    echo "📝 创建 .env 配置文件..."
    cat > .env << 'EOF'
# 服务器配置
PORT=8099
NODE_ENV=development

# MongoDB 配置
MONGODB_URI=mongodb://localhost:27017/task_distribution

# JWT 配置
JWT_SECRET=your_jwt_secret_key_here_please_change_in_production
JWT_EXPIRE=7d

# 文件上传配置
MAX_FILE_SIZE=10485760
EOF
    echo "✅ .env 文件创建成功"
fi
echo ""

# 安装依赖
echo "📦 安装依赖包..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败"
    exit 1
fi
echo "✅ 依赖安装完成"
echo ""

# 创建 uploads 目录
if [ ! -d uploads ]; then
    mkdir uploads
    echo "✅ 创建 uploads 目录"
fi

echo ""
echo "===================================="
echo "   安装完成！"
echo "===================================="
echo ""
echo "📋 下一步操作："
echo ""
echo "1️⃣  启动 MongoDB 服务"
echo "   sudo systemctl start mongod  # Linux"
echo "   brew services start mongodb  # macOS"
echo ""
echo "2️⃣  检查数据库连接"
echo "   npm run check"
echo ""
echo "3️⃣  初始化数据库"
echo "   npm run init"
echo ""
echo "4️⃣  启动开发服务器"
echo "   npm run dev"
echo ""
echo "📖 详细文档请查看 QUICKSTART.md"
echo ""

