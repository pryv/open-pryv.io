# Storage Engines Plugin System

Storage engines are self-contained plugins that provide implementations for one or more **storage types**.

## Storage Types

| Type | Purpose |
|---|---|
| `baseStorage` | User CRUD + global stores (Accesses, Profile, Streams, Webhooks, Sessions, etc.) |
| `dataStore` | Events & Streams (via mall) |
| `platformStorage` | Platform user registry (username/email uniqueness) |
| `seriesStorage` | Time-series data (HF events) |
| `fileStorage` | Event file attachments |
| `auditStorage` | Per-user audit records |

## Directory Structure

```
storages/
  index.ts                # Barrel: the single init point (storages.init())
  pluginLoader.ts         # Discover engine plugins, check them, resolve the configured engine per type
  internals.ts            # Host capabilities registry
  manifest-schema.ts      # Manifest validator

  interfaces/             # Interface contracts per storage type
    versions.ts           # Interface version of each storage type (see interfaces/README.md)
    baseStorage/
    platformStorage/
    seriesStorage/
    fileStorage/
    auditStorage/
    migrations/           # Schema migration runner shared by the engines
    backup/               # Backup reader / writer contracts

  engines/                # One folder per engine
    postgresql/           # every storage type
    sqlite/               # baseStorage, dataStore, seriesStorage, auditStorage
    rqlite/               # platformStorage
    filesystem/           # fileStorage
    s3/                   # fileStorage
    influxdb/             # seriesStorage
```

Each engine folder holds a `manifest.json` and the entrypoint it names (`src/index.ts`).

## Engine manifest.json

Only storage / service-core integration fields. Standard package metadata (name, version) belongs in `package.json`.

```json
{
  "storageTypes": ["baseStorage", "dataStore", "seriesStorage", "auditStorage"],
  "interfaceVersions": { "baseStorage": 1, "dataStore": 1, "seriesStorage": 1, "auditStorage": 1 },
  "entrypoint": "src/index.ts",
  "requiredInternals": ["userLocalDirectory", "getEventFiles"],
  "configuration": { "fields": { "path": { "type": "string", "required": true, "description": "..." } } },
  "scripts": { "setup": "scripts/setup", "start": "scripts/start" }
}
```

- The engine name is the folder name (`engines/postgresql/` is engine `postgresql`).
- `interfaceVersions` declares, per storage type, the interface version the engine implements; a type left out
  counts as 1. The server refuses to start when a discovered engine's version differs from its own: see
  [interfaces/README.md](interfaces/README.md). Every discovered engine is checked and loaded, selected or not.
- The schema is enforced by `manifest-schema.ts`.

## Engine Entrypoint

The entrypoint exports, for each declared storage type, the functions `pluginLoader.ts` (`REQUIRED_EXPORTS`)
requires:

| Storage type | Required exports |
|---|---|
| `baseStorage` | `initStorageLayer`, `getUserAccountStorage`, `getUsersLocalIndex` |
| `dataStore` | `getDataStoreModule` |
| `platformStorage` | `createPlatformDB` |
| `seriesStorage` | `createSeriesConnection` |
| `fileStorage` | `createFileStorage` |
| `auditStorage` | `createAuditStorage` |

plus `init(config, getLogger, internals)`, called by `storages/index.ts` before any of them.

## Configuration

```yaml
storages:
  base:
    engine: postgresql     # baseStorage + dataStore
  platform:
    engine: rqlite         # platformStorage
  series:
    engine: postgresql     # seriesStorage
  file:
    engine: filesystem     # fileStorage
  audit:
    engine: sqlite         # auditStorage
  engines:
    postgresql:
      host: 127.0.0.1
      port: 5432
    sqlite:
      path: var-pryv/users
```

`config/default-config.yml` holds the full list with comments. A configured engine that does not declare the
storage type it is chosen for stops the boot.

## Internals

Engines request host capabilities via `requiredInternals` in their manifest. Registered by `storages/index.ts`:

- `databasePG`: the PostgreSQL connection, when PostgreSQL is in use
- `storageLayer`: the storage layer instance
- `userLocalDirectory`: resolves per-user local filesystem paths
- `getEventFiles`: the event attachments store
- `cache`: the cache component
- `createUserAccountStorage`: the account storage factory


# License

[BSD-3-Clause](LICENSE)
