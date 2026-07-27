# V2 Transport Load-Type Release Acceptance - 2026-07-27

## Release

- Public URL: `https://v2-test.horselink.cn`
- Release: `v2-20260727-3ca2496`
- Source commit: `3ca2496484c5178c2b07091423a0e714232325c4`
- Previous release: `v2-20260727-dbfe29d`
- Archive SHA256: `c5e8c663796fc282efd5cee4dfad448e32e003a66904b1c254040fc6e1e6d37f`

## Verification

- Backend suite: `463/463` passed with Node `v22.23.1` and npm `10.9.8`.
- Web suite: `178/178` passed; production build completed.
- Mini-program source suite: `112/112` passed; 43 SFC checks and isolation passed.
- Protected dry-run: 2 active teams, 28 load types to create, 0 transport records to update, 0 conflicts.
- Execute: 28 load types and 2 system audits created in one guarded migration.
- Idempotent execute: 0 writes.
- Historical transport invariants: 46 records, 230 preserved bindings, 0 mismatches.
- Live rollback-only CRUD acceptance: create, rename/sort, disable, enable, and delete passed; the transaction was aborted and left 0 persistent test writes.
- Runtime: API, tunnel, backup timer, and health timer active; API/tunnel `NRestarts=0/0`.
- Public V2 and legacy site returned HTTP 200 after activation.

## Backup And Rollback Point

- Backup ID: `backup-20260727T145850Z-a69064ee`
- Manifest SHA256: `8dab3b445cd871e56299ed39e7fef102a2b60cdd9aaec08f924d9e818753184b`
- The backup was copied to the physical Windows host D drive, verified file by file, and acknowledged back to the Linux release workflow.
- The previous release directory remains available. Because the migration wrote database rows, rollback must use the verified database and upload backup rather than code-only switching.

## Remaining Mini-Program Step

The mini-program source reads the same configurable load types, but this release did not open HBuilderX or WeChat Developer Tools because another mini-program project was running locally. Recompile and upload the formal-AppID experience version only after that project is idle.
