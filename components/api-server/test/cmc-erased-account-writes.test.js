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
 * place.
 *
 * Pattern C: initCore + coreRequest + getNewFixture + cuid. The peer is a
 * test transport of the guarded peer client that holds the offer read until
 * the erasure is done.
 */

/* global initTests, initCore, coreRequest, getNewFixture, assert, cuid */

const fs = require('node:fs');
const { getConfig } = require('@pryv/boiler');
const { getStorageLayer, getUsersLocalIndex, userLocalDirectory } = require('storage');
const { withInjectedConfig } = require('test-helpers');
const { Deletion } = require('business/src/auth/deletion.ts');
const { setPeerTransportForTests } = require('business/src/outbound/peerFetch.ts');

const PEER_HOST = 'cmcer-peer.example.com';
const SETTLE_MS = 2_500;
const HOLD_TIMEOUT_MS = 10_000;

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function jsonResponse (status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A peer whose offer read waits for `release()`; it answers 404, or the offer. */
function holdingPeer (answer) {
  const peer = { reads: 0, deliveries: [] };
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let onHeld;
  peer.held = new Promise((resolve) => { onHeld = resolve; });
  peer.release = () => release();
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

async function orphanRowsOf (userId) {
  const check = await (await getUsersLocalIndex()).checkIntegrity();
  return check.errors.filter((e) => e.includes('"' + userId + '"'));
}

describe('[CMCER] cmc orchestration of an account erased meanwhile', function () {
  this.timeout(60_000);

  let config, storageLayer, unhandled;
  const onUnhandled = (reason) => { unhandled.push(String(reason?.stack ?? reason)); };

  before(async function () {
    await initTests();
    await initCore();
    config = await getConfig();
    storageLayer = await getStorageLayer();
  });

  beforeEach(function () {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onUnhandled);
    // Back to the transport the test setup installs for every suite (see
    // test-helpers helpers-base): the next suites reach their peers through
    // `globalThis.fetch`.
    setPeerTransportForTests((url, init) => globalThis.fetch(url, init));
  });

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

  for (const [code, answer, onUserDelete, label] of [
    ['CMCER1', 'not-found', 'erase', 'an offer read failing after the erasure queues no retry record'],
    ['CMCER2', 'offer', 'erase', 'an offer read succeeding after the erasure mints no grant and delivers no accept'],
    ['CMCER3', 'not-found', 'keep', 'with the audit kept, nothing is written into the kept user directory'],
  ]) {
    it('[' + code + '] ' + label, async function () {
      const account = await freshAccount();
      const peer = holdingPeer(answer);
      setPeerTransportForTests(peer.transport);
      try {
        const res = await coreRequest.post('/' + account.username + '/events').set('Authorization', account.token).send({
          streamIds: [':_cmc:apps:my-app'],
          type: 'consent/accept-cmc',
          content: { capabilityUrl: 'https://' + cuid() + '@' + PEER_HOST + '/', accessName: 'cmcer-grant-' + cuid().slice(-8) },
        });
        assert.strictEqual(res.status, 201, JSON.stringify(res.body));
        await Promise.race([
          peer.held,
          sleep(HOLD_TIMEOUT_MS).then(() => { throw new Error('the offer read was never made'); }),
        ]);

        await withInjectedConfig({ audit: { onUserDelete } }, async () => {
          await new Deletion(null, storageLayer, config).eraseAccount({ id: account.id, username: account.username }, { teardown: true });
        });
        assert.deepStrictEqual(await orphanRowsOf(account.id), [], 'rows left by the erasure itself');
        const entriesAfterErasure = directoryEntries(account.id);
        if (onUserDelete === 'erase') assert.strictEqual(entriesAfterErasure, null, 'user directory after the erasure');
      } finally {
        peer.release();
      }

      // The orchestration resumes now; anything it writes lands within a
      // few milliseconds of the read's answer.
      const t0 = Date.now();
      let orphans = [];
      while (Date.now() - t0 < SETTLE_MS) {
        await sleep(100);
        orphans = await orphanRowsOf(account.id);
        if (orphans.length > 0) break;
      }
      assert.deepStrictEqual(orphans, [], 'rows written for the erased account');
      if (onUserDelete === 'erase') {
        assert.strictEqual(directoryEntries(account.id), null, 'user directory re-created');
      } else {
        const entries = directoryEntries(account.id);
        assert.ok(entries == null || entries.every((name) => name.startsWith('audit')), 'files written into the kept directory: ' + JSON.stringify(entries));
      }
      assert.strictEqual(peer.reads, 1);
      assert.deepStrictEqual(peer.deliveries, [], 'calls made to the requester for the erased account');
      assert.deepStrictEqual(unhandled, [], 'unhandled rejections');
    });
  }
});
