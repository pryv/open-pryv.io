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
const { databaseFixture, childStorageEngineEnv } = require('test-helpers');
const { getMall } = require('mall');
const business = require('business');
const { integrity } = business;
const { DataMatrix } = require('business/src/series/data_matrix.ts');
const { seriesNamespace } = require('business/src/series/namespace.ts');
const { FUTURE_MARGIN_S, isCandidate, classify, repairUserSeriesDurations } = require('../../src/duration_repair.ts');

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
    // F ends three days from now (not from T, which is fixed): a candidate whatever the date of the run.
    const durationF = Math.ceil(Date.now() / 1000 - T) + 3 * 86400;
    await user.event({ id: ids.F, type: 'series:mass/kg', streamIds: [streamId], time: T, duration: durationF });
    await appendPoints(ids.F, [0, durationF * 1e9]);
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
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...childStorageEngineEnv() },
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

/**
 * [HFOV] The durations the old writer inflated from more than a few seconds
 * of data are beyond the range a series engine stores deltaTimes in (64-bit
 * integer nanoseconds). The tool checks and repairs them without querying the
 * series with such a bound, and one failing event does not stop the run.
 */
describe('[HFOV] hfs-duration-repair tool: durations beyond the series range', function () {
  this.timeout(120_000);
  const T = 1791362385;
  // extent (s) of each planted series: its inflated duration is extent * 1e9
  //   M: 50 s   -> 5e10 s, in nanoseconds beyond the 64-bit integer range
  //   L: 7140 s -> 7.14e12 s, in nanoseconds only printable in exponent form
  //   X: 2e4 s  -> 2e13 s, beyond the range of a date
  const extents = { M: 50, L: 7140, X: 20000 };
  // L is the latest, so the first one checked (as in the reported failure)
  const times = { M: T + 1, L: T + 2, X: T };
  let pryv, mall, userId, streamId;
  const ids = {};
  let planted = {};

  async function readAll () {
    const out = {};
    for (const [key, id] of Object.entries(ids)) out[key] = await mall.events.getOne(userId, id);
    return out;
  }

  function runTool (...args) {
    return execFileSync(process.execPath, ['bin/hfs-duration-repair.js', '--user', userId, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test', ...childStorageEngineEnv() },
      encoding: 'utf8'
    });
  }

  before(async function () {
    const database = await produceStorageConnection();
    pryv = databaseFixture(database);
    mall = await getMall();
    userId = cuid();
    streamId = cuid();
    const user = await pryv.user(userId, {});
    await user.stream({ id: streamId });
    const repo = new business.series.Repository(await produceSeriesConnection());
    for (const [key, extent] of Object.entries(extents)) {
      ids[key] = cuid();
      await user.event({ id: ids[key], type: 'series:mass/kg', streamIds: [streamId], time: times[key], duration: extent * 1e9 });
      const series = await repo.get(seriesNamespace(userId), 'event.' + ids[key]);
      await series.append(new DataMatrix(['deltaTime', 'value'], [[0, 1], [extent * 1e9, 2]]));
    }
    planted = await readAll();
  });

  after(async function () {
    await pryv.clean();
  });

  it('[HFOV1] a dry run checks them without error and writes nothing', async function () {
    const out = runTool('--dry-run');
    assert.match(out, /candidates\s+3\b/);
    assert.match(out, /repaired\s+3 \(would be\)\s+\[confirmed exact 3, series grew since 0\]/);
    assert.match(out, /check or write failed, skipped\s+0\b/);
    assert.deepStrictEqual(await readAll(), planted);
  });

  it('[HFOV2] the repair sets each to its extent in seconds', async function () {
    const out = runTool();
    assert.match(out, /repaired\s+3\s+\[confirmed exact 3, series grew since 0\]/);
    assert.match(out, /check or write failed, skipped\s+0\b/);
    const after = await readAll();
    for (const [key, extent] of Object.entries(extents)) {
      assert.strictEqual(after[key].duration, extent, key);
      if (integrity.events.isActive) assert.strictEqual(integrity.events.compute(after[key]).integrity, after[key].integrity, key + ' integrity verifies');
    }
  });

  it('[HFOV3] a series query with a bound beyond the stored range answers, on every series engine', async function () {
    const repo = new business.series.Repository(await produceSeriesConnection());
    const series = await repo.get(seriesNamespace(userId), 'event.' + ids.L);
    const count = async (query) => { let n = 0; (await series.query(query)).eachRow(() => n++); return n; };
    assert.strictEqual(await count({ from: 5e10 }), 0, 'from beyond the range: no point');
    assert.strictEqual(await count({ from: 1, to: 5e10 }), 1, 'to beyond the range: no upper bound');
    assert.strictEqual(await count({ from: 1, to: 2e13 }), 1, 'to beyond the range of a date: no upper bound');
    assert.strictEqual(await count({ from: -5e10, to: 5e10 }), 2, 'both beyond the range: every point');
    assert.strictEqual(await count({ from: -6e10, to: -5e10 }), 0, 'to under the range: no point');
  });

  it('[HFOV4] an event whose check fails is listed with the error kind only; the others are still repaired', async function () {
    const leaked = '7.139999999999999e+21';
    const events = [
      { id: 'bad', type: 'series:mass/kg', time: T, duration: 1e9 },
      { id: 'good', type: 'series:mass/kg', time: T, duration: 1e9 }
    ];
    const written = [];
    const fakeMall = {
      events: {
        get: async () => events,
        updateWithMerge: async (uid, id, merge) => { written.push(id); return merge({ ...events.find((e) => e.id === id) }); }
      }
    };
    const fakeRepo = {
      get: async (namespace, name) => ({
        query: async () => {
          if (name === 'event.bad') throw Object.assign(new Error('invalid input syntax for type bigint: "' + leaked + '"'), { code: '22P02' });
          return new DataMatrix(['deltaTime', 'value'], [[0, 1], [1, 2]]);
        }
      })
    };
    for (const dryRun of [true, false]) {
      written.length = 0;
      const r = await repairUserSeriesDurations({
        mall: fakeMall, seriesRepo: fakeRepo, seriesNamespace: 'ns', userId: 'u', username: 'u', now: T, dryRun
      });
      assert.strictEqual(r.candidates, 2);
      assert.strictEqual(r.repaired, 1, 'dryRun ' + dryRun);
      assert.deepStrictEqual(r.failed, ['u/bad (Error 22P02)']);
      assert.ok(!JSON.stringify(r).includes(leaked), 'no data value in the result');
      assert.deepStrictEqual(written, dryRun ? [] : ['good']);
    }
  });
});
