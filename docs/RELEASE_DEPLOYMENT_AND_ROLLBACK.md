# Release、部署与回滚手册

本文描述 TaskDistribution V2 的最终发布包检查、环境变量、Windows/Linux 部署、回滚演练和微信小程序版本回退。它是可执行操作手册，不代表任何环境已经部署或验收。

## 0. 2026-08-11 当前运维状态

> 2026-08-11 固定指纹的 `23224` 管理路由已恢复并可登录客户 Windows；V2 `/health` 与首页为 HTTP 200，边缘 `23224`/`38130` 及客户回环 `22/18120/18130/27150` 均监听。当前活动 release 已核对为 `v2-20260810-9da987a`，34个集合、9,857条文档和354/354条有效附件引用通过只读核验。旧站 `38080` 仍未监听，旧站 `/`、`/admin`、`/health` 均为HTTP 502；恢复旧站或正式批准停用旧站前，不得激活本轮候选。
>
> 本轮合同源码已提交并推送为 `1a8942fde629187b7068c1fa80b3817fb058b440`，不可变候选 `v2-20260811-1a8942f` 已构建，归档SHA256为`5f611082c3aafa0d72e6cbf800823274cefbb8283177f8fd6cc8bec2bfb424c0`，但尚未部署。在线恢复点`backup-20260811T144657Z-77862fb4`已在新D盘生成并复制到独立工作站E盘逐文件验签；它不是停止写入预部署备份，候选激活前仍必须执行正式停止写入备份和完整发布门禁。

> **V2 客户测试环境专用流程**：`v2-test.horselink.cn`、`18120/18130/27150`、
> `customer_acceptance_v2_test` 的发布和恢复必须使用
> [`V2_TEST_RELEASE_AND_ROLLBACK_RUNBOOK.md`](./V2_TEST_RELEASE_AND_ROLLBACK_RUNBOOK.md)。
> 该流程要求停 V2 写入后创建全新备份、复制到物理机 D 盘逐文件验签，再执行岗位层级和运输
> 主数据迁移。第一次 migration execute 后禁止只切回旧代码；必须 forward-fix，或恢复到全新的
> `*_v2_test` 数据库后再让旧代码连接恢复库。本文后续通用示例不能替代该专用门禁。

## 1. 发布边界

- 只从已提交、已标记的 Git commit 构建 release；工作区必须干净。
- API、Web、小程序源代码、运行环境文件、数据库、上传目录和备份目录相互分离。
- `.env`、凭据、`customer-data/`、`.test-data/`、`work/`、上传文件、数据库 dump、客户表格、
  客户图片、日志、截图和本机构建/依赖产物不得进入 release 或 Git。客户原始资料只能放在已忽略的
  `customer-data/`、`references/`、`attachments/` 或 `screenshots/` 中；不能混入源码资源目录。
- RSA 私钥 XML 必须留在独立工作站、Git 仓库之外的受保护 E 盘目录；不得进入 Git、release、聊天或命令输出。固定 public-only RSA XML 可以进入候选包，并必须由 release manifest 和 SHA256 绑定。
- 不使用 `app/install.bat`、`app/install.sh`、`app/init-db.js`、`npm run init:clear` 或任何 `import:*` 命令部署 V2。它们属于旧版初始化或测试数据工具。
- 当前 API 依赖 MongoDB 事务；正式环境必须使用 replica set，单节点 replica set 也可以。独立 `mongod` 会使点检/保养写入失败。
- API 生产进程由操作系统服务管理；Web 使用静态站点；MongoDB 和反向代理不由本仓库脚本自动安装。

## 2. 最终 release 清单

每个 release 目录至少包含：

| 内容 | 必需路径或记录 |
|---|---|
| 源代码 | `app/`、`miniprogram/`、`ops/`、`docs/`、根 `README.md` |
| 锁文件 | `app/package-lock.json`、`app/frontend/package-lock.json`；小程序仅在存在锁文件时归档 |
| Web 产物 | `app/frontend/dist/`，必须由当前 commit 构建 |
| 版本证据 | Git commit、tag、构建 UTC 时间、Node/npm 版本 |
| 完整性证据 | release 压缩包 SHA256、Web 产物文件清单及 SHA256 |
| 自动化证据 | 后端、Web、小程序测试数量，Web build 和小程序 SFC 检查结果 |
| 数据保护证据 | 上线前 `backupId`、`manifestSha256`、`ops/verify-backup.js` 成功结果 |
| 小程序证据 | `manifest.json` 的 `versionName`/`versionCode`、微信上传版本号、体验版/审核版/线上版状态 |
| 变更与回滚 | 变更摘要、已知限制、前一 release ID、回滚负责人和批准人 |

发布前在仓库根目录运行：

```powershell
node --version   # 必须为 v22.23.1
npm --version    # 必须为 10.9.8
git status --porcelain
git diff --check
$ApprovedRasterAssets = @(
  'app/frontend/src/assets/1.jpg',
  'app/frontend/src/assets/2.png',
  'app/frontend/src/assets/login-logistics.jpg',
  'miniprogram/static/logo.png'
)
$ForbiddenTracked = @(git ls-files | Where-Object {
  $_ -match '(^|/)(\.test-data|work|customer-data|references|attachments|screenshots|uploads|logs|backups?|dumps?|node_modules|dist|build)(/|$)' -or
  $_ -match '\.(xls|xlsx|xlsm|xlsb|log|bson|wt|sqlite|sqlite3|pem|key|pfx|p12|ppk|zip|tar|tgz|gz|7z)$' -or
  $_ -match '(^|/)(id_rsa[^/]*|id_ed25519[^/]*|known_hosts|authorized_keys)$' -or
  (($_ -match '(^|/)(\.env($|\.)|[^/]+\.env($|\.))') -and $_ -notmatch '\.(example|template)$') -or
  (($_ -match '\.(png|jpg|jpeg|gif|webp|bmp|tif|tiff)$') -and $_ -notin $ApprovedRasterAssets)
})
if ($ForbiddenTracked.Count) {
  $ForbiddenTracked
  throw 'Forbidden tracked release material found'
}

Push-Location app
npm ci
npm test
Pop-Location

Push-Location app\frontend
npm ci
npm run test:unit
$env:VITE_API_BASE_URL='/api'
npm run build
Remove-Item Env:VITE_API_BASE_URL
Pop-Location

Push-Location miniprogram
npm test
npm run check:sfc
Pop-Location
```

判定规则：

- `git status --porcelain` 和 `git ls-files ...` 必须无输出。
- 所有测试、静态检查和构建必须退出码为 `0`。
- 当前仓库没有小程序生产 CLI 构建脚本；小程序仍需 HBuilderX/微信开发者工具构建和上传，不能把 `check:sfc` 当作线上包。
- `miniprogram/manifest.json` 当前 `mp-weixin.setting.urlCheck` 的值必须在发布评审时检查；正式包应启用微信合法域名校验，不能以关闭校验替代域名配置。

创建可追溯源码归档：

```powershell
$ReleaseId = "v2-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$Commit = git rev-parse HEAD
git tag -a $ReleaseId $Commit -m "TaskDistribution V2 release $ReleaseId"
New-Item -ItemType Directory -Force E:\TaskDistribution-V2-Releases\packages | Out-Null
git archive --format=zip --output "E:\TaskDistribution-V2-Releases\packages\$ReleaseId-source.zip" $ReleaseId
Get-FileHash "E:\TaskDistribution-V2-Releases\packages\$ReleaseId-source.zip" -Algorithm SHA256
```

只有获得发布批准后才推送 tag。SHA256 和 commit 写入 release 记录，不把真实环境文件加入压缩包。

## 3. 环境变量

### 3.1 API

真实配置放在仓库外。API 启动时通过进程变量 `ENV_FILE` 指向该文件；`ENV_FILE` 本身不是业务配置项。

| 变量 | 必需 | 生产建议与约束 |
|---|---|---|
| `APP_ENV` | 是 | `production` |
| `NODE_ENV` | 是 | `production` |
| `APP_INSTANCE` | 是 | 唯一、可识别的实例名，例如 `task-distribution-v2-production` |
| `PORT` | 是 | API 内部监听端口；与反向代理配置一致 |
| `MONGODB_URI` | 是 | 包含数据库名和 `replicaSet`；凭据仅放受保护环境文件 |
| `JWT_SECRET` | 是 | 至少32字符，不得含 `replace-me`、`change-me` 等占位词 |
| `JWT_EXPIRE` | 否 | 默认 `8h` |
| `JWT_ISSUER` | 是 | 默认 `task-distribution-v2`，上线后保持稳定 |
| `JWT_AUDIENCE` | 是 | 默认 `task-distribution-v2-clients`，上线后保持稳定 |
| `UPLOAD_PATH` | 是 | 绝对持久化路径，不放在 release/current 下 |
| `MAX_FILE_SIZE` | 否 | 正整数，默认 10485760 字节 |
| `CORS_ORIGINS` | 是 | 逗号分隔的 Web HTTPS origin；同源部署也写明实际 origin |
| `ENABLE_LEGACY_PUBLIC_UPLOADS` | 是 | 保持 `false` |
| `EQUIPMENT_ROUTINE_WORKER_ENABLED` | 是 | 生产显式设为 `true`；紧急停用时可改为 `false` 后重启 API |
| `EQUIPMENT_ROUTINE_WORKER_INTERVAL_MS` | 否 | 默认300000，最小1000 |

本文后续健康检查命令以 `PORT=18099` 为示例；实际发布若使用其他端口，NSSM/systemd、反向代理、`operations.env` 和所有健康检查必须同时改成相同值。

生成 JWT secret，但不要把命令输出贴入工单或文档：

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

```bash
openssl rand -base64 48
```

### 3.2 Web

| 变量 | 构建要求 |
|---|---|
| `VITE_API_BASE_URL` | 每次 `vite build` 必填；推荐同源 `/api`，也可为明确的 HTTPS API URL |
| `VITE_DEV_PROXY_TARGET` | 仅开发服务器使用，默认 `http://127.0.0.1:18099` |
| `VITE_DEV_ALLOWED_HOSTS` | 仅开发服务器使用，逗号分隔 |

Web 的环境变量在构建时固化。修改 API 地址必须重新构建，不能只重启静态站点。

### 3.3 微信小程序

| 变量 | 构建要求 |
|---|---|
| `VITE_API_BASE_URL` | 生产构建必填，完整 HTTPS 地址并以 `/api` 结尾 |
| `VITE_UPLOAD_BASE_URL` | 可选；空值时从 API URL 去掉 `/api` 推导 |
| `VUE_APP_API_BASE_URL`、`VUE_APP_UPLOAD_BASE_URL` | 仅旧 HBuilderX 编译器兼容别名 |

生产 API、上传和下载域名必须先加入微信公众平台合法域名，证书链和 TLS 主机名必须有效。生产构建不允许回退到本机地址。

### 3.4 运维工具

备份、恢复和健康检查变量以 `ops/operations.env.example` 为唯一清单。真实文件放在仓库外并限制为运维账号只读，详见 `docs/OPERATIONS_RUNBOOK.md`。

## 4. Windows 部署

### 4.1 前置条件

- Node.js 22.23.1、npm 10.9.8、MongoDB Database Tools 和 MongoDB replica set 已安装并固定版本。
- 使用独立低权限服务账号；上传、日志、release、备份和 secrets 均位于 E 盘。
- API 服务管理器使用客户批准并固定哈希的 NSSM，或由客户现有服务平台提供等价能力。本仓库未捆绑 NSSM。
- IIS/Nginx 提供 HTTPS、Web 静态文件和 `/api` 反向代理。

### 4.2 安装候选 release

```powershell
$ReleaseId = 'v2-YYYYMMDD-HHMMSS'
$ReleaseRoot = "E:\TaskDistribution-V2-Releases\$ReleaseId"
New-Item -ItemType Directory -Force $ReleaseRoot | Out-Null
Expand-Archive "E:\TaskDistribution-V2-Releases\packages\$ReleaseId-source.zip" $ReleaseRoot

Push-Location "$ReleaseRoot\app"
npm ci --omit=dev
Pop-Location

Push-Location "$ReleaseRoot\app\frontend"
npm ci
$env:VITE_API_BASE_URL='/api'
npm run build
Remove-Item Env:VITE_API_BASE_URL
Pop-Location
```

核对候选目录没有 `.env`、客户文件或运行上传。将 API 环境文件放到 `E:\TaskDistribution-V2-Secrets\app.env` 并设置 ACL：

```powershell
icacls E:\TaskDistribution-V2-Secrets\app.env /inheritance:r
icacls E:\TaskDistribution-V2-Secrets\app.env /grant:r "DOMAIN\service-account:(R)"
```

### 4.3 首次注册 API 服务

以下命令仅在已安装并校验 NSSM 后执行；账号名、NSSM 路径和 release ID 必须替换：

```powershell
$Nssm = 'E:\ApprovedTools\nssm.exe'
& $Nssm install TaskDistributionV2Api 'C:\Program Files\nodejs\node.exe' 'E:\TaskDistribution-V2-Releases\current\app\server.js'
& $Nssm set TaskDistributionV2Api AppDirectory 'E:\TaskDistribution-V2-Releases\current\app'
& $Nssm set TaskDistributionV2Api AppEnvironmentExtra 'ENV_FILE=E:\TaskDistribution-V2-Secrets\app.env'
& $Nssm set TaskDistributionV2Api AppStdout 'E:\TaskDistribution-V2-Logs\api.log'
& $Nssm set TaskDistributionV2Api AppStderr 'E:\TaskDistribution-V2-Logs\api-error.log'
& $Nssm set TaskDistributionV2Api AppRotateFiles 1
```

在 `services.msc` 或客户批准的凭据部署工具中，把 `TaskDistributionV2Api` 的“登录”账号改为前述低权限服务账号并授予“作为服务登录”；不要把该账号密码放入命令行、脚本或 release 记录，也不要保留 NSSM 默认的 LocalSystem 身份。

此时只注册服务和核对账号、ACL、Node 版本及路径，不运行候选 `server.js`。包含新 TaskReview 索引声明的候选 API 在相应的备份与迁移完成前不得首次连接旧数据库，否则 Mongoose `autoIndex` 可能提前创建索引并绕过迁移门禁。Task / TaskReview 迁移完成后再按 4.6 节执行前台启动预检和正式启动；Windows Recovery 设备分类索引发布必须改走 4.5 节的专用两阶段流程，不得执行初始化或导入命令。

### 4.4 Task / TaskReview 审核轮次索引迁移门禁

release 解包、安装依赖和切换 `current` 都不会自动执行数据库 migration。包含 `Task.reviewRound`、`TaskReview.stage/reviewRound` 的候选 API（包括任何 `server.js` 前台预检）首次连接一个旧数据库前，必须由运维人员在维护窗口按 `docs/OPERATIONS_RUNBOOK.md` 的显式流程运行 `npm run migrate:task-review-stages -- ...`；不得把 migration 加入 NSSM、systemd、Web 构建或 API 启动命令。

发布记录必须同时附有：

- 默认 dry-run 生成的报告；
- 紧邻执行窗口创建并经 `ops/verify-backup.js` 验证的 `backupId`、备份目录、`manifest.json` 绝对路径和 `manifestSha256`；
- 带 `--execute`、精确 `--confirm-database`、`--backup-directory` 和独立 `--report` 的执行记录；
- 迁移后新唯一索引、旧索引精确删除结果及任务审核/最终确认冒烟结果。

维护窗口内必须停止 API、worker 和其他业务写入，再执行迁移。迁移顺序固定为：回填并校验 Task/TaskReview 的 `reviewRound` 及 `stage` -> 创建新的五字段唯一索引 -> 验证数据和新索引 -> 按迁移计划精确删除旧限制性唯一索引。最后一步只处理 key 精确等于 `{ task, reviewer }`、`{ teamId, task, reviewer }` 或 `{ teamId, task, reviewer, stage }` 的旧 unique 索引。禁止手工运行宽泛的 `dropIndexes()` 或用 `syncIndexes()` 代替该流程。

这是 forward-only 迁移：一旦同一人员和阶段已产生多个 `reviewRound`，就不能直接重建旧两字段、三字段或四字段 stage 唯一索引，也不能只切回不了解 `reviewRound` 的旧代码。此后代码回滚必须停在兼容 `uq_task_review_stage_round` 和多轮历史的版本；若必须恢复迁移前状态，只能走单独批准的整库恢复/RPO 决策，不能按普通 release 回滚处理。

### 4.5 Windows Recovery 设备分类唯一索引两阶段发布

本节只适用于以下固定拓扑，不得套用到其他数据库、端口或 Windows 实例：

- Recovery 根目录：`C:\TaskDistribution-V2\Recovery`；
- 数据库：`customer_acceptance_v2_test`；
- API/Web 回环端口：`18120`、`18130`；
- 公网测试入口：`https://v2-test.horselink.cn`；
- 业务任务：`TaskDistribution-V2-Recovery-Tunnel`、`TaskDistribution-V2-Recovery-Web`、`TaskDistribution-V2-Recovery-API`；
- 始终保留的管理任务：`TaskDistribution-V2-Recovery-Management-Tunnel`、`TaskDistribution-V2-Recovery-MongoDB`。

本流程把旧的团队级唯一索引 `uq_equipment_category_team_name` 迁移为父分类范围唯一索引 `uq_equipment_category_team_parent_name`。它同时完成候选激活，不能再执行 4.6 节的通用目录切换。没有完整通过 `Plan -> Hold -> 停写备份 -> 独立工作站验签 -> Execute -> post-audit` 时，只能写“候选已暂存”或“发布受阻”，不能写“已发布”。

#### 4.5.1 不可变输入和发布前门禁

1. 先把所有修改提交到一个干净工作树，再从该完整 40 位 commit 构建不可变包。`New-V2TestReleasePackage.ps1` 会强制检查干净工作树、Node `v22.23.1`、npm `10.9.8`、必需迁移脚本、staging 生成器和三份 Windows 发布/验签脚本。不得从未提交工作树直接拼包。
2. 候选准备和 evidence 生成是两个明确阶段。先按下面的固定步骤把归档解压到全新的 incoming 目录，复制已记录 SHA256 的固定 Node runtime 和 Web proxy，按 lockfile 执行 `npm ci`，生成两个 runner，最后以无覆盖改名得到候选目录。`Candidate`、`Incoming` 或本 release 的 `Evidence` 任一已存在都必须停止，不得删除后复用同一 release ID。
3. 只有依赖注入完成后，才运行候选内的 `New-V2RecoveryEquipmentCategoryIndexStage.ps1`。它会重新验证归档和 artifact manifest、候选精确 manifest、release metadata、固定公钥、上一活动 release 的精确文件树、预部署离机备份回执、Node/app 依赖树、Mongo guard 及两份环境文件，然后以 create-new 语义生成 `staged.json`。重复运行只允许复验完全相同的 evidence；任一输入漂移都失败，不覆盖旧文件。
   - 预部署 `deployment-backup-receipt.json` 是经批准传输链提供的外部 handoff 信任根。staging 只复核其传输 SHA256、字段结构和发布身份，不重新打开备份 ZIP、解析 BSON 或验证签名，因此 `staged.json` 会明确记录 `TRANSFER_SHA256_AND_SCHEMA_ONLY`。它不能替代停写后新备份的独立工作站验签；`Execute` 仍必须消费一份新的 RSA 签名回执并真实复验完整文件集、`fileassets.bson` 与 uploads。
4. `staged.json` 必须绑定 release、commit、上一 release、上一 commit、`deploy\FILE-MANIFEST.json` SHA256、预部署备份、精确顺序的 `runtimeInputs` 和顶层 `runtimeInputsSha256`。禁止手工编写或修补该 JSON。候选 `deploy\RELEASE.json` 还必须声明唯一 schema capability `equipment-category-parent-name-index-v1`、固定公钥相对路径及公钥 SHA256。
5. 候选 API 在 `Execute` 前禁止启动，禁止手工运行 `server.js`、`syncIndexes()`、`dropIndexes()` 或直接在 MongoDB 中改索引。
6. 在业务仍在线时，用候选 CLI 生成一个新的、只读的批准 dry-run。报告必须位于本 release 的 evidence 目录，状态为 `DRY_RUN_READY`，`writePerformed=false`，证明目标索引尚不存在、旧索引恰好一个、未知团队级 unique 索引为零、blocker 为零。

先在服务器的提升权限 Windows PowerShell 5.1 会话中填写非秘密发布标识。真实环境文件仍放在受保护路径，只传绝对路径，不把其内容写入命令记录或聊天：

```powershell
$RecoveryRoot = 'C:\TaskDistribution-V2\Recovery'
$ApprovedBackupRoot = 'C:\ServerBackups\TaskDistribution-V2-Test'
$ReleaseId = 'v2-YYYYMMDD-abcdef0'
$SourceCommit = '<40-char candidate commit SHA>'
$PreviousReleaseId = 'v2-YYYYMMDD-1234567'
$PreviousCommit = '<40-char previous commit SHA>'
$OperationsEnv = '<absolute protected operations env path>'
$ReleaseArchive = '<absolute path to v2-YYYYMMDD-abcdef0.tar.gz>'
$ExpectedReleaseArchiveSha256 = '<SHA256 from the approved build transfer record>'
$ArtifactManifest = '<absolute path to v2-YYYYMMDD-abcdef0.artifact-manifest.json>'
$ExpectedArtifactManifestSha256 = '<artifact manifest SHA256 from the approved transfer record>'
$PredeployBackupReceipt = '<absolute path to deployment-backup-receipt.json>'
$ExpectedPredeployBackupReceiptSha256 = '<predeploy receipt SHA256 from the off-host handoff>'
$PinnedRuntimeSource = '<absolute path to the approved node-v22.23.1-win-x64 directory>'
$ExpectedPinnedNodeSha256 = '<approved SHA256 of PinnedRuntimeSource\node.exe>'
$PinnedWebProxySource = '<absolute path to the approved serve-v2-recovery.cjs>'
$ExpectedPinnedWebProxySha256 = '<approved SHA256 of PinnedWebProxySource>'

$Candidate = Join-Path (Join-Path $RecoveryRoot 'releases') $ReleaseId
$PreviousCandidate = Join-Path (Join-Path $RecoveryRoot 'releases') $PreviousReleaseId
$Incoming = Join-Path (Join-Path $RecoveryRoot 'releases') ".incoming-$ReleaseId"
$Evidence = Join-Path (Join-Path $RecoveryRoot 'evidence') "release-$ReleaseId"
$AppEnv = Join-Path $RecoveryRoot 'config\app.env'
$TrustedPublicKeyRelativePath = 'deploy/v2-test/trusted-offhost-receipt-public-key.xml'
$TrustedPublicKeyPath = Join-Path $Candidate ($TrustedPublicKeyRelativePath -replace '/', '\')
$StageScript = Join-Path $Candidate 'ops\windows\New-V2RecoveryEquipmentCategoryIndexStage.ps1'
$ReleaseScript = Join-Path $Candidate 'ops\windows\Invoke-V2RecoveryEquipmentCategoryIndexRelease.ps1'
$PostAuditScript = Join-Path $Candidate 'ops\windows\Test-V2RecoveryEquipmentCategoryIndexRelease.ps1'
$ApprovedDryRun = Join-Path $Evidence 'equipment-category-index-approved-dry-run.json'
$StagedPath = Join-Path $Evidence 'staged.json'
```

候选准备必须在业务仍运行、候选 API 从未启动时执行。下面步骤没有覆盖或自动清理分支；任一步失败时保留 incoming 目录和输出，调查后使用新 release ID，除非已有单独批准的清理记录：

```powershell
foreach ($path in @($Candidate, $Incoming, $Evidence, $StagedPath)) {
  if (Test-Path -LiteralPath $path) { throw "Release path already exists; refusing overwrite: $path" }
}
foreach ($file in @(
  $ReleaseArchive, $ArtifactManifest, $PredeployBackupReceipt,
  (Join-Path $PinnedRuntimeSource 'node.exe'),
  (Join-Path $PinnedRuntimeSource 'npm.cmd'),
  $PinnedWebProxySource
)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required staging input missing: $file" }
}
if ((Get-FileHash -LiteralPath $ReleaseArchive -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    $ExpectedReleaseArchiveSha256) { throw 'Release archive transfer SHA256 mismatch' }
if ((Get-FileHash -LiteralPath $ArtifactManifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    $ExpectedArtifactManifestSha256) { throw 'Artifact manifest transfer SHA256 mismatch' }
if ((Get-FileHash -LiteralPath $PredeployBackupReceipt -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    $ExpectedPredeployBackupReceiptSha256) { throw 'Predeploy receipt transfer SHA256 mismatch' }
if ((Get-FileHash -LiteralPath (Join-Path $PinnedRuntimeSource 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    $ExpectedPinnedNodeSha256) { throw 'Pinned Node SHA256 mismatch' }
if ((Get-FileHash -LiteralPath $PinnedWebProxySource -Algorithm SHA256).Hash.ToLowerInvariant() -cne
    $ExpectedPinnedWebProxySha256) { throw 'Pinned Web proxy SHA256 mismatch' }
$pinnedWebProxyText = [IO.File]::ReadAllText($PinnedWebProxySource)
foreach ($requiredProxyVariable in @('WEB_ROOT', 'WEB_PORT', 'API_UPSTREAM')) {
  if (-not $pinnedWebProxyText.Contains($requiredProxyVariable)) {
    throw "Pinned Web proxy does not implement required variable: $requiredProxyVariable"
  }
}

$archiveEntries = @(& tar.exe -tzf $ReleaseArchive)
if ($LASTEXITCODE -ne 0 -or $archiveEntries.Count -eq 0) { throw 'Unable to list release archive' }
$archivePathSet = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $archiveEntries) {
  $relative = ([string]$entry).Replace('\', '/').TrimEnd('/')
  while ($relative.StartsWith('./', [StringComparison]::Ordinal)) {
    $relative = $relative.Substring(2)
  }
  if (-not $relative) { continue }
  $segments = @($relative.Split('/'))
  if (
    [IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or
    ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) -or
    -not $archivePathSet.Add($relative)
  ) { throw "Unsafe or duplicate release archive path: $entry" }
}

New-Item -ItemType Directory -Path $Incoming | Out-Null
& tar.exe -xzf $ReleaseArchive -C $Incoming
if ($LASTEXITCODE -ne 0) { throw 'Release archive extraction failed; incoming is retained' }
$reparse = @(Get-ChildItem -LiteralPath $Incoming -Recurse -Force | Where-Object {
  $_.Attributes -band [IO.FileAttributes]::ReparsePoint
})
if ($reparse.Count -ne 0) { throw "Extracted candidate contains a reparse point: $($reparse[0].FullName)" }

Copy-Item -LiteralPath $PinnedRuntimeSource -Destination (Join-Path $Incoming 'runtime-node') -Recurse
$candidateNode = Join-Path $Incoming 'runtime-node\node.exe'
$candidateNpm = Join-Path $Incoming 'runtime-node\npm.cmd'
if (([string](& $candidateNode --version)).Trim() -cne 'v22.23.1') { throw 'Injected Node version mismatch' }
Push-Location (Join-Path $Incoming 'app')
try {
  & $candidateNpm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Candidate npm ci failed; incoming is retained' }
}
finally { Pop-Location }
foreach ($dependency in @('dotenv', 'express', 'mongoose')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Incoming "app\node_modules\$dependency\package.json") -PathType Leaf)) {
    throw "Required production dependency missing after npm ci: $dependency"
  }
}
Copy-Item -LiteralPath $PinnedWebProxySource -Destination (Join-Path $Incoming 'serve-v2-recovery.cjs')

$apiRunner = @'
$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$recoveryRoot = Split-Path -Parent (Split-Path -Parent $releaseRoot)
$env:ENV_FILE = Join-Path $recoveryRoot 'config\app.env'
Set-Location (Join-Path $releaseRoot 'app')
& (Join-Path $releaseRoot 'runtime-node\node.exe') (Join-Path $releaseRoot 'app\server.js')
exit $LASTEXITCODE
'@
$webRunner = @'
$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:WEB_ROOT = Join-Path $releaseRoot 'app\frontend\dist'
$env:WEB_PORT = '18130'
$env:API_UPSTREAM = 'http://127.0.0.1:18120'
Set-Location $releaseRoot
& (Join-Path $releaseRoot 'runtime-node\node.exe') (Join-Path $releaseRoot 'serve-v2-recovery.cjs')
exit $LASTEXITCODE
'@
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $Incoming 'run-v2-recovery-api.ps1'), "$apiRunner`n", $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $Incoming 'run-v2-recovery-web.ps1'), "$webRunner`n", $utf8NoBom)
& $candidateNode --check (Join-Path $Incoming 'serve-v2-recovery.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Pinned Web proxy syntax check failed' }

foreach ($path in @($Candidate, $Evidence)) {
  if (Test-Path -LiteralPath $path) {
    throw "Release path appeared concurrently; refusing overwrite: $path"
  }
}
Move-Item -LiteralPath $Incoming -Destination $Candidate
```

`PinnedRuntimeSource` 和 `PinnedWebProxySource` 是经变更记录批准的只读输入，不得临时从网络下载，也不得仅凭文件名复用；其 SHA256 必须随本次 package/stage 证据归档。固定 Web proxy 必须实际读取并支持 `WEB_ROOT`、`WEB_PORT`、`API_UPSTREAM`，上述门禁会先检查三个变量契约，激活和 post-audit 还会验证其真实监听及反向代理结果。归档预检和解压后 reparse 检查都必须通过，才能执行依赖安装。候选准备只生成运行依赖和 runner，不生成 `staged.json`。

接着调用候选内的 staging 生成器。第一遍不带 `-Apply` 输出 `WINDOWS_RECOVERY_CANDIDATE_STAGE_PLAN_READY`；第二遍才以 create-new 方式写入。若 `staged.json` 已存在，同一命令只会输出 `WINDOWS_RECOVERY_CANDIDATE_STAGE_REVERIFIED`，输入不同则拒绝且不覆盖：

```powershell
$StageArgs = @{
  ReleaseId = $ReleaseId
  SourceCommit = $SourceCommit
  PreviousReleaseId = $PreviousReleaseId
  PreviousCommit = $PreviousCommit
  ReleaseArchivePath = $ReleaseArchive
  ExpectedReleaseArchiveSha256 = $ExpectedReleaseArchiveSha256
  ArtifactManifestPath = $ArtifactManifest
  ExpectedArtifactManifestSha256 = $ExpectedArtifactManifestSha256
  PredeployBackupReceiptPath = $PredeployBackupReceipt
  ExpectedPredeployBackupReceiptSha256 = $ExpectedPredeployBackupReceiptSha256
  OperationsEnvPath = $OperationsEnv
  RecoveryRoot = $RecoveryRoot
}
& $StageScript @StageArgs
& $StageScript @StageArgs `
  -ConfirmInstance 'task-distribution-v2-customer-test' `
  -ConfirmReleaseId $ReleaseId `
  -ConfirmPreviousReleaseId $PreviousReleaseId `
  -Apply -Confirm:$false

$Staged = [IO.File]::ReadAllText($StagedPath) | ConvertFrom-Json
$AppEnvSha256 = [string]$Staged.runtimeInputs.appEnvSha256
$OperationsEnvSha256 = [string]$Staged.runtimeInputs.operationsEnvSha256
$TrustedPublicKeySha256 = [string]$Staged.runtimeInputs.trustedPublicKeySha256
$RuntimeInputsJson = ConvertTo-Json $Staged.runtimeInputs -Depth 12 -Compress
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $RuntimeInputsSha256 = ([BitConverter]::ToString($sha256.ComputeHash(
    (New-Object Text.UTF8Encoding($false)).GetBytes($RuntimeInputsJson)
  ))).Replace('-', '').ToLowerInvariant()
}
finally { $sha256.Dispose() }
if ([string]$Staged.runtimeInputsSha256 -cne $RuntimeInputsSha256) {
  throw 'staged.json runtime input hash contract mismatch'
}

if (Test-Path -LiteralPath $ApprovedDryRun) { throw 'Approved dry-run path must be new' }
$hadEnvFile = Test-Path Env:ENV_FILE
$previousEnvFile = $env:ENV_FILE
try {
  $env:ENV_FILE = $AppEnv
  & (Join-Path $Candidate 'runtime-node\node.exe') `
    (Join-Path $Candidate 'app\script\migrateEquipmentCategoryIndex.js') `
    --dry-run --report $ApprovedDryRun
  if ($LASTEXITCODE -ne 0) { throw 'Approved equipment-category dry-run failed' }
}
finally {
  if ($hadEnvFile) { $env:ENV_FILE = $previousEnvFile }
  else { Remove-Item Env:ENV_FILE -ErrorAction SilentlyContinue }
}

$MigrationDryRunReportSha256 = (Get-FileHash -LiteralPath $ApprovedDryRun -Algorithm SHA256).Hash.ToLowerInvariant()
$StagedEvidenceSha256 = (Get-FileHash -LiteralPath $StagedPath -Algorithm SHA256).Hash.ToLowerInvariant()
$Common = @{
  ReleaseId = $ReleaseId
  SourceCommit = $SourceCommit
  PreviousReleaseId = $PreviousReleaseId
  PreviousCommit = $PreviousCommit
  MigrationDryRunReport = $ApprovedDryRun
  MigrationDryRunReportSha256 = $MigrationDryRunReportSha256
  StagedEvidenceSha256 = $StagedEvidenceSha256
  OperationsEnvPath = $OperationsEnv
  AppEnvSha256 = $AppEnvSha256
  OperationsEnvSha256 = $OperationsEnvSha256
  RecoveryRoot = $RecoveryRoot
  ApprovedBackupRoot = $ApprovedBackupRoot
}
```

#### 4.5.2 Phase 1：Plan 和 Hold

先执行只读 `Plan`。输出必须是 `TWO_PHASE_PLAN_READY`，并人工复核 release、commit、数据库、停止顺序、保留任务、观察时长和 `requiredRecoveryAfterMigrationStarts=FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE`：

```powershell
& $ReleaseScript @Common -Mode Plan
```

获得维护窗口批准后执行一次 `Hold`。显式确认参数是防误操作边界，不能改成相近名称：

```powershell
$holdOutput = @(& $ReleaseScript @Common `
  -Mode Hold `
  -ConfirmInstance 'task-distribution-v2-customer-test' `
  -ConfirmDatabase 'customer_acceptance_v2_test' `
  -ConfirmReleaseId $ReleaseId `
  -ConfirmPreviousReleaseId $PreviousReleaseId `
  -Confirm:$false 2>&1)
$Hold = (($holdOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
if ($Hold.status -ne 'BUSINESS_SURFACE_HELD_FOR_STOPPED_BACKUP') { throw 'Hold did not complete' }

$StoppedHandoffPath = [string]$Hold.stoppedHandoffPath
$StoppedHandoffSha256 = [string]$Hold.stoppedHandoffSha256
$HandoffNonce = [string]$Hold.handoffNonce
$SourceHost = [string]$Hold.sourceHost
$HoldMongoAnchorPath = [string]$Hold.holdMongoAnchorPath
$HoldMongoAnchorSha256 = [string]$Hold.holdMongoAnchorSha256
```

`Hold` 的固定顺序是业务 tunnel -> Web -> API，三项均停止并禁用；管理 tunnel 和 MongoDB 必须继续运行。脚本还会验证 `18120/18130` 已无监听、没有 Recovery 目标库写进程、停写状态下的第二次 dry-run 仍满足迁移前状态，然后一次性写入随机 nonce，采集 `mongo-write-anchor-hold.json`，最后把其绝对路径和整个文件的 SHA256 连同 `stoppedAt` 封入 handoff。从 `Hold` 成功返回到 `Execute` 完成前，客户业务面按设计不可用；不得手工启动、启用或运行这三个业务任务，否则 `Execute` 会因任务动作、`LastRunTime`、监听状态或 Mongo write anchor 漂移而拒绝。

#### 4.5.3 停写后新备份和服务器 ZIP 证据

必须在 `Hold.stoppedAt` 之后用候选 release 的官方 `ops/backup.js` 创建全新备份。该 `backupId` 必须不同于 `staged.json` 中的预部署备份，目录必须位于 `$ApprovedBackupRoot` 下，manifest 的 `createdAt` 和 `completedAt` 都不得早于 `stoppedAt`：

```powershell
$backupOutput = @(& (Join-Path $Candidate 'runtime-node\node.exe') `
  (Join-Path $Candidate 'ops\backup.js') --env-file $OperationsEnv 2>&1)
if ($LASTEXITCODE -ne 0) { throw ($backupOutput -join "`n") }
$Backup = (($backupOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
if ($Backup.status -ne 'BACKUP_COMPLETED' -or $Backup.database -ne 'customer_acceptance_v2_test') {
  throw 'Stopped backup identity mismatch'
}

$BackupId = [string]$Backup.backupId
$BackupDirectory = [string]$Backup.directory
$BackupManifestSha256 = [string]$Backup.manifestSha256
$verifyOutput = @(& (Join-Path $Candidate 'runtime-node\node.exe') `
  (Join-Path $Candidate 'ops\verify-backup.js') `
  --env-file $OperationsEnv --backup-id $BackupId 2>&1)
if ($LASTEXITCODE -ne 0) { throw ($verifyOutput -join "`n") }
$Verified = (($verifyOutput | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
if ($Verified.status -ne 'BACKUP_VERIFIED' -or $Verified.manifestSha256 -ne $BackupManifestSha256) {
  throw 'Stopped backup verification mismatch'
}

$ServerArchive = Join-Path $ApprovedBackupRoot "$BackupId.zip"
if (Test-Path -LiteralPath $ServerArchive) { throw 'Stopped backup archive path must be new' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory(
  $BackupDirectory,
  $ServerArchive,
  [IO.Compression.CompressionLevel]::Optimal,
  $true
)
$ExpectedArchiveSha256 = (Get-FileHash -LiteralPath $ServerArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$ExpectedArchiveBytes = [int64](Get-Item -LiteralPath $ServerArchive).Length
```

备份 manifest 必须声明 `task-distribution-v2-backup/v1`、`customer_acceptance_v2_test`、`BEST_EFFORT_ONLINE_MONGODUMP` 和 `databaseAndUploadsAtomic=false`，并完整包含 `equipmentcategories.bson`、`equipmentcategories.metadata.json`、uploads 文件及 FileAsset 引用验证。业务写入已经停止，但数据库和上传文件仍不是底层原子快照；恢复时必须把同一个 `backupId` 的数据库与 uploads 当作一套恢复点，不能拼接不同备份。

#### 4.5.4 独立工作站 E 盘验签和 receipt

把最终 `$BackupId.zip` 以二进制原样下载到一台不同于 `$SourceHost` 的独立 Windows 工作站 E 盘，同时取得候选中的以下五个原样文件：

- `runtime-node\node.exe`；
- `ops\lib\backupCore.js`；
- `ops\windows\New-V2RecoveryStoppedBackupOffhostReceipt.ps1`；
- `ops\windows\New-V2RecoveryOffhostReceiptSigningKey.ps1`；
- `deploy\v2-test\trusted-offhost-receipt-public-key.xml`。

传输记录必须保存服务器侧 ZIP SHA256、字节数和工作站侧复算值。Node、backupCore、receipt generator、key generator 和固定公钥也必须与服务器候选逐文件 SHA256 相同；receipt 会记录其实际消费工具的 SHA，`Execute` 会再次和候选比较。签名私钥必须提前由候选包内 `New-V2RecoveryOffhostReceiptSigningKey.ps1` 在独立工作站 E 盘受保护目录生成；该脚本会拒绝把 key root 放在 Git 仓库内。私钥只能留在该工作站，禁止上传服务器、写入仓库、命令输出或聊天。独立副本根目录必须真实位于 E 盘且不是 reparse point，ZIP、全新解压目录、固定公钥和全新 receipt 路径都必须位于该根目录下。

在独立工作站执行下面命令。第一遍不带 `-Apply` 只输出计划，确认无误后第二遍才写入；`ConfirmIndependentHost` 必须等于工作站自己的 `$env:COMPUTERNAME`：

```powershell
$IndependentRoot = "E:\TaskDistribution-V2-Offhost\$ReleaseId\$BackupId"
$ArchivePath = Join-Path $IndependentRoot "$BackupId.zip"
$ExtractionDirectory = Join-Path $IndependentRoot 'verified-extracted'
$ReceiptPath = Join-Path $IndependentRoot "offhost-verification-$BackupId.json"
$NodePath = Join-Path $IndependentRoot 'candidate-tools\runtime-node\node.exe'
$BackupCorePath = Join-Path $IndependentRoot 'candidate-tools\ops\lib\backupCore.js'
$ReceiptGenerator = Join-Path $IndependentRoot 'candidate-tools\ops\windows\New-V2RecoveryStoppedBackupOffhostReceipt.ps1'
$SigningPrivateKeyPath = '<protected E:\ path to offhost-receipt-private.xml>'
$ExpectedTrustedPublicKeySha256 = '<candidate public key SHA256 recorded at staging>'
$IndependentTrustedPublicKeyPath = Join-Path $IndependentRoot `
  'candidate-tools\deploy\v2-test\trusted-offhost-receipt-public-key.xml'
$IndependentTrustedPublicKeySha256 = (Get-FileHash `
  -LiteralPath $IndependentTrustedPublicKeyPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($IndependentTrustedPublicKeySha256 -cne $ExpectedTrustedPublicKeySha256) {
  throw 'Independent workstation public key differs from the staged candidate'
}

$ReceiptArgs = @{
  ReleaseId = $ReleaseId
  SourceCommit = $SourceCommit
  PreviousReleaseId = $PreviousReleaseId
  PreviousCommit = $PreviousCommit
  BackupId = $BackupId
  BackupManifestSha256 = $BackupManifestSha256
  StoppedHandoffSha256 = $StoppedHandoffSha256
  HandoffNonce = $HandoffNonce
  ExpectedArchiveSha256 = $ExpectedArchiveSha256
  ExpectedArchiveBytes = $ExpectedArchiveBytes
  SourceHost = $SourceHost
  IndependentCopyRoot = $IndependentRoot
  ArchivePath = $ArchivePath
  ExtractionDirectory = $ExtractionDirectory
  ReceiptPath = $ReceiptPath
  NodePath = $NodePath
  BackupCorePath = $BackupCorePath
  SigningPrivateKeyPath = $SigningPrivateKeyPath
  TrustedPublicKeyPath = $IndependentTrustedPublicKeyPath
  TrustedPublicKeySha256 = $IndependentTrustedPublicKeySha256
  ConfirmIndependentHost = $env:COMPUTERNAME
}
& $ReceiptGenerator @ReceiptArgs
& $ReceiptGenerator @ReceiptArgs -Apply -Confirm:$false
```

生成器会拒绝 ZIP 路径穿越、重复项、符号链接、已有解压/receipt 路径、source host 与 independent host 相同、ZIP SHA/字节数不一致，并调用 `verifyBackupSet(..., { verifyFiles: true })` 复核精确文件集、每个声明文件 SHA256、设备分类 BSON/metadata、uploads 和 FileAsset 引用。最终文件是 `task-distribution-v2-windows-stopped-backup-offhost-signed-envelope/v2`，使用 RSA-3072、SHA256、PKCS#1 v1.5 签名；服务器只信任候选包内固定公钥。保留 E 盘 ZIP、解压结果和原始 signed receipt，不要在 `Execute` 后立即清理。

将 receipt 原样上传回服务器的唯一固定路径，上传前该路径必须不存在，上传后再复算 SHA256；不要手工编辑 JSON：

```powershell
$OffhostVerificationReceipt = Join-Path $Evidence "offhost-verification-$BackupId.json"
# Upload the exact independent-workstation ReceiptPath through the approved transfer channel.
$OffhostVerificationReceiptSha256 = (Get-FileHash `
  -LiteralPath $OffhostVerificationReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
```

#### 4.5.5 Phase 2：Execute

`Execute` 会重新校验 handoff、nonce、任务连续性、停写后备份、离机 receipt、候选三份验证工具 SHA 和第三次 stopped-state dry-run，之后才创建一次性 execute claim。所有值必须来自本次链路，不能复用其他 release、主机或备份的报告：

```powershell
& $ReleaseScript @Common `
  -Mode Execute `
  -StoppedHandoffPath $StoppedHandoffPath `
  -StoppedHandoffSha256 $StoppedHandoffSha256 `
  -HandoffNonce $HandoffNonce `
  -BackupDirectory $BackupDirectory `
  -BackupId $BackupId `
  -BackupManifestSha256 $BackupManifestSha256 `
  -OffhostVerificationReceipt $OffhostVerificationReceipt `
  -OffhostVerificationReceiptSha256 $OffhostVerificationReceiptSha256 `
  -TrustedPublicKeyPath $TrustedPublicKeyPath `
  -TrustedPublicKeySha256 $TrustedPublicKeySha256 `
  -ConfirmInstance 'task-distribution-v2-customer-test' `
  -ConfirmDatabase 'customer_acceptance_v2_test' `
  -ConfirmReleaseId $ReleaseId `
  -ConfirmPreviousReleaseId $PreviousReleaseId `
  -ConfirmBackupId $BackupId `
  -ConfirmHandoffNonce $HandoffNonce `
  -Confirm:$false
```

`Execute` 在创建 claim 和写索引前，会生成 `mongo-write-anchor-execute.json` 并与 Hold anchor 比较；只要 oplog、Mongo 进程/拓扑身份、release 或 nonce 有变化，就保持业务闭锁并失败。不要中断默认的 330 秒候选稳定性观察和 300 秒 worker 观察。第一次 execute 报告必须是 `EXECUTED`、`writePerformed=true`；脚本紧接着进行的第二次 execute 必须是 `ALREADY_APPLIED`、`writePerformed=false`。随后才允许切换 stable runner、启动 API/Web、恢复业务 tunnel、开启 worker，并验证本地/公网健康、两团队列表、进程未重启且 worker 日志没有 `Equipment routine worker failed:`。handoff nonce 和所有报告路径只能消费一次；SSH 或终端断开时先查证据和任务状态，禁止盲目重跑 `Execute`。

MongoDB 的 `createIndex/dropIndex` 与文件证据台账不是一个数据库事务，不能描述为“DDL 与 ledger 原子提交”。本流程依靠停写窗口、Mongo write anchor、create-new 证据、失败闭锁和幂等复跑前向收敛；`migration-started.json` 落盘后禁止普通代码回滚。

#### 4.5.6 Post-audit 和成功判定

`Execute` 成功返回后，使用同一组 release、commit、backup、handoff、nonce 和 receipt SHA 运行独立 post-audit。`IndexAuditReport` 必须是 evidence 目录下的全新路径：

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$IndexAuditReport = Join-Path $Evidence `
  "equipment-category-index-postaudit-$stamp-$([Guid]::NewGuid().ToString('N')).json"
$BusinessAuditReport = Join-Path $Evidence `
  "equipment-routine-business-postaudit-$stamp-$([Guid]::NewGuid().ToString('N')).json"
& $PostAuditScript `
  -ReleaseId $ReleaseId `
  -SourceCommit $SourceCommit `
  -PreviousReleaseId $PreviousReleaseId `
  -PreviousCommit $PreviousCommit `
  -BackupId $BackupId `
  -BackupManifestSha256 $BackupManifestSha256 `
  -StagedEvidenceSha256 $StagedEvidenceSha256 `
  -StoppedHandoffSha256 $StoppedHandoffSha256 `
  -HandoffNonce $HandoffNonce `
  -OffhostVerificationReceiptSha256 $OffhostVerificationReceiptSha256 `
  -TrustedPublicKeyPath $TrustedPublicKeyPath `
  -TrustedPublicKeySha256 $TrustedPublicKeySha256 `
  -OperationsEnvPath $OperationsEnv `
  -AppEnvSha256 $AppEnvSha256 `
  -OperationsEnvSha256 $OperationsEnvSha256 `
  -RecoveryRoot $RecoveryRoot `
  -IndexAuditReport $IndexAuditReport `
  -BusinessAuditReport $BusinessAuditReport
```

只有输出 `POSTDEPLOY_AUDIT_PASSED` 才算发布链通过。post-audit 会重新验证候选精确 `FILE-MANIFEST.json`、固定公钥、`app.env`/`operations.env` 及 `runtimeInputsSha256` 的完整哈希链，复核 Hold/Execute 两份 Mongo write anchor 未漂移，并执行只读设备点检/保养业务审计。业务审计要求 `GEARBOX_LOGISTICS` 下三种在用一级设备名称的数量门禁分别为铅酸电池电动叉车 `6`、锂离子电池电动叉车 `5`、辊子输送机 `1`，且 `writePerformed=false`、违规数为零。它还验证目标索引存在、旧索引和未知团队级 unique 索引为零、blocker 为零、五个计划任务运行、API/Web 仅监听 loopback、当前进程属于候选 release、本地/公网健康、`ENGINE_LOGISTICS` 和 `GEARBOX_LOGISTICS` 可见。只要 release evidence 中存在 `migration-or-activation-failed.json`，即使同时存在 `active.json` 或 `activation-commit.json`，也必须判失败。post-audit 工具本身只报告并抛错，不会替操作者停止已激活服务；若它失败，应立即按事故流程冻结业务面并保全证据，不能宣告成功或直接回滚代码。

#### 4.5.7 固定证据和失败恢复边界

以下证据必须归档并记录 SHA256。除 post-audit 的带时间戳报告外，脚本对固定路径使用 create-new 语义；禁止删除后复用：

| 阶段 | 必需证据 |
| --- | --- |
| package/stage | release `.tar.gz`、归档 SHA256、artifact manifest、候选 `deploy\RELEASE.json`、`deploy\FILE-MANIFEST.json` 及 SHA256、`staged.json` 及 SHA256、`runtimeInputsSha256`、批准 dry-run及 SHA256 |
| Hold | `migration-rollback-state.json`、`equipment-category-index-stopped-dry-run.json`、`equipment-category-index-stopped-handoff.json` 及其 nonce、`stoppedAt`、`sourceHost`、任务动作/LastRunTime/监听状态、`mongo-write-anchor-hold.json` 及 SHA256 |
| stopped backup | 完整 `$BackupDirectory`、`manifest.json`、`manifest.sha256`、服务器 `$BackupId.zip` 的 SHA256 和字节数、官方 verify 成功输出 |
| independent workstation | E 盘原始 ZIP、全新解压目录、原始 `offhost-verification-$BackupId.json`、工作站名及 Node/backupCore/receipt generator/key generator SHA |
| Execute | `backup-verification-before-index-migration.json`、`equipment-category-index-execute-dry-run.json`、`equipment-category-index-execute-claim.json`、`mongo-write-anchor-execute.json` 及 SHA256、`migration-started.json`、`equipment-category-index-execute.json`、`equipment-category-index-idempotency.json`、`migration-completed.json` |
| activation/audit | `active.json`、`active-release.json`、`activation-commit.json`、带时间戳 post-audit index 报告及 SHA256、带时间戳只读 equipment-routine business 报告及 SHA256、post-audit 完整输出、任务/监听/健康/worker 观察结果 |

恢复决策以 `migration-started.json` 是否已落盘为唯一硬分界，不以操作者猜测 CLI 是否“可能还没写”代替证据：

| 状态 | 允许动作 |
| --- | --- |
| `Plan` 失败 | 没有业务变更；修复输入或 blocker 后创建新报告再评审。 |
| `Hold` 自身失败 | 脚本尝试按 `migration-rollback-state.json` 自动恢复旧 API/Web/tunnel，并写 `pre-migration-automatic-recovery.json`；若恢复不完整，继续保持事故状态，不能宣称旧版已恢复。 |
| `Hold` 成功，或 `Execute` 在 `migration-started.json` 前失败 | 业务面保持停止，`rollbackReady=false`。只有先证明索引完全未变，再严格恢复捕获的旧任务动作、runner 和 active marker，才允许恢复上一 release；不能随手启用任务。 |
| `migration-started.json` 已存在，无论后续迁移、激活或观察在哪一步失败 | 业务 tunnel、Web、API 必须保持停止；`rollbackReady=false`、`codeOnlyRollbackAllowed=false`，唯一恢复方向是 `FORWARD_FIX_OR_RESTORE_TO_NEW_DATABASE`。不得启动旧代码、重建旧索引、覆盖活动数据库或删除失败证据。 |
| 迁移及激活成功 | 仍然是 `rollbackReady=false`、`codeOnlyRollbackAllowed=false`。新索引允许不同父分类下出现相同二级名称，之后旧代码可能无法重建旧的团队级唯一约束，因此禁止普通代码单独回滚。 |

“恢复到新数据库”指：保持业务停止，把本次停写备份的数据库和 uploads 恢复到全新的隔离数据库名与隔离上传目录，完成 manifest/文件/索引/业务只读校验，再经单独批准切换兼容运行时；不能原地覆盖 `customer_acceptance_v2_test`。恢复完成前，管理 tunnel 和 MongoDB 可按取证需要保留，但不得借此开放客户业务面。

### 4.6 切换版本

本节是没有专用迁移激活器时的通用 Windows 切换。4.5 节的 Windows Recovery 设备分类索引发布已经由 `Execute` 完成 runner、active marker、API/Web、tunnel 和 worker 激活，不得再执行本节命令。

上线前先按 `docs/OPERATIONS_RUNBOOK.md` 创建并校验备份。维护窗口内：

```powershell
Stop-Service TaskDistributionV2Api
$Previous = (Get-Item E:\TaskDistribution-V2-Releases\current -ErrorAction SilentlyContinue).Target
if (Test-Path E:\TaskDistribution-V2-Releases\current) {
  Remove-Item E:\TaskDistribution-V2-Releases\current
}
New-Item -ItemType Junction -Path E:\TaskDistribution-V2-Releases\current -Target $ReleaseRoot | Out-Null
Start-Service TaskDistributionV2Api
Get-Service TaskDistributionV2Api
Invoke-WebRequest http://127.0.0.1:18099/health -UseBasicParsing
```

将 `$Previous`、新 release ID、健康检查和反向代理 HTTPS 检查结果写入发布记录。Web 站点根目录指向 `current\app\frontend\dist`；切换后回收应用池或重载 Nginx，不修改旧 release。

备份和健康计划任务使用现有 `ops/windows/Install-ScheduledTasks.ps1`，不能用于启动或重启业务 API。

## 5. Linux 部署

### 5.1 目录与账号

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin taskdistribution 2>/dev/null || true
sudo install -d -o root -g root -m 0755 /opt/taskdistribution-v2/releases
sudo install -d -o taskdistribution -g taskdistribution -m 0750 /srv/taskdistribution-v2/uploads
sudo install -d -o taskdistribution -g taskdistribution -m 0750 /var/log/taskdistribution-v2
sudo install -d -o root -g taskdistribution -m 0750 /etc/taskdistribution-v2
sudo install -o root -g taskdistribution -m 0640 /path/to/reviewed/app.env /etc/taskdistribution-v2/app.env
```

解包候选 release 并安装生产依赖；Web `dist` 应由相同 commit 构建并随 release 验证：

```bash
RELEASE_ID=v2-YYYYMMDD-HHMMSS
sudo install -d -o root -g root -m 0755 "/opt/taskdistribution-v2/releases/$RELEASE_ID"
sudo unzip "/srv/releases/$RELEASE_ID-source.zip" -d "/opt/taskdistribution-v2/releases/$RELEASE_ID"
cd "/opt/taskdistribution-v2/releases/$RELEASE_ID/app"
sudo npm ci --omit=dev
cd frontend
sudo npm ci
sudo env VITE_API_BASE_URL=/api npm run build
```

### 5.2 API systemd 单元

仓库只附带备份/健康 systemd 示例，以下 API 单元须经运维评审后另存为 `/etc/systemd/system/taskdistribution-v2-api.service`：

```ini
[Unit]
Description=TaskDistribution V2 API
After=network-online.target mongod.service
Wants=network-online.target

[Service]
Type=simple
User=taskdistribution
Group=taskdistribution
WorkingDirectory=/opt/taskdistribution-v2/current/app
Environment=ENV_FILE=/etc/taskdistribution-v2/app.env
ExecStart=/usr/bin/node /opt/taskdistribution-v2/current/app/server.js
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/taskdistribution-v2/current
ReadWritePaths=/srv/taskdistribution-v2/uploads /var/log/taskdistribution-v2
UMask=0027

[Install]
WantedBy=multi-user.target
```

`UPLOAD_PATH` 必须与 `ReadWritePaths` 一致。这里只验证单元并注册开机自启动，`systemctl enable` 不会启动服务：

```bash
sudo systemd-analyze verify /etc/systemd/system/taskdistribution-v2-api.service
sudo systemctl daemon-reload
sudo systemctl enable taskdistribution-v2-api.service
```

此阶段不得使用 `systemctl enable --now`、`systemctl start/restart taskdistribution-v2-api.service`，不得直接运行候选目录中的 `app/server.js`，也不得先把 `current` 指向候选 release。候选 API 首次连接旧数据库前必须完成 5.3 的停写、完整备份、审核轮次迁移和报告校验；否则 Mongoose `autoIndex` 可能先创建新索引并绕过迁移门禁。

Nginx 同源配置核心规则如下，证书和安全头由客户现有基线补齐：

```nginx
location / {
    root /opt/taskdistribution-v2/current/app/frontend/dist;
    try_files $uri $uri/ /index.html;
}

location /api/ {
    proxy_pass http://127.0.0.1:18099/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 5.3 原子切换

以下命令必须在维护窗口的同一个 Bash 会话中按顺序运行，以保留变量和 `set -o pipefail`。候选代码只用于备份和显式迁移 CLI，不启动候选 API。先填写并复核 release、数据库和受保护环境文件；`DATABASE_NAME` 必须与 `app.env` 中 `MONGODB_URI` 的数据库名精确一致：

```bash
set -euo pipefail
RELEASE_ID=v2-YYYYMMDD-HHMMSS
CANDIDATE="/opt/taskdistribution-v2/releases/$RELEASE_ID"
DATABASE_NAME='task_distribution_v2'
APP_ENV=/etc/taskdistribution-v2/app.env
OPS_ENV=/etc/taskdistribution-v2/operations.env
EVIDENCE_DIR="/var/log/taskdistribution-v2/releases/$RELEASE_ID"

test -d "$CANDIDATE/app"
test -f "$APP_ENV"
test -f "$OPS_ENV"
test ! -e "$EVIDENCE_DIR"
test ! -L "$EVIDENCE_DIR"
sudo install -d -o taskdistribution -g taskdistribution -m 0750 "$EVIDENCE_DIR"
```

停止 API 以及所有独立 worker、导入器和人工写入入口，并确认 API 已停止。首次部署也应先安装但不启动 API 单元，再执行此门禁：

```bash
sudo systemctl stop taskdistribution-v2-api.service
if sudo systemctl is-active --quiet taskdistribution-v2-api.service; then
  echo 'API is still active; aborting release gate' >&2
  exit 1
fi
```

由候选 release 的只读运维脚本创建完整数据库与上传备份。备份成功输出中的 `backupId` 和绝对目录必须人工回填到下面两个变量；不要复用旧备份 ID：

```bash
sudo -u taskdistribution /usr/bin/node "$CANDIDATE/ops/backup.js" \
  --env-file "$OPS_ENV" | sudo tee "$EVIDENCE_DIR/backup-result.json"

BACKUP_ID='backup-YYYYMMDDTHHMMSSZ-xxxxxxxx'
BACKUP_DIR='/dedicated-backup-mount/taskdistribution-v2/backup-YYYYMMDDTHHMMSSZ-xxxxxxxx'

sudo -u taskdistribution /usr/bin/node "$CANDIDATE/ops/verify-backup.js" \
  --env-file "$OPS_ENV" \
  --backup-id "$BACKUP_ID" | sudo tee "$EVIDENCE_DIR/backup-verify-result.json"
```

`verify-backup.js` 会复核清单 SHA256、每个声明文件及精确文件集合；审核轮次迁移还会在任何写入前再次强制校验数据库名，并要求清单和物理文件中同时存在 `tasks`、`taskreviews`。发布记录中显式保存这两个集合的预检证据：

```bash
sudo -u taskdistribution /usr/bin/node - \
  "$BACKUP_DIR/manifest.json" "$DATABASE_NAME" <<'NODE' \
  | sudo tee "$EVIDENCE_DIR/required-task-collections.json"
const fs = require('node:fs');
const [manifestPath, databaseName] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const collections = new Set((manifest.database?.collections || []).map(({ name }) => name));
const files = new Set((manifest.files || []).map(({ file }) => file));
const requiredCollections = ['tasks', 'taskreviews'];
const requiredFiles = requiredCollections.map(
  (name) => `database/${databaseName}/${name}.bson`
);
const missingCollections = requiredCollections.filter((name) => !collections.has(name));
const missingFiles = requiredFiles.filter((file) => !files.has(file));
const result = { databaseName, requiredCollections, requiredFiles, missingCollections, missingFiles };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (manifest.database?.name !== databaseName || missingCollections.length || missingFiles.length) {
  process.exitCode = 1;
}
NODE
```

为 dry-run 和 execute 使用两个从未存在过的独立报告路径。CLI 以不可覆盖方式创建报告，路径已存在会以 `EEXIST` 失败；execute 报告路径必须预先确认不存在且目录可写：

```bash
DRY_REPORT="$EVIDENCE_DIR/task-review-stages-dry-run.json"
EXEC_REPORT="$EVIDENCE_DIR/task-review-stages-execute.json"
sudo -u taskdistribution test -w "$EVIDENCE_DIR"
sudo -u taskdistribution test ! -e "$DRY_REPORT"
sudo -u taskdistribution test ! -e "$EXEC_REPORT"

sudo -u taskdistribution env ENV_FILE="$APP_ENV" \
  /usr/bin/node "$CANDIDATE/app/script/migrateTaskReviewStages.js" \
  --report "$DRY_REPORT"

sudo -u taskdistribution /usr/bin/node - "$DRY_REPORT" <<'NODE'
const report = require(process.argv[2]);
if (report.status !== 'DRY_RUN_READY' || report.writePerformed !== false) process.exit(1);
NODE

sudo -u taskdistribution env ENV_FILE="$APP_ENV" \
  /usr/bin/node "$CANDIDATE/app/script/migrateTaskReviewStages.js" \
  --execute \
  --confirm-database "$DATABASE_NAME" \
  --backup-directory "$BACKUP_DIR" \
  --report "$EXEC_REPORT"

sudo -u taskdistribution /usr/bin/node - "$EXEC_REPORT" "$BACKUP_ID" <<'NODE'
const report = require(process.argv[2]);
const backupId = process.argv[3];
if (
  report.status !== 'EXECUTED' ||
  report.backup?.backupId !== backupId ||
  !report.backup?.manifestSha256 ||
  report.after?.indexes?.desiredPresent !== true ||
  report.after?.indexes?.legacyRestrictive?.length !== 0
) process.exit(1);
NODE
```

只有以上命令全部成功后，才原子切换 `current` 并首次启动候选 API：

```bash
PREVIOUS=$(readlink -f /opt/taskdistribution-v2/current || true)
CURRENT_NEW="/opt/taskdistribution-v2/current.new.$RELEASE_ID"
test ! -e "$CURRENT_NEW"
test ! -L "$CURRENT_NEW"
sudo ln -s "$CANDIDATE" "$CURRENT_NEW"
sudo mv -Tf "$CURRENT_NEW" /opt/taskdistribution-v2/current
sudo systemctl start taskdistribution-v2-api.service
sudo systemctl --no-pager --full status taskdistribution-v2-api.service
curl --fail --silent --show-error http://127.0.0.1:18099/health
sudo nginx -t
sudo systemctl reload nginx
```

如果备份、备份校验、必需集合检查或 dry-run 失败，`current` 仍指向旧 release 且迁移没有写入；归档错误后可启动旧 API 恢复服务。execute 失败时必须先读取新的 execute 报告：仅当报告存在且 `writePerformed` 明确为 `false` 时，才可启动旧 API；若为 `true` 或报告缺失，保持 API 停止，不切换、不重跑、不按普通代码回滚，依据报告中的 `backup`、`before`、`after`、`completedSteps` 做 forward repair 或单独批准的整库恢复。任何已有报告路径都不得删除后复用。

安装备份/健康示例前先修改 `ops/linux/*.service` 中的用户、路径和读写目录，再按 `docs/OPERATIONS_RUNBOOK.md` dry run 和安装。

## 6. API/Web 回滚与演练

### 6.1 回滚触发条件

- API 健康检查失败或启动循环失败。
- 登录、团队选择、任务、附件或核心设备流程出现阻断性回归。
- 新版本产生持续 5xx、数据范围错误或 worker 异常重复消息。
- Web 静态资源无法加载、API base URL 错误或权限路由不可用。

普通代码回滚只切换 release，不回滚数据库或删除上传。当前 release 流程不自动执行 schema migration；只有经过独立批准且证据表明确要求时，才考虑数据恢复。若审核轮次迁移后已产生同一人员和阶段的多轮记录，禁止切回不识别 `reviewRound` 的旧代码或重建旧两字段、三字段、四字段 stage 限制性唯一索引；按 4.4 的 forward-only 约束处理。

### 6.2 Windows 回滚

```powershell
Stop-Service TaskDistributionV2Api
Remove-Item E:\TaskDistribution-V2-Releases\current
New-Item -ItemType Junction -Path E:\TaskDistribution-V2-Releases\current -Target 'E:\TaskDistribution-V2-Releases\<previous-release-id>' | Out-Null
Start-Service TaskDistributionV2Api
Invoke-WebRequest http://127.0.0.1:18099/health -UseBasicParsing
```

### 6.3 Linux 回滚

先确认目标旧 release 兼容当前数据库索引。若已执行审核轮次迁移，目标版本必须理解 `reviewRound` 和 `uq_task_review_stage_round`；不兼容的旧版本禁止启动。回滚时先停止 API，再切换链接：

```bash
set -euo pipefail
PREVIOUS_RELEASE=v2-YYYYMMDD-HHMMSS
ROLLBACK_TARGET="/opt/taskdistribution-v2/releases/$PREVIOUS_RELEASE"
ROLLBACK_LINK="/opt/taskdistribution-v2/current.rollback.$PREVIOUS_RELEASE"
test -d "$ROLLBACK_TARGET/app"
test ! -e "$ROLLBACK_LINK"
test ! -L "$ROLLBACK_LINK"
sudo systemctl stop taskdistribution-v2-api.service
sudo ln -s "$ROLLBACK_TARGET" "$ROLLBACK_LINK"
sudo mv -Tf "$ROLLBACK_LINK" /opt/taskdistribution-v2/current
sudo systemctl start taskdistribution-v2-api.service
curl --fail --silent --show-error http://127.0.0.1:18099/health
sudo nginx -t
sudo systemctl reload nginx
```

### 6.4 必做演练

在隔离 staging 环境执行，不连接生产数据库或上传目录：

1. 部署版本 N-1，完成登录、团队选择、任务读取、设备详情和附件读取冒烟检查。
2. 创建并校验 staging 备份，记录 `backupId` 和 `manifestSha256`。
3. 切换到版本 N，完成健康检查和相同冒烟流程。
4. 切回 N-1，确认 API/Web 恢复且原测试数据、附件仍可读取。
5. 再切回 N，确认重复切换不会执行初始化、导入或删除。
6. 记录两个 release ID、每次切换时间、退出码、日志、健康结果和批准人。

数据库恢复演练使用 `ops/restore.js` 恢复到新的 `_restore_test`/`_v2_test` 库和隔离目录，不能覆盖活动数据库或上传目录，详见 `docs/OPERATIONS_RUNBOOK.md`。

恢复到 Task/TaskReview 审核轮次迁移前的旧测试快照后，新测试库的字段和索引状态也随快照回退；在用当前版本启动 API 或继续冒烟前，必须针对该恢复库重新执行 dry-run 和显式迁移，不能沿用原数据库的迁移报告。

### 6.5 历史公网测试域名边缘回滚记录

`v2-test.horselink.cn` 是独立客户测试入口，不是生产切换。`PUBLIC_TEST_DEPLOYMENT_ACCEPTANCE_20260722.md` 和下列 ID 仅记录 2026-07-22 的历史演练，不是 2026-08-11 的当前真实回滚点。管理通道恢复后，必须先重新盘点并校验当前边缘配置、备份目录、证书、监听和实际 active release；在此之前禁止直接执行这些旧 ID。

1. 历史 provenance：当时的 HTTPS 切换备份为 `deploy-20260722T175528418-9e0c0ad6`，HTTP 部署备份为 `deploy-20260722T170909046-28c7dbed`。只有重新盘点证明目标、内容、完整性和当前拓扑仍匹配，并获得新的维护窗口批准后，才允许把某个历史备份提升为候选。
2. 禁止使用模糊的 `latest` 备份。回滚脚本必须先创建 safety backup，在 candidate 配置树执行 `nginx -t`，替换后再次执行 live `nginx -t`，成功后才 reload。
3. 边缘入口回滚并验证旧版 `/`、`/admin`、`/health` 和 `38080` 后，才删除测试 DNS 记录。
4. 完全下线时单独禁用 `TaskDistribution-V2-Test-Certificate-Renewal`，只停止 `taskdistribution-v2-test-tunnel.service` 和 V2 服务；不得触碰生产 `38080`、`27017` 或旧版服务。
5. 不删除 V2 MongoDB、附件、备份和 release。数据库恢复不属于普通边缘或代码回滚。

历史回滚脚本曾通过 PowerShell 5.1 解析和自包含 `21/21` 断言，但真实边缘完整撤销再恢复尚未演练，且2026-08-11管理通道不可用；完成重新盘点和新演练前，不得把旧脚本、旧备份或测试版部署写成当前回滚验收。

## 7. 微信小程序发布与版本回退

### 7.1 发布

1. 从已标记 commit 创建独立工作副本，更新并复核 `miniprogram/manifest.json` 的 `versionName`、`versionCode` 和微信 `appid`。
2. 在 HBuilderX 的生产构建环境显式设置 `VITE_API_BASE_URL` 和可选 `VITE_UPLOAD_BASE_URL`。
3. 确认微信公众平台已配置 request、uploadFile、downloadFile 合法域名和有效 HTTPS 证书。
4. 运行 `npm test` 和 `npm run check:sfc`，再由 HBuilderX 构建 `mp-weixin`。
5. 在微信开发者工具检查当前构建时间、API 域名、扫码、相机、定位、上传下载、团队隔离和全局只读。
6. 上传时填写唯一版本号和 Git commit；先发布体验版，完成验收记录后再提交审核/发布。
7. 归档该版本的源码压缩包、构建日志、上传版本号、体验二维码、测试记录和 SHA256。不要归档登录凭据。

### 7.2 回退

1. 出现阻断问题时先暂停新入口或通知用户停止受影响操作，保存错误时间、版本和请求证据。
2. 若微信公众平台“版本管理”提供上一线上版本的回退操作，由管理员选择上一已验收版本并按平台流程确认；记录操作人、时间和目标版本。
3. 若平台不提供直接回退，从上一 release tag 的独立归档重新构建。API/上传域名仍使用已批准生产值；上传时使用新的唯一上传版本标识，不修改旧归档。
4. 回退后重新验证登录、团队、消息、设备扫码、相机上传、任务和报表查询；确认线上版本号与回退记录一致。
5. 小程序回退不会自动回滚 API 或数据库。只有兼容性矩阵证明需要时，才按独立 API 回滚流程处理。

## 8. 发布后验证与证据

每次正式发布至少记录：

- 线上 API/Web URL、release ID、commit、启动时间和服务状态；
- `/health`、HTTPS、登录、团队选择、任务、设备、附件和消息冒烟结果；
- 点检/保养 worker 是否按批准配置运行；
- 当前 Web 构建的 API base URL 与小程序线上版本号；
- 上线前备份和上线后健康检查证据；
- 回滚目标、回滚命令评审人和观察窗口。

未完成上述实际操作前，只能写“发布文档已准备”，不能写“已部署”或“运行已验收”。
