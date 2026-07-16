# 🚀 快速启动指南

## 一键启动（推荐）

### Windows 用户

1. **确保 MongoDB 已启动**
```cmd
net start MongoDB
```

2. **启动后端**（在 TaskDistribution 目录）
```cmd
npm run dev
```

3. **启动前端**（新开终端，在 TaskDistribution/frontend 目录）
```cmd
npm run dev
```

4. **访问系统**
打开浏览器：http://localhost:3001

测试账号：`admin / 123456`

---

## 详细步骤

### 步骤 1：环境检查

```bash
# 检查 Node.js
node --version     # 应该 >= 14.x

# 检查 MongoDB
mongod --version   # 应该 >= 4.x
```

### 步骤 2：后端配置

```bash
cd TaskDistribution

# 首次运行需要安装依赖
npm install

# 检查数据库连接
npm run check

# 初始化数据库（首次运行或重置数据时）
npm run init

# 启动后端
npm run dev
```

看到以下输出表示成功：
```
✅ MongoDB连接成功
🚀 服务器运行在端口 8099
```

### 步骤 3：前端配置

**新开一个终端窗口：**

```bash
cd TaskDistribution/frontend

# 首次运行需要安装依赖
npm install

# 启动前端
npm run dev
```

看到以下输出表示成功：
```
VITE v5.x.x  ready in xxx ms

➜  Local:   http://localhost:3001/
```

### 步骤 4：登录测试

访问 http://localhost:3001

使用测试账号登录：
- **管理员**：`admin / 123456`（全部权限）
- **执行人**：`zhangsan / 123456`
- **抄送人**：`zhaoliu / 123456`

---

## 🎯 功能测试清单

登录后可以测试以下功能：

### 管理员账号（admin）
- [x] 查看统计看板
- [x] 管理用户（增删改查）
- [x] 创建任务
- [x] 查看所有任务
- [x] 审批延期申请
- [x] 确认任务完成
- [x] 查看消息通知

### 执行人账号（zhangsan）
- [x] 查看我的任务
- [x] 完成任务
- [x] 申请延期
- [x] 查看消息通知

### 抄送人账号（zhaoliu）
- [x] 查看抄送的任务
- [x] 审核任务
- [x] 添加评价和评分
- [x] 查看消息通知

---

## ⚠️ 故障排除

### 问题 1：MongoDB 连接失败

**错误信息**：`MongoDB连接失败`

**解决方法**：
1. 确认 MongoDB 服务是否启动
   ```bash
   # Windows
   net start MongoDB
   
   # Linux/macOS
   sudo systemctl status mongod
   ```

2. 检查 `.env` 文件中的 `MONGODB_URI` 配置
   ```
   MONGODB_URI=mongodb://localhost:27017/task_distribution
   ```

### 问题 2：端口被占用

**错误信息**：`Port 8099 is already in use`

**解决方法**：
- 修改后端端口：在 `.env` 文件中修改 `PORT=8099` 为其他端口
- 或杀死占用端口的进程

### 问题 3：前端无法连接后端

**错误信息**：`Network Error` 或 `ERR_CONNECTION_REFUSED`

**解决方法**：
1. 确认后端已启动（访问 http://localhost:8099 应该返回 JSON）
2. 检查前端代理配置（`frontend/vite.config.js`）

### 问题 4：登录后白屏

**解决方法**：
1. 打开浏览器控制台查看错误
2. 清除浏览器缓存和 localStorage
3. 确认后端 API 正常运行

---

## 📞 需要帮助？

1. 查看完整文档：[README-FULLSTACK.md](./README-FULLSTACK.md)
2. 查看 API 文档：[API.md](./API.md)
3. 查看配置指南：[SETUP.md](./SETUP.md)

---

**开发完成时间**：2025-12-15
**版本**：v1.0.0
**状态**：✅ 可用

