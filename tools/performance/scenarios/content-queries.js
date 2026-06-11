/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { Client, runConcurrent } from '../lib/client.js';

/**
 * Benchmark: events.get content/clientData query conditions.
 *
 * Setup adds ~200 "assertion" events (structured content with nested
 * codes) per user — the needles. The seeded events are the haystack the
 * conditions must filter through, so latency tracks total account size.
 * Declaring `storages.contentIndexes` for `drug.codes.atc` (+ restart)
 * benchmarks the indexed path; without it, the scan path.
 */

const CODES = [];
for (let i = 1; i <= 8; i++) CODES.push('G03DA' + String(i).padStart(2, '0'));
for (let i = 1; i <= 8; i++) CODES.push('B01AC' + String(i).padStart(2, '0'));

const ASSERTIONS_PER_USER = 200;
const BENCH_STREAM = 'cq-bench';

async function ensureAssertionEvents (config, user) {
  const client = new Client(config.target, user.masterToken);
  // probe: already seeded? (idempotent re-runs)
  const probe = await client.get(`/${user.username}/events?streams=["${BENCH_STREAM}"]&limit=1`);
  if (probe.ok && probe.body.events?.length > 0) return;

  const calls = [{ method: 'streams.create', params: { id: BENCH_STREAM, name: 'Content-query bench' } }];
  for (let i = 0; i < ASSERTIONS_PER_USER; i++) {
    calls.push({
      method: 'events.create',
      params: {
        streamIds: [BENCH_STREAM],
        type: 'bench/exposure-assertion-v1',
        content: {
          drug: { label: 'Bench drug ' + i, codes: { atc: CODES[i % CODES.length] } },
          taken: i % 2 === 0,
          scope: i % 5
        }
      }
    });
  }
  const res = await client.post(`/${user.username}`, calls);
  if (!res.ok) throw new Error('content-queries setup failed: HTTP ' + res.status);
}

export async function run (config, seedData) {
  for (const user of seedData.users) {
    await ensureAssertionEvents(config, user);
  }

  const subScenarios = [
    {
      name: 'eq-nested',
      conditions: (idx) => [{ path: 'drug.codes.atc', eq: CODES[idx % CODES.length] }]
    },
    {
      name: 'in-16-and-eq', // HDS checklist-prefill shape
      conditions: () => [{ path: 'drug.codes.atc', in: CODES }, { path: 'taken', eq: true }]
    },
    {
      name: 'prefix-class',
      conditions: () => [{ path: 'drug.codes.atc', prefix: 'G03DA' }]
    },
    {
      name: 'range-scope',
      conditions: () => [{ path: 'scope', gte: 3 }]
    }
  ];

  const runs = [];
  for (const subScenario of subScenarios) {
    console.log(`  Running content-queries [${subScenario.name}]...`);
    const results = await runConcurrent(
      async (idx) => {
        const user = seedData.users[idx % seedData.users.length];
        const client = new Client(config.target, user.masterToken);
        const content = encodeURIComponent(JSON.stringify(subScenario.conditions(idx)));
        const res = await client.get(`/${user.username}/events?content=${content}&limit=100`);
        return {
          elapsed: res.elapsed,
          error: res.ok ? null : `HTTP ${res.status}: ${res.body?.error?.message || 'unknown'}`
        };
      },
      { concurrency: config.concurrency, durationMs: config.duration * 1000 }
    );
    runs.push({ subScenario: `content-queries-${subScenario.name}`, results, extra: {} });
  }
  return runs;
}
