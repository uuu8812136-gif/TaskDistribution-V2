# TaskDistribution V2

This directory is the isolated development workspace for the management system upgrade.

## Safety boundary

- Production services, database, uploads, release links, and the existing mini program remain unchanged.
- `app/` is a read-only snapshot of the currently running production source, excluding secrets and runtime data.
- `miniprogram/` is an isolated copy of the delivered uni-app source.
- Test deployment must use a separate service name, port, MongoDB database, upload directory, and release root.
- No deployment script in this repository may point at the production database by default.

## Layout

- `app/`: Node.js API and Vue 3 web application.
- `miniprogram/`: uni-app / Vue 3 WeChat mini program.
- `docs/`: requirements, architecture, and development records.
- `references/`: customer-provided fixed templates and clarification files.
- `tools/`: snapshot, migration, and deployment tooling.
- `tests/`: integration and tenant-isolation tests.

