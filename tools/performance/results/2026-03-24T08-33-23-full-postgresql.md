# Full Benchmark Run

**Date:** 2026-03-24T08:33:23.954Z  
**Duration:** 15s per scenario | **Concurrency:** 10  
**Target:** http://127.0.0.1:3000 | **Profile:** manual

## Server Config
- **Base storage:** postgresql | **Platform:** sqlite | **Series:** postgresql
- **Audit:** ON | **Integrity:** {"attachments":true,"events":true,"accesses":true}
- **API workers:** 2

## System
- **CPU:** Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz (8 cores) | **Memory:** 31.0GB
- **Node:** v24.14.0 | **Version:** 2.0.0-pre.2 (71ef953e)

## Summary

| Scenario | Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| events-create | events-create-master | 302.53 | 28.54 | 64.66 | 93.33 | 147.49 | 4538 | 0 |
| events-create | events-create-restricted | 322.87 | 26.13 | 63.08 | 88.9 | 262.51 | 4843 | 0 |
| events-get | no-filter-master | 189.93 | 47.7 | 96.34 | 129.34 | 258.32 | 2849 | 0 |
| events-get | no-filter-restricted | 213 | 43.02 | 81.32 | 104.09 | 151.02 | 3195 | 0 |
| events-get | stream-parent-master | 101.8 | 91.14 | 168.83 | 218.52 | 320.07 | 1527 | 0 |
| events-get | stream-parent-restricted | 116 | 75.36 | 177.61 | 259.88 | 445.69 | 1740 | 0 |
| events-get | time-range-master | 200.73 | 46.6 | 88.27 | 108.17 | 142.39 | 3011 | 0 |
| events-get | time-range-restricted | 142.87 | 63.02 | 130.81 | 187 | 286.75 | 2143 | 0 |
| mixed-workload | mixed-workload | 210.87 | 41.8 | 95.69 | 136.44 | 224.19 | 3163 | 0 |
| series-read | series-read-1k-points | 596.8 | 14.73 | 30.28 | 48.77 | 93.7 | 8952 | 0 |
| series-read | series-read-10k-points | 37.33 | 249.4 | 428.61 | 511.99 | 592.31 | 560 | 0 |
| series-read | series-read-100k-points | 3.73 | 2884.18 | 3826.28 | 4021.76 | 4021.76 | 56 | 0 |
| series-write | series-write-batch10 | 166.07 | 48.9 | 126.6 | 194.32 | 305.23 | 2491 | 0 |
| series-write | series-write-batch100 | 26.67 | 334.77 | 652.87 | 746.89 | 765.98 | 400 | 0 |
| series-write | series-write-batch1000 | 3.33 | 3464.7 | 3978.2 | 4033.69 | 4033.69 | 50 | 0 |
| streams-create | streams-create-flat | 91.07 | 97.34 | 208.63 | 299.35 | 491.24 | 1366 | 0 |
| streams-create | streams-create-nested | 61.27 | 154.61 | 265.99 | 330.32 | 463.82 | 919 | 0 |
| streams-update | streams-update | 38.93 | 234.64 | 454.27 | 692.31 | 1002.11 | 584 | 0 |

## events-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create-master | 302.53 | 28.54 | 64.66 | 93.33 | 147.49 | 4538 | 0 |
| events-create-restricted | 322.87 | 26.13 | 63.08 | 88.9 | 262.51 | 4843 | 0 |

Resources: peak RSS=1010.1MB, peak CPU=273%

## events-get

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| no-filter-master | 189.93 | 47.7 | 96.34 | 129.34 | 258.32 | 2849 | 0 |
| no-filter-restricted | 213 | 43.02 | 81.32 | 104.09 | 151.02 | 3195 | 0 |
| stream-parent-master | 101.8 | 91.14 | 168.83 | 218.52 | 320.07 | 1527 | 0 |
| stream-parent-restricted | 116 | 75.36 | 177.61 | 259.88 | 445.69 | 1740 | 0 |
| time-range-master | 200.73 | 46.6 | 88.27 | 108.17 | 142.39 | 3011 | 0 |
| time-range-restricted | 142.87 | 63.02 | 130.81 | 187 | 286.75 | 2143 | 0 |

Resources: peak RSS=1295.5MB, peak CPU=226%

## mixed-workload

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed-workload | 210.87 | 41.8 | 95.69 | 136.44 | 224.19 | 3163 | 0 |

Resources: peak RSS=1297.5MB, peak CPU=216%

## series-read

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-read-1k-points | 596.8 | 14.73 | 30.28 | 48.77 | 93.7 | 8952 | 0 |
| series-read-10k-points | 37.33 | 249.4 | 428.61 | 511.99 | 592.31 | 560 | 0 |
| series-read-100k-points | 3.73 | 2884.18 | 3826.28 | 4021.76 | 4021.76 | 56 | 0 |

Resources: peak RSS=1752.2MB, peak CPU=173%

## series-write

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-write-batch10 | 166.07 | 48.9 | 126.6 | 194.32 | 305.23 | 2491 | 0 |
| series-write-batch100 | 26.67 | 334.77 | 652.87 | 746.89 | 765.98 | 400 | 0 |
| series-write-batch1000 | 3.33 | 3464.7 | 3978.2 | 4033.69 | 4033.69 | 50 | 0 |

Resources: peak RSS=1782.8MB, peak CPU=104%

## streams-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-create-flat | 91.07 | 97.34 | 208.63 | 299.35 | 491.24 | 1366 | 0 |
| streams-create-nested | 61.27 | 154.61 | 265.99 | 330.32 | 463.82 | 919 | 0 |

Resources: peak RSS=1532.9MB, peak CPU=287.8%

## streams-update

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-update | 38.93 | 234.64 | 454.27 | 692.31 | 1002.11 | 584 | 0 |

Resources: peak RSS=1539.5MB, peak CPU=225.8%

## Storage (from clean baseline)

| Engine | Clean DB | After all | Total growth |
|--------|----------|-----------|-------------|
| mongodb | 1.1GB | 1.1GB | +350.3KB |
| sqlite | 1.1MB | 1.3MB | +152.9KB |
| influxdb | 277.8KB | 277.8KB | +0B |
| userDirs | 183.8MB | 331.8MB | +148.0MB |
| syslogSize | 240.0MB | 309.2MB | +69.2MB |
| syslogLines | 755444 | 937501 | +182057 |

## Storage (benchmark run only)

| Engine | Before | After | Delta |
|--------|--------|-------|-------|
| mongodb | 1.1GB | 1.1GB | +53.3KB |
| sqlite | 1.3MB | 1.3MB | +0B |
| influxdb | 277.8KB | 277.8KB | +0B |
| userDirs | 314.4MB | 331.8MB | +17.4MB |
| syslogSize | 299.6MB | 309.2MB | +9.6MB |
| syslogLines | 907397 | 937501 | +30104 |

## Notes

_Add observations here._
