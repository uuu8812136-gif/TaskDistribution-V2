# TaskDistribution V2

This directory is the isolated development workspace for the management system upgrade.

## Safety boundary

- Production services, database, uploads, release links, and the existing mini program remain unchanged.
- `app/` is the isolated V2 Node.js API and Vue 3 Web development source, excluding secrets and runtime data.
- `miniprogram/` is the isolated V2 uni-app development source; generated `unpackage/` output is not maintained as source.
- Test deployment must use a separate service name, port, MongoDB database, upload directory, and release root.
- No deployment script in this repository may point at the production database by default.

## Layout

- `app/`: Node.js API and Vue 3 web application.
- `miniprogram/`: uni-app / Vue 3 WeChat mini program.
- `docs/`: requirements, architecture, and development records.
- `references/`: customer-provided fixed templates and clarification files.
- `tools/`: snapshot, migration, and deployment tooling.
- `tests/`: integration and tenant-isolation tests.

## Delivery documents

- `docs/DEVELOPMENT_ENVIRONMENTS.md`: isolated development and test environments.
- `docs/OPERATIONS_RUNBOOK.md`: backup, restore, retention, and health monitoring.
- `docs/RELEASE_DEPLOYMENT_AND_ROLLBACK.md`: release checklist, environment variables, Windows/Linux deployment, rollback drills, and mini-program rollback.
- `docs/PUBLIC_TEST_DEPLOYMENT_ACCEPTANCE_20260722.md`: live public PC-Web test deployment, isolation, TLS, regression evidence, and rollback points.
- `docs/CUSTOMER_OPERATION_GUIDE.md`: customer-facing basic operation guide.
- `docs/DELIVERY_REQUIREMENTS_CHECKLIST.md`: persistent completion and runtime-verification status.
