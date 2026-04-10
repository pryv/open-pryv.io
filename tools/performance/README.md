# Pryv Performance Benchmark Tool

Benchmarks for Pryv service-core — measures throughput, latency, resource usage, and storage growth across configurations.

## Setup

No dependencies to install — uses Node.js built-in `fetch` (undici) and `/proc` for monitoring.

Requires:
- Node.js >= 22
- A running service-core instance (local or remote)
- MongoDB, InfluxDB running (for full scenario coverage)

## Quick Start

From the `macroPryv/` root:

```bash
# 1. Clean databases (server stopped)
_local/scripts/perf-clean.sh --hard

# 2. Start service-core
cd service-core && just start-deps    # terminal 1
cd service-core && just start-master  # terminal 2

# 3. Seed test data
_local/scripts/perf-seed.sh --users 3 --events 50000 --profile manual

# 4. Run all scenarios (one combined result file)
_local/scripts/perf-run.sh all --concurrency 10 --duration 30

# Or full cycle in one command (prompts to start server after clean)
_local/scripts/perf-full.sh --users 3 --events 50000 --duration 30
```

## Helper Scripts

All scripts run from `macroPryv/` root.

| Script | Purpose |
|--------|---------|
| `_local/scripts/perf-clean.sh` | Clean benchmark data (soft: API delete, hard: wipe DBs) |
| `_local/scripts/perf-seed.sh` | Seed test users with realistic data |
| `_local/scripts/perf-run.sh` | Run benchmark scenarios |
| `_local/scripts/perf-full.sh` | Full cycle: clean → seed → run all |
| `_local/scripts/perf-compare.sh` | Compare two result files |

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
_local/scripts/perf-run.sh events-create --concurrency 10 --duration 30
```

### All scenarios (one combined result file)
```bash
_local/scripts/perf-run.sh all --concurrency 10 --duration 30
```

### Concurrency sweep
```bash
_local/scripts/perf-run.sh events-create --sweep 1,5,10,25,50 --duration 15
```
Runs the scenario at each concurrency level and produces a comparison table showing the saturation curve.

## Cleanup

```bash
# Soft clean — delete seeded users via API (server must be running)
_local/scripts/perf-clean.sh

# Hard clean — wipe SQLite, MongoDB, user dirs (server should be stopped)
_local/scripts/perf-clean.sh --hard

# Also remove result files
_local/scripts/perf-clean.sh --results
```

## Comparing Results

```bash
# Print comparison to console
_local/scripts/perf-compare.sh results/run-a.json results/run-b.json

# Save comparison to file
_local/scripts/perf-compare.sh results/run-a.json results/run-b.json --output comparison.md
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

### Storage
- MongoDB data directory size
- SQLite file sizes (platform, audit)
- InfluxDB data directory size
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

## Direct Usage (without helper scripts)

From `service-core/tools/performance/`:

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
_local/scripts/perf-seed.sh --target https://host:3000 --users 3 --events 50000
_local/scripts/perf-run.sh all --target https://host:3000 --concurrency 10
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
