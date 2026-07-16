# 快速开始指南

## 🚀 三步启动项目

### 第一步：检查 MongoDB 连接

```bash
npm run check
```

这个命令会：
- ✅ 检查 .env 配置是否正确
- ✅ 测试 MongoDB 连接
- ✅ 显示数据库状态

**如果连接失败，请参考输出的错误提示进行排查。**

### 第二步：初始化数据库

```bash
npm run init
```

这个命令会：
- ✅ 创建数据库和集合
- ✅ 创建索引
- ✅ 创建测试用户和任务

**如果需要清空重建，使用:** `npm run init:clear`

### 第三步：启动服务器

```bash
npm run dev
```

服务器将在 `http://localhost:8099` 启动

## 📝 测试账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | 123456 | 管理员 |
| zhangsan | 123456 | 执行人 |
| lisi | 123456 | 执行人 |

## 🧪 测试 API

### 1. 测试服务器状态
```bash
curl http://localhost:8099
```

### 2. 用户登录
```bash
curl -X POST http://localhost:8099/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"123456\"}"
```

### 3. 获取任务列表（需要登录后的 token）
```bash
curl http://localhost:8099/api/tasks -H "Authorization: Bearer YOUR_TOKEN"
```

## 📚 更多文档

- `SETUP.md` - 详细的配置指南
- `API.md` - API 接口文档
- `README.md` - 项目说明

## 🆘 常见问题

### MongoDB 连接失败？

1. 确认 MongoDB 是否已启动
   ```bash
   net start MongoDB
   ```

2. 检查 .env 文件是否存在并配置正确

3. 运行诊断命令
   ```bash
   npm run check
   ```

### 没有 .env 文件？

复制示例文件：
```bash
copy .env.example .env
```

然后根据实际情况修改配置。

## 🎯 开发流程

1. **启动开发服务器**
   ```bash
   npm run dev
   ```

2. **修改代码**
   - 后端代码在 `controllers/`、`models/`、`routes/` 目录
   - nodemon 会自动重启服务器

3. **测试 API**
   - 使用 Postman、Thunder Client 或 curl
   - 参考 `API.md` 文档

4. **查看日志**
   - 服务器会在终端输出日志
   - MongoDB 查询日志会显示执行的操作

## 💡 有用的命令

```bash
# 检查 MongoDB 连接
npm run check

# 初始化数据库（保留现有数据）
npm run init

# 清空并重新初始化
npm run init:clear

# 启动开发服务器
npm run dev

# 启动生产服务器
npm start
```

## 🔧 故障排除

如果遇到问题：

1. **先运行检查命令**
   ```bash
   npm run check
   ```

2. **查看详细错误信息**
   - 终端会显示详细的错误信息和解决建议

3. **查看文档**
   - `SETUP.md` 有详细的配置说明
   - 包含常见问题和解决方案

4. **重新初始化**
   ```bash
   npm run init:clear
   ```

---

**准备好了吗？开始第一步吧！** 🚀

```bash
npm run check
```
