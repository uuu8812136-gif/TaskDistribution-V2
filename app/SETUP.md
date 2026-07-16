# 数据库初始化指南

## 前置要求

1. **安装 MongoDB**
   - Windows: 下载并安装 [MongoDB Community Server](https://www.mongodb.com/try/download/community)
   - 启动 MongoDB 服务

2. **安装 Node.js 依赖**
   ```bash
   npm install
   ```

## 配置步骤

### 1. 配置环境变量

复制 `.env.example` 文件为 `.env`：

```bash
copy .env.example .env
```

编辑 `.env` 文件，根据你的实际情况修改配置：

```env
# MongoDB 连接地址（默认本地）
MONGODB_URI=mongodb://localhost:27017/task_distribution

# JWT 密钥（生产环境请修改）
JWT_SECRET=your_jwt_secret_key_here_please_change_in_production
```

### 2. 启动 MongoDB

确保 MongoDB 服务正在运行：

**Windows:**
```bash
# 方法1: 如果已安装为服务
net start MongoDB

# 方法2: 手动启动
mongod
```

**检查 MongoDB 是否运行:**
```bash
mongo --eval "db.version()"
```

### 3. 初始化数据库

#### 方式一: 首次初始化（推荐）
```bash
npm run init
```

这个命令会：
- ✅ 连接到 MongoDB
- ✅ 创建数据库和集合
- ✅ 创建索引
- ✅ 创建测试用户（如果不存在）
- ✅ 创建测试任务（如果不存在）

#### 方式二: 清空并重新初始化
```bash
npm run init:clear
```

⚠️ **警告**: 这个命令会删除所有现有数据！

### 4. 启动服务器

```bash
npm run dev
```

服务器将在 `http://localhost:8099` 启动

## 测试账号

初始化后，系统会创建以下测试账号：

| 用户名 | 密码 | 角色 | 部门 |
|--------|------|------|------|
| admin | 123456 | 管理员 + 执行人 + 抄送人 | 管理部 |
| zhangsan | 123456 | 执行人 | 技术部 |
| lisi | 123456 | 执行人 | 技术部 |
| wangwu | 123456 | 执行人 + 抄送人 | 产品部 |
| zhaoliu | 123456 | 抄送人 | 测试部 |

## 常见问题

### 1. MongoDB 连接失败

**错误信息:**
```
❌ MongoDB连接失败: connect ECONNREFUSED 127.0.0.1:27017
```

**解决方案:**
- 确认 MongoDB 服务是否已启动
- 检查 MongoDB 端口是否为 27017
- 检查防火墙设置

### 2. MONGODB_URI 未定义

**错误信息:**
```
❌ MongoDB连接失败: The `uri` parameter to `openUri()` must be a string, got "undefined"
```

**解决方案:**
- 确认是否创建了 `.env` 文件
- 确认 `.env` 文件中是否配置了 `MONGODB_URI`
- 重启服务器

### 3. 用户已存在

初始化脚本会自动检查用户是否存在，不会重复创建。

### 4. 清空数据

如果需要清空所有数据并重新初始化：

```bash
npm run init:clear
```

## API 测试

使用以下命令测试 API 是否正常：

```bash
# 测试服务器状态
curl http://localhost:8099

# 测试登录
curl -X POST http://localhost:8099/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"123456\"}"
```

## 下一步

1. 查看 `API.md` 了解所有可用的 API 接口
2. 查看 `README.md` 了解项目详细信息
3. 查看 `QUICKSTART.md` 了解快速开始指南

## 备份数据

如果需要备份数据库：

```bash
# 备份
mongodump --db task_distribution --out ./backup

# 恢复
mongorestore --db task_distribution ./backup/task_distribution
```

