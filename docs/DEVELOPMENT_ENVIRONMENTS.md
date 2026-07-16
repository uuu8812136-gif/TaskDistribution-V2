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

## Guardrails

- Development and test modes reject the known live hosts `www.horselink.cn` and `82.156.67.62`.
- Development and test modes also reject the port reserved by the currently running production API.
- Production endpoints are accepted only when supplied explicitly at build time.
- Do not put production or test credentials in any `.env.example` file.
