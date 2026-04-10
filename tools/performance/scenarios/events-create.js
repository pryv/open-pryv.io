/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: event creation
 * POST /{username}/events with note/txt events.
 * Runs with both master and restricted tokens.
 */
export async function run (config, seedData) {
  const runs = [];

  for (const authMode of ['master', 'restricted']) {
    console.log(`  Running events-create [${authMode}]...`);

    const results = await runConcurrent(
      async (idx) => {
        // round-robin across users
        const user = seedData.users[idx % seedData.users.length];
        const token = authMode === 'master' ? user.masterToken : user.restrictedToken;
        const client = new Client(config.target, token);

        // pick a stream the token has access to
        const streamId = authMode === 'master'
          ? user.streams[idx % user.streams.length]
          : user.restrictedStreams[idx % user.restrictedStreams.length];

        const res = await client.post(`/${user.username}/events`, {
          type: 'note/txt',
          streamIds: [streamId],
          content: `Benchmark event ${idx} - ${Date.now()}`
        });

        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`
        };
      },
      { concurrency: config.concurrency, durationMs: config.duration * 1000 }
    );

    runs.push({
      subScenario: `events-create-${authMode}`,
      results,
      extra: { authMode }
    });
  }

  return runs;
}
