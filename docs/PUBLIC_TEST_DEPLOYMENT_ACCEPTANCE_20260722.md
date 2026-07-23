# PC Web 公网测试版部署与验收报告（2026-07-22）

## 1. 结论

`https://v2-test.horselink.cn` 已部署为独立的 TaskDistribution V2 PC Web 客户测试版，可以交给客户进行测试。公网 HTTP/TLS、登录、团队隔离、真实业务数据、私有附件和三档响应式页面均已运行验证；旧版 `https://www.horselink.cn`、生产隧道和生产 MongoDB 在部署后均通过只读回归。

本结论是“隔离 PC Web 公网测试版运行已验证”，不是正式生产切换、旧数据迁移或小程序验收完成。

## 2. 范围和版本

- 公网测试域名：`https://v2-test.horselink.cn`
- DNS A 记录：`82.156.67.62`
- Git commit：`f8381642beead011f9d88fac25da19a97e1ec3ae`
- 部署标识：`f838164-r2`
- Web 入口资源：`/assets/index-CodzRoEF.js`
- 本次包含：PC Web、API、独立 MongoDB、独立附件、反向隧道、Nginx vhost、HTTPS 和证书续期
- 本次不包含：小程序公网测试、正式生产切换、旧版数据迁移、客户不可逆写流程和生产回滚演练

## 3. 隔离部署矩阵

| 组件 | 旧版生产 | V2 公网测试版 |
|---|---|---|
| 域名 | `www.horselink.cn` | `v2-test.horselink.cn` |
| 边缘入口 | 既有 Nginx vhost | 独立 Nginx vhost |
| 反向隧道 | `127.0.0.1:38080` | `127.0.0.1:38130` |
| Web | 既有生产服务 | `127.0.0.1:18130` |
| API | 既有生产服务 | `127.0.0.1:18120` |
| MongoDB | `127.0.0.1:27017/task_distribution` | `127.0.0.1:27150/customer_acceptance_v2_test` |
| 服务守护 | 既有生产服务 | 独立 V2 systemd units，已启用 |
| 数据和附件 | 生产目录 | 独立 V2 目录 |

V2 vhost 只代理 `38130`，不引用 `38080`。V2 的 API、数据库、上传目录、服务名、隧道密钥和证书目录均未复用旧版资源。

## 4. 数据基线

公网测试版运行库已核对：

| 数据 | 数量 |
|---|---:|
| 设备台账 | 141 |
| 点检规则 | 4 |
| 保养规则 | 4 |
| 运输提报 | 6 |
| 生产排产 | 43 |
| 出勤日报 | 7 |
| 私有 FileAsset / 物理附件 | 241 / 241 |

客户测试账号通过正式 API 创建，属于“变速箱物流部”项目管理员。账号只显示本团队，不显示发动机物流部或超级管理员全局只读入口；登录和只读浏览可能新增会话及认证审计，不改变业务基线。

## 5. 公网验收结果

### 5.1 HTTP、DNS 和 TLS

2026-07-22 18:00（Asia/Shanghai）最终复测：`10/10 PASS`。

- DNS 解析到 `82.156.67.62`。
- HTTP 301 跳转到同域 HTTPS。
- TLS 1.3、主机名和证书链验证通过。
- Let's Encrypt 证书 CN/SAN 均为 `v2-test.horselink.cn`，有效期为 2026-07-22 至 2026-10-20。
- 登录页、固定 release 资源和 `/health` 均为 HTTP 200。
- `/health` 返回 `instance=task-distribution-v2-customer-test`。
- 公共登录团队接口返回发动机物流部和变速箱物流部。
- 匿名访问 `/api/auth/me` 和私有附件均返回 HTTP 401。

### 5.2 浏览器业务和响应式

2026-07-22 18:06（Asia/Shanghai）最终只读 Playwright 复测：

- 业务检查：`12/12 PASS`
- 响应式路由：`18/18 PASS`
- Console warning/error：`0`
- Page Error：`0`
- HTTP 4xx/5xx：`0`
- 请求失败：`0`

实际覆盖登录、项目管理员团队隔离、141 条设备、鉴权私有图片、4 条点检规则、4 条保养规则、6 条运输、43 条生产、7 条出勤，以及 `1920x1080`、`1366x768`、`390x844` 下的统计看板、设备、规则、运输、生产和出勤页面。三档视口均无页面级横向溢出、可见控件裁切或残留 loading mask，移动菜单可正常开关。

### 5.3 全量自动化

- 后端：`356/356 PASS`
- Web 单元测试：`125/125 PASS`
- Web production build：PASS，入口资源仍为 `index-CodzRoEF.js`
- 小程序自动化：`81/81 PASS`，43 个 SFC 检查和环境隔离检查 PASS；本项仅证明源码回归，不属于本次公网小程序验收

## 6. 证书自动续期

- 计划任务：`TaskDistribution-V2-Test-Certificate-Renewal`
- 账号和权限：`SYSTEM`，最高权限
- 计划：每日 `03:17`
- 当前状态：`Ready` / Enabled
- 立即试跑结果：`LastTaskResult=0`
- 当前证书尚未到续期窗口，win-acme 明确报告到 2026-09-15 后才到期检查；试跑未改变证书哈希、Nginx 配置或 Nginx PID，也未触发无意义 reload

实际续期只能在进入 Let's Encrypt 续期窗口后完成外部验证。本次已验证的是任务注册、非到期分支、退出码和“不变更则不 reload”的行为。

## 7. 旧版生产回归

部署和续期任务试跑后完成只读回归：

- `https://www.horselink.cn/`：HTTP 200
- `https://www.horselink.cn/admin`：HTTP 200
- `https://www.horselink.cn/health`：HTTP 200
- 旧版 `127.0.0.1:38080/health`：HTTP 200
- V2 `127.0.0.1:38130/health`：HTTP 200
- 生产 MongoDB：`ok=1`、`isWritablePrimary=true`
- 生产库 `task_distribution`：5 个集合；`tasks=25`、`taskreviews=25`、`extensionrequests=20`、`messages=568`、`users=20`

生产 MongoDB 核对全程只读，未修改旧版应用、生产数据或 `38080`。

## 8. 备份和回滚点

### 8.1 数据备份

V2 干净客户测试基线备份：

- `backupId`：`backup-20260721T141605Z-03560577`
- `manifestSha256`：`8f6bb074da2015763b92927cac407eb9f58ae990961c72d041974b10e6ef3044`
- 验证结果：33 个集合，241 条 FileAsset 引用和 241 个物理附件一致

备份和附件位于 Git 忽略的 E 盘测试目录，不进入源码仓库。

### 8.2 Nginx 回滚点

- HTTP vhost 部署前备份：`C:\nginx\backups\v2-test\deploy-20260722T170909046-28c7dbed`
- HTTPS 切换前备份：`C:\nginx\backups\v2-test\deploy-20260722T175528418-9e0c0ad6`
- 原始主配置 SHA256：`E15E103C8CF1A98E228D657BB0322FFBA2A31F8EB732E474B8A69C3720FE299A`
- 当前主配置 SHA256：`72D569DFBC172ED964EED1056174CC70DCF422A221FB91AF909C60877C494230`
- 当前 V2 HTTPS vhost SHA256：`095CA162F25FAE147E288428D2CFAE87D5890D63819E84A1A0FE7418A404B240`

边缘回滚脚本已通过 Windows PowerShell 5.1 解析、自包含 `21/21` 断言和 candidate `nginx -t` 保护验证，但尚未在当前真实边缘主机执行一次完整撤销再恢复演练。

### 8.3 完全撤销顺序

1. 使用 HTTPS 切换备份把 vhost 回到 HTTP 阶段；如需完全移除，再使用 HTTP 部署备份撤销 V2 vhost。
2. 每次替换前后执行 candidate/live `nginx -t`，成功后才 reload，并复验旧版三个 URL 与 `38080`。
3. 边缘入口恢复后再删除 DNS A 记录，不能依赖 DNS 缓存作为即时止损手段。
4. 禁用 `TaskDistribution-V2-Test-Certificate-Renewal`；证书文件保留到回滚观察期结束。
5. 只停止 `taskdistribution-v2-test-tunnel.service` 和 V2 服务，禁止触碰生产 `38080`、`27017` 或旧版服务。
6. 不删除 V2 MongoDB、附件、备份和 release；普通代码回滚不自动回滚数据库。

## 9. 已知边界

- 测试域名当前未配置 HSTS；HTTPS、证书链和 HTTP 跳转均正常，这不是客户测试阻断项。
- 自动化为避免污染真实数据，未点击新增、保存、编辑、导入、审批、导出或删除；这些写流程由客户使用专用测试前缀执行后再清理。
- 公网已经创建客户可见、非系统的超级管理员账号，并验证默认全局只读、进入变速箱/发动机团队、返回全局及认证审计；凭据不进入本报告或Git。
- 小程序不在本次公网交付范围内；微信开发者工具和真机的扫码、相机、定位、授权拒绝和水印像素仍须单独验收。
- 本报告不替代正式生产迁移、备份周期观察、恢复演练和签字回滚演练。

## 10. 证据索引

原始证据保存在 Git 忽略目录，不提交密码、Token、Cookie、私钥、客户附件或原始配置：

- HTTP/TLS：`.test-data/deployment-20260722/public-smoke-results/http-2026-07-22T10-00-19-755Z/`
- 浏览器：`.test-data/deployment-20260722/public-smoke-results/browser-2026-07-22T10-06-25-923Z/`
- 最终自动化：`.test-data/final-validation-20260722T180848/`
- 证书续期基线：`C:\ProgramData\taskdistribution-v2-test\evidence\certificate-renewal-20260722T100429Z\baseline.json`
- 证书续期试跑：`C:\ProgramData\taskdistribution-v2-test\evidence\certificate-renewal-run-20260722T101618Z\verification.json`

## 11. 2026-07-23 运行事故补充

客户报告登录页“项目团队加载失败”后，公网静态HTML/JS仍为HTTP 200，但`/health`与`/api/auth/login-teams`均为502。DNS、TLS、旧服务器Nginx、`38130`反向隧道及旧版`38080`均正常；故障收敛到客户本地服务器Linux虚拟机内的V2依赖链。

根因是隧道身份初始化辅助脚本把共享目录`/etc/taskdistribution-v2-test`覆盖为`0750 root:taskdistributionv2test`。独立MongoDB以`mongodb-v2`运行，无法穿过父目录读取`mongod-v2-test.conf`，持续崩溃并带停API。修复只给`mongodb-v2`增加目录穿越ACL，没有授予`app.env`或隧道密钥读取权限；随后按MongoDB、API、隧道顺序恢复。

恢复后权威复验：

- `mongod-v2-test.service`、`taskdistribution-v2-test-api.service`、`taskdistribution-v2-test-tunnel.service`均为`active/running`，修复后重启计数为0；
- `27150`、`18120`、`18130`均监听；副本集`customer_acceptance_v2_rs`为writable primary；
- 公网`/health`和`/api/auth/login-teams`均为HTTP 200，并返回变速箱物流部和发动机物流部；
- 客户可见超级管理员完成全局只读、两个团队切换、返回全局及审计核对，验证会话已退出；
- 旧版`https://www.horselink.cn/health`保持HTTP 200，生产数据未修改。

事故报告：`INCIDENT_20260723_V2_TEST_502.md`。服务器证据目录：`/var/log/taskdistribution-v2-test/incident-config-acl-20260723T075516Z`。
