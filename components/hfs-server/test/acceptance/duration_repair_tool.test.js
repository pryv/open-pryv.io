/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const cuid = require('cuid');
const { produceStorageConnection, produceSeriesConnection } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const { getMall } = require('mall');
const business = require('business');
const { integrity } = business;
const { DataMatrix } = require('business/src/series/data_matrix.ts');
const { seriesNamespace } = require('business/src/series/namespace.ts');
const { FUTURE_MARGIN_S, isCandidate, classify } = require('../../src/duration_repair.ts');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

/**
 * [HFDR] bin/hfs-duration-repair.js: series events whose duration holds a
 * nanosecond extent (written before the metadata flush converted it) are set
 * to the extent in seconds read from the series data; legitimate, unexplained
 * and non-series events are left alone; a dry run writes nothing.
 */
describe('[HFDR] hfs-duration-repair tool', function () {
  this.timeout(120_000);
  // A time whose lowest mantissa bit makes (T + 1e9) - T !== 1e9: the old hash does not verify.
  const T = 1791362385.939;
  let pryv, mall, userId, streamId;
  const ids = {};
  let planted = {};
  let afterRepair = {};

  async function appendPoints (eventId, deltaTimesNs) {
    const repo = new business.series.Repository(await produceSeriesConnection());
    const series = await repo.get(seriesNamespace(userId), 'event.' + eventId);
    await series.append(new DataMatrix(['deltaTime', 'value'], deltaTimesNs.map((d) => [d, 1])));
  }

  async function readAll () {
    const out = {};
    for (const [key, id] of Object.entries(ids)) out[key] = await mall.events.getOne(userId, id);
    return out;
  }

  before(async function () {
    const database = await produceStorageConnection();
    pryv = databaseFixture(database);
    mall = await getMall();
    userId = cuid();
    streamId = cuid();
    for (const key of ['A', 'B', 'G', 'F', 'U', 'C', 'N']) ids[key] = cuid();
    const user = await pryv.user(userId, {});
    await user.stream({ id: streamId });

    // A: planted the way the old flush left it, with the hash computed over the raw 1e9.
    const authorId = cuid();
    const a = {
      id: ids.A,
      type: 'series:mass/kg',
      streamIds: [streamId],
      time: T,
      duration: 1e9,
      created: T,
      createdBy: authorId,
      modified: T,
      modifiedBy: authorId
    };
    a.integrity = integrity.events.isActive ? integrity.events.hash({ ...a }) : undefined;
    await mall.events.create(userId, a, null, true);
    await appendPoints(ids.A, [0, 1e9]);

    await user.event({ id: ids.B, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: 1e8 });
    await appendPoints(ids.B, [0, 1e8]);
    await user.event({ id: ids.G, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: 1e9 });
    await appendPoints(ids.G, [0, 1e9, 3e9]);
    await user.event({ id: ids.F, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: 3 * 86400 });
    await appendPoints(ids.F, [0, 3 * 86400 * 1e9]);
    await user.event({ id: ids.U, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: 1e9 });
    // C: a client-set duration ending in the future, with data beyond the candidate extent but none at it.
    await user.event({ id: ids.C, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: 10 * 365 * 86400 });
    await appendPoints(ids.C, [0, 5e9]);
    await user.event({ id: ids.N, type: 'note/txt', content: 'n', streamIds: [streamId], time: T, duration: 1e9 });
    planted = await readAll();
  });

  after(async function () {
    await pryv.clean();
  });

  function runTool (...args) {
    return execFileSync(process.execPath, ['bin/hfs-duration-repair.js', '--user', userId, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
      encoding: 'utf8'
    });
  }

  function verifies (event) {
    return integrity.events.compute(event).integrity === event.integrity;
  }

  it('[HFDR1] a dry run reports the candidates and writes nothing', async function () {
    if (integrity.events.isActive) assert.ok(!verifies(planted.A), 'precondition: A carries an old hash that does not verify');
    const out = runTool('--dry-run');
    assert.match(out, /candidates\s+6\b/);
    assert.match(out, /repaired\s+3 \(would be\)/);
    assert.match(out, /data extends to the duration\s+1\b/);
    assert.match(out, /no series point at the extent\s+2\b/);
    assert.ok(out.includes(userId + '/' + ids.U), 'U is listed');
    assert.ok(out.includes(userId + '/' + ids.C), 'C is listed');
    assert.deepStrictEqual(await readAll(), planted);
  });

  it('[HFDR2] repairs the three inflated events from the series data, keeps the others', async function () {
    const out = runTool();
    assert.match(out, /repaired\s+3\s+\[confirmed exact 2, series grew since 1\]/);
    afterRepair = await readAll();
    assert.strictEqual(afterRepair.A.duration, 1);
    assert.strictEqual(afterRepair.G.duration, 3);
    assert.ok(Math.abs(afterRepair.B.duration - 0.1) < 1e-6, 'B: ' + afterRepair.B.duration);
    for (const key of ['A', 'B', 'G']) {
      const e = afterRepair[key];
      if (integrity.events.isActive) assert.ok(verifies(e), key + ' integrity verifies');
      assert.ok(e.modified > planted[key].modified, key + ' modified refreshed');
      assert.strictEqual(e.modifiedBy, planted[key].modifiedBy, key + ' modifiedBy kept');
    }
    for (const key of ['F', 'U', 'C', 'N']) assert.deepStrictEqual(afterRepair[key], planted[key], key + ' untouched');
  });

  it('[HFDR3] a re-run repairs nothing and changes nothing', async function () {
    const out = runTool();
    assert.match(out, /candidates\s+3\b/);
    assert.match(out, /repaired\s+0\b/);
    assert.match(out, /data extends to the duration\s+1\b/);
    assert.match(out, /no series point at the extent\s+2\b/);
    assert.deepStrictEqual(await readAll(), afterRepair);
  });

  it('[HFDR4] candidate and classification rules', function () {
    const now = 1791362385;
    const series = (over) => ({ id: 'x', type: 'series:mass/kg', time: now, duration: 1e9, ...over });
    assert.strictEqual(isCandidate(series({ duration: undefined }), now), false);
    assert.strictEqual(isCandidate(series({ duration: 0 }), now), false);
    assert.strictEqual(isCandidate(series({ duration: null }), now), false);
    assert.strictEqual(isCandidate(series({ type: 'note/txt' }), now), false);
    assert.strictEqual(isCandidate(series({ duration: FUTURE_MARGIN_S }), now), false);
    assert.strictEqual(isCandidate(series({ duration: FUTURE_MARGIN_S + 1 }), now), true);
    assert.strictEqual(isCandidate(series({ trashed: true }), now), true);

    const duration = 1e9;
    const c = duration / 1e9;
    assert.deepStrictEqual(classify(duration, null, false), { kind: 'unexplained' });
    assert.deepStrictEqual(classify(duration, duration - 5e-4, false), { kind: 'legit' });
    assert.deepStrictEqual(classify(duration, c, true), { kind: 'repair', duration: c, exact: true });
    assert.deepStrictEqual(classify(duration, c + 1, true), { kind: 'repair', duration: c + 1, exact: false });
    assert.deepStrictEqual(classify(duration, c - 2e-3, true), { kind: 'repair', duration: c - 2e-3, exact: false });
    // data beyond the candidate extent but no point at it: not the old writer's value
    assert.deepStrictEqual(classify(duration, c + 4, false), { kind: 'unexplained' });
  });
});
