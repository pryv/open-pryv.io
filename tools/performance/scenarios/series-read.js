/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: HF series read
 * GET /{username}/events/{eventId}/series with varying time ranges.
 * Seeded with 100K points at 1-second intervals.
 * Real-world devices can output at 41kHz — test with larger datasets when needed.
 */
export async function run (config, seedData) {
  const runs = [];

  // sub-scenarios: read different sized ranges from the 100K seeded points
  // points are at 1-second intervals, so range in seconds = number of points
  const ranges = [
    { name: '1k-points', seconds: 1000 },
    { name: '10k-points', seconds: 10000 },
    { name: '100k-points', seconds: 100000 }
  ];

  for (const range of ranges) {
    console.log(`  Running series-read [${range.name}]...`);

    const results = await runConcurrent(
      async (idx) => {
        const user = seedData.users[idx % seedData.users.length];
        const client = new Client(config.hfsTarget, user.masterToken);

        if (!user.seriesEventIds || user.seriesEventIds.length === 0) {
          return { elapsed: 0, error: 'no series events seeded' };
        }

        const eventId = user.seriesEventIds[idx % user.seriesEventIds.length];
        const now = Math.floor(Date.now() / 1000);
        const from = now - range.seconds;

        const res = await client.get(
          `/${user.username}/events/${eventId}/series?fromDeltaTime=${from}&toDeltaTime=${now}`
        );

        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`,
          pointCount: res.body?.points?.length || 0
        };
      },
      { concurrency: config.concurrency, durationMs: config.duration * 1000 }
    );

    runs.push({
      subScenario: `series-read-${range.name}`,
      results,
      extra: { range: range.name, rangeSeconds: range.seconds }
    });
  }

  return runs;
}
