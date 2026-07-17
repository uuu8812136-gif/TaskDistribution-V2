# Project Completion Rules

These rules apply to every task in this repository.

## Required Context Review

Before editing, read the task-relevant parts of:

1. The currently visible conversation and latest compaction/handoff summary.
2. `docs/DELIVERY_REQUIREMENTS_CHECKLIST.md`.
3. `docs/DELIVERY_SCOPE_AUDIT.md`.
4. The customer source notes under `docs/` and the ignored `customer-data/` directory when the task depends on source data.

Before reporting completion, repeat that review and also inspect the current Git diff/status, automated test results, active process version, database state, and user-facing runtime flow.

## Completion Language

- `Implemented`: code exists; verification may remain.
- `Tests passed`: relevant automated checks pass; the running process may still be stale.
- `Runtime verified`: the latest code is running and the real user flow was exercised.
- `Fully complete`: every in-scope requirement is runtime verified or explicitly accepted as out of scope, with no known pending item or hidden placeholder.

If evidence conflicts, use the least-complete status. Never use `Fully complete` while either delivery document contains an unresolved in-scope item.

## Safety And Delivery

- Do not modify the customer-used legacy website, mini-program, production database, or production release while developing this V2 project.
- Keep development state, uploads, backups, and customer fixtures on the E drive.
- Keep `customer-data/`, `.test-data/`, local environment files, credentials, and generated mini-program output out of Git.
- Back up authoritative local state before applying fixture imports or migrations.
- Update the delivery checklist and scope audit after each meaningful implementation or verification milestone.
- Run focused tests during development, then backend, Web, mini-program, build, browser, database, and file reconciliation checks before final delivery.
- Push source changes to the private GitHub repository only after confirming ignored customer files are not staged.
