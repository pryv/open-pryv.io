# Benchmark Comparison

| | **A** | **B** |
|---|---|---|
| File | 2026-03-23T16-12-55-full-mongodb | 2026-03-24T13-21-21-full-postgresql-optimized |
| Date | 2026-03-23T16:12:55.181Z | 2026-03-24T13:21:21.270Z |
| Duration | 15s | 15s |
| Concurrency | 10 | 10 |

## Config Differences

| Setting | A | B |
|---------|---|---|
| engines | {"base":"mongodb","platform":"sqlite","series":"influxdb","file":"filesystem","audit":"sqlite"} | {"base":"postgresql","platform":"sqlite","series":"postgresql","file":"filesystem","audit":"sqlite"} |

## Version

- **A:** 2.0.0-pre.2 (f5f5e80c)
- **B:** 2.0.0-pre.2 (6aea864a)

## Performance

| Sub-scenario | Req/s A | Req/s B | Delta | p50 A | p50 B | p95 A | p95 B |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create/events-create-master | 289.07 | 299.93 | +10.9 (+3.8%) | 30.62 | 28.57 | 63.39 | 63.5 |
| events-create/events-create-restricted | 373.27 | 414.8 | +41.5 (+11.1%) | 23.43 | 21.43 | 48.97 | 48.28 |
| events-get/no-filter-master | 140.33 | 217.73 | +77.4 (+55.2%) | 62.77 | 42.24 | 131.09 | 83.27 |
| events-get/no-filter-restricted | 199.67 | 183.2 | -16.5 (-8.2%) | 45.39 | 51.06 | 85.88 | 95.56 |
| events-get/stream-parent-master | 184.6 | 172 | -12.6 (-6.8%) | 49.3 | 55.28 | 89.89 | 96.59 |
| events-get/stream-parent-restricted | 209.33 | 143.07 | -66.3 (-31.7%) | 43.73 | 63.44 | 79.34 | 130 |
| events-get/time-range-master | 163.67 | 150.33 | -13.3 (-8.2%) | 55.31 | 62.31 | 104.01 | 123.93 |
| events-get/time-range-restricted | 142.8 | 153.93 | +11.1 (+7.8%) | 63.14 | 61.43 | 114.32 | 108.25 |
| mixed-workload/mixed-workload | 192.2 | 221.6 | +29.4 (+15.3%) | 46.15 | 39.08 | 96.51 | 90.92 |
| series-read/series-read-1k-points | 252.6 | 417.73 | +165.1 (+65.4%) | 35.9 | 21.95 | 67.15 | 38.86 |
| series-read/series-read-10k-points | 50.93 | 43.8 | -7.1 (-14.0%) | 184.35 | 222.2 | 300.8 | 302.26 |
| series-read/series-read-100k-points | 4.67 | 4.6 | -0.1 (-1.5%) | 2290.32 | 2372.96 | 3299.06 | 2983.35 |
| series-write/series-write-batch10 | 339.87 | 665.87 | +326.0 (+95.9%) | 24.99 | 13.57 | 57.18 | 25.72 |
| series-write/series-write-batch100 | 312.27 | 399.07 | +86.8 (+27.8%) | 28.65 | 22.26 | 54.27 | 42.1 |
| series-write/series-write-batch1000 | 134.2 | 57.93 | -76.3 (-56.8%) | 71.02 | 133.95 | 113.75 | 464.82 |
| streams-create/streams-create-flat | 88.6 | 101.27 | +12.7 (+14.3%) | 107.76 | 88.05 | 200.32 | 180.96 |
| streams-create/streams-create-nested | 59.13 | 57.8 | -1.3 (-2.2%) | 166.41 | 157.22 | 272.07 | 274.88 |
| streams-update/streams-update | 43.07 | 49.27 | +6.2 (+14.4%) | 228.23 | 180.35 | 345.54 | 350.13 |

## Summary

- **Average throughput change:** +10.1%
- **Faster in B:** 10/18 sub-scenarios
- **Slower in B:** 8/18 sub-scenarios

## Storage

| Engine | Growth A | Growth B | Delta |
|--------|----------|----------|-------|
| mongodb | 39.7MB | 176.7KB | -39.6MB |
| sqlite | 104.6KB | 0B | -104.6KB |
| influxdb | 462.0B | 0B | -462.0B |
| userDirs | 44.7MB | 153.7MB | +109.0MB |
| syslogSize | 28.7MB | 69.3MB | +40.6MB |
| syslogLines | +95343 | +183803 | +88460 |

## Notes

_Add observations here._
