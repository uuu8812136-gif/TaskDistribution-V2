# Release、部署与回滚手册

本文描述 TaskDistribution V2 的最终发布包检查、环境变量、Windows/Linux 部署、回滚演练和微信小程序版本回退。它是可执行操作手册，不代表任何环境已经部署或验收。

## 1. 发布边界

- 只从已提交、已标记的 Git commit 构建 release；工作区必须干净。
- API、Web、小程序源代码、运行环境文件、数据库、上传目录和备份目录相互分离。
- `.env`、凭据、`customer-data/`、`.test-data/`、上传文件、数据库 dump 和客户原始资料不得进入 release 或 Git。
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
git ls-files customer-data .test-data "*.env" "*.pem" "*.key"

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

此时只注册服务和核对账号、ACL、Node 版本及路径，不运行候选 `server.js`。包含新 TaskReview 索引声明的候选 API 在下一节备份与迁移完成前不得首次连接旧数据库，否则 Mongoose `autoIndex` 可能提前创建索引并绕过迁移门禁。迁移完成后再按 4.5 节执行前台启动预检和正式启动；不得执行初始化或导入命令。

### 4.4 Task / TaskReview 审核轮次索引迁移门禁

release 解包、安装依赖和切换 `current` 都不会自动执行数据库 migration。包含 `Task.reviewRound`、`TaskReview.stage/reviewRound` 的候选 API（包括任何 `server.js` 前台预检）首次连接一个旧数据库前，必须由运维人员在维护窗口按 `docs/OPERATIONS_RUNBOOK.md` 的显式流程运行 `npm run migrate:task-review-stages -- ...`；不得把 migration 加入 NSSM、systemd、Web 构建或 API 启动命令。

发布记录必须同时附有：

- 默认 dry-run 生成的报告；
- 紧邻执行窗口创建并经 `ops/verify-backup.js` 验证的 `backupId`、备份目录、`manifest.json` 绝对路径和 `manifestSha256`；
- 带 `--execute`、精确 `--confirm-database`、`--backup-directory` 和独立 `--report` 的执行记录；
- 迁移后新唯一索引、旧索引精确删除结果及任务审核/最终确认冒烟结果。

维护窗口内必须停止 API、worker 和其他业务写入，再执行迁移。迁移顺序固定为：回填并校验 Task/TaskReview 的 `reviewRound` 及 `stage` -> 创建新的五字段唯一索引 -> 验证数据和新索引 -> 按迁移计划精确删除旧限制性唯一索引。最后一步只处理 key 精确等于 `{ task, reviewer }`、`{ teamId, task, reviewer }` 或 `{ teamId, task, reviewer, stage }` 的旧 unique 索引。禁止手工运行宽泛的 `dropIndexes()` 或用 `syncIndexes()` 代替该流程。

这是 forward-only 迁移：一旦同一人员和阶段已产生多个 `reviewRound`，就不能直接重建旧两字段、三字段或四字段 stage 唯一索引，也不能只切回不了解 `reviewRound` 的旧代码。此后代码回滚必须停在兼容 `uq_task_review_stage_round` 和多轮历史的版本；若必须恢复迁移前状态，只能走单独批准的整库恢复/RPO 决策，不能按普通 release 回滚处理。

### 4.5 切换版本

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
