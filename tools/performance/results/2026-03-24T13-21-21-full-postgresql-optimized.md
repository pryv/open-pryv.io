# Full Benchmark Run

**Date:** 2026-03-24T13:21:21.270Z  
**Duration:** 15s per scenario | **Concurrency:** 10  
**Target:** http://127.0.0.1:3000 | **Profile:** manual

## Server Config
- **Base storage:** postgresql | **Platform:** sqlite | **Series:** postgresql
- **Audit:** ON | **Integrity:** {"attachments":true,"events":true,"accesses":true}
- **API workers:** 2

## System
- **CPU:** Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz (8 cores) | **Memory:** 31.0GB
- **Node:** v24.14.0 | **Version:** 2.0.0-pre.2 (6aea864a)

## Summary

| Scenario | Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| events-create | events-create-master | 299.93 | 28.57 | 63.5 | 97.29 | 177.89 | 4499 | 264 |
| events-create | events-create-restricted | 414.8 | 21.43 | 48.28 | 69.76 | 120.86 | 6222 | 0 |
| events-get | no-filter-master | 217.73 | 42.24 | 83.27 | 101.04 | 127.87 | 3266 | 0 |
| events-get | no-filter-restricted | 183.2 | 51.06 | 95.56 | 136.03 | 203.47 | 2748 | 0 |
| events-get | stream-parent-master | 172 | 55.28 | 96.59 | 122.1 | 166.62 | 2580 | 0 |
| events-get | stream-parent-restricted | 143.07 | 63.44 | 130 | 189.16 | 286.18 | 2146 | 0 |
| events-get | time-range-master | 150.33 | 62.31 | 123.93 | 154.24 | 197.93 | 2255 | 0 |
| events-get | time-range-restricted | 153.93 | 61.43 | 108.25 | 156.28 | 252.87 | 2309 | 0 |
| mixed-workload | mixed-workload | 221.6 | 39.08 | 90.92 | 124.46 | 202.87 | 3324 | 58 |
| series-read | series-read-1k-points | 417.73 | 21.95 | 38.86 | 57.5 | 143.82 | 6266 | 0 |
| series-read | series-read-10k-points | 43.8 | 222.2 | 302.26 | 359 | 402.45 | 657 | 0 |
| series-read | series-read-100k-points | 4.6 | 2372.96 | 2983.35 | 4078.46 | 4078.46 | 69 | 0 |
| series-write | series-write-batch10 | 665.87 | 13.57 | 25.72 | 39.3 | 114.58 | 9988 | 0 |
| series-write | series-write-batch100 | 399.07 | 22.26 | 42.1 | 64.07 | 124.71 | 5986 | 0 |
| series-write | series-write-batch1000 | 57.93 | 133.95 | 464.82 | 596.36 | 684.97 | 869 | 0 |
| streams-create | streams-create-flat | 101.27 | 88.05 | 180.96 | 240.09 | 330.82 | 1519 | 0 |
| streams-create | streams-create-nested | 57.8 | 157.22 | 274.88 | 339.89 | 488.17 | 867 | 92 |
| streams-update | streams-update | 49.27 | 180.35 | 350.13 | 413.63 | 480.98 | 739 | 42 |

## events-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create-master | 299.93 | 28.57 | 63.5 | 97.29 | 177.89 | 4499 | 264 |
| events-create-restricted | 414.8 | 21.43 | 48.28 | 69.76 | 120.86 | 6222 | 0 |

Resources: peak RSS=81.1MB, peak CPU=7%

## events-get

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| no-filter-master | 217.73 | 42.24 | 83.27 | 101.04 | 127.87 | 3266 | 0 |
| no-filter-restricted | 183.2 | 51.06 | 95.56 | 136.03 | 203.47 | 2748 | 0 |
| stream-parent-master | 172 | 55.28 | 96.59 | 122.1 | 166.62 | 2580 | 0 |
| stream-parent-restricted | 143.07 | 63.44 | 130 | 189.16 | 286.18 | 2146 | 0 |
| time-range-master | 150.33 | 62.31 | 123.93 | 154.24 | 197.93 | 2255 | 0 |
| time-range-restricted | 153.93 | 61.43 | 108.25 | 156.28 | 252.87 | 2309 | 0 |

Resources: peak RSS=81.1MB, peak CPU=1%

## mixed-workload

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed-workload | 221.6 | 39.08 | 90.92 | 124.46 | 202.87 | 3324 | 58 |

Resources: peak RSS=81.1MB, peak CPU=4%

## series-read

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-read-1k-points | 417.73 | 21.95 | 38.86 | 57.5 | 143.82 | 6266 | 0 |
| series-read-10k-points | 43.8 | 222.2 | 302.26 | 359 | 402.45 | 657 | 0 |
| series-read-100k-points | 4.6 | 2372.96 | 2983.35 | 4078.46 | 4078.46 | 69 | 0 |

Resources: peak RSS=81.1MB, peak CPU=1%

## series-write

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-write-batch10 | 665.87 | 13.57 | 25.72 | 39.3 | 114.58 | 9988 | 0 |
| series-write-batch100 | 399.07 | 22.26 | 42.1 | 64.07 | 124.71 | 5986 | 0 |
| series-write-batch1000 | 57.93 | 133.95 | 464.82 | 596.36 | 684.97 | 869 | 0 |

Resources: peak RSS=81.1MB, peak CPU=0%

## streams-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-create-flat | 101.27 | 88.05 | 180.96 | 240.09 | 330.82 | 1519 | 0 |
| streams-create-nested | 57.8 | 157.22 | 274.88 | 339.89 | 488.17 | 867 | 92 |

Resources: peak RSS=81.4MB, peak CPU=4%

## streams-update

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-update | 49.27 | 180.35 | 350.13 | 413.63 | 480.98 | 739 | 42 |

Resources: peak RSS=81.4MB, peak CPU=4%

## Storage (from clean baseline)

| Engine | Clean DB | After all | Total growth |
|--------|----------|-----------|-------------|
| mongodb | 1.2GB | 1.2GB | +176.7KB |
| sqlite | 4.0MB | 4.0MB | +0B |
| influxdb | 279.3KB | 279.3KB | +0B |
| userDirs | 705.7MB | 859.3MB | +153.7MB |
| syslogSize | 448.4MB | 517.7MB | +69.3MB |
| syslogLines | 1311931 | 1495734 | +183803 |

## Storage (benchmark run only)

| Engine | Before | After | Delta |
|--------|--------|-------|-------|
| mongodb | 1.2GB | 1.2GB | +53.0KB |
| sqlite | 4.0MB | 4.0MB | +0B |
| influxdb | 279.3KB | 279.3KB | +0B |
| userDirs | 839.2MB | 859.3MB | +20.2MB |
| syslogSize | 507.1MB | 517.7MB | +10.6MB |
| syslogLines | 1462605 | 1495734 | +33129 |

## Notes

_Add observations here._
