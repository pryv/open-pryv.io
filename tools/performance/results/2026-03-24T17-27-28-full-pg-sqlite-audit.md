# Full Benchmark Run

**Date:** 2026-03-24T17:27:28.971Z  
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
| events-create | events-create-master | 366.27 | 24.03 | 45.01 | 57.9 | 433.94 | 5494 | 0 |
| events-create | events-create-restricted | 427 | 20.61 | 42.58 | 54.27 | 88.69 | 6405 | 0 |
| events-get | no-filter-master | 116.33 | 82.4 | 127.24 | 150.51 | 187.18 | 1745 | 0 |
| events-get | no-filter-restricted | 222.07 | 42.22 | 69.01 | 86.24 | 130.85 | 3331 | 0 |
| events-get | stream-parent-master | 92.4 | 103.49 | 172.96 | 219.09 | 391.53 | 1386 | 0 |
| events-get | stream-parent-restricted | 90.6 | 100.42 | 254.21 | 313.54 | 407.55 | 1359 | 0 |
| events-get | time-range-master | 117 | 82.74 | 121.48 | 139.51 | 167.3 | 1755 | 0 |
| events-get | time-range-restricted | 200.93 | 46.94 | 74.84 | 99.08 | 153.62 | 3014 | 0 |
| mixed-workload | mixed-workload | 90.73 | 92.74 | 241.7 | 291.72 | 483.36 | 1361 | 5 |
| series-read | series-read-1k-points | 941.93 | 8.87 | 20.67 | 36.66 | 192.18 | 14129 | 0 |
| series-read | series-read-10k-points | 1211 | 7.44 | 13.12 | 20.83 | 44.19 | 18165 | 0 |
| series-read | series-read-100k-points | 1238.47 | 7.2 | 12.97 | 20.57 | 55.84 | 18577 | 0 |
| series-write | series-write-batch10 | 776.27 | 12.33 | 19.8 | 27.48 | 104.13 | 11644 | 0 |
| series-write | series-write-batch100 | 421.4 | 21.98 | 35.7 | 50.48 | 111.62 | 6321 | 0 |
| series-write | series-write-batch1000 | 64.93 | 138.82 | 279.98 | 511.65 | 646.62 | 974 | 0 |
| streams-create | streams-create-flat | 32.87 | 208.97 | 328.73 | 404.07 | 509.01 | 493 | 1204 |
| streams-create | streams-create-nested | 34.93 | 243.03 | 409.3 | 1023.68 | 1316.47 | 524 | 582 |
| streams-update | streams-update | 31.87 | 299.17 | 511.8 | 581.95 | 630.64 | 478 | 0 |

## events-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create-master | 366.27 | 24.03 | 45.01 | 57.9 | 433.94 | 5494 | 0 |
| events-create-restricted | 427 | 20.61 | 42.58 | 54.27 | 88.69 | 6405 | 0 |

Resources: peak RSS=91.7MB, peak CPU=8%

## events-get

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| no-filter-master | 116.33 | 82.4 | 127.24 | 150.51 | 187.18 | 1745 | 0 |
| no-filter-restricted | 222.07 | 42.22 | 69.01 | 86.24 | 130.85 | 3331 | 0 |
| stream-parent-master | 92.4 | 103.49 | 172.96 | 219.09 | 391.53 | 1386 | 0 |
| stream-parent-restricted | 90.6 | 100.42 | 254.21 | 313.54 | 407.55 | 1359 | 0 |
| time-range-master | 117 | 82.74 | 121.48 | 139.51 | 167.3 | 1755 | 0 |
| time-range-restricted | 200.93 | 46.94 | 74.84 | 99.08 | 153.62 | 3014 | 0 |

Resources: peak RSS=91.9MB, peak CPU=6%

## mixed-workload

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed-workload | 90.73 | 92.74 | 241.7 | 291.72 | 483.36 | 1361 | 5 |

Resources: peak RSS=81.8MB, peak CPU=3%

## series-read

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-read-1k-points | 941.93 | 8.87 | 20.67 | 36.66 | 192.18 | 14129 | 0 |
| series-read-10k-points | 1211 | 7.44 | 13.12 | 20.83 | 44.19 | 18165 | 0 |
| series-read-100k-points | 1238.47 | 7.2 | 12.97 | 20.57 | 55.84 | 18577 | 0 |

Resources: peak RSS=82.2MB, peak CPU=2%

## series-write

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-write-batch10 | 776.27 | 12.33 | 19.8 | 27.48 | 104.13 | 11644 | 0 |
| series-write-batch100 | 421.4 | 21.98 | 35.7 | 50.48 | 111.62 | 6321 | 0 |
| series-write-batch1000 | 64.93 | 138.82 | 279.98 | 511.65 | 646.62 | 974 | 0 |

Resources: peak RSS=82.4MB, peak CPU=4%

## streams-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-create-flat | 32.87 | 208.97 | 328.73 | 404.07 | 509.01 | 493 | 1204 |
| streams-create-nested | 34.93 | 243.03 | 409.3 | 1023.68 | 1316.47 | 524 | 582 |

Resources: peak RSS=82.2MB, peak CPU=3%

## streams-update

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-update | 31.87 | 299.17 | 511.8 | 581.95 | 630.64 | 478 | 0 |

Resources: peak RSS=82.5MB, peak CPU=3%

## Storage (from clean baseline)

| Engine | Clean DB | After all | Total growth |
|--------|----------|-----------|-------------|
| mongodb | 1.2GB | 1.2GB | +277.0KB |
| sqlite | 2.2MB | 2.4MB | +217.3KB |
| influxdb | 285.7KB | 285.7KB | +0B |
| userDirs | 36.8MB | 171.5MB | +134.7MB |
| syslogSize | 592.8MB | 652.3MB | +59.5MB |
| syslogLines | 1699264 | 1860527 | +161263 |

## Storage (benchmark run only)

| Engine | Before | After | Delta |
|--------|--------|-------|-------|
| mongodb | 1.2GB | 1.2GB | +20.3KB |
| sqlite | 2.4MB | 2.4MB | +8.0KB |
| influxdb | 285.7KB | 285.7KB | +0B |
| userDirs | 153.9MB | 171.5MB | +17.6MB |
| syslogSize | 642.6MB | 652.3MB | +9.7MB |
| syslogLines | 1831477 | 1860527 | +29050 |

## Notes

_Add observations here._
