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
