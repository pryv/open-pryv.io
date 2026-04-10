/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: event retrieval
 * GET /{username}/events with various filters.
 * Runs sub-scenarios with both master and restricted tokens.
 */
export async function run (config, seedData) {
  const runs = [];

  const subScenarios = [
    {
      name: 'no-filter',
      query: '?limit=100'
    },
    {
      name: 'stream-parent',
      // use a parent stream that has children — forces recursive child lookup
      query: (user, authMode) => {
        if (authMode === 'restricted') {
          // use a stream the restricted token can access
          const stream = user.restrictedStreams?.[0] || user.streams[0];
          return `?streams[]=${stream}&limit=100`;
        }
        const parentStream = user.parentStreams?.[0] || user.streams[0];
        return `?streams[]=${parentStream}&limit=100`;
      }
    },
    {
      name: 'time-range',
      query: (user) => {
        // last 30 days from seed time
        const now = user.seedTime || (Date.now() / 1000);
        const from = now - (30 * 24 * 3600);
        return `?fromTime=${from}&toTime=${now}&limit=100`;
      }
    }
  ];

  for (const sub of subScenarios) {
    for (const authMode of ['master', 'restricted']) {
      const label = `${sub.name}-${authMode}`;
      console.log(`  Running events-get [${label}]...`);

      const results = await runConcurrent(
        async (idx) => {
          const user = seedData.users[idx % seedData.users.length];
          const token = authMode === 'master' ? user.masterToken : user.restrictedToken;
          const client = new Client(config.target, token);

          const query = typeof sub.query === 'function' ? sub.query(user, authMode) : sub.query;
          const res = await client.get(`/${user.username}/events${query}`);

          return {
            elapsed: res.elapsed,
            error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`,
            eventCount: res.body?.events?.length || 0
          };
        },
        { concurrency: config.concurrency, durationMs: config.duration * 1000 }
      );

      runs.push({
        subScenario: label,
        results,
        extra: { authMode, filter: sub.name }
      });
    }
  }

  return runs;
}
