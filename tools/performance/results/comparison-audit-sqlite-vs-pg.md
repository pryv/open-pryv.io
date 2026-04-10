# Benchmark Comparison

| | **A** | **B** |
|---|---|---|
| File | 2026-03-24T17-27-28-full-pg-sqlite-audit | 2026-03-24T17-35-28-full-pg-pg-audit |
| Date | 2026-03-24T17:27:28.971Z | 2026-03-24T17:35:28.221Z |
| Duration | 15s | 15s |
| Concurrency | 10 | 10 |

## Config Differences

| Setting | A | B |
|---------|---|---|
| engines | {"base":"postgresql","platform":"sqlite","series":"postgresql","file":"filesystem","audit":"sqlite"} | {"base":"postgresql","platform":"sqlite","series":"postgresql","file":"filesystem","audit":"postgresql"} |

## Performance

| Sub-scenario | Req/s A | Req/s B | Delta | p50 A | p50 B | p95 A | p95 B |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create/events-create-master | 366.27 | 341.4 | -24.9 (-6.8%) | 24.03 | 24.53 | 45.01 | 55.6 |
| events-create/events-create-restricted | 427 | 396.73 | -30.3 (-7.1%) | 20.61 | 21.93 | 42.58 | 52.09 |
| events-get/no-filter-master | 116.33 | 83.33 | -33.0 (-28.4%) | 82.4 | 112.1 | 127.24 | 214.71 |
| events-get/no-filter-restricted | 222.07 | 205.13 | -16.9 (-7.6%) | 42.22 | 41.96 | 69.01 | 93.92 |
| events-get/stream-parent-master | 92.4 | 81.27 | -11.1 (-12.0%) | 103.49 | 118.48 | 172.96 | 200.57 |
| events-get/stream-parent-restricted | 90.6 | 69 | -21.6 (-23.8%) | 100.42 | 124.07 | 254.21 | 359.56 |
| events-get/time-range-master | 117 | 82.87 | -34.1 (-29.2%) | 82.74 | 114.21 | 121.48 | 209.07 |
| events-get/time-range-restricted | 200.93 | 192.07 | -8.9 (-4.4%) | 46.94 | 48.03 | 74.84 | 96.07 |
| mixed-workload/mixed-workload | 90.73 | 64.67 | -26.1 (-28.7%) | 92.74 | 115.82 | 241.7 | 379.8 |
| series-read/series-read-1k-points | 941.93 | 423.93 | -518.0 (-55.0%) | 8.87 | 20.96 | 20.67 | 41.54 |
| series-read/series-read-10k-points | 1211 | 502.67 | -708.3 (-58.5%) | 7.44 | 18.59 | 13.12 | 30.65 |
| series-read/series-read-100k-points | 1238.47 | 519.33 | -719.1 (-58.1%) | 7.2 | 18.04 | 12.97 | 28.98 |
| series-write/series-write-batch10 | 776.27 | 745.2 | -31.1 (-4.0%) | 12.33 | 12.46 | 19.8 | 22.14 |
| series-write/series-write-batch100 | 421.4 | 385.27 | -36.1 (-8.6%) | 21.98 | 23.5 | 35.7 | 42.41 |
| series-write/series-write-batch1000 | 64.93 | 63.53 | -1.4 (-2.2%) | 138.82 | 138.81 | 279.98 | 285.49 |
| streams-create/streams-create-flat | 32.87 | 16.47 | -16.4 (-49.9%) | 208.97 | 289.3 | 328.73 | 507.07 |
| streams-create/streams-create-nested | 34.93 | 26.87 | -8.1 (-23.1%) | 243.03 | 296.4 | 409.3 | 508.39 |
| streams-update/streams-update | 31.87 | 25.13 | -6.7 (-21.1%) | 299.17 | 377.66 | 511.8 | 655.22 |

## Summary

- **Average throughput change:** -23.8%
- **Faster in B:** 0/18 sub-scenarios
- **Slower in B:** 18/18 sub-scenarios

## Storage

| Engine | Growth A | Growth B | Delta |
|--------|----------|----------|-------|
| mongodb | 277.0KB | 357.0KB | +79.9KB |
| sqlite | 217.3KB | 338.0KB | +120.7KB |
| influxdb | 0B | 0B | +0B |
| userDirs | 134.7MB | 134.8MB | +120.7KB |
| syslogSize | 59.5MB | 68.6MB | +9.1MB |
| syslogLines | +161263 | +187965 | +26702 |

## Notes

_Add observations here._
