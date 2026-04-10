# Benchmark Comparison

| | **A** | **B** |
|---|---|---|
| File | 2026-03-23T16-12-55-full-mongodb | 2026-03-24T08-33-23-full-postgresql |
| Date | 2026-03-23T16:12:55.181Z | 2026-03-24T08:33:23.954Z |
| Duration | 15s | 15s |
| Concurrency | 10 | 10 |

## Config Differences

| Setting | A | B |
|---------|---|---|
| engines | {"base":"mongodb","platform":"sqlite","series":"influxdb","file":"filesystem","audit":"sqlite"} | {"base":"postgresql","platform":"sqlite","series":"postgresql","file":"filesystem","audit":"sqlite"} |

## Version

- **A:** 2.0.0-pre.2 (f5f5e80c)
- **B:** 2.0.0-pre.2 (71ef953e)

## Performance

| Sub-scenario | Req/s A | Req/s B | Delta | p50 A | p50 B | p95 A | p95 B |
|---|---:|---:|---:|---:|---:|---:|---:|
| events-create/events-create-master | 289.07 | 302.53 | +13.5 (+4.7%) | 30.62 | 28.54 | 63.39 | 64.66 |
| events-create/events-create-restricted | 373.27 | 322.87 | -50.4 (-13.5%) | 23.43 | 26.13 | 48.97 | 63.08 |
| events-get/no-filter-master | 140.33 | 189.93 | +49.6 (+35.3%) | 62.77 | 47.7 | 131.09 | 96.34 |
| events-get/no-filter-restricted | 199.67 | 213 | +13.3 (+6.7%) | 45.39 | 43.02 | 85.88 | 81.32 |
| events-get/stream-parent-master | 184.6 | 101.8 | -82.8 (-44.9%) | 49.3 | 91.14 | 89.89 | 168.83 |
| events-get/stream-parent-restricted | 209.33 | 116 | -93.3 (-44.6%) | 43.73 | 75.36 | 79.34 | 177.61 |
| events-get/time-range-master | 163.67 | 200.73 | +37.1 (+22.6%) | 55.31 | 46.6 | 104.01 | 88.27 |
| events-get/time-range-restricted | 142.8 | 142.87 | +0.1 (+0.0%) | 63.14 | 63.02 | 114.32 | 130.81 |
| mixed-workload/mixed-workload | 192.2 | 210.87 | +18.7 (+9.7%) | 46.15 | 41.8 | 96.51 | 95.69 |
| series-read/series-read-1k-points | 252.6 | 596.8 | +344.2 (+136.3%) | 35.9 | 14.73 | 67.15 | 30.28 |
| series-read/series-read-10k-points | 50.93 | 37.33 | -13.6 (-26.7%) | 184.35 | 249.4 | 300.8 | 428.61 |
| series-read/series-read-100k-points | 4.67 | 3.73 | -0.9 (-20.1%) | 2290.32 | 2884.18 | 3299.06 | 3826.28 |
| series-write/series-write-batch10 | 339.87 | 166.07 | -173.8 (-51.1%) | 24.99 | 48.9 | 57.18 | 126.6 |
| series-write/series-write-batch100 | 312.27 | 26.67 | -285.6 (-91.5%) | 28.65 | 334.77 | 54.27 | 652.87 |
| series-write/series-write-batch1000 | 134.2 | 3.33 | -130.9 (-97.5%) | 71.02 | 3464.7 | 113.75 | 3978.2 |
| streams-create/streams-create-flat | 88.6 | 91.07 | +2.5 (+2.8%) | 107.76 | 97.34 | 200.32 | 208.63 |
| streams-create/streams-create-nested | 59.13 | 61.27 | +2.1 (+3.6%) | 166.41 | 154.61 | 272.07 | 265.99 |
| streams-update/streams-update | 43.07 | 38.93 | -4.1 (-9.6%) | 228.23 | 234.64 | 345.54 | 454.27 |

## Summary

- **Average throughput change:** -9.9%
- **Faster in B:** 9/18 sub-scenarios
- **Slower in B:** 9/18 sub-scenarios

## Storage

| Engine | Growth A | Growth B | Delta |
|--------|----------|----------|-------|
| mongodb | 39.7MB | 350.3KB | -39.4MB |
| sqlite | 104.6KB | 152.9KB | +48.3KB |
| influxdb | 462.0B | 0B | -462.0B |
| userDirs | 44.7MB | 148.0MB | +103.3MB |
| syslogSize | 28.7MB | 69.2MB | +40.5MB |
| syslogLines | +95343 | +182057 | +86714 |

## Notes

_Add observations here._
