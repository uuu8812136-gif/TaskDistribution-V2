# 任务分配管理系统 API 文档

## 基础信息

**Base URL**: `http://localhost:3000/api`

**认证方式**: JWT Token (Bearer Token)

**请求头**:
```
Content-Type: application/json
Authorization: Bearer {token}
```

---

## 1. 用户认证模块 (/auth)

### 1.1 用户注册
```
POST /auth/register
```

**请求体**:
```json
{
  "username": "zhangsan",
  "password": "123456",
  "name": "张三",
  "phone": "13800138000",
  "email": "zhangsan@example.com",
  "roles": ["executor"],
  "department": "技术部"
}
```

**响应**:
```json
{
  "message": "注册成功",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "...",
    "username": "zhangsan",
    "name": "张三",
    ...
  }
}
```

### 1.2 用户登录
```
POST /auth/login
```

**请求体**:
```json
{
  "username": "zhangsan",
  "password": "123456"
}
```

**响应**: 同注册

### 1.3 获取当前用户信息
```
GET /auth/me
Headers: Authorization: Bearer {token}
```

### 1.4 修改密码
```
POST /auth/change-password
Headers: Authorization: Bearer {token}
```

**请求体**:
```json
{
  "oldPassword": "123456",
  "newPassword": "654321"
}
```

---

## 2. 用户管理模块 (/users) [管理员]

### 2.1 获取所有用户
```
GET /users?page=1&limit=10&status=active&role=executor&keyword=张三
Headers: Authorization: Bearer {token}
```

**查询参数**:
- `page`: 页码（默认1）
- `limit`: 每页数量（默认10）
- `status`: 用户状态（active/inactive）
- `role`: 角色（admin/executor/cc）
- `keyword`: 搜索关键词

### 2.2 获取单个用户
```
GET /users/:id
```

### 2.3 创建用户
```
POST /users
```

**请求体**: 同注册接口

### 2.4 更新用户
```
PUT /users/:id
```

**请求体**:
```json
{
  "name": "张三",
  "phone": "13800138000",
  "roles": ["admin", "executor"],
  "department": "技术部",
  "status": "active"
}
```

### 2.5 删除用户
```
DELETE /users/:id
```

### 2.6 重置用户密码
```
POST /users/:id/reset-password
```

**请求体**:
```json
{
  "newPassword": "123456"
}
```

---

## 3. 任务管理模块 (/tasks)

### 3.1 创建任务 [管理员]
```
POST /tasks
Content-Type: multipart/form-data
```

**请求体**:
```json
{
  "taskName": "开发新功能",
  "taskType": "开发任务",
  "taskSource": "产品需求",
  "description": "任务描述...",
  "executor": ["user_id1"],
  "mainExecutor": "user_id1",
  "ccUsers": ["user_id2", "user_id3"],
  "plannedCompletionTime": "2025-12-31T23:59:59.000Z",
  "tags": ["紧急", "重要"],
  "priority": "high",
  "remarks": "备注信息",
  "subTasks": [
    {
      "taskName": "子任务1",
      "description": "子任务描述",
      "executor": "user_id4",
      "plannedCompletionTime": "2025-12-25T23:59:59.000Z"
    }
  ]
}
```

**附件上传**: 使用 `attachments` 字段，支持多文件上传（最多10个）

### 3.2 获取任务列表
```
GET /tasks?page=1&limit=10&status=in_progress&priority=high&keyword=开发&startDate=2025-01-01&endDate=2025-12-31
```

**查询参数**:
- `page`: 页码
- `limit`: 每页数量
- `status`: 任务状态
- `priority`: 优先级（low/normal/high/urgent）
- `keyword`: 搜索关键词
- `startDate`: 开始日期
- `endDate`: 结束日期

### 3.3 获取我的任务
```
GET /tasks/my-tasks?type=executor&status=in_progress
```

**查询参数**:
- `type`: 任务类型
  - `executor`: 我执行的任务
  - `cc`: 我抄送的任务
  - `created`: 我创建的任务
- `status`: 任务状态

### 3.4 获取任务详情
```
GET /tasks/:id
```

### 3.5 更新任务 [管理员]
```
PUT /tasks/:id
```

### 3.6 删除任务 [管理员]
```
DELETE /tasks/:id
```

---

## 4. 任务执行流程

### 4.1 完成任务（执行人）
```
POST /tasks/:id/complete
```

### 4.2 审核任务（抄送人）
```
POST /tasks/:id/review
```

**请求体**:
```json
{
  "content": "任务完成质量很好",
  "result": "approved",
  "rating": 5
}
```

### 4.3 确认任务（管理员）
```
POST /tasks/:id/confirm
```

### 4.4 获取任务审核记录
```
GET /tasks/:id/reviews
```

---

## 5. 延期申请模块 (/extensions)

### 5.1 申请延期
```
POST /extensions/apply/:id
```

**请求体**:
```json
{
  "reason": "因不可抗力原因，需要延期",
  "requestedDays": 7
}
```

**可选天数**: 3, 5, 7, 10 或自定义

### 5.2 审批延期申请 [管理员]
```
POST /extensions/approve/:id
```

**请求体**:
```json
{
  "status": "approved",
  "approvedDays": 5,
  "approvalNote": "同意延期5天"
}
```

**status**: `approved` 或 `rejected`

### 5.3 获取延期申请列表
```
GET /extensions?status=pending&taskId=xxx
```

### 5.4 获取延期申请详情
```
GET /extensions/:id
```

### 5.5 获取任务延期历史
```
GET /extensions/history/:taskId
```

---

## 6. 统计模块 (/statistics)

### 6.1 获取统计概览
```
GET /statistics/overview
```

**响应**:
```json
{
  "overview": {
    "totalTasks": 100,
    "inProgressTasks": 30,
    "finishedTasks": 60,
    "delayedTasks": 10,
    "pendingReviewTasks": 5,
    "pendingConfirmTasks": 3,
    "pendingExtensions": 2,
    "totalUsers": 50,
    "completionRate": 60
  }
}
```

### 6.2 导出任务统计 [管理员]
```
GET /statistics/export/tasks?startDate=2025-01-01&endDate=2025-12-31&status=finished&executor=xxx
```

**返回**: Excel文件下载

### 6.3 导出人员统计 [管理员]
```
GET /statistics/export/users?startDate=2025-01-01&endDate=2025-12-31
```

**返回**: Excel文件下载

---

## 7. 消息通知模块 (/messages)

### 7.1 获取消息列表
```
GET /messages?page=1&limit=20&isRead=false&type=task_assigned
```

**查询参数**:
- `page`: 页码（默认1）
- `limit`: 每页数量（默认20）
- `isRead`: 是否已读（true/false）
- `type`: 消息类型

**消息类型**:
- `task_assigned` - 任务分配
- `task_updated` - 任务更新
- `task_completed` - 任务完成
- `task_reviewed` - 任务已审核
- `task_confirmed` - 任务已确认
- `task_deleted` - 任务删除
- `extension_applied` - 延期申请
- `extension_approved` - 延期审批通过
- `extension_rejected` - 延期审批拒绝
- `system` - 系统通知

**响应**:
```json
{
  "messages": [
    {
      "_id": "...",
      "type": "task_assigned",
      "title": "新任务分配",
      "content": "您有新的任务「xxx」待处理",
      "isRead": false,
      "sender": {
        "_id": "...",
        "name": "张三"
      },
      "relatedTask": {
        "_id": "...",
        "taskName": "xxx"
      },
      "createdAt": "2025-12-15T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "pages": 3
  }
}
```

### 7.2 获取未读消息数量
```
GET /messages/unread-count
```

**响应**:
```json
{
  "count": 5
}
```

### 7.3 获取单个消息详情
```
GET /messages/:id
```

**说明**: 访问后自动标记为已读

### 7.4 标记单条消息为已读
```
PUT /messages/:id/read
```

### 7.5 批量标记消息为已读
```
PUT /messages/read-multiple
```

**请求体**:
```json
{
  "messageIds": ["id1", "id2", "id3"]
}
```

### 7.6 全部标记为已读
```
PUT /messages/read-all
```

### 7.7 删除单条消息
```
DELETE /messages/:id
```

### 7.8 批量删除消息
```
DELETE /messages/delete-multiple
```

**请求体**:
```json
{
  "messageIds": ["id1", "id2", "id3"]
}
```

### 7.9 清空所有已读消息
```
DELETE /messages/clear-read
```

---

## 8. 任务状态说明

| 状态值 | 说明 | 中文 |
|--------|------|------|
| pending | 待开始 | 待开始 |
| in_progress | 进行中 | 进行中 |
| partial_completed | 部分完成（主任务） | 部分完成 |
| extension_pending | 等待延期审批 | 待延期审批 |
| extension_approved | 延期审批通过 | 延期通过 |
| completed | 执行人已完成 | 已完成 |
| pending_review | 等待抄送人审核 | 待审核 |
| pending_confirm | 等待管理员确认 | 待确认 |
| finished | 任务完结 | 已完结 |

---

## 9. 任务流程图

```
创建任务 (管理员)
    ↓
进行中 (in_progress)
    ↓
[可选] 申请延期 → 待延期审批 (extension_pending)
                    ↓
            审批通过 → 继续进行中
            审批拒绝 → 保持进行中
    ↓
执行人完成 (completed)
    ↓
[如有抄送人] 待审核 (pending_review) → 抄送人审核
    ↓
待确认 (pending_confirm)
    ↓
管理员确认
    ↓
已完结 (finished)
```

---

## 10. 错误码说明

| 状态码 | 说明 |
|--------|------|
| 200 | 请求成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 401 | 未登录或token失效 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 500 | 服务器错误 |

---

## 11. 注意事项

1. **认证**: 除了注册和登录接口，其他所有接口都需要在请求头中携带 JWT Token
2. **权限**: 标记为 [管理员] 的接口只有 admin 角色可以访问
3. **文件上传**: 支持的文件类型包括图片（jpg/png/gif）、文档（pdf/doc/docx/xls/xlsx/txt）
4. **文件大小**: 单个文件最大 10MB
5. **延期限制**: 每个任务只能申请一次延期
6. **子任务**: 主任务必须等所有子任务完成后才能标记完成
7. **团队任务**: 只有主负责人可以申请延期
8. **消息通知**: 系统会自动发送消息通知，无需手动调用

---

## 12. 开发环境配置

1. 安装依赖: `npm install`
2. 配置 `.env` 文件
3. 启动 MongoDB
4. 运行项目: `npm run dev`

默认端口: 3000

