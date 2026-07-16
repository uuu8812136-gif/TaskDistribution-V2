# 任务分配管理系统 - 后端API

## 📋 项目简介
基于 Node.js + Express + MongoDB 的任务分配管理系统后端API，支持单人任务、团队任务、子任务、延期申请等完整的任务管理流程。

## ✨ 功能特性

### 核心功能
- ✅ **用户认证系统**：账号密码登录、JWT Token认证
- ✅ **多角色管理**：管理员、执行人、抄送人三种角色
- ✅ **任务管理**：创建、分配、查询、更新、删除
- ✅ **子任务支持**：主任务可创建多个子任务
- ✅ **团队任务**：支持多人协作，指定主负责人
- ✅ **任务流程**：完成→审核→确认的完整流程
- ✅ **延期申请**：支持延期申请、审批、历史记录（核心功能）
- ✅ **文件上传**：支持图片、文档等附件上传
- ✅ **统计导出**：任务统计、人员统计Excel导出
- ✅ **权限控制**：基于角色的细粒度权限管理

### 延期申请功能详解（新增）
- 📅 支持主任务和子任务延期
- ⏰ 延期天数可选：3/5/7/10天或自定义
- 👤 只有主负责人可申请延期
- 🔒 每个任务只能申请一次延期
- 📝 完整的延期审批流程
- 📊 延期历史记录追踪
- 🔄 主任务延期自动同步所有子任务

## 🛠️ 技术栈

### 后端框架
- **Node.js** (v14+)
- **Express** (4.18.2)
- **MongoDB** (4.x+)
- **Mongoose** (8.0.3)

### 核心依赖
- **bcryptjs**: 密码加密
- **jsonwebtoken**: JWT认证
- **multer**: 文件上传
- **xlsx**: Excel导出
- **express-validator**: 数据验证
- **cors**: 跨域支持
- **dotenv**: 环境变量管理

## 🚀 快速开始

### 方式一：一键安装（推荐）

**Windows:**
```bash
install.bat
```

**macOS/Linux:**
```bash
chmod +x install.sh
./install.sh
```

安装脚本会自动：
- ✅ 检查 Node.js 环境
- ✅ 创建 .env 配置文件
- ✅ 安装所有依赖包
- ✅ 创建必要的目录

### 方式二：手动安装

#### 1. 环境准备
```bash
# 确保已安装 Node.js (>= 14.x)
node --version

# 确保已安装 MongoDB (>= 4.x)
mongod --version
```

#### 2. 安装依赖
```bash
npm install
```

#### 3. 配置环境变量
手动创建 `.env` 文件，内容如下：
```env
PORT=8099
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/task_distribution
JWT_SECRET=your_jwt_secret_key_here_please_change_in_production
JWT_EXPIRE=7d
MAX_FILE_SIZE=10485760
```

#### 4. 启动 MongoDB
```bash
# Windows
net start MongoDB
# 或
mongod

# macOS/Linux  
sudo systemctl start mongod
```

#### 5. 检查数据库连接
```bash
npm run check
```

#### 6. 初始化数据库
```bash
# 首次初始化（保留现有数据）
npm run init

# 清空并重新初始化
npm run init:clear
```

生成的测试账号：
- 管理员：`admin` / `123456` (拥有所有权限)
- 执行人：`zhangsan` / `123456` (技术部)
- 执行人：`lisi` / `123456` (技术部)
- 执行人+抄送：`wangwu` / `123456` (产品部)
- 抄送人：`zhaoliu` / `123456` (测试部)

#### 7. 启动项目
```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm start
```

服务器将运行在：`http://localhost:8099`

### 📋 可用命令

```bash
npm run check        # 检查 MongoDB 连接
npm run init         # 初始化数据库（保留现有数据）
npm run init:clear   # 清空并重新初始化数据库
npm run dev          # 启动开发服务器
npm start            # 启动生产服务器
npm run seed         # 旧的初始化脚本（已被 init 替代）
```

## 📁 项目结构
```
TaskDistribution/
├── models/              # 数据模型
│   ├── User.js         # 用户模型
│   ├── Task.js         # 任务模型
│   ├── ExtensionRequest.js  # 延期申请模型
│   └── TaskReview.js   # 任务评价模型
├── controllers/         # 控制器
│   ├── authController.js
│   ├── userController.js
│   ├── taskController.js
│   ├── taskFlowController.js
│   ├── extensionController.js
│   └── statisticsController.js
├── routes/              # 路由
│   ├── auth.js
│   ├── users.js
│   ├── tasks.js
│   ├── extensions.js
│   └── statistics.js
├── middlewares/         # 中间件
│   ├── auth.js         # 认证中间件
│   └── upload.js       # 文件上传中间件
├── utils/               # 工具函数
│   └── jwt.js
├── uploads/             # 上传文件目录
├── server.js            # 入口文件
├── seed.js              # 旧的测试数据脚本
├── init-db.js           # 数据库初始化脚本（推荐使用）
├── check-db.js          # 数据库连接检查脚本
├── install.bat          # Windows 一键安装脚本
├── install.sh           # Linux/macOS 一键安装脚本
├── package.json
├── .env.example         # 环境变量示例
├── README.md            # 项目说明
├── QUICKSTART.md        # 快速开始指南（三步启动）
├── SETUP.md             # 详细配置指南
├── API.md               # API接口文档
└── PROJECT_SUMMARY.md   # 项目总结
```

## 📖 文档

- **[QUICKSTART.md](./QUICKSTART.md)** - 快速开始指南（三步启动）
- **[SETUP.md](./SETUP.md)** - 详细的安装配置指南
- **[API.md](./API.md)** - 完整的 API 接口文档
- **[PROJECT_SUMMARY.md](./PROJECT_SUMMARY.md)** - 项目总结

## 🔄 任务流程

### 完整流程图
```
1. 管理员创建任务（单人/团队/子任务）
   ↓
2. 分配执行人和抄送人
   ↓
3. 任务进行中
   ↓
4. [可选] 申请延期
   - 主负责人提交申请
   - 管理员审批（同意/拒绝）
   - 批准后延长时间
   ↓
5. 执行人完成任务
   - 子任务必须全部完成
   ↓
6. 抄送人审核
   - 任意一个审核即可
   - 可添加评价和评分
   ↓
7. 管理员最终确认
   ↓
8. 任务完结
```

## 📊 数据模型

### 用户 (User)
- 基本信息：用户名、密码、姓名、手机、邮箱
- 角色：admin（管理员）、executor（执行人）、cc（抄送人）
- 部门、状态、头像等

### 任务 (Task)
- 基本信息：任务名称、类型、来源、描述
- 人员：创建者、执行人、主负责人、抄送人
- 时间：开始时间、计划完成时间、实际完成时间
- 状态：9种状态覆盖完整流程
- 子任务：支持父子任务关联
- 附件：支持多文件上传

### 延期申请 (ExtensionRequest)
- 申请信息：申请人、原因、申请时间、请求天数
- 审批信息：审批人、审批结果、审批时间、批准天数
- 关联：任务ID、申请类型（主任务/子任务）

### 任务评价 (TaskReview)
- 评价信息：评价人、内容、评分、结果
- 关联：任务ID

## 🔐 权限说明

### 管理员 (admin)
- ✅ 创建、修改、删除任务
- ✅ 管理用户
- ✅ 审批延期申请
- ✅ 确认任务完成
- ✅ 查看所有任务和统计
- ✅ 导出Excel报表

### 执行人 (executor)
- ✅ 查看分配给自己的任务
- ✅ 完成任务
- ✅ 申请延期（如果是主负责人）
- ❌ 不能创建任务
- ❌ 不能审核任务

### 抄送人 (cc)
- ✅ 查看抄送给自己的任务
- ✅ 审核任务（监督）
- ✅ 添加评价和评分
- ❌ 不能完成任务
- ❌ 不能申请延期

## 🧪 接口测试

### 使用 Postman/Apifox

1. **登录获取 Token**
```http
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "123456"
}
```

2. **复制返回的 token**

3. **在后续请求中添加 Header**
```
Authorization: Bearer {你的token}
```

4. **测试其他接口**
详见 [API.md](./API.md)

## 📈 统计功能

### 统计概览
- 任务总数、进行中、已完成、延期数量
- 待审核、待确认任务数
- 用户总数、任务完成率

### Excel 导出
- **任务统计表**：包含任务详情、子任务、审核记录、延期信息
- **人员统计表**：包含每个用户的任务执行情况、完成率、绩效数据

## ⚙️ 环境变量配置

```env
# 服务器配置
PORT=3000
NODE_ENV=development

# MongoDB配置
MONGODB_URI=mongodb://localhost:27017/task_distribution

# JWT配置（生产环境请修改！）
JWT_SECRET=your_jwt_secret_key_change_in_production
JWT_EXPIRE=7d

# 文件上传配置
UPLOAD_PATH=./uploads
MAX_FILE_SIZE=10485760
```

## 🐛 常见问题

### Q1: MongoDB 连接失败
**错误**: `The uri parameter to openUri() must be a string, got "undefined"`
```bash
# 1. 确保 .env 文件存在
# 2. 检查 MONGODB_URI 配置
# 3. 运行诊断命令
npm run check
```

### Q2: MongoDB 服务未启动
**错误**: `connect ECONNREFUSED 127.0.0.1:27017`
```bash
# Windows
net start MongoDB

# Linux/macOS
sudo systemctl start mongod
```

### Q3: 端口被占用
**A**: 修改 `.env` 中的 `PORT` 配置（默认 8099）

### Q4: JWT Token 失效
**A**: Token 默认有效期7天，过期后需要重新登录

### Q5: 文件上传失败
**A**: 确保 `uploads` 目录存在且有写入权限

### Q6: completeTask is not defined
**A**: 此错误已在最新版本修复，确保使用最新代码

更多问题请查看 [SETUP.md](./SETUP.md) 中的详细排查指南。

## 🔧 后续优化建议

### 功能扩展
- [ ] 任务评论功能
- [ ] 消息通知系统（邮件/站内信）
- [ ] 任务甘特图
- [ ] 任务模板
- [ ] 批量操作

### 性能优化
- [ ] Redis 缓存
- [ ] 接口限流
- [ ] 数据库索引优化

### 安全加固
- [ ] 请求频率限制
- [ ] XSS/CSRF 防护
- [ ] 日志审计

## 📝 更新日志

### v1.0.0 (2025-12-15)
- ✅ 完成所有核心功能开发
- ✅ 实现延期申请功能
- ✅ 完成API文档编写
- ✅ 添加测试数据脚本

## 👨‍💻 开发团队

开发完成时间：2025-12-15

## 📄 License

MIT

---

**开发状态**: ✅ 已完成，可投入使用
**版本**: v1.0.0

