/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
/* global initTests, initCore, getNewFixture, coreRequest, assert */

const path = require('path');
const { spawnSync } = require('child_process');
const { childStorageEngineEnv } = require('test-helpers');
const cuid = require('cuid');
const { getMall } = require('mall');
const { integrity } = require('business');

const CLI = path.resolve(__dirname, '../../../bin/events-stamp-backfill.js');
const STAMPS = ['created', 'createdBy', 'modified', 'modifiedBy'];

/**
 * [SBFT] bin/events-stamp-backfill.js fills the tracking properties of events
 * stored without them; deleted rows and version rows are left as they are.
 */
describe('[SBFT] bin/events-stamp-backfill.js', function () {
  this.timeout(120000);
  let fixtures, mall, username, token, streamId;
  const ids = { raw: cuid(), partial: cuid(), full: cuid(), deleted: cuid(), trashed: cuid(), version: cuid() };
  const T0 = 1700000000;
  const FULL = { created: 1500, createdBy: 'a-full', modified: 1600, modifiedBy: 'a-full' };
  let fullBefore;

  function runCli (args) {
    const res = spawnSync('node', [CLI, '--user', username, ...args], {
      cwd: path.resolve(__dirname, '../../../'),
      env: { ...process.env, ...childStorageEngineEnv() },
      encoding: 'utf8',
      timeout: 60000
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    return res.stdout;
  }

  // The row as the store holds it (what the integrity check reads).
  async function storedRow (id) {
    return await mall.events.eventsStores.get('local').getOne(username, id);
  }

  function assertIntegrity (row, label) {
    if (!integrity.events.isActive) return;
    assert.strictEqual(row.integrity, integrity.events.compute({ ...row }).integrity, label + ': integrity matches the row');
  }

  before(async function () {
    await initTests();
    await initCore();
    mall = await getMall();
    fixtures = getNewFixture();
    username = 'sbf' + cuid.slug().toLowerCase();
    token = cuid();
    streamId = 'sbf-' + cuid.slug();
    const user = await fixtures.user(username);
    await user.access({ token, type: 'personal' });
    await user.session(token);
    await user.stream({ id: streamId, name: 'backfill' });
    const base = { streamIds: [streamId], type: 'note/txt' };
    // Raw loads keep what they are given, as the rows the earlier server wrote.
    await mall.events.create(username, { ...base, id: ids.raw, content: 'raw', time: T0 }, null, true);
    await mall.events.create(username, { ...base, id: ids.partial, content: 'partial', time: T0 + 1, created: 1000, createdBy: 'a-partial', modified: 1100 }, null, true);
    await mall.events.create(username, { ...base, id: ids.full, content: 'full', time: T0 + 2, ...FULL }, null, true);
    await mall.events.create(username, { ...base, id: ids.trashed, content: 'trashed', time: T0 + 3, trashed: true }, null, true);
    // A version row of the raw event, as history keeps it (hashed under the head's id).
    const version = { ...base, content: 'raw v0', time: T0 };
    const versionIntegrity = integrity.events.compute({ ...version, id: ids.raw }).integrity;
    await mall.events.create(username, { ...version, id: ids.version, headId: ids.raw, integrity: versionIntegrity }, null, true);
    // Deleted under the default mode: the stamps are cleared on purpose.
    await mall.events.create(username, { ...base, id: ids.deleted, content: 'deleted', time: T0 + 4 }, null, true);
    await mall.events.delete(username, await mall.events.getOne(username, ids.deleted));
    fullBefore = await storedRow(ids.full);
  });

  after(async function () {
    await fixtures.clean();
  });

  // The repair run happens once, in whichever test needs it first, so every
  // test also passes when selected on its own.
  let repair = null;
  function repairOnce () {
    if (repair == null) {
      const runStart = Date.now() / 1000;
      const out = runCli([]);
      repair = { runStart, out, runEnd: Date.now() / 1000 };
    }
    return repair;
  }

  it('[SBF1] a dry run counts the head rows to repair and the version rows, and writes nothing', async function () {
    const out = runCli(['--dry-run']);
    assert.match(out, /DRY-RUN/);
    assert.match(out, /events rewritten\s+3 \(would be\)/);
    assert.match(out, /version rows with NULL stamps \(not rewritten\)\s+1/);
    for (const id of [ids.raw, ids.trashed]) {
      const row = await storedRow(id);
      for (const f of STAMPS) assert.strictEqual(row[f], undefined, id + ': ' + f + ' still absent');
    }
    assert.strictEqual((await storedRow(ids.partial)).modifiedBy, undefined);
  });

  it('[SBF2] a run fills the missing stamps, sets modified to the run time, recomputes integrity, leaves the rest', async function () {
    const { runStart, out, runEnd } = repairOnce();
    assert.match(out, /events rewritten\s+3(?! \(would be\))/);

    const raw = await storedRow(ids.raw);
    assert.strictEqual(raw.created, T0, 'raw: created is the event time');
    assert.strictEqual(raw.createdBy, 'system');
    assert.ok(raw.modified >= runStart && raw.modified <= runEnd, 'raw: modified is the run time');
    assert.strictEqual(raw.modifiedBy, 'system');
    assertIntegrity(raw, 'raw');

    const partial = await storedRow(ids.partial);
    assert.strictEqual(partial.created, 1000, 'partial: created is kept');
    assert.strictEqual(partial.createdBy, 'a-partial', 'partial: createdBy is kept');
    assert.ok(partial.modified >= runStart, 'partial: modified is the run time');
    assert.strictEqual(partial.modifiedBy, 'system');
    assertIntegrity(partial, 'partial');

    const trashed = await storedRow(ids.trashed);
    assert.strictEqual(trashed.trashed, true);
    assert.strictEqual(trashed.created, T0 + 3);
    assert.strictEqual(trashed.modifiedBy, 'system');
    assertIntegrity(trashed, 'trashed');

    const full = await storedRow(ids.full);
    assert.strictEqual(full.modified, FULL.modified, 'full: untouched');
    assert.strictEqual(full.integrity, fullBefore.integrity, 'full: integrity untouched');

    const deleted = await mall.events.getOne(username, ids.deleted);
    assert.strictEqual(typeof deleted.deleted, 'number');
    for (const f of STAMPS) assert.strictEqual(deleted[f], undefined, 'deleted: ' + f + ' stays cleared');

    const history = await mall.events.getHistory(username, ids.raw);
    assert.strictEqual(history.length, 1, 'no version row added');
    for (const f of STAMPS) assert.strictEqual(history[0][f], undefined, 'version row: ' + f + ' left as written');
  });

  it('[SBF3] modifiedSince returns exactly the repaired events; a re-run finds nothing left', async function () {
    const { runStart } = repairOnce();
    const res = await coreRequest.get('/' + username + '/events').set('Authorization', token)
      .query({ streams: JSON.stringify([streamId]), state: 'all', modifiedSince: runStart });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.events.map((e) => e.id).sort(), [ids.raw, ids.partial, ids.trashed].sort());
    const out = runCli([]);
    assert.match(out, /events rewritten\s+0/);
    assert.match(out, /version rows with NULL stamps \(not rewritten\)\s+1/);
  });
});
