# Full Benchmark Run

**Date:** 2026-03-24T17:09:17.551Z  
**Duration:** 15s per scenario | **Concurrency:** 10  
**Target:** http://127.0.0.1:3000 | **Profile:** manual

## Server Config
- **Base storage:** postgresql | **Platform:** sqlite | **Series:** postgresql | **Audit:** sqlite
- **Audit active:** ON | **Integrity:** {"attachments":true,"events":true,"accesses":true}
- **API workers:** 2

## System
- **CPU:** Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz (8 cores) | **Memory:** 31.0GB
- **Node:** v24.14.0 | **Version:** 2.0.0-pre.2 (a5bfb8a1)

## Summary

| Scenario | Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| events-create | events-create-master | 352.47 | 25.04 | 49.97 | 70.15 | 205.23 | 5287 | 0 |
| events-create | events-create-restricted | 384.6 | 22.07 | 49.67 | 74.36 | 133.28 | 5769 | 0 |
| events-get | no-filter-master | 173.4 | 51.43 | 104.1 | 138.29 | 239.39 | 2601 | 0 |
| events-get | no-filter-restricted | 200.6 | 44.49 | 82.15 | 133.26 | 302.1 | 3009 | 0 |
| events-get | stream-parent-master | 94.07 | 101.75 | 167.96 | 213.68 | 276.6 | 1411 | 0 |
| events-get | stream-parent-restricted | 122.33 | 77.39 | 151.63 | 194.96 | 318.32 | 1835 | 0 |
| events-get | time-range-master | 181.67 | 50.7 | 89.11 | 121.81 | 176.75 | 2725 | 0 |
| events-get | time-range-restricted | 184.2 | 48.05 | 96.71 | 140.45 | 175.78 | 2763 | 0 |
| mixed-workload | mixed-workload | 198.4 | 43.72 | 102.81 | 158.5 | 272.25 | 2976 | 0 |
| series-read | series-read-1k-points | 0 | - | - | - | - | 0 | 44247 |
| series-read | series-read-10k-points | 0 | - | - | - | - | 0 | 48977 |
| series-read | series-read-100k-points | 0 | - | - | - | - | 0 | 48745 |
| series-write | series-write-batch10 | 0 | - | - | - | - | 0 | 33395 |
| series-write | series-write-batch100 | 0 | - | - | - | - | 0 | 25869 |
| series-write | series-write-batch1000 | 0 | - | - | - | - | 0 | 16310 |
| streams-create | streams-create-flat | 80.27 | 110.52 | 243.57 | 382.27 | 755.5 | 1204 | 0 |
| streams-create | streams-create-nested | 38.8 | 248.97 | 433.95 | 573.21 | 738.41 | 582 | 0 |
| streams-update | streams-update | 39.07 | 247.87 | 392.32 | 474.89 | 556.49 | 586 | 0 |

## events-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create-master | 352.47 | 25.04 | 49.97 | 70.15 | 205.23 | 5287 | 0 |
| events-create-restricted | 384.6 | 22.07 | 49.67 | 74.36 | 133.28 | 5769 | 0 |

Resources: peak RSS=86MB, peak CPU=7%

## events-get

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| no-filter-master | 173.4 | 51.43 | 104.1 | 138.29 | 239.39 | 2601 | 0 |
| no-filter-restricted | 200.6 | 44.49 | 82.15 | 133.26 | 302.1 | 3009 | 0 |
| stream-parent-master | 94.07 | 101.75 | 167.96 | 213.68 | 276.6 | 1411 | 0 |
| stream-parent-restricted | 122.33 | 77.39 | 151.63 | 194.96 | 318.32 | 1835 | 0 |
| time-range-master | 181.67 | 50.7 | 89.11 | 121.81 | 176.75 | 2725 | 0 |
| time-range-restricted | 184.2 | 48.05 | 96.71 | 140.45 | 175.78 | 2763 | 0 |

Resources: peak RSS=86.5MB, peak CPU=2%

## mixed-workload

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed-workload | 198.4 | 43.72 | 102.81 | 158.5 | 272.25 | 2976 | 0 |

Resources: peak RSS=86.7MB, peak CPU=3%

## series-read

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-read-1k-points | 0 | - | - | - | - | 0 | 44247 |
| series-read-10k-points | 0 | - | - | - | - | 0 | 48977 |
| series-read-100k-points | 0 | - | - | - | - | 0 | 48745 |

Resources: peak RSS=87.1MB, peak CPU=6%

## series-write

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-write-batch10 | 0 | - | - | - | - | 0 | 33395 |
| series-write-batch100 | 0 | - | - | - | - | 0 | 25869 |
| series-write-batch1000 | 0 | - | - | - | - | 0 | 16310 |

Resources: peak RSS=87.4MB, peak CPU=2%

## streams-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-create-flat | 80.27 | 110.52 | 243.57 | 382.27 | 755.5 | 1204 | 0 |
| streams-create-nested | 38.8 | 248.97 | 433.95 | 573.21 | 738.41 | 582 | 0 |

Resources: peak RSS=87.7MB, peak CPU=6%

## streams-update

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-update | 39.07 | 247.87 | 392.32 | 474.89 | 556.49 | 586 | 0 |

Resources: peak RSS=87.9MB, peak CPU=4%

## Storage (from clean baseline)

| Engine | Clean DB | After all | Total growth |
|--------|----------|-----------|-------------|
| mongodb | 1.2GB | 1.2GB | +153.9KB |
| sqlite | 2.2MB | 2.3MB | +96.6KB |
| influxdb | 285.7KB | 285.7KB | +0B |
| userDirs | 36.8MB | 153.7MB | +117.0MB |
| syslogSize | 592.8MB | 642.4MB | +49.6MB |
| syslogLines | 1699264 | 1830666 | +131402 |

## Storage (benchmark run only)

| Engine | Before | After | Delta |
|--------|--------|-------|-------|
| mongodb | 1.2GB | 1.2GB | +50.6KB |
| sqlite | 2.3MB | 2.3MB | +0B |
| influxdb | 285.7KB | 285.7KB | +0B |
| userDirs | 135.7MB | 153.7MB | +18.0MB |
| syslogSize | 632.4MB | 642.4MB | +10.0MB |
| syslogLines | 1800009 | 1830666 | +30657 |

## Notes

_Add observations here._
