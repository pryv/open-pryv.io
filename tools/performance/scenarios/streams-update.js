/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: stream update
 * PUT /{username}/streams/:id — rename streams.
 */
export async function run (config, seedData) {
  console.log('  Running streams-update...');

  const results = await runConcurrent(
    async (idx) => {
      const user = seedData.users[idx % seedData.users.length];
      const client = new Client(config.target, user.masterToken);

      // cycle through streams to update
      const streamId = user.streams[idx % user.streams.length];

      const res = await client.put(`/${user.username}/streams/${streamId}`, {
        name: `Updated ${streamId} ${idx}`
      });

      return {
        elapsed: res.elapsed,
        error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`
      };
    },
    { concurrency: config.concurrency, durationMs: config.duration * 1000 }
  );

  return { subScenario: 'streams-update', results };
}
