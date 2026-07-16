# 任务分配管理系统 - 前端

基于 Vue 3 + Element Plus 的后台管理界面

## 技术栈

- Vue 3
- Vite
- Element Plus
- Vue Router
- Pinia
- Axios
- ECharts
- Day.js

## 安装依赖

```bash
cd frontend
npm install
```

## 开发

```bash
npm run dev
```

访问：http://localhost:3001

## 构建

```bash
npm run build
```

## 测试账号

- 管理员: admin / 123456
- 执行人: zhangsan / 123456
- 抄送人: zhaoliu / 123456

## 功能模块

- ✅ 登录认证
- ✅ 统计看板
- ✅ 用户管理（管理员）
- ✅ 任务管理（列表、详情、创建、编辑、看板）
- ✅ 我的任务
- ✅ 延期管理
- ✅ 消息通知
- ✅ 个人中心

## 项目结构

```
frontend/
├── src/
│   ├── api/          # API接口
│   ├── assets/       # 静态资源
│   ├── layouts/      # 布局组件
│   ├── router/       # 路由配置
│   ├── stores/       # 状态管理
│   ├── utils/        # 工具函数
│   ├── views/        # 页面组件
│   ├── App.vue       # 根组件
│   └── main.js       # 入口文件
├── index.html
├── package.json
└── vite.config.js
```

## 注意事项

1. 确保后端服务已启动（端口 8099）
2. 前端开发服务器端口为 3001
3. 已配置代理，API请求自动转发到后端

