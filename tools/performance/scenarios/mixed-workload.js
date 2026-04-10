/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: mixed realistic workload
 * 60% event reads, 30% event creates, 5% stream creates, 5% stream updates.
 * Uses master token, multiple concurrent users.
 */
export async function run (config, seedData) {
  console.log('  Running mixed-workload...');

  const results = await runConcurrent(
    async (idx) => {
      const user = seedData.users[idx % seedData.users.length];
      const client = new Client(config.target, user.masterToken);

      // weighted random operation
      const roll = Math.random() * 100;
      let op;

      if (roll < 60) {
        // 60% — event reads
        op = 'events-get';
        const res = await client.get(`/${user.username}/events?limit=50`);
        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}`,
          op
        };
      } else if (roll < 90) {
        // 30% — event creates
        op = 'events-create';
        const streamId = user.streams[idx % user.streams.length];
        const res = await client.post(`/${user.username}/events`, {
          type: 'note/txt',
          streamIds: [streamId],
          content: `Mixed workload event ${idx}`
        });
        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}`,
          op
        };
      } else if (roll < 95) {
        // 5% — stream creates
        op = 'streams-create';
        const res = await client.post(`/${user.username}/streams`, {
          id: `bench-mixed-${idx}-${Date.now()}`,
          name: `Mixed stream ${idx}`
        });
        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}`,
          op
        };
      } else {
        // 5% — stream updates
        op = 'streams-update';
        const streamId = user.streams[idx % user.streams.length];
        const res = await client.put(`/${user.username}/streams/${streamId}`, {
          name: `Mixed update ${idx}`
        });
        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}`,
          op
        };
      }
    },
    { concurrency: config.concurrency, durationMs: config.duration * 1000 }
  );

  return { subScenario: 'mixed-workload', results };
}
