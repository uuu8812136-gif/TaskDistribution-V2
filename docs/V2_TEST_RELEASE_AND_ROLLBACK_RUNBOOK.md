# V2 客户测试环境安全发布与恢复手册

本文只适用于隔离的 V2 客户测试环境：

| 项目 | 固定值 |
|---|---|
| 实例 | `task-distribution-v2-customer-test` |
| 公网入口 | `https://v2-test.horselink.cn` |
| API / Web | `127.0.0.1:18120` / `127.0.0.1:18130` |
| MongoDB | `127.0.0.1:27150/customer_acceptance_v2_test` |
| Replica set | `customer_acceptance_v2_rs` |
| 当前附件 | `/srv/taskdistribution-v2-test/taskdistribution-v2/uploads` |
| Linux 独立备份盘 | `/mnt/taskdistribution-v2-test-backup` |
| 物理机离机副本 | `D:\ServerBackups\TaskDistribution-V2-Test` |

本流程不切换旧版入口，不停止旧版 API/MongoDB，不 reload Nginx，也不覆盖活动数据库或附件。
所有脚本默认只做 dry-run；发生写入必须同时提供执行开关和精确确认值。

## 1. 发布模型

发布分为两个不能合并的阶段：

1. **候选准备阶段**：从干净 commit 构建、验签并解包到新的 release 目录；不切换
   `current`，不重启任何服务。
2. **停写发布阶段**：仅停止 V2 API/tunnel，创建新的完整备份，将备份复制到物理机
   D 盘并逐文件验签；收到 D 盘回执后才运行岗位层级和运输主数据迁移，再切换候选版本。

`migratePositionLevels.js --execute` 开始后，旧 release 不再兼容活动数据库中的岗位层级和新权限。
因此第一次迁移写入就是数据库回滚点：后续失败只能 forward-fix，或将备份恢复到全新的
`*_v2_test` 数据库后，让旧代码连接恢复库。禁止只把 `current` 切回旧代码并继续连接活动库。

## 2. 发布前门禁

开始前确认：

- 维护窗口已批准，客户知道 V2 测试版会短暂停机；旧版继续运行。
- 代码已经提交，工作区完全干净；release ID、commit 和变更单一致。
- `/mnt/taskdistribution-v2-test-backup` 是独立挂载，且不在 Linux 根盘。
- `/etc/taskdistribution-v2-test/app.env` 和 `operations.env` 已由 root 保护，不在 Git/release 中。
- 物理机 D 盘是不同于 Windows 系统盘的物理磁盘。
- SSH 使用专用密钥和 pinned `known_hosts`，不使用 `StrictHostKeyChecking=no`。
- 禁止开启 `set -x`，禁止将环境文件内容、URI、令牌或密钥写入终端记录。

旧版和隔离环境的只读基线：

```bash
systemctl is-active task-distribution.service mongod.service nginx.service
curl --fail --silent --show-error http://127.0.0.1:8099/
curl --fail --silent --show-error http://127.0.0.1/health
curl --fail --silent --show-error -H 'Cache-Control: no-cache' \
  "https://www.horselink.cn/health?release_guard=$(date -u +%s)"
systemctl is-active mongod-v2-test.service taskdistribution-v2-test-api.service \
  taskdistribution-v2-test-tunnel.service
systemctl show taskdistribution-v2-test-tunnel.service -p ExecStart --value
mongosh --quiet --host 127.0.0.1 --port 27150 --eval \
  'const h=db.hello(); printjson({ok:h.ok,primary:h.isWritablePrimary,setName:h.setName})'
```

V2 tunnel 的 `ExecStart` 必须且只能包含
`-R 127.0.0.1:38130:127.0.0.1:18130`，不得引用旧版 `38080` 或 `8099`。
正式发布脚本会重复上述只读检查，并校验本机旧版 Nginx 与公网旧域名的 health
`status/service` 一致；公网检查由旧版域名经 `38080` 返回，因此任一旧版链路异常都会在
停启 V2 服务前或激活完成前 fail closed。

任何一项失败都先结束发布，不要用本流程修复既有故障。

## 3. 从干净 commit 构建候选包

在开发机仓库根目录用 PowerShell 运行。第一次不带 `-Apply`，只输出计划：

```powershell
$ReleaseId = 'v2-20260724-001'
$Commit = (git rev-parse HEAD).Trim()

.\ops\windows\New-V2TestReleasePackage.ps1 `
  -ReleaseId $ReleaseId `
  -SourceCommit $Commit
```

确认计划中的 commit 和输出目录后执行：

```powershell
.\ops\windows\New-V2TestReleasePackage.ps1 `
  -ReleaseId $ReleaseId `
  -SourceCommit $Commit `
  -Apply `
  -ConfirmCommit $Commit `
  -Confirm:$false
```

构建器会拒绝脏工作区和非固定 Node/npm 版本，从该 commit 的 `git archive` 构建 Web，删除
环境示例和依赖目录，拒绝密钥、客户数据、上传目录及符号链接，并生成：

- `work/release/out/<release-id>.tar.gz`
- `work/release/out/<release-id>.tar.gz.sha256`
- `work/release/out/<release-id>.artifact-manifest.json`
- 包内 `deploy/RELEASE.json` 和 `deploy/FILE-MANIFEST.json`

将三个产物传到 Linux 的受限 incoming 目录后，先校验 archive SHA256。发布工具必须从同一个
已验签 archive 安装，并保留包内 `ops/linux/` 与 `ops/lib/` 的兄弟目录关系；
`v2-test-release-common.sh` 会通过 `../lib/` 加载 MongoDB 目标保护器。不能只复制 shell 脚本，
也不能从临时聊天文件、未验签目录或旧工作区运行。

## 4. 准备候选 release

先把该 release 的工具安装到新的版本化、root 只读目录。不得覆盖或复用已有目录：

```bash
set -euo pipefail
RELEASE_ID='v2-20260724-001'
COMMIT='<40位小写commit>'
ARCHIVE="/srv/taskdistribution-v2-test/incoming/${RELEASE_ID}.tar.gz"
ARCHIVE_SHA256='<artifact-manifest中的archive.sha256>'
TOOL_RELEASE_ROOT="/usr/local/libexec/taskdistribution-v2-test/releases/${RELEASE_ID}-${COMMIT}"
TOOLS="${TOOL_RELEASE_ROOT}/ops/linux"

printf '%s  %s\n' "$ARCHIVE_SHA256" "$ARCHIVE" | sha256sum --check -
test ! -e "$TOOL_RELEASE_ROOT"
sudo install -d -o root -g root -m 0755 "$(dirname -- "$TOOL_RELEASE_ROOT")"
sudo install -d -o root -g root -m 0755 "$TOOL_RELEASE_ROOT"
sudo tar -xzf "$ARCHIVE" -C "$TOOL_RELEASE_ROOT" ./ops/linux ./ops/lib
sudo chown -R root:root "$TOOL_RELEASE_ROOT"
sudo find "$TOOL_RELEASE_ROOT" -type d -exec chmod 0755 {} +
sudo find "$TOOL_RELEASE_ROOT" -type f -exec chmod 0444 {} +
sudo find "$TOOLS" -maxdepth 1 -type f -name '*.sh' -exec chmod 0555 {} +
test -r "$TOOLS/../lib/v2TestMongoTargetGuard.js"
test -r "$TOOLS/../lib/operationsConfig.js"
test -r "$TOOLS/../lib/backupCore.js"

sudo /usr/bin/env bash "$TOOLS/prepare-v2-test-candidate.sh" \
  --archive "$ARCHIVE" \
  --archive-sha256 "$ARCHIVE_SHA256" \
  --release-id "$RELEASE_ID" \
  --source-commit "$COMMIT"
```

dry-run 成功后显式执行：

```bash
sudo /usr/bin/env bash "$TOOLS/prepare-v2-test-candidate.sh" \
  --archive "$ARCHIVE" \
  --archive-sha256 "$ARCHIVE_SHA256" \
  --release-id "$RELEASE_ID" \
  --source-commit "$COMMIT" \
  --execute \
  --confirm-instance task-distribution-v2-customer-test
```

预期状态为 `CANDIDATE_READY`。此时 `current`、API、tunnel 和数据库均未改变。

## 5. 停写并创建全新备份

先 dry-run：

```bash
OPS_ENV=/etc/taskdistribution-v2-test/operations.env
sudo /usr/bin/env bash "$TOOLS/create-v2-test-release-backup.sh" \
  --release-id "$RELEASE_ID" \
  --operations-env "$OPS_ENV"
```

确认输出中的 previous release 和独立备份根目录后执行：

```bash
sudo /usr/bin/env bash "$TOOLS/create-v2-test-release-backup.sh" \
  --release-id "$RELEASE_ID" \
  --operations-env "$OPS_ENV" \
  --execute \
  --confirm-instance task-distribution-v2-customer-test \
  --confirm-database customer_acceptance_v2_test
```

脚本只停止 `taskdistribution-v2-test-api.service` 和
`taskdistribution-v2-test-tunnel.service`，随后：

- 重新确认旧版 `8099`、本机 Nginx、公网旧域名（经 `38080`）和 V2 MongoDB 健康；
- 记录迁移输入摘要和运输历史快照摘要；
- 记录已有运输主数据引用和当时的 master ID 集合；
- 新建数据库 + uploads 完整备份；
- 再次逐文件校验 manifest；
- 强制确认 `teammemberships`、`transportrecords` BSON 存在；
- 写入 `/var/log/taskdistribution-v2-test/releases/<release-id>/backup-handoff.json`；
- 成功后故意保持 V2 停止，等待 D 盘回执。

若备份阶段在 handoff 形成前失败，脚本会尝试恢复原 V2 API/tunnel；仍需人工核对状态。

## 6. 复制到物理机 D 盘并逐文件验签

从 `backup-handoff.json` 读取 `backupId` 和 `manifestSha256`。在承载 Linux VM 的物理 Windows
主机上先运行 dry-run：

```powershell
$BackupId = 'backup-YYYYMMDDTHHMMSSZ-xxxxxxxx'
$ManifestSha256 = '<64位sha256>'
$ReleaseId = 'v2-20260724-001'
$IdentityFile = 'E:\ServerVM\Keys\backup_ed25519'
$KnownHostsFile = 'E:\ServerVM\Keys\known_hosts'

.\ops\windows\Copy-V2TestBackupOffHost.ps1 `
  -BackupId $BackupId `
  -ExpectedManifestSha256 $ManifestSha256 `
  -SourceReleaseId $ReleaseId `
  -IdentityFile $IdentityFile `
  -KnownHostsFile $KnownHostsFile
```

确认来源为 `serveradmin@127.0.0.1:22022`、目标位于 D 盘后执行：

```powershell
.\ops\windows\Copy-V2TestBackupOffHost.ps1 `
  -BackupId $BackupId `
  -ExpectedManifestSha256 $ManifestSha256 `
  -SourceReleaseId $ReleaseId `
  -IdentityFile $IdentityFile `
  -KnownHostsFile $KnownHostsFile `
  -Apply `
  -ConfirmInstance task-distribution-v2-customer-test `
  -Confirm:$false
```

脚本会拒绝系统盘或与系统卷同一物理磁盘的 D 盘，校验 manifest 自身 SHA256、每个声明文件的
大小/SHA256、精确文件集合以及两个迁移 BSON。成功后生成无凭据回执并上传至 Linux：

```text
/tmp/v2-test-offhost-<backup-id>.json
```

只有状态 `OFFHOST_BACKUP_VERIFIED` 才能继续。

## 7. 迁移并激活候选版本

先验证 handoff、D 盘回执和停写后摘要，并实际运行四项迁移的只读预检，仍不写数据库：

```bash
HANDOFF="/var/log/taskdistribution-v2-test/releases/${RELEASE_ID}/backup-handoff.json"
RECEIPT="/tmp/v2-test-offhost-${BACKUP_ID}.json"

sudo /usr/bin/env bash "$TOOLS/activate-v2-test-candidate.sh" \
  --release-id "$RELEASE_ID" \
  --handoff "$HANDOFF" \
  --offhost-receipt "$RECEIPT" \
  --operations-env "$OPS_ENV"
```

成功后会以不可覆盖方式写入四份 `*-dry-run.json` 和 `migration-preview.json`。预览摘要固定绑定
`releaseId`、source commit、`RELEASE.json` SHA256、`backupId`、备份 manifest SHA256、精确
`127.0.0.1:27150/customer_acceptance_v2_test` 目标和停写后的迁移输入 SHA256。报告中必须显示：

- 岗位层级无 blocker；运输主数据无冲突；
- 设备归属待迁移 86 台、点检计划 630 条，冲突为 0；
- 2026 年 6/7 月验收数据计划写入 4 条，blocker 为 0；
- 所有报告的 `writePerformed` 都是 `false`。

迁移进程使用受限应用账号连接数据库，但报告先写入隔离 staging，再由 root 以 `0640` 封存到
root-owned release evidence 目录；handoff、preview、dry-run、execute 和幂等报告均不可由应用账号覆盖。

这一步不能携带 `--execute`，也不需要设备审计操作人。预览失败或证据文件已存在时不要删除、覆盖或
复用证据目录；排查后使用新的 release ID 重新走完整流程。确认 `migration-preview.json` 后执行：

```bash
sudo /usr/bin/env bash "$TOOLS/activate-v2-test-candidate.sh" \
  --release-id "$RELEASE_ID" \
  --handoff "$HANDOFF" \
  --offhost-receipt "$RECEIPT" \
  --operations-env "$OPS_ENV" \
  --execute \
  --confirm-instance task-distribution-v2-customer-test \
  --confirm-database customer_acceptance_v2_test \
  --confirm-backup-id "$BACKUP_ID" \
  --equipment-operator-username '<已确认的活动审计账号>'
```

脚本按固定顺序执行：

1. 要求上述独立 preview 已存在，复验四份报告和每份报告 SHA256。
2. 复验 preview 绑定的 release、commit、备份 manifest 和停写输入摘要。
3. 再次逐文件验签 Linux 备份，并再次确认停写后的迁移输入未变化。
4. 写入包含 preview SHA256 的 `migration-started.json`，从此禁止 code-only rollback。
5. 显式执行固定 2026 年 6/7 月排产/出勤修复，随后重复执行一次证明幂等。
6. 显式执行岗位层级和运输主数据迁移并验收报告。
7. 显式执行设备归属/点检计划回填，随后重复执行一次证明幂等；审计操作者必须是显式传入的活动账号。
8. 验证两项客户修复的执行报告均绑定同一个已验签 backup ID 和 manifest SHA256。
9. 确认运输历史快照字段未变化，校验岗位层级和运输引用不变量。
10. 原子切换 `current`，启动 API，等待健康和新索引。
11. 启动 tunnel，执行旧版、本地 V2、公网 V2、preview 证据和数据库不变量验证。

运输单据中的车次、路线、车牌、车型和司机文本是提交时的历史快照。主数据后续改名时，验证只要求
引用对象仍存在且团队、类型一致，不要求当前 master 名称等于历史文本；已有引用 ID 必须保持不变。

预期最终状态为 `ACTIVATED_AND_VERIFIED`。脚本不 reload Nginx。

发布后可重复执行只读验证：

```bash
SNAPSHOT=$(cat "/var/log/taskdistribution-v2-test/releases/${RELEASE_ID}/transport-snapshots.before.sha256")
REFERENCE_BASELINE="/var/log/taskdistribution-v2-test/releases/${RELEASE_ID}/transport-references.before.json"
sudo /usr/bin/env bash "$TOOLS/verify-v2-test-release.sh" \
  --release-id "$RELEASE_ID" \
  --expected-transport-snapshot "$SNAPSHOT" \
  --expected-reference-baseline "$REFERENCE_BASELINE"
```

## 8. 失败处理矩阵

| 失败位置 | 状态 | 处理 |
|---|---|---|
| candidate 准备失败 | 业务未变化 | 修复包或环境，使用新 release ID 重建 |
| 停写前检查失败 | 业务未变化 | 结束维护窗口，不继续 |
| 备份/handoff 前失败 | 旧 release、未迁移 | 核对脚本是否恢复 V2 服务，再处理故障 |
| handoff 后、迁移前失败 | V2 保持停止、数据库未迁移 | 修复 D 盘复制/回执后继续；不要新建无关备份 |
| 任一 migration dry-run 失败 | V2 停止、数据库未迁移 | 保留报告；修复 blocker 后重新走新 release 证据目录 |
| 第一次 migration execute 后失败 | V2 停止、数据库可能已变化 | 禁止切旧代码；forward-fix 或执行第 9 节恢复 |
| 切换/健康/公网验证失败 | V2 停止、candidate 可能已成为 current | 保留现场；forward-fix 或执行第 9 节恢复 |

不要删除或覆盖任何失败报告，不要复用 evidence 路径，不要自动 drop 数据库。

## 9. 恢复到全新 `*_v2_test` 数据库

此操作从已验签备份创建新的数据库和新的附件恢复目录，不触碰活动数据库/附件。首先在仓库外
准备受保护配置，可参考 `deploy/v2-test/operations.restore.env.template`：

```bash
TARGET_DB='customer_acceptance_rollback_20260724_v2_test'
RESTORE_ENV="/etc/taskdistribution-v2-test/restore-${TARGET_DB}.env"
sudo chown root:taskdistributionv2test "$RESTORE_ENV"
sudo chmod 0640 "$RESTORE_ENV"
```

配置中的 `RESTORE_DATABASE` 必须等于 `$TARGET_DB`，`RESTORE_MONGODB_URI` 必须使用
`127.0.0.1:27150/$TARGET_DB` 和 `replicaSet=customer_acceptance_v2_rs`；不得复制活动数据库名。

先 dry-run：

```bash
sudo /usr/bin/env bash "$TOOLS/restore-v2-test-backup.sh" \
  --release-id "$RELEASE_ID" \
  --handoff "$HANDOFF" \
  --restore-env "$RESTORE_ENV" \
  --target-database "$TARGET_DB"
```

确认目标数据库没有 collection 后执行：

```bash
sudo /usr/bin/env bash "$TOOLS/restore-v2-test-backup.sh" \
  --release-id "$RELEASE_ID" \
  --handoff "$HANDOFF" \
  --restore-env "$RESTORE_ENV" \
  --target-database "$TARGET_DB" \
  --execute \
  --confirm-instance task-distribution-v2-customer-test \
  --confirm-source-database customer_acceptance_v2_test \
  --confirm-target-database "$TARGET_DB" \
  --confirm-backup-id "$BACKUP_ID"
```

恢复脚本会再次逐文件验签、恢复到新库、复制附件到新的 restore 目录，并校验每个 collection
document count 和每个 FileAsset。成功输出 `RESTORE_VERIFIED` 和新的 restore handoff，且
`activeStateChanged=false`。

若恢复工具中途失败，目标库可能留下部分 collection。脚本不会自动 drop；保留证据并换一个全新
目标库重试，或在单独审批后人工处理失败库。活动库始终不能作为清理目标。

## 10. 可选：让旧代码连接已验证恢复库

仅当需要恢复客户测试服务、且 forward-fix 不适合时执行。先在
`/etc/taskdistribution-v2-test/rollback-envs/` 准备 root-owned `0600/0640` 的 replacement
app env：

- `APP_INSTANCE=task-distribution-v2-customer-test`
- `PORT=18120`
- `NODE_ENV=production`
- `MONGODB_URI` 指向 `$TARGET_DB` 和固定 replica set
- `UPLOAD_PATH` 指向 restore handoff 中的 `restoredUploadRoot`

不要在命令行填写 URI 或秘密。先 dry-run：

```bash
RESTORE_HANDOFF="/var/log/taskdistribution-v2-test/releases/${RELEASE_ID}/restore-${TARGET_DB}-handoff.json"
ROLLBACK_ENV="/etc/taskdistribution-v2-test/rollback-envs/${TARGET_DB}.env"
PREVIOUS_RELEASE_ID='<backup-handoff中的previousRelease目录名>'

sudo /usr/bin/env bash "$TOOLS/activate-v2-test-restored-rollback.sh" \
  --release-id "$RELEASE_ID" \
  --restore-handoff "$RESTORE_HANDOFF" \
  --replacement-app-env "$ROLLBACK_ENV" \
  --operations-env "$RESTORE_ENV"
```

显式执行：

```bash
sudo /usr/bin/env bash "$TOOLS/activate-v2-test-restored-rollback.sh" \
  --release-id "$RELEASE_ID" \
  --restore-handoff "$RESTORE_HANDOFF" \
  --replacement-app-env "$ROLLBACK_ENV" \
  --operations-env "$RESTORE_ENV" \
  --execute \
  --confirm-instance task-distribution-v2-customer-test \
  --confirm-target-database "$TARGET_DB" \
  --confirm-previous-release-id "$PREVIOUS_RELEASE_ID" \
  --confirm-backup-id "$BACKUP_ID"
```

脚本会保护性备份原 `app.env`，原子安装 replacement env，切换到 previous release，启动并验证
V2 API/tunnel 和旧版健康。原活动数据库和附件仍保留。失败时 V2 保持停止，不会自动重新连接
活动数据库。

## 11. 证据与完成标准

每个 release 的证据位于：

```text
/var/log/taskdistribution-v2-test/releases/<release-id>/
```

至少归档：release metadata SHA256、运行前基线、备份/复验结果、backup handoff、D 盘 receipt、
`migration-preview.json`、四项迁移 dry-run/execute 报告、两项客户修复的幂等重放报告、迁移后基线、
activation result 和最终只读验证结果。

只有满足以下全部条件才能宣布发布完成：

- `current` 精确指向候选 release；
- V2 API/tunnel/MongoDB 健康，公网 V2 健康与团队接口成功；
- 岗位层级、运输主数据引用、索引和历史快照不变量通过；
- 旧版 API `8099`、MongoDB、Nginx 和公网旧域名（经 `38080`）健康且未被重启或切换；
- Linux 独立备份和物理机 D 盘副本具有相同 manifest SHA256；
- 不存在未解释的失败报告、部分恢复库或临时 release 链接。

本文和脚本只表示流程已经准备，不表示真实环境已执行、恢复演练已完成或客户已验收。
