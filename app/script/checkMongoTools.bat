@echo off
chcp 65001 >nul
echo ================================================
echo MongoDB 工具检测
echo ================================================
echo.

echo 🔍 正在检测 MongoDB 命令行工具...
echo.

REM 检测 mongorestore
echo [1/3] 检测 mongorestore...
where mongorestore >nul 2>&1
if %errorlevel%==0 (
    echo ✅ mongorestore 已安装并在 PATH 中
    mongorestore --version 2>nul | findstr "version"
) else (
    echo ❌ mongorestore 未在 PATH 中找到
    
    REM 检查常见安装路径
    echo.
    echo 🔍 检查常见安装路径...
    
    if exist "C:\Program Files\MongoDB\Server\7.0\bin\mongorestore.exe" (
        echo ✅ 找到: C:\Program Files\MongoDB\Server\7.0\bin\mongorestore.exe
    ) else if exist "C:\Program Files\MongoDB\Server\6.0\bin\mongorestore.exe" (
        echo ✅ 找到: C:\Program Files\MongoDB\Server\6.0\bin\mongorestore.exe
    ) else if exist "C:\Program Files\MongoDB\Server\5.0\bin\mongorestore.exe" (
        echo ✅ 找到: C:\Program Files\MongoDB\Server\5.0\bin\mongorestore.exe
    ) else if exist "C:\Program Files\MongoDB\Server\4.4\bin\mongorestore.exe" (
        echo ✅ 找到: C:\Program Files\MongoDB\Server\4.4\bin\mongorestore.exe
    ) else if exist "C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe" (
        echo ✅ 找到: C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe
    ) else (
        echo ❌ 未在常见路径找到 mongorestore
    )
)

echo.
echo [2/3] 检测 mongodump...
where mongodump >nul 2>&1
if %errorlevel%==0 (
    echo ✅ mongodump 已安装并在 PATH 中
    mongodump --version 2>nul | findstr "version"
) else (
    echo ❌ mongodump 未在 PATH 中找到
)

echo.
echo [3/3] 检测 MongoDB 服务...
sc query MongoDB >nul 2>&1
if %errorlevel%==0 (
    echo ✅ MongoDB 服务已安装
    sc query MongoDB | findstr "STATE"
) else (
    echo ⚠️  MongoDB 服务未找到（可能使用其他名称或手动启动）
)

echo.
echo ================================================
echo 检测完成
echo ================================================
echo.

echo 💡 如果 mongorestore 未找到，请:
echo    1. 下载 MongoDB Database Tools:
echo       https://www.mongodb.com/try/download/database-tools
echo.
echo    2. 解压后将 bin 目录添加到系统 PATH 环境变量
echo       例如: C:\mongodb-database-tools\bin
echo.
echo    3. 或者运行修复后的 importDatabase.js 脚本
echo       它会自动查找常见安装路径
echo.

pause
