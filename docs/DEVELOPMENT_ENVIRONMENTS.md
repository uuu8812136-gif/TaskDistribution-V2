# Development and test environments

The Web frontend and mini program must not silently connect to the currently running customer system. Real URLs belong in local untracked environment files or deployment secrets, not in source control.

## Web frontend

For local development, copy `app/frontend/.env.example` to `app/frontend/.env.local`. The default request path remains `/api`; Vite proxies it to the isolated local port `http://127.0.0.1:18099`.

To use the isolated test API, set:

```dotenv
VITE_API_BASE_URL=https://test-api.example.com/api
```

Every `vite build` requires `VITE_API_BASE_URL` explicitly. A same-origin reverse proxy is supported by setting it explicitly to `/api`.

## Isolated local API

The equipment inspection and maintenance module fails closed when MongoDB transactions are not
available. Development, test, and production API instances must connect to a replica set (a
single-node replica set is sufficient); a standalone `mongod` can still serve reads but routine
writes return `503 EQUIPMENT_ROUTINE_TRANSACTIONS_REQUIRED` before any business write.

For a locally installed MongoDB, start it with a replica-set name, initialize it once, and keep the
same `replicaSet` query parameter in `MONGODB_URI`:

```powershell
mongod --dbpath E:\mongodb-data --port 27017 --replSet task_distribution_v2_rs --bind_ip 127.0.0.1
mongosh --port 27017 --eval "rs.initiate({_id:'task_distribution_v2_rs',members:[{_id:0,host:'127.0.0.1:27017'}]})"
$env:MONGODB_URI='mongodb://127.0.0.1:27017/task_distribution_v2_dev?replicaSet=task_distribution_v2_rs'
```

The local E2E launcher starts a loopback-only API, a persistent in-memory MongoDB replica set, isolated uploads, two demo teams and three account classes. It refuses the live API port, MongoDB's default port, non-loopback hosts, non-`_v2_test` databases and runtime paths outside `.test-data`.

Use the repository-pinned Node.js version, then from `app` enter a strong password that is used only for demo accounts and start the isolated runtime:

```powershell
node --version # must print v22.23.1
$env:V2_DEMO_PASSWORD = Read-Host 'V2 demo password'
npm run start:v2-e2e
```

The default API is `http://127.0.0.1:18099`. Startup prints only demo usernames and IDs; it never prints the password. Rerunning the seed is idempotent and does not reset existing demo passwords.

To seed an already running isolated `_v2_dev` or `_v2_test` database instead:

```powershell
$env:MONGODB_URI='mongodb://127.0.0.1:27028/local_e2e_v2_test?replicaSet=v2_local_e2e_rs'
$env:V2_DEMO_PASSWORD = Read-Host 'V2 demo password'
npm run seed:v2-demo
```

## Mini program

For local development, copy `miniprogram/.env.example` to `miniprogram/.env.local`. Without an API variable, non-production builds use `http://127.0.0.1:18099/api` only.

Test and production builds should set both values in their build environment (the upload URL is optional and otherwise derived from the API URL):

```dotenv
VITE_API_BASE_URL=https://test-api.example.com/api
VITE_UPLOAD_BASE_URL=https://test-api.example.com
```

A production mini-program build without `VITE_API_BASE_URL` fails during startup instead of falling back to the live customer system. The API and upload origins must also be added to the WeChat Mini Program request/upload/download domain allowlists before device testing.

## Remote V2 test access

The following topology was live-verified on 2026-07-27 (Asia/Shanghai). Passwords and private-key contents must stay in the approved local credential store or task record and must never be committed to this repository.

### SSH topology

| Hop | Address visible from that hop | User | Purpose |
| --- | --- | --- | --- |
| Public edge host | `82.156.67.62:22` | `Administrator` | SSH jump host and public reverse-proxy host |
| Customer Windows host | edge loopback `127.0.0.1:23222` | `codexops` | Reverse SSH tunnel to `DKY-20260713SLA:22` |
| Linux VM | edge loopback `127.0.0.1:23223` | `serveradmin` | Reverse SSH path to `linux-server:22` through Windows loopback `127.0.0.1:22022` |

Ports `23222` and `23223` are bound only to loopback on the edge host. They are not reachable directly from a developer workstation; connect through the public edge host as a jump host.

Current workstation key locations (local and untracked):

```text
C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\codexops_ed25519
C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\new-host-local-backup_ed25519
```

PowerShell/OpenSSH connection forms:

```powershell
# Customer Windows host
ssh -J Administrator@82.156.67.62:22 -i "C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\codexops_ed25519" -p 23222 codexops@127.0.0.1

# Linux VM
ssh -J Administrator@82.156.67.62:22 -i "C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\new-host-local-backup_ed25519" -p 23223 serveradmin@127.0.0.1
```

Pin the verified host keys in a dedicated `known_hosts` file before routine automation. Do not use `StrictHostKeyChecking=no`, place a password in a command line, or copy either private key into the repository. Local helper scripts belong under the ignored `work/` directory and must read the edge password interactively or from the approved credential store.

### V2 application path

```text
https://v2-test.horselink.cn
  -> edge Nginx
  -> edge loopback 127.0.0.1:38130
  -> reverse SSH tunnel
  -> Linux Web 127.0.0.1:18130
  -> Linux API 127.0.0.1:18120
  -> MongoDB 127.0.0.1:27150/customer_acceptance_v2_test
```

The legacy customer system uses the separate edge tunnel `127.0.0.1:38080`. V2 deployment or diagnostics must not stop, rebind, overwrite, or reuse `38080`, the legacy release tree, or the production database. Verify both V2 and legacy health after every V2 deployment.

## Guardrails

- Development and test modes reject the known live hosts `www.horselink.cn` and `82.156.67.62`.
- Development and test modes also reject the port reserved by the currently running production API.
- Production endpoints are accepted only when supplied explicitly at build time.
- Do not put production or test credentials in any `.env.example` file.
