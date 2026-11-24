/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * Bench (not part of the test matrix): cost of the PostgreSQL audit storage's
 * refusal of records of an unindexed user id (`refuseUnindexedUsers`).
 *
 * Measures audit record inserts, refusal on and off in alternating rounds, one
 * by one, and with concurrent writers on the same account (they lock the same
 * users index entry). Reports medians and the slowdown.
 *
 * Run from components/api-server, PostgreSQL engine, test database:
 *   STORAGE_ENGINE=postgresql NODE_ENV=test npx mocha --no-config --exit \
 *     --require test-helpers/src/helpers-c.ts --timeout 0 test/bench/pg-audit-unindexed.bench.js
 * Knobs: BENCH_ROWS (records per round, 1000), BENCH_ROUNDS (rounds per side,
 * 10), BENCH_WRITERS (concurrent writers, 5).
 */

/* global initTests, initCore, getNewFixture */

import cuid from 'cuid';
import * as storages from 'storages';

const ROWS = Number(process.env.BENCH_ROWS || 1000);
const ROUNDS = Number(process.env.BENCH_ROUNDS || 10);
const WRITERS = Number(process.env.BENCH_WRITERS || 5);

function median (values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe('[AGPB] bench: PostgreSQL audit records, refusal of unindexed users', function () {
  let storage, fixtures, userId;

  before(async function () {
    if (process.env.STORAGE_ENGINE !== 'postgresql') return this.skip();
    await initTests();
    await initCore();
    storage = storages.auditStorage;
    if (typeof storage.refuseUnindexedUsers !== 'function') return this.skip();
    fixtures = getNewFixture();
    userId = (await fixtures.user('agpb' + cuid.slug().toLowerCase())).attrs.id;
  });

  after(async function () {
    if (storage?.refuseUnindexedUsers == null) return;
    storage.refuseUnindexedUsers(true);
    await storage.deleteUser(userId);
    await fixtures?.clean();
  });

  function event () {
    return {
      id: cuid(),
      streamIds: [':_audit:access-a', ':_audit:action-events.get'],
      type: 'audit-log/pryv-api',
      time: 1,
      endTime: 1,
      created: 1,
      createdBy: 'system',
      modified: 1,
      modifiedBy: 'system',
      trashed: false,
      content: { action: 'events.get', source: { name: 'http', ip: '127.0.0.1' }, query: { streams: ['a', 'b'] }, recordCount: 12 }
    };
  }

  async function round (writers) {
    const db = await storage.forUser(userId);
    const start = process.hrtime.bigint();
    await Promise.all(Array.from({ length: writers }, async () => {
      for (let i = 0; i < ROWS / writers; i++) await db.createEvent(event());
    }));
    return Number(process.hrtime.bigint() - start) / 1e3 / ROWS;
  }

  for (const writers of [1, WRITERS]) {
    it(`[AGPB${writers}] ${writers} writer(s)`, async function () {
      const us = { off: [], on: [] };
      await round(writers); // warm up
      for (let i = 0; i < ROUNDS; i++) {
        for (const side of i % 2 === 0 ? ['off', 'on'] : ['on', 'off']) {
          storage.refuseUnindexedUsers(side === 'on');
          us[side].push(await round(writers));
        }
      }
      const off = median(us.off); const on = median(us.on);
      console.log(`AGPB ${writers} writer(s): off ${off.toFixed(1)} us, on ${on.toFixed(1)} us per record, ${((on / off - 1) * 100).toFixed(1)} %`);
    });
  }
});
