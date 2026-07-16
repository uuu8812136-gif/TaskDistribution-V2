@echo off
chcp 65001 >nul
echo.
echo ====================================
echo    任务分配系统 - 快速安装
echo ====================================
echo.

REM 检查 Node.js 是否安装
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js
    echo 📥 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

echo ✅ Node.js 已安装
node --version
echo.

REM 检查 .env 文件是否存在
if exist .env (
    echo ✅ .env 配置文件已存在
) else (
    echo 📝 创建 .env 配置文件...
    (
        echo # 服务器配置
        echo PORT=8099
        echo NODE_ENV=development
        echo.
        echo # MongoDB 配置
        echo MONGODB_URI=mongodb://localhost:27017/task_distribution
        echo.
        echo # JWT 配置
        echo JWT_SECRET=your_jwt_secret_key_here_please_change_in_production
        echo JWT_EXPIRE=7d
        echo.
        echo # 文件上传配置
        echo MAX_FILE_SIZE=10485760
    ) > .env
    echo ✅ .env 文件创建成功
)
echo.

REM 安装依赖
echo 📦 安装依赖包...
call npm install
if %errorlevel% neq 0 (
    echo ❌ 依赖安装失败
    pause
    exit /b 1
)
echo ✅ 依赖安装完成
echo.

REM 创建 uploads 目录
if not exist uploads (
    mkdir uploads
    echo ✅ 创建 uploads 目录
)

echo.
echo ====================================
echo    安装完成！
echo ====================================
echo.
echo 📋 下一步操作：
echo.
echo 1️⃣  启动 MongoDB 服务
echo    net start MongoDB
echo.
echo 2️⃣  检查数据库连接
echo    npm run check
echo.
echo 3️⃣  初始化数据库
echo    npm run init
echo.
echo 4️⃣  启动开发服务器
echo    npm run dev
echo.
echo 📖 详细文档请查看 QUICKSTART.md
echo.
pause

