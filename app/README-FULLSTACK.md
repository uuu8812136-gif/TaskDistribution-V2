# 任务分配管理系统 - 完整项目

完整的任务分配管理系统，包含后端API和前端管理界面。

## 🎯 项目说明

本系统用于企业内部的任务分配和管理，支持：
- 多角色权限管理（管理员、执行人、抄送人）
- 任务创建、分配、跟踪
- 子任务管理
- 任务审核流程
- 延期申请与审批
- 消息通知
- 数据统计与导出

## 📁 项目结构

```
TaskDistribution/
├── backend/                    # 后端 (Node.js + Express + MongoDB)
│   ├── controllers/            # 控制器
│   ├── models/                 # 数据模型
│   ├── routes/                 # 路由
│   ├── middlewares/            # 中间件
│   ├── utils/                  # 工具函数
│   ├── server.js               # 服务器入口
│   ├── init-db.js              # 数据库初始化
│   └── package.json
│
└── frontend/                   # 前端 (Vue 3 + Element Plus)
    ├── src/
    │   ├── api/                # API接口
    │   ├── assets/             # 静态资源
    │   ├── layouts/            # 布局组件
    │   ├── router/             # 路由
    │   ├── stores/             # 状态管理
    │   ├── utils/              # 工具函数
    │   ├── views/              # 页面组件
    │   └── main.js
    ├── index.html
    ├── vite.config.js
    └── package.json
```

## 🚀 快速开始

### 前置要求

- Node.js >= 14.x
- MongoDB >= 4.x
- npm 或 yarn

### 1. 启动 MongoDB

```bash
# Windows
net start MongoDB

# Linux/macOS
sudo systemctl start mongod
```

### 2. 后端启动

```bash
# 进入后端目录
cd TaskDistribution

# 安装依赖（如果未安装）
npm install

# 检查数据库连接
npm run check

# 初始化数据库
npm run init

# 启动后端服务
npm run dev
```

后端将运行在 `http://localhost:8099`

### 3. 前端启动

新开一个终端窗口：

```bash
# 进入前端目录
cd TaskDistribution/frontend

# 安装依赖
npm install

# 启动前端开发服务器
npm run dev
```

前端将运行在 `http://localhost:3001`

### 4. 访问系统

打开浏览器访问：`http://localhost:3001`

测试账号：
- 管理员：`admin / 123456`
- 执行人：`zhangsan / 123456`
- 抄送人：`zhaoliu / 123456`

## 📝 功能模块

### 后端 API

- ✅ 用户认证与管理
- ✅ 任务CRUD操作
- ✅ 任务流程管理（完成、审核、确认）
- ✅ 子任务支持
- ✅ 延期申请与审批
- ✅ 消息通知系统
- ✅ 统计与Excel导出
- ✅ 文件上传

### 前端界面

- ✅ 登录页面
- ✅ 统计看板（数据卡片、图表）
- ✅ 用户管理（增删改查）
- ✅ 任务管理
  - 全部任务列表
  - 我的任务（Tab切换）
  - 任务看板视图
  - 任务详情
  - 创建/编辑任务（分步表单）
- ✅ 延期管理（申请、审批）
- ✅ 消息中心
- ✅ 个人中心

## 🛠️ 技术栈

### 后端
- Node.js + Express
- MongoDB + Mongoose
- JWT 认证
- Multer（文件上传）
- XLSX（Excel导出）

### 前端
- Vue 3 (Composition API)
- Vite
- Element Plus
- Vue Router
- Pinia
- Axios
- ECharts

## 📖 文档

- [后端 API 文档](./API.md)
- [快速开始指南](./QUICKSTART.md)
- [数据库配置指南](./SETUP.md)
- [前端说明](./frontend/README.md)

## 🔧 开发命令

### 后端

```bash
npm run dev         # 启动开发服务器
npm run check       # 检查MongoDB连接
npm run init        # 初始化数据库
npm run init:clear  # 清空并重新初始化
```

### 前端

```bash
npm run dev         # 启动开发服务器
npm run build       # 构建生产版本
npm run preview     # 预览生产构建
```

## 🐛 常见问题

### 1. MongoDB 连接失败

确保 MongoDB 服务已启动，并检查 `.env` 文件中的 `MONGODB_URI` 配置。

### 2. 前端无法访问后端

检查后端是否在 8099 端口运行，前端代理配置是否正确。

### 3. 登录后白屏

检查浏览器控制台错误，可能是路由配置或权限问题。

## 📄 License

MIT

## 👨‍💻 开发者

开发完成时间：2025-12-15

---

**状态**: ✅ 开发完成，可投入使用

