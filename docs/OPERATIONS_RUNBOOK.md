# TaskDistribution V2 备份、恢复与健康监控手册

## 1. 安全边界

- `BACKUP_ROOT` 必须位于显式配置的非系统盘 `BACKUP_VOLUME_ROOT` 内，且不能与活动 `UPLOAD_PATH` 重叠。
- 每次备份在隐藏临时目录中生成，数据库、附件、清单和 SHA256 全部验证后才通过同卷 `rename` 原子发布。
- `.operations.lock` 串行化备份、保留、校验和恢复，未知、损坏或未完成的目录永不自动删除。
- 恢复只允许 loopback MongoDB，目标库必须以 `_restore_test` 或 `_v2_test` 结尾，并且必须没有任何集合。
- 恢复附件只写入独立 `RESTORE_ROOT`；工具不会覆盖活动附件，也不会删除目标数据库或恢复目录。
- 凭据只从受保护环境文件读取，不接受 URI、密码等 CLI 参数。

## 2. 初始化

1. 将 `ops/operations.env.example` 复制到仓库外的受保护位置并填写实际路径。
2. Windows 使用专用运维账号授予环境文件只读权限：

```powershell
icacls E:\TaskDistribution-V2-Secrets\operations.env /inheritance:r
icacls E:\TaskDistribution-V2-Secrets\operations.env /grant:r "DOMAIN\ops-user:(R)"
```

3. 计算并固定 MongoDB Database Tools 二进制哈希：

```powershell
Get-FileHash 'E:\MongoDB-Tools\bin\mongodump.exe' -Algorithm SHA256
Get-FileHash 'E:\MongoDB-Tools\bin\mongorestore.exe' -Algorithm SHA256
```

4. 先检查帮助和配置路径，不启动或重启任何业务服务：

```powershell
node ops/backup.js --help
node ops/restore.js --help
node ops/verify-backup.js --help
node ops/health-terminal.js --help
```

## 3. 创建、校验与保留

创建一个数据库和附件的共同恢复点：

```powershell
node ops/backup.js --env-file E:\TaskDistribution-V2-Secrets\operations.env
```

成功输出 `BACKUP_COMPLETED`、`backupId`、目录和 `manifestSha256`。备份创建过程会：

1. 用 `mongodump` 单并发导出配置的单个业务数据库。Database Tools 的 `--oplog` 仅支持整实例 full dump，因此单库模式保持 `BACKUP_USE_OPLOG=false`；恢复演练应在维护窗口执行，或像本地演练一样用数据库 change stream 证明备份窗口没有写入。
2. 稳定复制附件，复制前后比较源文件大小、mtime 和 SHA256。
3. 解析每个 BSON 文件并记录集合文档数、字节数和 SHA256。
4. 用 BSON 中非删除 `fileassets` 逐条核对附件大小和 SHA256。
5. 生成 `manifest.json` 和 `manifest.sha256`，复核完整文件集合后原子发布。
6. 保留最新 7 个 `daily` 恢复点及最新 4 个 `weekly` 恢复点；两类集合取并集。

再次全量校验指定恢复点：

```powershell
node ops/verify-backup.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --backup-id backup-20260717T020000Z-abcdef12
```

预览和显式应用保留计划：

```powershell
node ops/retention.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --dry-run
node ops/retention.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --apply
```

先保存 `--dry-run` 输出。保留工具只会删除 `BACKUP_ROOT` 下通过清单校验的直系 `backup-*` 目录。

## 4. Task / TaskReview 审核轮次索引显式迁移

`Task.reviewRound`、`TaskReview.stage/reviewRound` 和轮次唯一索引属于数据库状态，不随 release 切换自动应用。迁移工具默认严格 dry-run；API 启动、NSSM/systemd、Web 构建和 release 脚本均不得自动调用它。

### 4.1 维护窗口与备份门禁

1. 公告维护窗口，停止 API、设备例行 worker、导入任务和所有其他写入入口；MongoDB 保持运行。确认没有旁路客户端继续写库。
2. 使用第 3 节命令创建紧邻本次迁移的备份，再用 `ops/verify-backup.js` 全量验证。记录 `backupId`、备份目录、`manifestSha256` 和该目录内 `manifest.json` 的绝对路径。
3. `--backup-directory` 必须指向上述已验证的完整备份目录；该目录内必须同时存在原始 `manifest.json` 和 `manifest.sha256`。执行模式会复核清单哈希和清单声明的全部文件；空目录、未验证目录或只复制清单而缺少声明文件的目录都不能通过门禁。
4. dry-run 报告和 execute 报告使用两个不同的绝对路径，并与变更单一起归档。不得覆盖预检证据。

### 4.2 默认 dry-run

在候选 release 的 `app` 目录执行；真实环境文件仍通过受保护的 `ENV_FILE` 提供：

```powershell
$env:ENV_FILE='E:\TaskDistribution-V2-Secrets\app.env'
Push-Location E:\TaskDistribution-V2-Releases\current\app
npm run migrate:task-review-stages -- --report E:\TaskDistribution-V2-Reports\task-review-stages-dry-run.json
Pop-Location
Remove-Item Env:ENV_FILE
```

未传 `--execute` 时只生成计划和验证报告，不回填字段、不创建或删除索引。审核报告中的实际数据库名、Task/TaskReview 待回填轮次数量、待推断 stage 数量、无效/冲突数据、新索引计划，以及 key 精确等于 `{ task, reviewer }`、`{ teamId, task, reviewer }` 或 `{ teamId, task, reviewer, stage }` 的待删除旧 unique 索引名称；有阻断项时不得进入执行阶段。

### 4.3 显式执行与验证

保持维护窗口停写，用已审核的精确数据库名和已验证备份清单执行：

```powershell
$env:ENV_FILE='E:\TaskDistribution-V2-Secrets\app.env'
Push-Location E:\TaskDistribution-V2-Releases\current\app
npm run migrate:task-review-stages -- `
  --execute `
  --confirm-database task_distribution_v2 `
  --backup-directory E:\TaskDistribution-V2-Backups\backup-YYYYMMDDTHHMMSSZ-xxxxxxxx `
  --report E:\TaskDistribution-V2-Reports\task-review-stages-execute.json
Pop-Location
Remove-Item Env:ENV_FILE
```

执行模式缺少 `--confirm-database`、已验证的 `--backup-directory` 或 `--report` 时必须失败。工具内部顺序不可调整：

1. 将缺少的 `Task.reviewRound` 和 `TaskReview.reviewRound` 回填为 `1`，根据审核/最终确认审计证据推断并回填缺少的 `TaskReview.stage`；无 stage 证据、证据冲突或轮次不是大于等于 `1` 的整数时阻断，并验证五字段候选唯一键和数据数量；
2. 创建 `{ teamId, task, reviewer, stage, reviewRound }` 新唯一索引 `uq_task_review_stage_round`；
3. 重新读取 Task、TaskReview 和索引，确认字段回填完整、新唯一索引 key/unique/name 均准确；
4. 只按报告中的精确索引名称删除 key 等于 `{ task, reviewer }`、`{ teamId, task, reviewer }` 或 `{ teamId, task, reviewer, stage }` 的三类旧限制性 unique 索引，再验证三类旧 unique key 均不存在；其他索引不删除。

禁止手工执行 `dropIndexes()`、按名称猜测删除、先删旧索引或用 `syncIndexes()` 代替迁移。执行成功后保存退出码和 execute 报告，再启动 API，至少完成一次“抄送审核拒绝 -> 第 2 轮重提 -> 审核通过 -> 管理员最终确认”闭环，并核对 Task 当前轮次和不同 `stage/reviewRound` 的 TaskReview 历史。

### 4.4 Forward-only 与旧快照恢复

当同一 `teamId/task/reviewer/stage` 已存在多个 `reviewRound`，或同一人员同时存在审核与最终确认记录后，旧两字段、三字段和四字段 stage 唯一索引都无法重建；不识别 `reviewRound` 的旧代码也不再兼容。不得通过普通 release 回滚直接恢复旧索引或旧代码；后续只能部署兼容五字段索引和多轮历史的版本。确需回到迁移前状态时，必须作为独立整库恢复变更处理，明确恢复点及将丢失的迁移后写入并重新审批。

从迁移前旧快照恢复出的测试库同样没有可信的新字段/索引状态。每次恢复后都必须针对新测试数据库重新运行 4.2 dry-run 和 4.3 显式迁移，生成新的报告；不能复用源库或上一次恢复库的 migration 报告。完成迁移后才能用当前 API 进行测试。

## 5. 恢复演练

1. 在环境文件中设置新的、空的 loopback 测试库，例如 `task_distribution_20260717_restore_test`。
2. 确认 `RESTORE_ROOT` 与备份盘、活动附件目录都不重叠。
3. 执行恢复：

```powershell
node ops/restore.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --backup-id backup-20260717T020000Z-abcdef12
```

恢复成功后检查 `<RESTORE_ROOT>\restore-*\restore-report.json`。报告必须同时包含：

- 原备份 `manifestSha256`；
- 每个集合的恢复后文档数；
- `FileAsset` 引用数、文件大小和 SHA256 对账结果；
- 开始、结束时间和耗时。

业务抽查至少覆盖 `users`、`tasks`、`equipmentassets`、提报相关集合及 5 个附件字节。清理测试库和恢复目录不是脚本职责；必须在演练报告签字确认目标名称后，由管理员用独立命令处理，避免误删。

### 5.1 2026-07-17 本地隔离真实演练历史基线

本地开发环境已使用 MongoDB Database Tools `100.17.0` 完成一次真实 `mongodump`/`mongorestore` 演练。该快照已被2026-07-21最终客户测试基线取代，但仍作为恢复工具链的历史演练证据。该结论只适用于 E 盘隔离测试环境，不代表客户宿主机已经安装或验收。

- 源库：`mongodb://127.0.0.1:27140/final_e2e_v2_test`，副本集 `v2_local_e2e_rs`。
- 恢复库：演练前为空的 `final_e2e_v2_restore_test`。
- `backupId`：`backup-20260717T120212Z-1f611af3`。
- `restoreId`：`restore-20260717T120212Z-1f611af3-b62801e9`。
- 清单 SHA256：`d54662d437676ffb69cdf6929cc36979b5f69eb20ac2d56fbd1a6bce58aab404`。
- 源库和恢复库均为 24 个集合、652 条文档；逐集合文档数差异为 0。
- 源库和恢复库均为 243 条 `FileAsset`；关键字段差异为 0。
- 活动、备份、恢复三处附件均为 243 个文件、117,731,236 字节；243/243 个文件完成大小和 SHA256 全量三方核对，差异为 0。
- 单库 dump 不使用仅支持 full dump 的 `--oplog`；演练期间用数据库 change stream 覆盖整个备份窗口，观测到 0 个写事件。
- API、Web、MongoDB 未停止或重启，活动附件目录全程只读。

本地证据位于以下 Git 忽略路径，只用于本机验收和故障复盘，不得提交工具、备份、恢复附件或报告：

- `.test-data/OPERATIONS_DRILL_REPORT.md`
- `.test-data/backup-change-watch-result.json`
- `.test-data/operations-drill-reconciliation.json`
- `.test-data/operations-backups/backup-20260717T120212Z-1f611af3/manifest.json`
- `.test-data/operations-restore/restore-20260717T120212Z-1f611af3-b62801e9/restore-report.json`

### 5.2 2026-07-21 最终客户测试干净基线

完成浏览器验收并清除仅由验收产生的登录会话和审计记录后，重新创建并独立验证最终恢复点：

- 源库：`mongodb://127.0.0.1:27140/final_clean_v2_test`，副本集 `v2_local_e2e_rs`。
- `backupId`：`backup-20260721T141605Z-03560577`。
- 清单 SHA256：`8f6bb074da2015763b92927cac407eb9f58ae990961c72d041974b10e6ef3044`。
- 33个数据库集合；`audit_logs=0`、`authsessions=0`。
- 141条设备、43个生产月份、6条运输、7条出勤。
- 241条 `FileAsset` 引用与241个物理上传文件全部通过大小和SHA256校验，总字节数117,731,100。
- 备份目录及验证结果位于Git忽略的 `.test-data/client-test-clean-backups/` 与 `operations.jsonl`，不得提交Git。

该恢复点是当前隔离客户测试的回滚基线。正式上线前仍须在客户选定宿主机创建新的上线前备份并完成恢复演练，不能直接把本地测试恢复点当作生产备份。

客户宿主机仍须单独完成：受保护环境文件配置、计划任务或 systemd 安装、至少一个真实调度周期观察、登录健康终端自启动、批准的告警通道接入，以及在客户维护窗口按本节流程复演并归档客户签字报告。在这些步骤完成前，只能称“本地隔离演练已通过”，不能称“客户宿主机备份恢复已验收”。

## 6. 健康终端

单次检查适用于监控系统，退出码 `0` 表示全部健康、`2` 表示降级：

```powershell
node ops/health-terminal.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --once --json
```

持续可见终端：

```powershell
node ops/health-terminal.js --env-file E:\TaskDistribution-V2-Secrets\operations.env --watch
```

检查项包括 API/Web HTTP、MongoDB TCP、最近成功备份时效和清单、备份卷剩余空间、主机可用内存，以及 API/Web/备份日志中的 `fatal`、`unhandled`、`uncaught`、`panic` 信号。该终端只读，不会重启进程。

告警系统应每 5 分钟执行一次 `--once --json`，连续 2 次退出码非零时通知值班人；备份失败、备份超过 26 小时、磁盘低于阈值应立即升级。通知通道和收件人必须在上线前由客户确认。

## 7. Windows 计划任务

先执行 dry run：

```powershell
powershell -NoProfile -File ops\windows\Install-ScheduledTasks.ps1 `
  -RepoRoot E:\releases\TaskDistribution-V2\current `
  -EnvFile E:\TaskDistribution-V2-Secrets\operations.env
```

审阅后显式安装：

```powershell
powershell -NoProfile -File ops\windows\Install-ScheduledTasks.ps1 `
  -RepoRoot E:\releases\TaskDistribution-V2\current `
  -EnvFile E:\TaskDistribution-V2-Secrets\operations.env `
  -Apply -Confirm
```

安装器创建每日 02:00 的 `TaskDistribution-V2-Backup` 和当前运维账号登录时显示的 `TaskDistribution-V2-Health`。验证：

```powershell
Get-ScheduledTask -TaskName 'TaskDistribution-V2-Backup','TaskDistribution-V2-Health'
Get-ScheduledTaskInfo -TaskName 'TaskDistribution-V2-Backup'
```

不要用计划任务启动、停止或重启现有 API、Web、MongoDB。

## 8. Linux systemd 示例

先按实际 release、账号和挂载点修改 `ops/linux/*.service`，并创建权限为 `0600` 的 `/etc/taskdistribution-v2/operations.env`。预览及安装：

```bash
sh ops/linux/install-systemd.sh
sudo sh ops/linux/install-systemd.sh --apply
systemctl status taskdistribution-v2-backup.timer taskdistribution-v2-health.service
journalctl -u taskdistribution-v2-backup.service -n 100 --no-pager
```

示例同时提供 `taskdistribution-v2.logrotate`。正式启用前必须运行：

```bash
systemd-analyze verify /etc/systemd/system/taskdistribution-v2-*.service /etc/systemd/system/taskdistribution-v2-backup.timer
logrotate --debug /etc/logrotate.d/taskdistribution-v2
```

## 9. 故障处置和证据

- `BACKUP_ALREADY_RUNNING`：确认现有进程；不要手工删除仍有活进程持有的锁。
- `UPLOAD_CHANGED_DURING_BACKUP`：等待上传低峰后重试，保留失败日志。
- `FILE_ASSET_BACKUP_INCONSISTENT`：先调查数据库和附件差异，不能发布该恢复点。
- `BACKUP_*_HASH_MISMATCH`：隔离该目录，禁止进入保留或恢复流程。
- `RESTORE_TARGET_NOT_EMPTY`：改用新的测试库名，工具不会清空现有库。
- `RESTORE_*_MISMATCH`：保留测试库、日志和临时证据，不得据此替换活动数据。

每次备份/恢复演练归档命令、UTC 时间、主机、`backupId`、`manifestSha256`、退出码、`operations.jsonl` 对应行、恢复报告、抽查结果和处理人。不得在工单或聊天中粘贴 MongoDB URI 凭据。
