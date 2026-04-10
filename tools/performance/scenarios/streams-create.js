/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: stream creation
 * POST /{username}/streams — flat and nested.
 * Uses master token only (stream creation requires broad permissions).
 */
export async function run (config, seedData) {
  const runs = [];

  for (const mode of ['flat', 'nested']) {
    console.log(`  Running streams-create [${mode}]...`);

    let parentCounter = 0;

    const results = await runConcurrent(
      async (idx) => {
        const user = seedData.users[idx % seedData.users.length];
        const client = new Client(config.target, user.masterToken);

        const streamId = `bench-stream-${mode}-${idx}-${Date.now()}`;
        const data = {
          id: streamId,
          name: `Benchmark ${mode} ${idx}`
        };

        if (mode === 'nested') {
          // create under a parent — reuse existing parent streams
          const parentStream = user.parentStreams?.[parentCounter % (user.parentStreams?.length || 1)] ||
            user.streams[0];
          data.parentId = parentStream;
          parentCounter++;
        }

        const res = await client.post(`/${user.username}/streams`, data);

        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`
        };
      },
      { concurrency: config.concurrency, durationMs: config.duration * 1000 }
    );

    runs.push({
      subScenario: `streams-create-${mode}`,
      results,
      extra: { mode }
    });
  }

  return runs;
}
