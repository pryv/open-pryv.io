# Pryv.io Databases

## v2 storage picture

Open Pryv.io v2 runs on two complementary engines for user-data storage:

- **PostgreSQL** — the default. Shared `user_id`-keyed tables. Cheap
  cross-user queries, single `pg_dump` artefact for backup. Deleted-user
  rows linger in historical backups (Art.17 erasure is application-level).
- **SQLite** — the alternative. Per-user files at
  `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. Deletion
  is `unlink(<userId>)`, per-user backups are trivial, clean GDPR
  Art.17 right-to-be-forgotten semantics. Best fit for low-volume /
  single-tenant deployments.

Both engines cover `baseStorage`, `dataStore`, and `auditStorage`.
PostgreSQL additionally covers `seriesStorage` (HF time-series).
InfluxDB remains an optional `seriesStorage` choice.

The **platform DB** is always [`rqlite`](https://rqlite.io/) (distributed
SQLite, embedded — `bin/master.js` spawns and supervises `rqlited`).
Multi-core clusters all share one logical platform DB via Raft.

Engine choice is per `storageType` in `config/default-config.yml`:

```yaml
storages:
  base:     { engine: postgresql }   # or sqlite
  data:     { engine: postgresql }   # or sqlite
  series:   { engine: postgresql }   # or influxdb
  audit:    { engine: sqlite }
  platform: { engine: rqlite }        # only supported value in v2
  file:     { engine: filesystem }
```

## List of storage used in Pryv.io

### User local directory

base code: [components/storage/src/userLocalDirectory.ts](components/storage/src/userLocalDirectory.ts)

Localization of user data on the host filesystem, usually under
`var-pryv/users/`. A directory path is constructed using the 3 last
characters of the userId and the userId itself.

Example with userId `c123456789abc`: `var-pryv/users/c/b/a/c123456789abc/`

In this directory, attachments and per-user SQLite databases (including
the SQLite engine's `baseStorage-<version>.sqlite` when SQLite is the
selected engine) are stored.

### User local index

base code: [components/storage/src/usersLocalIndex.ts](components/storage/src/usersLocalIndex.ts)

Per-server index mapping userId ↔ userName. Backed by a single SQLite
file at `var-pryv/user-index.db`. Could be extended in the future to
allow user aliases.

### User account storage

base code: [components/storage/src/userAccountStorage.ts](components/storage/src/userAccountStorage.ts)

Per-user password + password history. SQLite file `account-1.0.0.sqlite`
inside the per-user local directory.

### Platform-wide shared storage

base code: [components/platform](components/platform)

Holds indexed and unique fields for users (emails, custom system-stream
data) plus the user→core mapping in multi-core deployments.

Since v2 the platform DB is **always** rqlite (distributed SQLite).
`bin/master.js` spawns and supervises an embedded `rqlited` in
single-core mode (one node) and in multi-core mode (each core runs its
own node, joined into one Raft cluster via DNS discovery on
`lsc.{dns.domain}`).

- Data lives in `var-pryv/rqlite-data/` (Raft log + SQLite snapshot)
- HTTP API: `http://localhost:4001` (default)
- PostgreSQL still ships a `PlatformDB` implementation for conformance
  tests, but rqlite is the only engine selectable at runtime via
  `storages.platform.engine`

### Events, Streams & Attachments storage

base code:  [storages/engines/postgresql/src/dataStore](storages/engines/postgresql/src/dataStore) and [storages/engines/sqlite/src/dataStore](storages/engines/sqlite/src/dataStore)

Main storage for `events`, `streams` & `attachments`. Implementations
follow the modular API of the
[datastore](https://github.com/pryv/pryv-datastore) abstraction.

- **PostgreSQL** — shared `pryv-node` database, tables keyed by
  `user_id`.
- **SQLite** — per-user file
  `<userLocalDirectory>/<userId>/baseStorage-<version>.sqlite`. One
  table per collection inside the file; minimal schema (id / headId
  / deleted as columns + JSON `data` column for the rest).
- Attachments stay on the local filesystem via the `filesystem`
  fileStorage engine, regardless of dataStore choice.

### Profile, Accesses & Webhooks storage

base code:  [storages/engines/postgresql/src/user](storages/engines/postgresql/src/user) and [storages/engines/sqlite/src/userBaseStorage](storages/engines/sqlite/src/userBaseStorage)

Per-user `profile`, `accesses`, `webhooks`, `streams` (legacy), plus
shared `sessions` and `passwordResetRequests` collections. Both engines
implement the full surface; the PG version uses shared tables with
`user_id` columns, SQLite uses per-user files (alongside the dataStore
SQLite file).

### High-frequency series storage

base code: [storages/engines/postgresql/src/dataStore](storages/engines/postgresql/src/dataStore) (series) and [storages/engines/influxdb](storages/engines/influxdb)

Engine choices for `seriesStorage`:

- **PostgreSQL** (default) — same backend as baseStorage; HF points
  stored in a separate table family.
- **InfluxDB** 1.x — kept as alternative for high-throughput HF
  workloads.

A SQLite implementation of `seriesStorage` is **not yet available** —
deployments choosing SQLite for baseStorage/dataStore must still pick
PostgreSQL or InfluxDB for HF series.

### Audit storage

base code: [storages/engines/sqlite/src/userSQLite](storages/engines/sqlite/src/userSQLite) and [storages/engines/postgresql/src/AuditStoragePG.ts](storages/engines/postgresql/src/AuditStoragePG.ts)

Per-user audit trail. SQLite is the default (per-user file via the
`userSQLite/Storage` abstraction). PostgreSQL is supported as an
alternative for deployments standardising on a single relational
backend.
