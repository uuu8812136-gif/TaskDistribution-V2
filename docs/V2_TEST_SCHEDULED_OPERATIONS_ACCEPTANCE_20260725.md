# V2 测试环境定时备份、告警与隔离恢复验收报告（2026-07-25）

## 1. 结论

客户选定测试宿主机 `DKY-20260713SLA` 及其 Linux 虚拟机 `linux-server` 已完成以下运行验收：

- Linux 每日备份 timer、独立备份卷和 5 分钟健康检查已安装并启用；
- 一次真实 systemd acceptance timer 周期已生成完整数据库和附件备份；
- Windows SYSTEM 任务已把该恢复点复制到物理机 D 盘并逐文件验签；
- Windows 15 分钟健康检查已验证公网健康、离机备份时效、D 盘空间和同步任务结果；
- 连续两次失败与恢复演练分别写入 Windows Application Event Log `5201` 和 `5202`；
- 最新已验签备份已恢复到全新隔离数据库和附件目录，34 个集合及 284 个有效附件全部对账通过；
- 演练前后活动 release、API、tunnel 和公网健康均未变化。

本报告不等于正式生产切换或完整活动回滚签字。外部通知通道、客户签字和活动环境完整回滚仍见第 7 节。

## 2. 运行环境

| 项目 | 验收值 |
|---|---|
| Windows 宿主机 | `DKY-20260713SLA` |
| Linux 虚拟机 | `linux-server` |
| V2 当前 release | `v2-20260725-2eb8284` |
| V2 公网入口 | `https://v2-test.horselink.cn` |
| 活动数据库 | `customer_acceptance_v2_test`，`127.0.0.1:27150` |
| Linux 备份卷 | `/mnt/taskdistribution-v2-test-backup`，2 GiB 独立 tmpfs，由 systemd 恢复挂载 |
| Windows 离机目录 | `D:\ServerBackups\TaskDistribution-V2-Test` |

## 3. 定时备份与离机复制

已安装并启用：

- `taskdistribution-v2-test-backup-volume.service`
- `taskdistribution-v2-test-backup.service`
- `taskdistribution-v2-test-backup.timer`：每日 `02:00 Asia/Shanghai`，持久补跑并带 5 分钟随机延迟；
- `taskdistribution-v2-test-health.service`
- `taskdistribution-v2-test-health.timer`：每 5 分钟；
- `TaskDistribution-V2-Daily-Offhost-Backup`：Windows SYSTEM 每小时发现并同步最新 handoff；
- `TaskDistribution-V2-Health-Alert`：Windows SYSTEM 每 15 分钟。

真实 acceptance timer 生成的最新恢复点：

| 字段 | 值 |
|---|---|
| `backupId` | `backup-20260725T075620Z-a0614728` |
| 完成时间 | `2026-07-25T07:56:24.328Z` |
| manifest SHA256 | `65775c85ed409dde1372bf312742c4f26abffd149ff248fce1281d58240c403a` |
| manifest 文件数 | 368 |
| 声明字节数 | 136,801,378 |
| Windows 同步结果 | `OFFHOST_SYNC_VERIFIED`，`DownloadPerformed=true` |
| Windows 任务结果 | `LastTaskResult=0` |

同步后的 D 盘有效恢复点为：

- `backup-20260725T075620Z-a0614728`
- `backup-20260725T070913Z-9b295cd8`
- `backup-20260724T091447Z-19e9061e`

保留实现按最新 7 个 daily 恢复点与最新 4 个 weekly 恢复点取并集；未知、损坏或未验签目录不自动删除。

### 3.1 保留策略偏差记录

首次 Windows 同步实现错误地按自然日合并 daily 恢复点，删除了 3 个同日旧发布副本。D 盘没有可用 VSS 快照，无法恢复这 3 个旧副本。活动数据和服务未受影响，当时仍保留最新完整恢复点和前一日恢复点。

实现随后改为严格保留“最新 7 个完整 daily 恢复点 + 4 个 weekly 恢复点”，专项 Pester 用例验证最新 7 个和 4 个更老 weekly 的并集；修正版部署后两次同步均未再误删，后续 acceptance timer 又生成并验签了新的第三个恢复点。

## 4. 健康检查和告警

最终真实健康报告：

- 状态：`HEALTHY`
- 公网：HTTP 200，`instance=task-distribution-v2-customer-test`
- 最新离机备份：`backup-20260725T075620Z-a0614728`
- D 盘剩余：约 84.2 GiB，高于 10 GiB 阈值；
- 同步任务：`LastTaskResult=0`；
- 连续失败计数：0。

隔离告警演练结果：

| 次序 | 结果 |
|---|---|
| 第一次模拟失败 | 退出码 2，只累计失败次数 |
| 第二次模拟失败 | 退出码 2，`consecutiveFailures=2`，写入 Event Log `5201` |
| 恢复真实健康 URL | 退出码 0，状态回到 `HEALTHY`，写入 Event Log `5202` |

当前已接通的告警通道是 Windows Application Event Log。脚本支持从受保护文件读取 webhook，但客户尚未提供或批准实际 webhook，因此没有虚构外部消息已送达。

### 4.1 控制端重启后的远程复验

2026-07-25 18:09 CST，在本地控制端重启并重新连接客户宿主机后，重新执行了不依赖原终端会话的运行检查：

- 公网 `https://v2-test.horselink.cn/health` 返回 HTTP 200，`instance=task-distribution-v2-customer-test`；
- Linux MongoDB、API 和 tunnel 均为 active，API/tunnel `NRestarts=0/0`；
- API journal 高优先级日志和启动错误信号均为 0；
- 2 GiB 备份卷、每日备份 timer 和 5 分钟健康 timer 均为 enabled；
- 下一次固定备份为 `2026-07-26 02:00:33 CST`；
- Linux 最新 manifest SHA256 与 Windows D 盘副本一致；
- Windows 两个 SYSTEM 任务 `LastTaskResult=0`，离机同步最后运行于 17:13:13，健康任务最后运行于 18:00:00；
- D 盘剩余约 84.2 GiB。

这证明调度和健康检查不依赖本地控制端会话持续在线，但不替代下一次固定 02:00 周期的观察证据。

## 5. 隔离恢复演练

第一次执行由安全门禁拦截，错误为 `RESTORE_SOURCE_OVERWRITE_FORBIDDEN`。根因是恢复工具错误地拒绝了文档规定的“URI 数据库与 `RESTORE_DATABASE` 相同”配置。该次未创建或写入恢复库，活动状态未改变，失败证据保留。

修复后的工具要求：

1. 目标数据库必须以 `_restore_test` 或 `_v2_test` 结尾；
2. URI 必须是 loopback；
3. URI 数据库必须与 `RESTORE_DATABASE` 完全相同；
4. URI/目标数据库均不得指向源数据库；
5. 目标数据库必须为空。

成功演练使用：

| 字段 | 值 |
|---|---|
| 源备份 | `backup-20260725T070913Z-9b295cd8` |
| 源 manifest SHA256 | `3b64382ab57af68426f093daf3701f5b940803b4a2a91b8c80bd64117d0e62b1` |
| `restoreId` | `restore-20260725T070913Z-9b295cd8-52ee4204` |
| 隔离目标数据库 | `customer_acceptance_restore_20260725_1555_r2_v2_test` |
| 隔离附件目录 | `/srv/taskdistribution-v2-test/restore-drills/restore-20260725T070913Z-9b295cd8-52ee4204` |
| 集合对账 | 34/34 |
| 有效 FileAsset 对账 | 284/284 |
| `users` | 22 |
| `tasks` | 0 |
| `equipmentassets` | 141 |
| `transportrecords` | 24 |
| `fileassets` | 297（其中有效引用 284） |
| 活动状态改变 | `false` |

恢复后：

- `current` 仍指向 `v2-20260725-2eb8284`；
- `taskdistribution-v2-test-api.service=active`；
- `taskdistribution-v2-test-tunnel.service=active`；
- 公网健康仍返回 `{"status":"ok","instance":"task-distribution-v2-customer-test"}`。

## 6. 证据位置

运行证据位于客户服务器受保护目录，不进入 Git：

- `/var/log/taskdistribution-v2-test/restore-drills/customer_acceptance_restore_20260725_1555_r2_v2_test/`
- `/srv/taskdistribution-v2-test/restore-drills/restore-20260725T070913Z-9b295cd8-52ee4204/restore-report.json`
- `D:\ServerBackups\TaskDistribution-V2-Test\logs\scheduled-sync-latest.json`
- `C:\ProgramData\LinuxBackup\v2-operations-health-state.json`
- Windows Application Event Log，来源 `TaskDistribution-V2 Operations`，事件 `5201/5202`。

## 7. 尚需客户或维护窗口完成

- 提供并批准企业微信、微信、邮件或其他 webhook，才能把本地 Event Log 告警升级为外部送达告警；
- 在批准的维护窗口执行“恢复数据库和附件 -> 切换旧 release -> 验证 -> 切回当前 release”的完整活动回滚；
- 客户确认演练证据后签字；
- 隔离恢复库和附件在签字前保留，签字后再按独立审批命令清理。

## 8. 签字

| 确认方 | 姓名/签字 | 日期 | 备注 |
|---|---|---|---|
| 客户项目负责人 | 待签 |  |  |
| 客户运维负责人 | 待签 |  |  |
| 实施方 | 待签 |  |  |
