# Delivery Requirements Checklist

This checklist is the persistent completion source for the current customer-management project. Update it when requirements or runtime evidence change. A task must not be reported as fully complete until every in-scope item is either verified or explicitly marked as pending.

## Mandatory Completion Gate

Before reporting any task as complete, review all of the following sources again:

- [x] The currently visible conversation and every requirement added since the previous handoff.
- [x] The latest context-compaction/handoff summary, including explicit unfinished items and active-agent work.
- [x] This persistent checklist and the customer source files under `customer-data/`.
- [x] The current Git diff/status so uncommitted or partial implementations are not overlooked.
- [x] The authoritative runtime state: automated tests, browser flows, database records, uploaded files, and active process versions as applicable.

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
- [x] The public V2 customer-test site uses a dedicated domain, vhost, `38130` tunnel, `18120/18130` services, `27150` MongoDB and isolated data paths; the legacy site, `38080` tunnel and production MongoDB passed the post-deployment read-only regression.

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
- [x] The fixed `TRANSPORT_ADMIN` functional role expands only `report.transport` to team scope; with only `report.view` it can read all transport records in the active team but cannot submit reports, manage members, cross teams, or widen task/equipment/attendance/production scope. Model, management API, transport-isolation, and Web option tests pass.
- [ ] Assign `TRANSPORT_ADMIN` to the intended customer members and runtime-verify the team-wide transport view after the V2 test release.
- [ ] Five-level organization, functional positions, module-specific data scopes, member enable/disable, and fixed permission assignment are runtime verified.
- [ ] Team switching, global read-only behavior, privileged writes, and membership changes produce the required audit records.
- [x] Audit-log query is implemented as read-only list/detail APIs plus a Web page; global access is super-admin only, team access additionally permits project administrators with `audit.view`, and system-account identity is redacted from nested snapshots, arrays, and text.
- [x] Browser automation verifies login, both selectable teams, global read-only mode, entering a team, and the audit-log list/detail page; automated tests cover global/team scope and deep system-account redaction.
- [x] The 2026-07-22 focused browser rerun verifies developer-account login, both team choices, entering/leaving global read-only mode, returning to Gearbox Logistics, 141 equipment rows, an equipment detail with eight simultaneous calendar/runtime/combined rules, the dynamic checklist row control, six transport rows, seven attendance rows, task required-field validation, and a clean warning/error console. Overdue-first mutation remains automated-test evidence rather than a browser mutation test.
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
- [x] Equipment import and persisted data-quality issues use Chinese labels, field names, handling guidance, and safe fallbacks for every current exception type; historic English `message`/`suggestedAction` values and invalid-media diagnostics are not rendered to users.
- [x] Apply the real workbook to the local test database: 144 source rows, 141 publishable assets, and 3 idle duplicate rows retained as pending confirmation without duplicate asset creation.
- [x] Connect workbook image extraction to the normal web upload-preview-confirm-publish workflow; 228 image references survive strict validation and WPS JPEG normalization tests.
- [x] Equipment Excel preview lifecycle has per-request upload progress/timeout, explicit upload-parse-write UI states, local non-sensitive job-id recovery, cancel-on-close/new-import, transaction-first bounded physical staging cleanup with retry/audit metadata, and a 24-hour expiry cleanup CLI; focused cleanup tests and the 98,035,547-byte workbook benchmark pass.
- [x] Equipment list/detail/photo access is verified in the running browser against 141 customer equipment records and the private uploaded images.
- [ ] One-asset-one-code generation and QR download/print are runtime verified.
- [ ] Mini-program QR lookup is runtime verified for valid, invalid, cancelled, cross-team, and read-only cases.
- [x] Inventory batches, discrepancy handling, return-and-resubmit, and the fixed four-stage approval chain are implemented across backend, Web, and mini-program with automated tests.
- [ ] Inventory creation, scan, discrepancy evidence, return/resubmit, approvals, and export are runtime verified end to end in the latest Web API and WeChat Developer Tools build.
  - The Web inventory page and current data state are browser verified; mutation/approval/export and WeChat device flows remain pending.
- [x] Inspection rules support configurable items/order/periods, configurable shift windows and weekly/monthly defaults, per-item normal/abnormal results, required abnormal notes/camera photos, plan status, overdue reminders, one-hour escalation, fixed three-stage exception handling, query, and formula-safe export in backend, Web, and mini-program code with automated tests.
- [x] The inspection-rule editor can repeatedly add, reorder, and remove checklist rows beyond the original two-row limit while retaining at least one row; Web unit tests verify three-row editing and the backend round trip verifies persistence and reload of more than two ordered items.
- [x] One device can retain independent active daily, weekly, monthly, runtime-hour, and combined rules at the same time; `COMBINED` `ANY` materializes the first due dimension and `ALL` waits for both, with idempotent generation keys, deterministic overdue-first execution, versioned re-materialization after rule edits, and cancellation of stale open plans on update/disable.
- [ ] Inspection worker scheduling, message recipients, abnormal handling, Web workbench/export, and burned-in camera watermark photos are runtime verified against the latest API, browser, and WeChat Developer Tools/device build.
  - The Web inspection workbench page is browser verified. Code and replica-set tests now send every inspection/maintenance overdue level only to the current equipment branch's manager/deputy, with supervisor fallback only when that branch has no active primary leader; ordinary employees and department-wide escalation roles receive none. Public-data cleanup and real-role runtime acceptance remain pending.
- [x] Repair supports fault report, parts-required, and no-parts fixed flows with the confirmed fields, evidence, approvals, query, and export in backend, Web, and mini-program automated tests.
  - Implemented and automated tests passed: fixed three-flow state machine, 1-5 private photos from camera or album, dynamic parts, server-recalculated prices, manager-assistant substitution, rejection/void, audit, query/export, maintained team-scoped report locations, readable actor name/Chinese position, copyable completion summary, and compact Web/mini-program actions.
- [ ] The three repair flows are runtime verified end to end against the latest local API and WeChat Developer Tools/device build.
  - The repaired authorization path uses the same node eligibility for notification, todo listing, detail access, and transition. Assistant/deputy/manager todo reads no longer inherit an unrelated ordinary equipment org-unit filter. Public deployment plus Jing Longji/Ma Yanhao role acceptance, private evidence, approvals, and WeChat camera/album flows remain pending.
- [x] A dry-run-by-default equipment-message repair tool deletes only routine reminders whose recipient is outside the equipment branch's current leadership, preserves valid branch-manager reminders, localizes historic repair status text, requires exact database confirmation plus a verified complete backup for execution, writes one system audit per change, and is transactionally idempotent in a replica-set test.
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
  - Web and mini-program now require team-scoped master-data selections for trip, route, plate, vehicle type, and driver. Load-detail types are also team-scoped master data: authorized administrators can add, sort, disable, enable, and delete them, while each transport record keeps its submitted name/quantity snapshot. The guarded transport-master backfill initializes the original 14 types once per active team and will not recreate customer-deleted types. Public Web release `v2-20260727-3ca2496` initialized 28 types across two active teams, changed zero transport records, preserved all historical reference invariants, and passed rollback-only live CRUD acceptance. Mini-program recompilation and formal-AppID experience upload remain pending.
- [x] A fixed, dry-run-by-default repair script covers the audited July transport aliases and tagged placeholders. Its replica-set transaction test proves 17 record corrections, 6 tagged placeholder deletions, 13 attachment soft deletions, 36 system audit rows, exact postconditions, backup freshness checks, and idempotent replay.
- [ ] Previous/current-month daily schedules, monthly schedule maintenance, fixed calculation rules, and production daily-text generation are runtime verified end to end.
  - Implemented and automated tests passed: independent team/date report resource; fixed customer D4:D13 text template; current and prior reviewed attendance plus seven-record snapshots; current/prior daily and monthly production snapshots; previous natural day's item-3 schedule as actual completion; source fingerprints; bounded version history; audit; Web/mini-program tracing, version selection, and copy.
  - The running Web production and generated-daily-report pages display all 43 customer production-month records; mutation/generation/copy and WeChat device click-through remain pending.
- [x] Attendance implements one active reporter per branch, pre-09:00 replacement, post-09:00 officer changes with reason/before/after audit, missing-branch blocking/reminders, permanent review lock, manager notification, and copyable final text across Web and mini-program tests.
- [x] Attendance monthly report is generated only from reviewed daily submissions, merges sick leave into leave, and exports the fixed A:R format with natural-month tests.
- [x] The 2026-07-24 attendance correction adds day/night temporary-worker count and names, includes temporary workers and not-yet-employed counts in the displayed effective actual attendance, preserves reported inputs for editing, and carries each branch's other-situation remark into department summaries, final text, and monthly export. Legacy records without the new field remain readable.
- [x] The 2026-07-27 planned-attendance correction is runtime verified on public release `v2-20260727-1a3a84a`: `planned = registered - rest + not-yet-employed + temporary workers` corrected the locked daily review from `123-1+2+2` to `126`, while 2026-07-26 remained `45`, all 7 raw submissions and the summary snapshot remained byte-for-byte unchanged, and the idempotent replay returned `NO_CHANGES`. The guarded run wrote exactly one review correction and one `CORRECT / ATTENDANCE_REVIEW` audit row (`6a66c72a703f9fd05b17a7ac`). Backup `backup-20260727T024151Z-626afa93` was verified on physical-host `D:` with manifest SHA256 `bd23fa86ba9cd06608a4beb93da5898f7549f40d149e3c537d31582ab9233ec1`; public health returned HTTP 200 and API/tunnel remained active with `NRestarts=0/0`.
- [ ] Release the guarded July 2026 acceptance-data repair, then verify that the fixed reviewed daily summary and final text show the two temporary workers, branch remarks, and corrected production source values on the public V2 test instance.
- [x] The seven real 2026-07-14 branch rows are present in the isolated local test database, retain source-summary inconsistencies as visible data-quality exceptions, and the importer has idempotency/manual-conflict tests.
- [x] Attendance data-quality messages preserve trusted Chinese source explanations, map all current issue codes to Chinese, and replace unknown English messages with a Chinese confirmation prompt.
- [ ] Attendance submission, 08:59/09:00 behavior, missing reminders, review lock, manager notification, final-text copy, and monthly export are runtime verified end to end against the latest API.
  - The running Web attendance page displays all 7 source rows; boundary-time writes, notifications, permanent review, copy, and download remain pending.

## Mini-Program

- [x] Team selection at login is implemented.
- [x] Existing equipment list/detail and reporting query foundations are present.
- [x] Add a visible scan-to-find-equipment entry.
- [x] Add scan-to-inspect and scan-to-maintain flows with permission checks.
- [ ] Verify valid, invalid, cancelled, cross-team, no-camera, denied-location, and global-read-only scan states in WeChat Developer Tools or on a real device.
- [x] Complete local mini-program automated verification: 81/81 general tests, 21/21 equipment/scan core tests (29/29 across equipment-related suites), 43 SFC checks, and the environment-isolation check pass.
- [x] HBuilderX 5.15 recompiles the final source successfully on 2026-07-22; the generated WeChat output contains the latest request-race protection, multi-period equipment rules, scan, inventory, repair, status-application, attendance, and production-report code.
- [x] The 2026-07-23 final mini-program rerun passes 96/96 tests, 43 SFC checks, environment isolation, and `git diff --check`; the current HBuilderX output includes the one-shot request/loading settlement fix.
- [x] The WeChat Developer Tools structured MCP verifies the logged-in workbench, scan entry, 20 equipment rows, equipment detail with 8 routine plans, inspection execution form, runtime-hour history/input, four reporting modules, 8 transport rows, and the fixed 9-row transport form. The sanitized network summary contains 21 HTTP 200 responses and no 4xx/5xx response.
- [x] Test AppID `wxf95c5cdacceb6ab8` generated a preview QR code and accepted upload version `0.9.20260723.2` (1,247,592 bytes) on 2026-07-23. Generated QR/upload artifacts remain under ignored `.test-data`.
- [x] Formal AppID `wxd8f18985dfd63b89` accepted the 2026-07-25 transport-selector development upload as version `0.9.20260725.1` (1,497,428 bytes), and a formal-AppID experience QR code was generated under ignored `.test-data`.
- [x] The formal-AppID real-device run completed a transport submission with all five master-data selections and two camera photos on 2026-07-25. The saved record retained all five master ids and both private photo references.
- [x] Formal AppID `wxd8f18985dfd63b89` accepted the album-enabled development upload as version `0.9.20260725.2` (1,497,457 bytes), and a fresh experience QR code was generated under ignored `.test-data`.
- [ ] On a real device, verify that version `0.9.20260725.2` can select album photos, mix camera and album photos, retain the 2-10 photo limit, and submit successfully. Scanning the experience QR alone does not complete this workflow acceptance.
- [ ] After real-device acceptance, submit version `0.9.20260725.2` for WeChat review and publish it. A development upload is not yet visible to all customer users.

## Backup, Restore, And Operations

- [x] Backup implementation isolates the non-system backup path, serializes operations with an exclusive lock, atomically publishes completed directories, and records SHA256 for the manifest and every database/upload file.
- [x] Backup implementation reconciles BSON collection counts and non-deleted FileAsset records against upload bytes before publication.
- [x] Retention implementation keeps the newest 7 daily and 4 weekly recovery points, and never deletes incomplete, corrupt, unknown, or nested directories.
- [x] Restore CLI only accepts a completed direct-child backup, an empty loopback `_restore_test`/`_v2_test` database, an exact URI/target-database match, and an isolated restore directory; it reconciles collection counts and FileAsset bytes after restore.
- [x] Focused backup, restore, retention, path-policy, and health-terminal tests pass (11/11 on 2026-07-25 after restore-target guard hardening); the final API-health/operations compatibility focus passes 14/14.
- [x] Windows Task Scheduler installer, Linux systemd timer/service and logrotate examples, visible health terminal, and operations runbook are present.
- [x] Final release checklist, environment-variable inventory, Windows/Linux deployment, API/Web rollback drill, mini-program rollback, and customer basic-operation instructions are documented with executable commands.
- [x] The historical 2026-07-17 isolated restore drill remains valid historical evidence for the backup/restore tooling; its 243-file snapshot is not the current customer-test baseline.
- [x] The final clean customer-test baseline was backed up and independently verified on 2026-07-21 as `backup-20260721T141605Z-03560577` with manifest SHA256 `8f6bb074da2015763b92927cac407eb9f58ae990961c72d041974b10e6ef3044`: 33 collections, 241 FileAsset references, and 241 physical upload files totaling 117,731,100 bytes.
- [x] `.test-data` operations tools, environment files, backup sets, restored attachments, and drill reports are ignored by Git and are not delivery-source artifacts.
- [x] The isolated V2 test certificate renewal task runs daily as SYSTEM, returns `LastTaskResult=0` when the certificate is not yet due, and does not reload Nginx when the certificate hash is unchanged.
- [x] The 2026-07-23 public V2 `502` incident was traced to lost `mongodb-v2` traversal on the shared configuration directory, repaired with a traverse-only ACL, and documented with a fail-closed recovery script. MongoDB/API/tunnel, both login teams, customer-super-admin transitions, and legacy health were runtime verified after recovery.
- [x] On the customer-selected V2 test host, install the Linux schedule and health timer plus Windows SYSTEM off-host/health tasks, observe a real acceptance-timer backup cycle, verify the local two-failure/recovery alert path, and repeat the isolated restore drill without changing active state. Evidence is archived in `V2_TEST_SCHEDULED_OPERATIONS_ACCEPTANCE_20260725.md`.
- [ ] Connect the customer-approved external alert destination, install/accept the optional visible foreground terminal if still required, obtain customer signatures, and execute the complete active release/database/upload rollback in an approved maintenance window. Windows Application Event Log is active now, but it is not proof of external message delivery.

## Final Verification

- [x] The 2026-07-27 Web-only release `v2-20260727-fcddddc` was atomically activated from commit `fcddddcc1580c4e17bbd3b5d19f489ccb754762f`, with rollback preserved at `v2-20260727-1a3a84a`. The candidate and previous backend source trees matched at SHA256 `d1f91a4f88ef9d8343f2d806eaafdbb9989a6991121871971a941cecc68e5693`; no database migration or service restart occurred. Public V2 serves `index-Bcme9OPP.js`, the public routine-rule chunk matches the deployed SHA256, V2 and legacy health return HTTP 200, API/tunnel `NRestarts=0/0`, and the post-activation warning journal is empty.
- [x] The 2026-07-23 user-facing Chinese-message pass succeeds: backend `360/360`, Web `138/138` plus production build, mini-program `88/88`, 43 SFC checks and environment isolation; 278 relevant source/test files pass strict UTF-8 decoding with no replacement character, and Web/mini-program request-error maps remain byte-identical.
- [x] The 2026-07-25 transport-selector, monthly-summary, and scheduled-operations regression succeeds against the current worktree: backend `450/450`, Web `174/174`, mini-program `110/110`, release-operations guards `49/49`, focused restore/health tests `11/11`, Windows packaging `Pester 2/2`, retention-policy `Pester 1/1`, `git diff --check`, shell syntax checks, 43 mini-program SFC checks, environment isolation, HBuilderX WeChat compilation, and a standalone Vite production build all pass.
- [x] The 2026-07-27 planned-attendance implementation passes the complete backend suite `454/454`, release-operations guards `51/51` including the exact-backup-directory off-host ACL gate, Windows packaging `Pester 2/2`, focused attendance/reporting/correction regression `21/21`, Git Bash syntax checks for the protected activation path, and `git diff --check`; its public activation and immutable runtime evidence are recorded above.
- [x] The stopped customer-repair forward-fix path is implemented and tested: it accepts only the sealed two-mismatch `ba1eaec` evidence, reverifies the existing backup and live database, reuses the completed execute/idempotent reports, records zero migration writes, and cannot call any migration script.
- [x] Corrected resume candidate `v2-20260724-e79cefb` was built and activated with archived evidence. It chained the sealed `ba1eaec` migration and failed `fba985b` resume evidence, performed zero migration writes, verified both customer-repair sets with zero mismatches, preserved the unique `teamId + month` production-schedule index, and passed current-release, single-listener, public V2, both-team, legacy-boundary, super-admin identity, transport-index and process-stability checks.
- [ ] Repeat authenticated post-activation browser mutations for transport-role access, attendance review, generated-report creation and their new audit rows. The customer super administrator password was not reset merely to manufacture this evidence; the previously archived global/Engine/Gearbox/global switch and audit run remains valid historical evidence.
- [x] The first resume candidate `v2-20260724-fba985b` failed closed before API health because its packaged launcher attempted to bind Nginx-owned port `18130`; it performed zero migration writes, preserved both evidence directories, stopped API/tunnel, and exposed the release packaging defect. The launcher now starts only the configured `18120` API, candidate validation rejects Web launchers, and chained resume evidence is required before superseding this failed release.
- [x] The isolated public V2 Web asset check for `web-localization-976e8cd-20260723T104552Z` remains valid historical evidence: its public `index.html` and localized equipment/reporting assets matched the local production build hashes. The historical `e79cefb` release independently passed V2 health/team options and legacy health; current release `v2-20260725-2eb8284` returns public HTTP 200, and its API/tunnel `NRestarts=0/0` remained stable in the 18:09 CST remote recheck.
- [x] Backend full test suite passes after all current changes (356/356 on 2026-07-22), including the multi-period/`ANY`/`ALL` worker and rule-version regression cases.
- [x] Web unit tests (125/125) and production build pass (2026-07-22); the equipment-focused Web run is 23/23.
- [x] The 2026-07-27 repair-recipient worktree passes backend `457/457`, Web `176/176` before the final UI assertion addition plus production build, mini-program `110/110` before the final UI assertion addition, 43 SFC checks, environment isolation, and `git diff --check`; focused final UI tests add one passing Web case and one passing mini-program case. Public activation, message cleanup, HBuilderX recompilation/upload, and real-role acceptance remain pending.
- [x] The 2026-07-27 configurable transport load-type release passes backend `463/463`, Web `178/178`, mini-program `112/112`, Web production build, 43 SFC checks, mini-program isolation, focused legacy-client compatibility, rename/delete snapshot preservation, guarded default initialization, deletion persistence, and `git diff --check`. Public release `v2-20260727-3ca2496` created exactly 28 load types and 2 system audits, updated zero transport records, preserved 230 historical bindings with zero mismatches, and passed create/update/disable/enable/delete transaction acceptance with zero persistent test writes. Mini-program recompilation/upload remains pending.
- [x] The earlier `touristappid` blocker is superseded by managed test/formal-AppID runs: structured MCP verifies login/session recovery, workbench, scan UI, equipment/detail/routine/runtime-hour reads, reporting, transport list/form, preview generation, and test-number upload; formal AppID `wxd8f18985dfd63b89` accepted development versions `0.9.20260725.1` and `0.9.20260725.2` and generated experience QR codes. One real-device transport submission with five master selections and two camera photos is verified. Album selection, routine camera/location permission paths, watermark pixels, other write-state mutations, WeChat review, and customer-wide publication remain explicitly unverified.
- [x] The 2026-07-21 broad browser run verifies all 23 Web routes, 5/5 focused clicks, 30/30 ordinary-team route/viewport cases, 9 global-read-only core routes, and 15 screenshots across 1920x1080, 1366x768, and 390x844. The 2026-07-22 focused rerun adds current equipment multi-period/dynamic-row evidence and catches then verifies the mobile shell fix: at 390x844 the closed sidebar leaves no residual node or gray rail, document width equals the 390px viewport, the title is not clipped, and the menu opens/closes normally.
- [x] Database and file reconciliation confirms 141 equipment, 43 production months, 6 transport, 7 attendance, 241 FileAssets, and 241 upload files totaling 117,731,100 bytes. The clean customer-test baseline had zero audit/session rows; the current isolated runtime snapshot has 8 active routine rules, 0 open plans, 20 audit rows, and 7 auth sessions from local smoke verification, all outside production.
- [x] Local API and Web development servers run the latest code. Web `3101` proxies to API `18110`; the final API was restarted after the last source change and passed `/health`, login, seven critical routes, and clean-console checks.
- [x] The 2026-07-22 public V2 test deployment passed HTTP/DNS/TLS `10/10`, authenticated browser checks `12/12`, and the `1920x1080`/`1366x768`/`390x844` responsive route matrix `18/18`; console errors, page errors, HTTP 4xx/5xx and request failures were all zero.
- [x] After the 2026-07-23 V2-only outage, public `/health` and `/api/auth/login-teams` returned HTTP 200 again, all three isolated services had zero post-repair restarts, the visible super administrator completed global/Engine/Gearbox/global transitions with audit evidence, and legacy health remained HTTP 200.
- [x] The public run verified 141 equipment assets, 8 routine rules, 6 transport rows, 43 production rows, 7 attendance rows and an authenticated private image; the customer project-admin account could see only Gearbox Logistics and had no Engine Logistics or global-read-only entry.
- [x] After the public deployment and renewal-task trial, the legacy `/`, `/admin`, `/health`, `38080` tunnel and production MongoDB remained healthy; the MongoDB check was read-only.
- [x] Current source is committed and pushed to the private GitHub repository; the delivery commit contains no customer source files, local data, uploads, backups, environment files, generated HBuilderX output, or Web build output.
- [ ] Execute and archive the release/rollback drill on the selected staging host; the documentation itself is not deployment evidence.
