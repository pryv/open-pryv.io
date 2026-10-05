# Pryv Performance Benchmark Tool

Benchmarks for `open-pryv.io` — measures throughput, latency, resource usage, and storage growth across configurations.

## Setup

No dependencies to install — uses Node.js built-in `fetch` (undici) and `/proc` for monitoring.

Requires:
- Node.js >= 22
- A running `open-pryv.io` instance (local or remote)
- The default storage engine (PostgreSQL + rqlite + filesystem) running locally; the optional `influxd` is only needed for `series-*` scenarios when `storages.series.engine: influxdb` is configured in `override-config.yml`.

## Quick Start

Run the benchmark commands from `tools/performance/`; the `just` commands run from the repository root.

```bash
# 1. Clean databases (server stopped; wipes the local test and dev data)
just clean-test-data

# 2. Start open-pryv.io
just start-deps    # terminal 1
just start-master  # terminal 2

# 3. Seed test data
node datasets/seed.js --target http://127.0.0.1:3000 --users 3 --events 50000 --profile manual

# 4. Run all scenarios (one combined result file)
node bin/run-benchmark.js --all --concurrency 10 --duration 30
```

To compare two configurations (for example PostgreSQL and SQLite), run the cycle once per
configuration, changing `storages` in `config/override-config.yml` and restarting between runs,
then compare the two result files (see [Comparing Results](#comparing-results)).

## Scenarios

| Scenario | What it tests | Sub-scenarios |
|----------|--------------|---------------|
| `events-create` | Event creation throughput | master token, restricted token (10 streams) |
| `events-get` | Event retrieval with filters | no-filter, stream-parent, time-range × 2 auth modes |
| `streams-create` | Stream creation | flat (top-level), nested (with parentId) |
| `streams-update` | Stream rename | single sub-scenario |
| `series-write` | HF series data ingestion | batch sizes: 10, 100, 1000 points |
| `series-read` | HF series data query | ranges: 1K, 10K, 100K points |
| `mixed-workload` | Realistic mix | 60% reads, 30% event creates, 5% stream creates, 5% updates |

## Seed Profiles

Two profiles based on real Pryv accounts:

**manual** (default) — modeled after `perki.pryv.me`
- ~68 streams, mostly flat with a few nested trees (4 levels deep)
- Event types: position/wgs84, note/txt, frequency/bpm, energy/cal, mass/kg, etc.
- Spread distribution across many streams

**iot** — modeled after `demo.datasafe.dev/miratest`
- ~47 streams, structured hierarchy with path-like IDs
- Event types: concentration/iu-l, concentration/mg-l, composite types
- 95% of events concentrated in 5 leaf streams (device bridge data)

Both profiles create 2 series events per user with 100K data points each (for HFS benchmarks).

## Run Modes

### Single scenario
```bash
node bin/run-benchmark.js --scenario events-create --concurrency 10 --duration 30
```

### All scenarios (one combined result file)
```bash
node bin/run-benchmark.js --all --concurrency 10 --duration 30
```

### Concurrency sweep
```bash
node bin/run-benchmark.js --scenario events-create --sweep 1,5,10,25,50 --duration 15
```
Runs the scenario at each concurrency level and produces a comparison table showing the saturation curve.

## Cleanup

```bash
# Soft clean: delete the seeded users via the API (server running)
node datasets/seed.js --clean

# Hard clean: wipe the local databases and user dirs (server stopped)
just clean-test-data   # from the repository root; then: rm -f datasets/seed-result.json

# Also remove result files
rm -f results/*.json results/*.md
```

## Comparing Results

```bash
# Print comparison to console
node bin/compare.js results/run-a.json results/run-b.json

# Save comparison to file
node bin/compare.js results/run-a.json results/run-b.json --output comparison.md
```

Shows: config differences, throughput delta (absolute + %), latency comparison, storage growth comparison.

## What Gets Measured

### Performance
- Requests per second (throughput)
- Latency percentiles: p50, p95, p99, max
- Error count and rate

### Resources (Linux only)
- RSS memory (peak + average) across master + all worker processes
- CPU usage (peak + average)

### Storage (Linux only, local instance)
- PostgreSQL data directory size (`var-pryv/postgresql-data`, the bundled engine)
- rqlite data directory size (`var-pryv/rqlite-data`)
- Per-user SQLite file sizes (base storage, audit, series under `var-pryv/users`)
- InfluxDB data directory size (`var-pryv/influxdb-data`)
- User directories total size
- Syslog file size and line count (audit overhead)

Storage is tracked with two baselines:
- **From clean DB** — total growth since empty database (seed + benchmark)
- **This run** — benchmark-only growth (excludes seed cost)

### Server Config (captured automatically)
- Storage engines (base, platform, series, file, audit)
- Audit on/off
- Integrity settings (attachments, events, accesses)
- Number of API workers
- Git commit and version

## Result Files

Results are in `results/` as paired JSON + markdown files:
- `{timestamp}-{scenario}-{label}.json` — machine-readable, full data
- `{timestamp}-{scenario}-{label}.md` — human-readable summary with tables

Result files can be committed to git for historical comparison.

## Direct Usage

From `tools/performance/`:

```bash
# Seed
node datasets/seed.js --target http://127.0.0.1:3000 --users 3 --events 50000 --profile manual

# Clean seeded users via API
node datasets/seed.js --clean

# Run benchmark
node bin/run-benchmark.js --scenario events-create --concurrency 10 --duration 30

# Run all
node bin/run-benchmark.js --all --concurrency 10 --duration 30

# Concurrency sweep
node bin/run-benchmark.js --scenario events-get --sweep 1,5,10,25,50 --duration 15

# Compare
node bin/compare.js results/run-a.json results/run-b.json
```

## Remote Targets

All commands accept `--target` to benchmark a remote server:

```bash
node datasets/seed.js --target https://host:3000 --users 3 --events 50000
node bin/run-benchmark.js --all --target https://host:3000 --concurrency 10
```

Note: resource monitoring and storage tracking only work for local instances.

## Deferred

The following features are not yet implemented:

- **Matrix runner** — automated config switching (restart server with different engine/audit/integrity combinations and run all scenarios for each). Currently done manually by changing config and re-running.
- **SSH remote resource monitoring** — track RSS/CPU of a remote server during benchmarks via SSH. Currently resource monitoring is local-only.
- **Multi-core topology testing** — benchmark against multi-core deployments (multiple core instances with rqlite). Needs a multi-core deployment setup.
- **41kHz device simulation** — series scenarios seed 100K points; real devices can output at 41kHz producing millions of points per series. Future work: add a `--series-points` flag for larger datasets.


# License

[BSD-3-Clause](LICENSE)
