# Hidden Read-only Demo Account

The hidden demo identity is provisioned by `app/script/provisionReadOnlyDemoAccount.js`.

- Set `READONLY_DEMO_USERNAME` and `READONLY_DEMO_PASSWORD` through the deployment secret store; do not put credentials in release notes, source, or chat.
- The identity is `isSystemAccount=true` and `isSuperAdmin=false`, so account/member APIs filter it from management lists and redact its identity in nested responses.
- One active `MEMBER` membership is reconciled for every active team. The membership uses `DEPARTMENT_MANAGER_ASSISTANT` only to obtain team data scope, but its permission list contains view permissions only.
- It receives no create, edit, import, delete, submit, approve, review, upload, or maintenance permission. It cannot enter global read-only mode and cannot write in a team.
- The provisioning command refuses databases that do not end in `_v2_dev` or `_v2_test`. A formal production run requires an explicit `READONLY_DEMO_PRODUCTION_CONFIRMATION=I_UNDERSTAND_READONLY_DEMO_PRODUCTION` approval gate.
- Re-running with the same username is idempotent only when the existing hidden account and password match; a conflicting non-system or super-admin account fails closed.

Example environment (use a secret manager, not a checked-in `.env`):

```text
MONGODB_URI=<target MongoDB URI>
READONLY_DEMO_USERNAME=<hidden username>
READONLY_DEMO_PASSWORD=<secret password>
```

Run from `app` with `npm run provision:readonly-demo`. The command output contains only a user ID, team count, and permission keys; it never prints the password.
