# Full Benchmark Run

**Date:** 2026-03-24T14:29:48.056Z  
**Duration:** 15s per scenario | **Concurrency:** 10  
**Target:** http://127.0.0.1:3000 | **Profile:** manual

## Server Config
- **Base storage:** postgresql | **Platform:** sqlite | **Series:** postgresql
- **Audit:** ON | **Integrity:** {"attachments":true,"events":true,"accesses":true}
- **API workers:** 2

## System
- **CPU:** Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz (8 cores) | **Memory:** 31.0GB
- **Node:** v24.14.0 | **Version:** 2.0.0-pre.2 (5f04148f)

## Summary

| Scenario | Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| events-create | events-create-master | 234.4 | 34.35 | 95.91 | 140.39 | 258.59 | 3516 | 0 |
| events-create | events-create-restricted | 396.13 | 21.91 | 46.17 | 62.26 | 90.95 | 5942 | 0 |
| events-get | no-filter-master | 204.2 | 45.26 | 78.76 | 108.58 | 150.37 | 3063 | 0 |
| events-get | no-filter-restricted | 235.73 | 39.77 | 64.53 | 82.56 | 117.18 | 3536 | 0 |
| events-get | stream-parent-master | 111.07 | 83.61 | 138.42 | 181.58 | 466.32 | 1666 | 0 |
| events-get | stream-parent-restricted | 172.4 | 54.5 | 95.34 | 124.84 | 181.93 | 2586 | 0 |
| events-get | time-range-master | 181.53 | 47.62 | 106.01 | 157.48 | 242.03 | 2723 | 0 |
| events-get | time-range-restricted | 156.2 | 58.27 | 113.21 | 155.65 | 199.89 | 2343 | 0 |
| mixed-workload | mixed-workload | 232.6 | 38.39 | 81.48 | 112.73 | 203.14 | 3489 | 0 |
| series-read | series-read-1k-points | 514.4 | 18.08 | 30.06 | 40.77 | 110.23 | 7716 | 0 |
| series-read | series-read-10k-points | 43.33 | 216.17 | 344.64 | 449.76 | 470.93 | 650 | 0 |
| series-read | series-read-100k-points | 4.07 | 2654.94 | 3655.9 | 3904.84 | 3904.84 | 61 | 0 |
| series-write | series-write-batch10 | 535.6 | 15.39 | 39.6 | 66.55 | 144.59 | 8034 | 0 |
| series-write | series-write-batch100 | 348.93 | 25.65 | 50.07 | 73.68 | 137.91 | 5234 | 0 |
| series-write | series-write-batch1000 | 64.8 | 142.09 | 260.37 | 384.83 | 462.97 | 972 | 0 |
| streams-create | streams-create-flat | 89.13 | 98.23 | 218.85 | 410.75 | 801.38 | 1337 | 0 |
| streams-create | streams-create-nested | 65.6 | 144.67 | 245.15 | 338.56 | 615.14 | 984 | 0 |
| streams-update | streams-update | 50.07 | 192.97 | 305.2 | 365.31 | 496.79 | 751 | 0 |

## events-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create-master | 234.4 | 34.35 | 95.91 | 140.39 | 258.59 | 3516 | 0 |
| events-create-restricted | 396.13 | 21.91 | 46.17 | 62.26 | 90.95 | 5942 | 0 |

Resources: peak RSS=80.9MB, peak CPU=7%

## events-get

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| no-filter-master | 204.2 | 45.26 | 78.76 | 108.58 | 150.37 | 3063 | 0 |
| no-filter-restricted | 235.73 | 39.77 | 64.53 | 82.56 | 117.18 | 3536 | 0 |
| stream-parent-master | 111.07 | 83.61 | 138.42 | 181.58 | 466.32 | 1666 | 0 |
| stream-parent-restricted | 172.4 | 54.5 | 95.34 | 124.84 | 181.93 | 2586 | 0 |
| time-range-master | 181.53 | 47.62 | 106.01 | 157.48 | 242.03 | 2723 | 0 |
| time-range-restricted | 156.2 | 58.27 | 113.21 | 155.65 | 199.89 | 2343 | 0 |

Resources: peak RSS=80.9MB, peak CPU=1%

## mixed-workload

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| mixed-workload | 232.6 | 38.39 | 81.48 | 112.73 | 203.14 | 3489 | 0 |

Resources: peak RSS=81MB, peak CPU=4%

## series-read

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-read-1k-points | 514.4 | 18.08 | 30.06 | 40.77 | 110.23 | 7716 | 0 |
| series-read-10k-points | 43.33 | 216.17 | 344.64 | 449.76 | 470.93 | 650 | 0 |
| series-read-100k-points | 4.07 | 2654.94 | 3655.9 | 3904.84 | 3904.84 | 61 | 0 |

Resources: peak RSS=81MB, peak CPU=1%

## series-write

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| series-write-batch10 | 535.6 | 15.39 | 39.6 | 66.55 | 144.59 | 8034 | 0 |
| series-write-batch100 | 348.93 | 25.65 | 50.07 | 73.68 | 137.91 | 5234 | 0 |
| series-write-batch1000 | 64.8 | 142.09 | 260.37 | 384.83 | 462.97 | 972 | 0 |

Resources: peak RSS=81MB, peak CPU=1%

## streams-create

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-create-flat | 89.13 | 98.23 | 218.85 | 410.75 | 801.38 | 1337 | 0 |
| streams-create-nested | 65.6 | 144.67 | 245.15 | 338.56 | 615.14 | 984 | 0 |

Resources: peak RSS=81.3MB, peak CPU=5%

## streams-update

| Sub-scenario | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | OK | Fail |
|---|---:|---:|---:|---:|---:|---:|---:|
| streams-update | 50.07 | 192.97 | 305.2 | 365.31 | 496.79 | 751 | 0 |

Resources: peak RSS=81.3MB, peak CPU=4%

## Storage (from clean baseline)

| Engine | Clean DB | After all | Total growth |
|--------|----------|-----------|-------------|
| mongodb | 1.2GB | 1.2GB | +47.6KB |
| sqlite | 4.0MB | 4.0MB | +0B |
| influxdb | 282.4KB | 282.4KB | +0B |
| userDirs | 1.0GB | 1.2GB | +141.4MB |
| syslogSize | 519.4MB | 589.0MB | +69.6MB |
| syslogLines | 1501959 | 1685217 | +183258 |

## Storage (benchmark run only)

| Engine | Before | After | Delta |
|--------|--------|-------|-------|
| mongodb | 1.2GB | 1.2GB | +4.6KB |
| sqlite | 4.0MB | 4.0MB | +0B |
| influxdb | 282.4KB | 282.4KB | +0B |
| userDirs | 1.2GB | 1.2GB | +18.5MB |
| syslogSize | 578.8MB | 589.0MB | +10.2MB |
| syslogLines | 1653064 | 1685217 | +32153 |

## Notes

_Add observations here._
