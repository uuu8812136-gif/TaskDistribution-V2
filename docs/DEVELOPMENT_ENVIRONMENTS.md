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

Passwords and private-key contents must stay in the approved local credential store or task record and must never be committed to this repository.

### Current Windows recovery topology (2026-08-08)

The customer Linux VM/E-drive runtime is currently unavailable. The public V2 test site has been restored to an isolated Windows C-drive runtime without modifying the legacy site, legacy tunnel, or production database:

```text
https://v2-test.horselink.cn
  -> edge Nginx
  -> edge loopback 127.0.0.1:38130
  -> recovery reverse SSH tunnel
  -> customer Windows Web 127.0.0.1:18130
  -> customer Windows API 127.0.0.1:18120
  -> customer Windows MongoDB 127.0.0.1:27150/customer_acceptance_v2_test
```

The recovery root is `C:\TaskDistribution-V2\Recovery`. The persistent tasks are:

```text
TaskDistribution-V2-Recovery-MongoDB
TaskDistribution-V2-Recovery-API
TaskDistribution-V2-Recovery-Web
TaskDistribution-V2-Recovery-Tunnel
TaskDistribution-V2-Recovery-Management-Tunnel
```

The management task is independent from the `38130` business tunnel. It runs as `SYSTEM`, starts at boot, retries every minute after failure, and uses `C:\TaskDistribution-V2\Recovery\ops\run-management-tunnel.ps1`. Its private key stays under the recovery `config` directory with access limited to `SYSTEM` and `Administrators`.

Use the Windows SSH hop below for read-only diagnostics. The API, Web, and MongoDB ports must remain bound to `127.0.0.1`; public access is only through the dedicated reverse tunnel. The old VM's local `22022` TCP port accepting then closing an SSH handshake is not proof that its filesystem or database is readable.

Current recovery data boundary:

- Snapshot cutoff: `2026-08-06 11:11:51 CST`.
- Restored: 34 collections, 8,736 documents, and 426 upload files.
- Missing after the cutoff: 8 transport submissions and 16 uploaded files; recover from the failed VM/E drive or re-enter them.
- Recovery backup: `C:\ServerBackups\TaskDistribution-V2-Test\backup-20260806T031145Z-4929dc62`.
- Independent workstation ZIP: `C:\Users\uu\Documents\Codex\2026-07-24\management-system-recovered\outputs\offhost-recovery\backup-20260806T031145Z-4929dc62.zip`, 214,425,493 bytes, SHA256 `8454e317eca7b918ecc40b8b8de2d1481da58b7fffa8f2a25bd2a8fd6b1c54ed`.
- Current one-time workstation recovery point: `C:\Users\uu\Documents\Codex\2026-07-24\management-system-recovered\outputs\offhost-recovery-current\backup-20260808T105046Z-3f525c7d.zip`, 249,556,161 bytes, SHA256 `22d5b8547c446d98567c5417312658029ad30e2b36314d5dfcb133e12c3e5878`. Its signed manifest contains 34 collections, 8,793 documents, 483 upload files, and 552 declared files; all declared hashes and all 246 active FileAsset references were independently revalidated after download. This is a best-effort online `mongodump` plus stable upload copy, not an atomic or recurring backup.
- The equipment routine worker is enabled with the application-default `300000ms` interval. Its 2026-08-08 startup catch-up created four plans and four deduplicated messages; a subsequent 330-second run and the final `19:21 CST` read-only check both remained at 64 plans and 578 routine messages with zero duplicate groups.
- The 2026-08-08 V2 `502` window ended at `15:07:27 CST`; the first recovered 200 was recorded at `15:15:24 CST`. Edge Nginx could not connect to loopback upstream `127.0.0.1:38130` while the customer-host business reverse tunnel was absent. No post-recovery 502 was found in the captured edge logs; this incident was not a Web application exception.
- Customer D/E visibility is intermittent. Both reside on the same Micron NVMe (`PhysicalDrive0`) that recorded controller resets, more than 2,000 paging-I/O errors after boot, and one unexpected removal. The hourly task at `2026-08-08 19:13 CST` still could not resolve the `E:` partition, so neither drive is an acceptable off-host target.
- `TaskDistribution-V2-Daily-Offhost-Backup` is enabled hourly but still returns `1` because the legacy E-drive/Linux-VM source chain is unavailable. `TaskDistribution-V2-Health-Alert` runs every 15 minutes and correctly returned `2` at `19:15 CST`; public health is 200, while off-host backup, disk, and sync-task checks remain false. Operations health therefore remains `DEGRADED`.

### SSH topology and historical VM route

The dedicated Windows recovery hop was installed and live-verified on 2026-08-08. The Linux VM row records the 2026-07-27 path for recovery work only; it is currently unavailable and must not be treated as a live deployment path.

| Hop | Address visible from that hop | User | Purpose |
| --- | --- | --- | --- |
| Public edge host | `82.156.67.62:22` | `Administrator` | SSH jump host and public reverse-proxy host |
| Customer Windows recovery route | edge loopback `127.0.0.1:23224` | `codexops` | Preferred C-drive management tunnel to `DKY-20260713SLA:22` |
| Customer Windows legacy route | edge loopback `127.0.0.1:23222` | `codexops` | Fallback route carried by the legacy multi-forward tunnel; do not restart it during normal V2 work |
| Linux VM (currently unavailable) | historical edge loopback `127.0.0.1:23223` | `serveradmin` | Historical reverse SSH path to `linux-server:22` through Windows loopback `127.0.0.1:22022`; do not use as current-state evidence |

The Windows `23224` and `23222` routes are bound only to loopback on the edge host and require the public edge host as a jump host. Prefer `23224`: it has a separate key whose edge authorization is restricted to `permitlisten="127.0.0.1:23224"`. The legacy `23222` connection shares one SSH process with `38080`, `23223`, and `38443`, so stopping it can also interrupt the legacy site or historical VM routes. The customer-side `127.0.0.1:22022` port and the visible `Website Live Logs` window belong to the unavailable Linux VM and are not the Windows management route.

Current workstation key locations (local and untracked):

```text
C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\codexops_ed25519
C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\new-host-local-backup_ed25519
```

PowerShell/OpenSSH connection forms:

```powershell
# Customer Windows host, preferred C-drive recovery route
ssh -J Administrator@82.156.67.62:22 -i "C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\codexops_ed25519" -p 23224 codexops@127.0.0.1

# Customer Windows host, legacy fallback only
ssh -J Administrator@82.156.67.62:22 -i "C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\codexops_ed25519" -p 23222 codexops@127.0.0.1

# Linux VM recovery attempt only; currently unavailable
ssh -J Administrator@82.156.67.62:22 -i "C:\Users\uu\Documents\Codex\2026-07-14\new-chat-2\work\remote-access\new-host-local-backup_ed25519" -p 23223 serveradmin@127.0.0.1
```

The customer Windows SSH host key was the same on `23222` and `23224` during acceptance: `SHA256:lWV9+NliZCpNIP/Yzs8TR29yUa+jXD7lW1tECeleOKQ`. The dedicated tunnel identity fingerprint is `SHA256:i6iWVaz+qAwEcgdE5MDxvx5+GGD5aRvmEAFxqrXWaUQ`. Verify these fingerprints through the existing trusted route before updating a pinned `known_hosts` file.

Pin the verified host keys in a dedicated `known_hosts` file before routine automation. Do not use `StrictHostKeyChecking=no`, place a password in a command line, or copy either private key into the repository. Local helper scripts belong under the ignored `work/` directory and must read the edge password interactively or from the approved credential store.

### Historical Linux VM application path (currently unavailable)

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

### WeChat service notification secret entry

The mini-program AppSecret must never be passed as a command-line argument, pasted into chat,
stored in Git, or copied into a release receipt. After the matching release has been staged on the
customer Windows host, copy the reviewed operator script from that immutable release to the stable
recovery `ops` directory. From an elevated **Command Prompt**, first run its read-only plan:

```cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\TaskDistribution-V2\Recovery\ops\Set-V2RecoveryWechatServiceNotification.ps1"
```

If the displayed AppID, template ID, page, worker interval, and environment path are correct, apply
the configuration:

```cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\TaskDistribution-V2\Recovery\ops\Set-V2RecoveryWechatServiceNotification.ps1" -Apply -Confirm:$false
```

The script requests the AppSecret twice with hidden interactive input. It only updates the existing
`C:\TaskDistribution-V2\Recovery\config\app.env`, does not accept a secret parameter, does not create
a temporary or backup secret file, restricts that file to `SYSTEM` and `Administrators`, and reports
only non-sensitive configuration. A successful result has
`status=WECHAT_SERVICE_NOTIFICATION_CONFIGURATION_UPDATED` and `apiRestartRequired=true`.

Do not restart the API until the immutable release containing the WeChat notification code is the
approved active candidate. After the controlled API restart, verify local/public health, an
authenticated `/api/wechat-service-notifications/config` response, real-device subscription consent,
one actual service-notification delivery, and the notification card's return page. Secret entry and
HTTP health alone are not delivery acceptance.

## Guardrails

- Development and test modes reject the known live hosts `www.horselink.cn` and `82.156.67.62`.
- Development and test modes also reject the port reserved by the currently running production API.
- Production endpoints are accepted only when supplied explicitly at build time.
- Do not put production or test credentials in any `.env.example` file.
