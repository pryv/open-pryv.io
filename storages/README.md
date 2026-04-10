# Storage Engines Plugin System

Storage engines are self-contained plugins that provide implementations for one or more **storage types**.

## Storage Types

| Type | Purpose |
|---|---|
| `baseStorage` | User CRUD + global stores (Accesses, Profile, Streams, Webhooks, Sessions, etc.) |
| `platformStorage` | Platform user registry (username/email uniqueness) |
| `dataStore` | Events & Streams (via mall) |
| `seriesStorage` | Time-series data (HF events) |
| `fileStorage` | Event file attachments |

## Directory Structure

```
storages/
  pluginLoader.js         # Discover & load engine plugins
  internals.js            # Host capabilities registry
  manifest-schema.js      # Manifest validator

  interfaces/             # Interface contracts per storage type
    baseStorage/
    platformStorage/
    seriesStorage/
    fileStorage/

  engines/                # One folder per engine
    mongodb/
      manifest.json
      src/index.js
    postgresql/
      manifest.json
      src/index.js
    sqlite/
      manifest.json
      src/index.js
    filesystem/
      manifest.json
      src/index.js
```

## Engine manifest.json

Only storage–service-core integration fields. Standard package metadata (name, version) belongs in `package.json`.

```json
{
  "storageTypes": ["baseStorage", "dataStore", "platformStorage", "seriesStorage"],
  "entrypoint": "src/index.js",
  "requiredInternals": ["userLocalDirectory"],
  "scripts": { "setup": "scripts/setup", "start": "scripts/start" }
}
```

The engine name is derived from the folder name (e.g. `engines/mongodb/` → engine name `mongodb`).
```

## Engine Entrypoint

Each engine exports factory functions for the storage types it supports:

```js
module.exports = {
  createBaseStorage: async (config, internals) => { ... },
  createDataStore: async (config, internals) => { ... },
  createPlatformStorage: async (config, internals) => { ... },
  createSeriesStorage: async (config, internals) => { ... }
};
```

## Configuration

```yaml
storages:
  baseStorage:
    engine: mongodb
  dataStore:
    engine: mongodb
  platformStorage:
    engine: sqlite
  seriesStorage:
    engine: mongodb
  fileStorage:
    engine: filesystem
  mongodb:
    host: localhost
    port: 27017
  postgresql:
    host: localhost
    port: 5432
```

Legacy config keys (`storageEngine`, `database:engine`, etc.) are supported via backward-compat mapping in `pluginLoader.js`.

## Internals

Plugins can request host capabilities via `requiredInternals` in their manifest:

- `userLocalDirectory` — resolves per-user local filesystem paths
- `accountStreams` — account streams config cache (was SystemStreamsSerializer)
- `storeKeyValueData` — key-value store for plugin metadata


# License

[BSD-3-Clause](LICENSE)
