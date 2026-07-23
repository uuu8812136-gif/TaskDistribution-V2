# V2 customer-test 502 incident, 2026-07-23

## Scope and impact

- Affected: `https://v2-test.horselink.cn/health` and dynamic `/api/*` routes.
- Customer symptom: the login page loaded, but the project-team selector reported a network failure.
- Unaffected: the legacy production website, `38080` tunnel, production API, and production MongoDB.
- Data impact: none. The isolated V2 database files remained intact; the failure happened before MongoDB accepted connections.

## Timeline (Asia/Shanghai)

- 2026-07-22 16:36: a tunnel identity helper changed the shared configuration directory to `0750 root:taskdistributionv2test`.
- 2026-07-23 06:59: `mongod-v2-test.service` restarted and could no longer traverse the shared directory.
- 2026-07-23 15:44: the customer reported that project teams could not load.
- 2026-07-23 15:55: MongoDB, API, and the reverse tunnel were restored in dependency order.

## Root cause

`mongod-v2-test.service` runs as `mongodb-v2`, while its configuration is stored at:

```text
/etc/taskdistribution-v2-test/mongod-v2-test.conf
```

The shared parent directory had become:

```text
0750 root:taskdistributionv2test /etc/taskdistribution-v2-test
```

The MongoDB configuration file itself was readable, but `mongodb-v2` could not traverse the parent directory. MongoDB aborted with:

```text
boost::filesystem::status: Permission denied [system:13]
```

The API depends on the isolated MongoDB unit, so port `18120` disappeared. Nginx on `18130` and the public edge remained available and returned `502 Bad Gateway` for dynamic requests. Cached/static Web assets still returned `200`, which explains the partially rendered login page.

## Recovery

The repair installed the standard `acl` package and granted only directory traversal:

```text
user:mongodb-v2:--x
```

Verification proved that `mongodb-v2` can read `mongod-v2-test.conf` but still cannot read `app.env`. The services were then restored in this order:

1. `mongod-v2-test.service`
2. `taskdistribution-v2-test-api.service`
3. `taskdistribution-v2-test-tunnel.service`

The reusable, fail-closed recovery command is:

```bash
sudo bash ops/linux/repair-v2-test-config-acl.sh
```

It captures before/after service, listener, journal, ACL, MongoDB replica-set, V2 health, login-team, and legacy-health evidence under `/var/log/taskdistribution-v2-test/incident-config-acl-*`.

## Runtime verification

- Public V2 `/health`: HTTP `200`, instance `task-distribution-v2-customer-test`.
- Public V2 `/api/auth/login-teams`: HTTP `200`, both `ENGINE_LOGISTICS` and `GEARBOX_LOGISTICS` returned.
- V2 listeners: `18120`, `18130`, and `27150` present.
- V2 MongoDB: replica set `customer_acceptance_v2_rs`, writable primary.
- Customer-visible super administrator: global read-only login, both team transitions, return to global, and authentication audit actions verified; verification session logged out.
- Legacy `https://www.horselink.cn/health`: HTTP `200` after recovery.

Authoritative server evidence:

```text
/var/log/taskdistribution-v2-test/incident-config-acl-20260723T075516Z
```

## Prevention and remaining risk

- The tunnel identity helper now preserves an existing shared configuration directory instead of replacing its owner/group/mode.
- Individual secrets remain protected by `0640` or `0600` file modes; the MongoDB ACL grants traverse only.
- The customer-test services remain dependent on the local server and its outbound reverse tunnel. A local-server outage still makes the public V2 test unavailable.
- Alert delivery for repeated service restarts or consecutive public-health failures is still pending; systemd restart alone did not surface this permission failure quickly enough.
