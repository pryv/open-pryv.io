/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: HF series write
 * POST /{username}/events/{eventId}/series with data points.
 * Varies batch size.
 */
export async function run (config, seedData) {
  const runs = [];
  const batchSizes = [10, 100, 1000];

  for (const batchSize of batchSizes) {
    console.log(`  Running series-write [batch=${batchSize}]...`);

    const results = await runConcurrent(
      async (idx) => {
        const user = seedData.users[idx % seedData.users.length];
        const client = new Client(config.hfsTarget, user.masterToken);

        if (!user.seriesEventIds || user.seriesEventIds.length === 0) {
          return { elapsed: 0, error: 'no series events seeded' };
        }

        const eventId = user.seriesEventIds[idx % user.seriesEventIds.length];
        const baseTime = Math.floor(Date.now() / 1000) + idx * batchSize;

        // generate flatJSON data points
        const points = [];
        for (let i = 0; i < batchSize; i++) {
          points.push([baseTime + i, +(Math.random() * 100).toFixed(2)]);
        }

        const res = await client.post(`/${user.username}/events/${eventId}/series`, {
          format: 'flatJSON',
          fields: ['deltaTime', 'value'],
          points
        });

        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`,
          pointsWritten: res.ok ? batchSize : 0
        };
      },
      { concurrency: config.concurrency, durationMs: config.duration * 1000 }
    );

    runs.push({
      subScenario: `series-write-batch${batchSize}`,
      results,
      extra: { batchSize }
    });
  }

  return runs;
}
