# V2 小程序开发与构建

## 隔离约束

- 开发默认 API：`http://127.0.0.1:18099/api`
- 非生产构建拒绝 `www.horselink.cn`、`horselink.cn`、`82.156.67.62` 和端口 `8099`
- 不编辑或提交 `unpackage/`；HBuilderX 输出仅作为本机构建产物
- 请求仅通过 `Authorization: Bearer <token>` 表达登录/团队上下文，客户端不附加团队授权头

## 本地检查

在本目录使用 Node.js `22.23.1`：

```powershell
npm test
npm run check:isolation
npm run check:sfc
```

纯 JavaScript 单元测试不依赖 HBuilderX，也不会连接服务器或数据库。

## HBuilderX / 微信开发者工具

1. 在 HBuilderX 中导入本目录。
2. 通过运行配置显式设置 `VITE_API_BASE_URL`；本地联调保持 `http://127.0.0.1:18099/api`。
3. 运行到微信开发者工具，验证登录、团队选择、切换团队、只读模式、401 失效和消息角标。
4. 真机访问电脑本机服务时，需将 API 地址改为真机可达的独立测试实例地址；仍不得使用生产域名、生产 IP 或 `8099`。

生产构建必须显式提供 `VITE_API_BASE_URL`，不能依赖开发默认值。当前命令行环境不包含 HBuilderX 编译器，因此最终微信真机构建需在 HBuilderX/微信开发者工具中完成。
