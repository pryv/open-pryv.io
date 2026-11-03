/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC orchestration running while its account is erased.
 *
 * [CMCER] An accept is dispatched after its 201 and reads the requester's
 * offer through the capability URL. The account is erased while that read is
 * held open; once the read answers, the orchestration must not write anything
 * for the erased account: no retry record (it would keep the capability URL
 * with its token), no data-grant access, no anchor stream, no status stamp,
 * and no file in the erased account's directory. A grant that cannot be
 * stored is not delivered to the requester either. Run on both engines, and
 * with the audit `keep` mode, where the erasure leaves the user directory in
 * place (reads may re-open empty databases there, never with a row). Also: an erasure record on an account that still exists (an erasure
 * under way, or one that stopped half way) refuses the same writes and keeps
 * the account out of the retry loop, and nothing of it is left once the record
 * is gone.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid. The peer is a
 * test transport of the guarded peer client that holds the offer read until
 * the erasure is done. The orchestration is known to be over when the guard
 * reports it dropped the trigger's last status stamp.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const path = require('node:path');
const sinon = require('sinon');
const { getConfig, getLogger } = require('@pryv/boiler');
const { getStorageLayer, getUsersLocalIndex, userLocalDirectory } = require('storage');
const { getMall } = require('mall');
const { withInjectedConfig } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { getErasuresLocal } = require('business/src/auth/erasures.ts');
const { setPeerTransportForTests, getPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');
const { cmcLoopUserIds } = require('api-server/src/methods/helpers/cmcMall.ts');

const PEER_HOST = 'cmcer-peer.example.com';
const SIGNAL_TIMEOUT_MS = 10_000;
const HOLD_TIMEOUT_MS = 10_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function jsonResponse (status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A peer whose offer read waits for `release()` (unless `held: false`); it
 * answers 404, or the offer. Deliveries (POST) are recorded and answered 201.
 */
function holdingPeer (answer, { held = true } = {}) {
  const peer = { reads: 0, deliveries: [] };
  let release;
  const released = held ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  let onHeld;
  peer.held = new Promise((resolve) => { onHeld = resolve; });
  peer.release = () => release?.();
  peer.transport = async (rawUrl, init) => {
    const u = new URL(rawUrl);
    if (u.hostname !== PEER_HOST) throw new Error('unexpected peer call: ' + u.hostname);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      peer.reads += 1;
      onHeld();
      await released;
      if (answer === 'not-found') return jsonResponse(404, { error: { id: 'unknown-resource', message: 'gone' } });
      return jsonResponse(200, { events: [offerEvent()] });
    }
    peer.deliveries.push({ method, path: u.pathname });
    return jsonResponse(201, { event: { id: cuid(), type: 'consent/accept-cmc' } });
  };
  return peer;
}

function offerEvent () {
  const capabilityId = 'cap' + cuid().slice(-10);
  return {
    id: cuid(),
    type: 'consent/request-cmc',
    streamIds: [':_cmc:_internal:offer:' + capabilityId],
    time: Date.now() / 1000,
    content: {
      capabilityId,
      requesterUsername: 'cmcerdoc',
      requesterHost: PEER_HOST,
      requesterMeta: { username: 'cmcerdoc', appId: 'my-app' },
      request: {
        title: { en: 'CMCER' },
        description: { en: 'd' },
        consent: { en: 'I consent.' },
        permissions: [{ streamId: 'fertility', level: 'read' }],
      },
    },
  };
}

function directoryEntries (userId) {
  const dir = userLocalDirectory.getPathForUser(userId);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort();
}

/** Row counts of the non-empty tables of the databases in the user's directory, the audit's aside. */
function rowsInKeptDatabases (userId) {
  const SQLite3 = require('better-sqlite3');
  const dir = userLocalDirectory.getPathForUser(userId);
  const rows = {};
  for (const name of directoryEntries(userId) ?? []) {
    if (!name.endsWith('.sqlite') || name.startsWith('audit')) continue;
    const db = new SQLite3(path.join(dir, name), { readonly: true, fileMustExist: true });
    try {
      for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get().n;
        if (count > 0) rows[name + ':' + table] = count;
      }
    } finally {
      db.close();
    }
  }
  return rows;
}

async function orphanRowsOf (userId) {
  const check = await (await getUsersLocalIndex()).checkIntegrity();
  return check.errors.filter((e) => e.includes('"' + userId + '"'));
}

describe('[CMCER] cmc orchestration of an account erased meanwhile', function () {
  this.timeout(60_000);

  let config, storageLayer, unhandled, previousTransport, logSpies;
  const onUnhandled = (reason) => { unhandled.push(String(reason?.stack ?? reason)); };

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    storageLayer = await getStorageLayer();
    // Every boiler logger shares this prototype: the guard's lines are seen
    // whichever instance writes them.
    const proto = Object.getPrototypeOf(getLogger('cmcer'));
    logSpies = { info: sinon.spy(proto, 'info'), warn: sinon.spy(proto, 'warn') };
  });

  after(function () {
    logSpies?.info.restore();
    logSpies?.warn.restore();
  });

  beforeEach(function () {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    previousTransport = getPeerTransportForTests();
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onUnhandled);
    setPeerTransportForTests(previousTransport);
  });

  /** The guard's lines about `userId`, at `level`. */
  function dropLines (level, userId) {
    return logSpies[level].getCalls()
      .filter((c) => typeof c.args[0] === 'string' && c.args[0].startsWith('cmc: write dropped') && c.args[1]?.userId === userId)
      .map((c) => c.args[1]);
  }

  /**
   * Wait until the trigger's last status stamp was dropped by the guard (the
   * orchestration is over), or a row of the erased account shows up.
   */
  async function settle (userId, triggerId, { checkOrphans = true } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < SIGNAL_TIMEOUT_MS) {
      const lines = [...dropLines('info', userId), ...dropLines('warn', userId)];
      if (lines.some((l) => l.operation === 'events.updateWithMerge' && l.id === triggerId)) return { signal: true, orphans: [] };
      if (checkOrphans) {
        const orphans = await orphanRowsOf(userId);
        if (orphans.length > 0) return { signal: false, orphans };
      }
      await sleep(100);
    }
    return { signal: false, orphans: checkOrphans ? await orphanRowsOf(userId) : [] };
  }

  async function freshAccount () {
    const username = ('cmcer' + cuid().toLowerCase().replace(/[^a-z0-9]/g, '')).slice(0, 20);
    const fixtures = getNewFixture();
    const fu = await fixtures.user(username);
    const token = cuid();
    await fu.access({ token, type: 'personal' });
    await fu.session(token);
    const res = await coreRequest.post('/' + username + '/streams').set('Authorization', token)
      .send({ id: ':_cmc:apps:my-app', parentId: ':_cmc:apps', name: 'My App' });
    if (res.status !== 201 && res.body?.error?.id !== 'item-already-exists') {
      throw new Error('app scope: ' + res.status + ' ' + JSON.stringify(res.body));
    }
    return { id: fu.attrs.id, username, token, fixtures };
  }

  async function accept (account) {
    const res = await coreRequest.post('/' + account.username + '/events').set('Authorization', account.token).send({
      streamIds: [':_cmc:apps:my-app'],
      type: 'consent/accept-cmc',
      content: { capabilityUrl: 'https://' + cuid() + '@' + PEER_HOST + '/', accessName: 'cmcer-grant-' + cuid().slice(-8) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.event;
  }

  async function heldRead (peer) {
    await Promise.race([
      peer.held,
      sleep(HOLD_TIMEOUT_MS).then(() => { throw new Error('the offer read was never made'); }),
    ]);
  }

  async function erase (account, onUserDelete = 'erase') {
    await withInjectedConfig({ audit: { onUserDelete } }, async () => {
      await new Deletion(null, storageLayer, config).eraseAccount({ id: account.id, username: account.username }, { teardown: true });
    });
  }

  function erasureRecord (account) {
    const now = Date.now();
    return { userId: account.id, username: account.username, trigger: 'test', startedAt: now, updatedAt: now, doneSteps: [], seriesNamespaces: null, attempts: 1, lastError: null };
  }

  async function grantsOf (account) {
    const accesses = await new Promise((resolve, reject) => storageLayer.accesses.find({ id: account.id }, {}, null, (err, items) => err ? reject(err) : resolve(items)));
    return (accesses || []).filter((a) => a.type !== 'personal');
  }

  async function retryRecordsOf (account) {
    const mall = await getMall();
    return await mall.events.get(account.id, { streams: [{ any: [':_cmc:_internal:retries'] }], state: 'all' });
  }

  for (const [code, answer, onUserDelete, label] of [
    ['CMCER1', 'not-found', 'erase', 'an offer read failing after the erasure queues no retry record'],
    ['CMCER2', 'offer', 'erase', 'an offer read succeeding after the erasure mints no grant and delivers no accept'],
    ['CMCER3', 'not-found', 'keep', 'with the audit kept, a failing read writes no row into the kept user directory'],
    ['CMCER4', 'offer', 'keep', 'with the audit kept, a succeeding read writes no row into the kept user directory'],
  ]) {
    it('[' + code + '] ' + label, async function () {
      const account = await freshAccount();
      const peer = holdingPeer(answer);
      setPeerTransportForTests(peer.transport);
      let trigger;
      try {
        trigger = await accept(account);
        await heldRead(peer);
        await erase(account, onUserDelete);
        assert.deepStrictEqual(await orphanRowsOf(account.id), [], 'rows left by the erasure itself');
        if (onUserDelete === 'erase') assert.strictEqual(directoryEntries(account.id), null, 'user directory after the erasure');
      } finally {
        peer.release();
      }

      const { signal, orphans } = await settle(account.id, trigger.id);
      assert.deepStrictEqual(orphans, [], 'rows written for the erased account');
      assert.ok(signal, 'the orchestration did not reach its last status stamp within ' + SIGNAL_TIMEOUT_MS + ' ms');
      assert.deepStrictEqual(await orphanRowsOf(account.id), [], 'rows written for the erased account');
      if (onUserDelete === 'erase') {
        assert.strictEqual(directoryEntries(account.id), null, 'user directory re-created');
      } else {
        // The kept directory may get back empty databases from the reads the
        // late work makes (a store opens its file on a read): no row in them.
        assert.deepStrictEqual(rowsInKeptDatabases(account.id), {}, 'rows written into the kept directory');
      }
      assert.strictEqual(peer.reads, 1);
      assert.deepStrictEqual(peer.deliveries, [], 'calls made to the requester for the erased account');
      assert.deepStrictEqual(dropLines('warn', account.id), [], 'an erased account is not a stopped erasure');
      assert.deepStrictEqual(unhandled, [], 'unhandled rejections');
    });
  }

  it('[CMCER5] an erasure record on an account that still exists refuses the writes, warns, and leaves nothing once removed', async function () {
    const account = await freshAccount();
    const store = await getErasuresLocal();
    const peer = holdingPeer('offer');
    setPeerTransportForTests(peer.transport);
    let trigger;
    try {
      trigger = await accept(account);
      await heldRead(peer);
      assert.ok(await store.insertIfAbsent(erasureRecord(account)));
    } finally {
      peer.release();
    }
    try {
      const { signal } = await settle(account.id, trigger.id, { checkOrphans: false });
      assert.ok(signal, 'the orchestration did not reach its last status stamp within ' + SIGNAL_TIMEOUT_MS + ' ms');
      assert.deepStrictEqual(peer.deliveries, [], 'accept delivered for an account being erased');
      assert.deepStrictEqual(await grantsOf(account), [], 'grant minted for an account being erased');
      assert.deepStrictEqual(await retryRecordsOf(account), [], 'retry record written for an account being erased');
      const warned = dropLines('warn', account.id);
      assert.strictEqual(warned.length, 1, 'one warning per account: ' + JSON.stringify(warned));
      // The retry loop and the member ledger pass leave this account alone.
      assert.ok(!(await cmcLoopUserIds()).includes(account.id), 'an account being erased is visited by the loop');
    } finally {
      await store.delete(account.id);
    }

    // The record gone, the account works as before.
    assert.ok((await cmcLoopUserIds()).includes(account.id), 'a live account is not visited by the loop');
    const peer2 = holdingPeer('offer', { held: false });
    setPeerTransportForTests(peer2.transport);
    const second = await accept(account);
    const t0 = Date.now();
    let status;
    while (Date.now() - t0 < SIGNAL_TIMEOUT_MS) {
      const res = await coreRequest.get('/' + account.username + '/events/' + second.id).set('Authorization', account.token);
      status = res.body?.event?.content?.status;
      if (status === 'completed' || status === 'failed') break;
      await sleep(100);
    }
    assert.strictEqual(status, 'completed');
    assert.strictEqual(peer2.deliveries.length, 1, 'the accept is delivered');
    assert.strictEqual((await grantsOf(account)).length, 1, 'one grant, from the second accept');
    await erase(account);
    assert.deepStrictEqual(unhandled, [], 'unhandled rejections');
  });
});
