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
const { produceStorageConnection } = require('./test-helpers');
const { databaseFixture } = require('test-helpers');
const { getMall } = require('mall');
const storage = require('storage');
const { fromCallback } = require('utils');
const { getPlatform } = require('platform');
const { getAccessIndex } = require('platform/src/accessIndex.ts');
const { integrity } = require('business');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

/**
 * [HAST] bin/hfs-author-scrub.js: a series event whose modifiedBy holds an
 * access token is rewritten to the access id; with --revoke the access is
 * deleted; a dry run writes nothing.
 */
describe('[HAST] hfs-author-scrub tool', function () {
  this.timeout(120_000);
  let pryv, mall, storageLayer;
  let userId, streamId, eventId, accessId, accessToken, cleanEventId, webhookId;

  before(async function () {
    const database = await produceStorageConnection();
    pryv = databaseFixture(database);
    mall = await getMall();
    storageLayer = await storage.getStorageLayer();
    userId = cuid();
    streamId = cuid();
    eventId = cuid();
    cleanEventId = cuid();
    accessId = cuid();
    accessToken = cuid();
    webhookId = cuid();
    const user = await pryv.user(userId, {});
    await user.stream({ id: streamId });
    await user.access({ id: accessId, token: accessToken, type: 'personal' });
    await user.session(accessToken);
    await user.webhook({ id: webhookId }, accessId);
    await user.event({ id: eventId, type: 'series:mass/kg', streamIds: [streamId], modifiedBy: accessToken + ' caller-x' });
    await user.event({ id: cleanEventId, type: 'note/txt', content: 'x', streamIds: [streamId], modifiedBy: accessId });
  });

  after(async function () {
    await pryv.clean();
  });

  function runTool (...args) {
    return execFileSync(process.execPath, ['bin/hfs-author-scrub.js', '--user', userId, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
      encoding: 'utf8'
    });
  }

  async function liveAccessIds () {
    const live = await fromCallback((cb) => storageLayer.accesses.find({ id: userId }, {}, null, cb));
    return live.map((a) => a.id);
  }

  it('[HAST1] a dry run reports the event and the access, and writes nothing', async function () {
    const out = runTool('--dry-run');
    assert.match(out, /events rewritten\s+1 \(would be\)/);
    assert.match(out, new RegExp('access ' + accessId + ' \\(personal, live\\)'));
    assert.ok(!out.includes(accessToken), 'the token is never printed');
    assert.strictEqual((await mall.events.getOne(userId, eventId)).modifiedBy, accessToken + ' caller-x');
  });

  it('[HAST2] rewrites the token to the access id and keeps the caller id; other events untouched', async function () {
    const out = runTool();
    assert.match(out, /events rewritten\s+1/);
    assert.strictEqual((await mall.events.getOne(userId, eventId)).modifiedBy, accessId + ' caller-x');
    assert.strictEqual((await mall.events.getOne(userId, cleanEventId)).modifiedBy, accessId);
    assert.ok((await liveAccessIds()).includes(accessId), 'without --revoke the access stays');
  });

  it('[HAST3] a re-run finds nothing left to rewrite, so even --revoke revokes nothing', async function () {
    const out = runTool('--revoke');
    assert.match(out, /events rewritten\s+0/);
    assert.ok((await liveAccessIds()).includes(accessId), 'nothing left to match, nothing revoked');
  });

  it('[HAST4] --revoke deletes the access like accesses.delete: session, webhooks, index row marked deleted', async function () {
    await mall.events.update(userId, { ...(await mall.events.getOne(userId, eventId)), modifiedBy: accessToken }, null, { skipVersioning: true });
    const webhooksBefore = await fromCallback((cb) => storageLayer.webhooks.find({ id: userId }, { accessId }, null, cb));
    assert.deepStrictEqual(webhooksBefore.map((w) => w.id), [webhookId], 'fixture: the access owns a webhook');
    const out = runTool('--revoke');
    assert.match(out, /accesses revoked\s+1/);
    assert.ok(!(await liveAccessIds()).includes(accessId), 'the access is deleted');
    const session = await fromCallback((cb) => storageLayer.sessions.get(accessToken, cb));
    assert.strictEqual(session, null, 'the session is closed');
    assert.strictEqual((await mall.events.getOne(userId, eventId)).modifiedBy, accessId);
    const webhooksAfter = await fromCallback((cb) => storageLayer.webhooks.find({ id: userId }, { accessId }, null, cb));
    assert.deepStrictEqual(webhooksAfter, [], 'the webhooks of the access are deleted');
    const entry = await getAccessIndex(await getPlatform(), accessId);
    assert.ok(entry != null && typeof entry.deleted === 'number', 'the access index row is kept and marked deleted');
  });
});

/**
 * [HASP] bin/hfs-author-scrub.js: trashed events and deleted events that kept
 * their `modifiedBy` are found and rewritten too, and a scan over more rows
 * than one page finds every one of them.
 */
describe('[HASP] hfs-author-scrub tool: trashed, deleted and paged rows', function () {
  this.timeout(120_000);
  let pryv, mall;
  let userId, accessId, accessToken, trashedId, deletedId, wipedId;
  const liveIds = [];
  const cleanIds = [];

  before(async function () {
    const database = await produceStorageConnection();
    pryv = databaseFixture(database);
    mall = await getMall();
    userId = cuid();
    const streamId = cuid();
    accessId = cuid();
    accessToken = cuid();
    trashedId = cuid();
    deletedId = cuid();
    wipedId = cuid();
    const user = await pryv.user(userId, {});
    await user.stream({ id: streamId });
    await user.access({ id: accessId, token: accessToken, type: 'personal' });
    for (let i = 0; i < 5; i++) {
      const id = cuid();
      liveIds.push(id);
      await user.event({ id, type: 'series:mass/kg', streamIds: [streamId], modifiedBy: accessToken });
    }
    for (let i = 0; i < 3; i++) {
      const id = cuid();
      cleanIds.push(id);
      await user.event({ id, type: 'note/txt', content: 'x', streamIds: [streamId], modifiedBy: accessId });
    }
    await user.event({ id: trashedId, type: 'series:mass/kg', streamIds: [streamId], trashed: true, modifiedBy: accessToken + ' caller-t' });

    // A deletion under the default mode (keep-nothing) clears modifiedBy.
    await user.event({ id: wipedId, type: 'series:mass/kg', streamIds: [streamId], modifiedBy: accessToken });
    await mall.events.delete(userId, await mall.events.getOne(userId, wipedId));

    // A deletion under keep-authors or keep-everything keeps modifiedBy in the
    // remaining row: deleted, then the author written back as such a mode leaves it.
    await user.event({ id: deletedId, type: 'series:mass/kg', streamIds: [streamId], modifiedBy: accessToken });
    await mall.events.delete(userId, await mall.events.getOne(userId, deletedId));
    const tombstone = await mall.events.getOne(userId, deletedId);
    await mall.events.update(userId, { ...tombstone, modified: tombstone.deleted, modifiedBy: accessToken + ' caller-d' }, null, { skipVersioning: true });
  });

  after(async function () {
    await pryv.clean();
  });

  function runTool (...args) {
    return execFileSync(process.execPath, ['bin/hfs-author-scrub.js', '--user', userId, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  // Checked on the row as the store holds it, like the integrity check does.
  async function assertIntegrity (eventId, what) {
    if (!integrity.events.isActive) return;
    const row = await mall.events.eventsStores.get('local').getOne(userId, eventId);
    assert.strictEqual(row.integrity, integrity.events.compute({ ...row }).integrity, what + ': integrity matches the rewritten row');
  }

  it('[HASP1] a deletion under the default mode leaves no modifiedBy in the remaining row', async function () {
    const wiped = await mall.events.getOne(userId, wipedId);
    assert.strictEqual(typeof wiped.deleted, 'number');
    assert.strictEqual(wiped.modifiedBy, undefined);
    const tombstone = await mall.events.getOne(userId, deletedId);
    assert.strictEqual(typeof tombstone.deleted, 'number', 'fixture: the event is deleted');
    assert.strictEqual(tombstone.modifiedBy, accessToken + ' caller-d', 'fixture: the deleted row keeps the token');
  });

  it('[HASP2] a dry run over pages of 2 counts every live, trashed and deleted row, and writes nothing', async function () {
    const out = runTool('--dry-run', '--page-size', '2');
    assert.match(out, /events rewritten\s+7 \(would be\)/);
    assert.ok(!out.includes(accessToken), 'the token is never printed');
    assert.strictEqual((await mall.events.getOne(userId, trashedId)).modifiedBy, accessToken + ' caller-t');
    assert.strictEqual((await mall.events.getOne(userId, deletedId)).modifiedBy, accessToken + ' caller-d');
    for (const id of liveIds) assert.strictEqual((await mall.events.getOne(userId, id)).modifiedBy, accessToken);
  });

  it('[HASP3] a run over pages of 2 rewrites them all and keeps their state', async function () {
    const out = runTool('--page-size', '2');
    assert.match(out, /events rewritten\s+7\n/);
    const trashed = await mall.events.getOne(userId, trashedId);
    assert.strictEqual(trashed.modifiedBy, accessId + ' caller-t');
    assert.strictEqual(trashed.trashed, true, 'the trashed event stays trashed');
    await assertIntegrity(trashedId, 'trashed event');
    const deleted = await mall.events.getOne(userId, deletedId);
    assert.strictEqual(deleted.modifiedBy, accessId + ' caller-d');
    assert.strictEqual(typeof deleted.deleted, 'number', 'the deleted event stays deleted');
    assert.strictEqual(deleted.type, undefined, 'the deleted row gets no field back');
    await assertIntegrity(deletedId, 'deleted event');
    for (const id of liveIds) {
      assert.strictEqual((await mall.events.getOne(userId, id)).modifiedBy, accessId);
      await assertIntegrity(id, 'live event');
    }
    for (const id of cleanIds) assert.strictEqual((await mall.events.getOne(userId, id)).modifiedBy, accessId);
    assert.strictEqual((await mall.events.getOne(userId, wipedId)).modifiedBy, undefined);
  });

  it('[HASP4] a re-run with the default page size finds nothing left', async function () {
    const out = runTool();
    assert.match(out, /events rewritten\s+0\n/);
  });

  it('[HASP5] refuses a page size that is not a positive integer', function () {
    for (const bad of ['0', '-1', '1.5', 'x']) {
      assert.throws(() => runTool('--page-size', bad), /--page-size needs a positive integer/);
    }
  });
});
