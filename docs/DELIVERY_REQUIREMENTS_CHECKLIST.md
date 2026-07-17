# Delivery Requirements Checklist

This checklist is the persistent completion source for the current customer-management project. Update it when requirements or runtime evidence change. A task must not be reported as fully complete until every in-scope item is either verified or explicitly marked as pending.

## Mandatory Completion Gate

Before reporting any task as complete, review all of the following sources again:

- [ ] The currently visible conversation and every requirement added since the previous handoff.
- [ ] The latest context-compaction/handoff summary, including explicit unfinished items and active-agent work.
- [ ] This persistent checklist and the customer source files under `customer-data/`.
- [ ] The current Git diff/status so uncommitted or partial implementations are not overlooked.
- [ ] The authoritative runtime state: automated tests, browser flows, database records, uploaded files, and active process versions as applicable.

Completion wording is evidence-based:

- `Implemented`: the code exists, but full verification may still be pending.
- `Tests passed`: the relevant automated checks passed, but the deployed/running flow may still be stale or unverified.
- `Runtime verified`: the latest code is running and the user-facing flow was exercised against authoritative state.
- `Fully complete`: every in-scope checklist item is runtime verified or explicitly accepted as out of scope; there are no hidden placeholders or known pending items.

If any source conflicts with another, use the least-complete status and keep the item open. After each meaningful task, update this file before giving the user the completion report.

## Runtime Protection

- [x] Existing customer-used website and mini-program remain untouched.
- [x] Development source, database state, uploads, and customer fixtures stay on the E drive.
- [x] Customer source files are excluded from Git.
- [x] A database and upload backup exists before the real-data import.

## Requirements Baseline

- [x] Reconcile this checklist against `管理系统本次开发需求范围确认书-v0.4.md`.
- [x] Reconcile this checklist against `管理系统V1.0开发设计文档-v0.2.md`.
- [x] Reconcile this checklist against `客户补充需求-注释3解析-v0.1.md`, the supplied spreadsheets/images, and subsequent chat requirements.
- [x] Record every customer-confirmed item as implemented, runtime verified, explicitly pending customer input, or explicitly out of scope in `DELIVERY_SCOPE_AUDIT.md`.

## Teams And Accounts

- [x] Login supports selecting Gearbox Logistics or Engine Logistics.
- [x] Usernames are globally unique.
- [x] Team data is isolated.
- [x] Super administrators can read across teams and must enter a team before editing.
- [x] Project administrators can manage fixed permissions only inside their team.
- [ ] Five-level organization, functional positions, module-specific data scopes, member enable/disable, and fixed permission assignment are runtime verified.
- [ ] Team switching, global read-only behavior, privileged writes, and membership changes produce the required audit records.
- [x] Audit-log query is implemented as read-only list/detail APIs plus a Web page; global access is super-admin only, team access additionally permits project administrators with `audit.view`, and system-account identity is redacted from nested snapshots, arrays, and text.
- [x] Browser automation verifies login, both selectable teams, global read-only mode, entering a team, and the audit-log list/detail page; automated tests cover global/team scope and deep system-account redaction.
- [x] Restart the local API after the database-readiness health patch and repeat the health/login smoke check; a live MongoDB disconnect returns HTTP 503 with `database=unavailable`, the same database recovers to HTTP 200, and the login/page smoke check has no console warnings or errors.

## Existing Task Management

- [x] Existing task creation, assignment, receipt, completion, review, extension, messages, attachments, statistics, and exports are implemented and covered by regression tests.
- [x] Task records, reviews, extension requests, messages, files, queries, statistics, and exports enforce team and organization scope in automated isolation tests.
- [ ] The latest running Web API and mini-program complete the task-management browser/device regression flow.
- [ ] Existing data is assigned to Gearbox Logistics only after the final migration confirmation and can be reconciled after migration.

## Equipment Management

- [x] Five fixed asset-sheet types and all source columns are represented.
- [x] Source row, raw values, date precision/display, quantities, and data-quality issues are retained.
- [x] WPS cell images and ordinary drawing images can be extracted and mapped to source rows.
- [x] Web list, detail, import preview, photos, and exception display are implemented.
- [x] Apply the real workbook to the local test database: 144 source rows, 141 publishable assets, and 3 idle duplicate rows retained as pending confirmation without duplicate asset creation.
- [x] Connect workbook image extraction to the normal web upload-preview-confirm-publish workflow; 228 image references survive strict validation and WPS JPEG normalization tests.
- [x] Equipment Excel preview lifecycle has per-request upload progress/timeout, explicit upload-parse-write UI states, local non-sensitive job-id recovery, cancel-on-close/new-import, transaction-first bounded physical staging cleanup with retry/audit metadata, and a 24-hour expiry cleanup CLI; focused cleanup tests and the 98,035,547-byte workbook benchmark pass.
- [x] Equipment list/detail/photo access is verified in the running browser against 143 equipment records and the private uploaded images.
- [ ] One-asset-one-code generation and QR download/print are runtime verified.
- [ ] Mini-program QR lookup is runtime verified for valid, invalid, cancelled, cross-team, and read-only cases.
- [x] Inventory batches, discrepancy handling, return-and-resubmit, and the fixed four-stage approval chain are implemented across backend, Web, and mini-program with automated tests.
- [ ] Inventory creation, scan, discrepancy evidence, return/resubmit, approvals, and export are runtime verified end to end in the latest Web API and WeChat Developer Tools build.
  - The Web inventory page and current data state are browser verified; mutation/approval/export and WeChat device flows remain pending.
- [x] Inspection rules support configurable items/order/periods, configurable shift windows and weekly/monthly defaults, per-item normal/abnormal results, required abnormal notes/camera photos, plan status, overdue reminders, one-hour escalation, fixed three-stage exception handling, query, and formula-safe export in backend, Web, and mini-program code with automated tests.
- [x] The inspection-rule editor can repeatedly add, reorder, and remove checklist rows beyond the original two-row limit while retaining at least one row; Web unit tests verify three-row editing and the backend round trip verifies persistence and reload of more than two ordered items.
- [ ] Inspection worker scheduling, message recipients, abnormal handling, Web workbench/export, and burned-in camera watermark photos are runtime verified against the latest API, browser, and WeChat Developer Tools/device build.
  - The Web inspection workbench page is browser verified; scheduled transitions, export, real camera/location, and watermarked pixels remain pending.
- [x] Repair supports fault report, parts-required, and no-parts fixed flows with the confirmed fields, evidence, approvals, query, and export in backend, Web, and mini-program automated tests.
  - Implemented and automated tests passed: fixed three-flow state machine, 1-5 private photos, dynamic parts, server-recalculated prices, manager-assistant substitution, rejection/void, audit, query/export, Web and mini-program pages.
- [ ] The three repair flows are runtime verified end to end against the latest local API and WeChat Developer Tools/device build.
  - The Web repair page is browser verified; state mutations, private evidence, approvals, and WeChat camera flows remain pending.
- [x] Maintenance supports configurable items/periods, camera-only burned-in watermark evidence plus server capture/location metadata, next-cycle calculation, idempotent overdue day-1/day-2/day-3 reminders, query, exception filtering, and formula-safe export in backend, Web, and mini-program code with automated tests.
- [ ] Maintenance next-cycle materialization, overdue recipients, watermarked image bytes, positioning denial/precision behavior, and export are runtime verified against the latest API, browser, and WeChat Developer Tools/device build.
- [x] Idle, stopped, and scrapped applications are implemented with ASSET_ADMIN-only creation, assistant/deputy review, manager final approval, private attachments, append-only history, conditional revisions, audit rollback, and final transactional asset-status mutation.
- [ ] Idle, stopped, and scrapped applications are runtime verified end to end in the latest Web API/browser and WeChat Developer Tools build.
  - The Web status-application page is browser verified; create/review/final mutation and WeChat device flows remain pending.
- [x] Equipment issue and transfer, parts inventory, warehouse, purchasing, and cost accounting remain excluded.

## Reporting Data

- [x] Production fixture parsing reconciles 2023-01 through 2026-07.
- [x] June 2026 totals 12000 and July through day 16 totals 6263; July 17-31 stays unreported/null.
- [x] Six real transport records and thirteen source photos are structured for test import.
- [x] Apply and verify production records, transport records, photo files, totals, and idempotent rerun.
- [x] Keep unconfirmed transport fields and photo associations visibly marked as test placeholders.
- [ ] Transport entry/query, monthly driver trip totals, fixed-field Excel export, attachment isolation, and audit behavior are runtime verified end to end.
  - The running Web query page displays all 7 records; create/edit, download, and audit mutation checks remain pending.
- [ ] Previous/current-month daily schedules, monthly schedule maintenance, fixed calculation rules, and production daily-text generation are runtime verified end to end.
  - Implemented and automated tests passed: independent team/date report resource; fixed customer D4:D13 text template; current and prior reviewed attendance plus seven-record snapshots; current/prior daily and monthly production snapshots; previous natural day's item-3 schedule as actual completion; source fingerprints; bounded version history; audit; Web/mini-program tracing, version selection, and copy.
  - The running Web production and generated-daily-report pages display the 44 production records; mutation/generation/copy and WeChat device click-through remain pending.
- [x] Attendance implements one active reporter per branch, pre-09:00 replacement, post-09:00 officer changes with reason/before/after audit, missing-branch blocking/reminders, permanent review lock, manager notification, and copyable final text across Web and mini-program tests.
- [x] Attendance monthly report is generated only from reviewed daily submissions, merges sick leave into leave, and exports the fixed A:R format with natural-month tests.
- [x] The seven real 2026-07-14 branch rows are present in the isolated local test database, retain source-summary inconsistencies as visible data-quality exceptions, and the importer has idempotency/manual-conflict tests.
- [ ] Attendance submission, 08:59/09:00 behavior, missing reminders, review lock, manager notification, final-text copy, and monthly export are runtime verified end to end against the latest API.
  - The running Web attendance page displays all 7 source rows; boundary-time writes, notifications, permanent review, copy, and download remain pending.

## Mini-Program

- [x] Team selection at login is implemented.
- [x] Existing equipment list/detail and reporting query foundations are present.
- [x] Add a visible scan-to-find-equipment entry.
- [x] Add scan-to-inspect and scan-to-maintain flows with permission checks.
- [ ] Verify valid, invalid, cancelled, cross-team, no-camera, denied-location, and global-read-only scan states in WeChat Developer Tools or on a real device.
- [x] Complete local mini-program automated verification: 54/54 general tests, 18/18 scan-focused tests, 43 SFC checks, and the environment-isolation check pass.
- [x] HBuilderX completes the WeChat mini-program build and the isolated review output contains the latest scan, inventory, repair, status-application, attendance, and production-report pages.

## Backup, Restore, And Operations

- [x] Backup implementation isolates the non-system backup path, serializes operations with an exclusive lock, atomically publishes completed directories, and records SHA256 for the manifest and every database/upload file.
- [x] Backup implementation reconciles BSON collection counts and non-deleted FileAsset records against upload bytes before publication.
- [x] Retention implementation keeps the newest 7 daily and 4 weekly recovery points, and never deletes incomplete, corrupt, unknown, or nested directories.
- [x] Restore CLI only accepts a completed direct-child backup, an empty loopback `_restore_test`/`_v2_test` database, and an isolated restore directory; it reconciles collection counts and FileAsset bytes after restore.
- [x] Focused backup, restore, retention, path-policy, and health-terminal tests pass (11/11 on 2026-07-17); the final API-health/operations compatibility focus passes 14/14.
- [x] Windows Task Scheduler installer, Linux systemd timer/service and logrotate examples, visible health terminal, and operations runbook are present.
- [x] Final release checklist, environment-variable inventory, Windows/Linux deployment, API/Web rollback drill, mini-program rollback, and customer basic-operation instructions are documented with executable commands.
- [x] Real local isolated drill completed on 2026-07-17: official Database Tools 100.17.0 backed up `final_e2e_v2_test`, restored into the fresh `final_e2e_v2_restore_test`, reconciled 24 collections/652 documents and all 243 FileAssets/files (117,731,236 bytes). Evidence is retained only in ignored paths: `.test-data/OPERATIONS_DRILL_REPORT.md`, `.test-data/operations-drill-reconciliation.json`, the backup manifest, and the restore report.
- [x] `.test-data` operations tools, environment files, backup sets, restored attachments, and drill reports are ignored by Git and are not delivery-source artifacts.
- [ ] On the customer-selected host, install the schedule and visible health terminal, observe at least one real scheduled backup cycle, connect the approved alert channel, and repeat the isolated restore drill in a customer maintenance window with a signed report.

## Final Verification

- [x] Backend full test suite passes after all current changes (302/302 on 2026-07-17).
- [x] Web unit tests (66/66) and production build pass (2026-07-17).
- [x] Mini-program tests (54/54), scan-focused tests (18/18), 43 SFC/static checks, environment isolation, and HBuilderX WeChat build pass (2026-07-17).
- [x] Browser automation verifies login, both teams, global read-only/team switching, equipment and photos, transport, production, attendance, inventory, inspection, repair, status applications, generated daily reports, and audit pages. At a 390px viewport, primary controls stay inside the DOM boundary and wide tables scroll inside their own containers.
- [x] Database and file reconciliation confirms 143 equipment, 44 production, 7 transport, 7 attendance, 243 FileAssets, and 243 upload files totaling 117,731,236 bytes.
- [x] Local API and Web development servers run the latest code. Web `3101` proxies to API `18110`; the API was restarted after the database-readiness patch and passed live disconnect-503, recovery-200, login, and page smoke checks.
- [x] Current source is committed and pushed to the private GitHub repository; implementation commit `6d8d1ee` contains no customer source files, local data, uploads, backups, environment files, or generated build output.
- [ ] Execute and archive the release/rollback drill on the selected staging host; the documentation itself is not deployment evidence.
