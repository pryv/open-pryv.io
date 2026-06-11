# Storage-isolation config keys (for parallel-test fixtures)

> Canonical list of configuration keys that a parallel-test fixture must
> override per worker so concurrent mocha worker processes don't collide
> on shared storage state (PG databases, SQLite paths, ports, etc.).
> Produced as groundwork (config-layer hardening, 2026-05) for the
> future per-worker parallelism wiring.

## Background

Open Pryv.io uses **mocha parallel mode** (one worker process per CPU) when running large test matrices. Mocha workers don't share JS memory — they're separate Node processes — but they DO share filesystem and TCP-port namespaces. Without explicit isolation, two workers running tests in parallel would:

- write to the same PostgreSQL test database (`pryv-node-test`),
- write to the same per-user SQLite directories (`var-pryv/users-test/`),
- spawn HTTP servers on the same `http:port` (default `3000`),
- talk to the same rqlite cluster (`http://localhost:4001`),
- and so on.

Most existing `*-seq.test.js` files were marked sequential precisely to avoid these collisions. The 2026-05 config-layer hardening made the boiler config layer tolerant of `config.set()` after `ready()` resolves (lazy getters, REQUIRED_WHEN validation), so a test-helper running in a worker's setup hook can mutate these keys before factories first touch them.

## The canonical key list

Each row: the config key, today's default fallback (if any), what it owns, and the per-worker shape the parallelism fixture should set.

| Config key | Today's default | Owner | Per-worker shape |
|---|---|---|---|
| `storages:engines:postgresql:database` | `pryv-node-test` (`test-config.yml`) | PG test DB name | `pryv-node-test-w${id}` |
| `storages:engines:postgresql:host` | `127.0.0.1` | PG server host | unchanged (shared instance OK) |
| `storages:engines:postgresql:port` | `5432` | PG server port | unchanged (shared instance OK; per-DB-name isolation handles workers) |
| `storages:engines:postgresql:user` | `pryv` | PG role | unchanged |
| `storages:engines:postgresql:password` | `pryv` | PG password | unchanged |
| `storages:engines:sqlite:path` | `var-pryv/users` (default-config; per-user dirs nest under this root) | SQLite user-dirs root | `var-pryv/users-test-w${id}/` |
| `storages:engines:filesystem:previewsDirPath` | unset by default; required when previews are on | Previews disk store | `var-pryv/previews-test-w${id}/` |
| `storages:engines:rqlite:url` | `http://localhost:4001` (fallback in `bin/master.js:88`) | rqlite HTTP endpoint | `http://localhost:${4011 + id*10}` (worker 0 → 4011 so host rqlited at 4001 can keep serving sequential runs) |
| `storages:engines:rqlite:raftPort` | `4002` (fallback in `bin/master.js:98`) | rqlite Raft port | `${4012 + id*10}` |
| `storages:engines:rqlite:dataDir` | `var-pryv/rqlite-data` (fallback in `bin/master.js:96`) | rqlite data dir | `var-pryv/rqlite-data-w${id}/` |
| `storages:engines:rqlite:external` | `false` | tells master to spawn (false) vs. connect (true) | leave unchanged; workers spawn their own rqlited |
| `http:port` | unset by default; must be set | api-server primary HTTP port | `${3000 + id*10}` |
| `http:ip` | `127.0.0.1` | api-server bind address | unchanged |
| `http:hfsPort` | `4000` (fallback in `components/api-server/src/server.ts:64`) | HFS in-process dispatcher target port | `${4000 + id*10}` |
| `http:previewsPort` | unset by default; must be set if previews enabled | Previews worker port | `${3001 + id*10}` |
| `tcpBroker:port` | `4222` (fallback in `components/messages/src/tcp_pubsub.ts:231`) | TCP pub/sub broker (single-core cross-worker messaging) | `${4222 + id*10}` |
| `cluster:tokens:path` | unset; only meaningful for multi-core bootstrap | Multi-core join-token files | `var-pryv/tokens-test-w${id}/` (only if the test exercises bootstrap) |
| `core:id` | `'single'` (fallback in `bin/master.js:94`) | Core identity | `single-w${id}` (or skip — distinct rqlite per worker already isolates this) |
| `auth:adminAccessKey` | `'some_key_yo'` (`test-config.yml`) | Admin API key | unchanged (shared across workers in tests is fine) |
| `auth:filesReadTokenSecret` | `'some_token'` (`test-config.yml`) | File-read-token HMAC seed | unchanged (workers don't cross-validate file tokens) |

Where "unchanged" appears, the key is either truly worker-shareable (read-only secrets, shared PG instance) or test-specific to a single test scenario.

## How to apply at test boot

In the future per-worker fixture (likely `components/test-helpers/src/parallelWorkerSetup.ts`):

```ts
import { ready } from '@pryv/boiler';

// `MOCHA_WORKER_ID` is set by mocha on each child process; defaults
// to 0 in non-parallel mode.
const id = parseInt(process.env.MOCHA_WORKER_ID || '0', 10);

const config = await ready();

config.set('storages:engines:postgresql:database', `pryv-node-test-w${id}`);
config.set('storages:engines:sqlite:path', `var-pryv/users-test-w${id}/`);
config.set('storages:engines:filesystem:previewsDirPath', `var-pryv/previews-test-w${id}/`);
config.set('storages:engines:rqlite:url', `http://localhost:${4011 + id * 10}`);
config.set('storages:engines:rqlite:raftPort', 4012 + id * 10);
config.set('storages:engines:rqlite:dataDir', `var-pryv/rqlite-data-w${id}/`);
config.set('http:port', 3000 + id * 10);
config.set('http:hfsPort', 4000 + id * 10);
config.set('http:previewsPort', 3001 + id * 10);
config.set('tcpBroker:port', 4222 + id * 10);
```

Then a `just clean-test-data-parallel` recipe (same future work) drops the N PG databases, removes the N user-dir trees, and resets each rqlited.

## Why this lives in `open-pryv.io/docs/`

The list is tied to the code that consumes these keys — when those consumers change, this doc has to track. Keeping it in the same repo as the consumers gives reviewers a single place to verify the contract on every PR touching `bin/master.js`, `components/messages/src/tcp_pubsub.ts`, or any storage engine.

The doc here is the canonical contract; the work that consumes it references it from the development backlog.

## Pre-existing fallback behaviour

Two of the keys above (`storages:engines:rqlite:url`, `storages:engines:rqlite:raftPort`) have hardcoded literal fallbacks in `bin/master.js`. These fallbacks are intentional for single-core production deploys where the operator's `override-config.yml` doesn't need to spell out localhost ports. For parallel-test isolation the fallbacks are irrelevant because the per-worker fixture sets explicit values before `ready()` resolves — but if a future code change makes the fallback the only way to reach a value, parallel tests would silently collide. **Rule for any code touching these keys**: read through `config.get(...)` with no in-code literal fallback that would mask a missing config — let `REQUIRED_WHEN` (`config/plugins/config-validation.js`) catch it at boot.
