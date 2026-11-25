/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — handleIncomingBackChannel tests.
 *
 * [CMCBC] covers the accepter-side handler for `consent/back-channel-cmc`
 * events arriving on `:_cmc:inbox`. The handler updates the data-grant
 * access's clientData with the requester's apiEndpoint + remote
 * stream-ids so accepter-side chat / system handlers can resolve a
 * remote endpoint to POST to.
 */

const assert = require('node:assert/strict');
const { handleIncomingBackChannel } = require('../src/handleIncomingBackChannel.ts');

function fakeMall (initialAccesses, capture = {}) {
  capture.updates = capture.updates || [];
  return {
    accesses: {
      async get () { return initialAccesses; },
      async update (_userId, params) {
        capture.updates.push(params);
        return { id: params.id, ...params.update };
      },
    },
  };
}

describe('[CMCBC] cmc/handleIncomingBackChannel', () => {
  it('[BC01] updates the data-grant matching the from-counterparty', async () => {
    const accesses = [
      {
        id: 'unrelated',
        clientData: { cmc: { role: 'capability' } },
      },
      {
        id: 'data-grant-1',
        clientData: {
          cmc: {
            role: 'counterparty',
            counterparty: { username: 'alice', host: 'pryv.me' },
            offerEventId: 'offer-1',
            backChannelApiEndpoint: null,
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        content: {
          from: { username: 'alice', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
          remoteChatStreamId: ':_cmc:apps:my-app:chats:bob--example-com',
          remoteCollectorStreamId: ':_cmc:apps:my-app:collectors:bob--example-com',
          appCode: 'my-app',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'data-grant-1');
    assert.equal(capture.updates.length, 1);
    const upd = capture.updates[0].update.clientData.cmc;
    assert.equal(upd.counterparty.apiEndpoint, 'https://tok@pryv.me/alice/');
    assert.equal(upd.counterparty.remoteChatStreamId,
      ':_cmc:apps:my-app:chats:bob--example-com');
    assert.equal(upd.counterparty.remoteCollectorStreamId,
      ':_cmc:apps:my-app:collectors:bob--example-com');
    assert.equal(upd.backChannelApiEndpoint, 'https://tok@pryv.me/alice/');
    // Existing fields like offerEventId are preserved.
    assert.equal(upd.offerEventId, 'offer-1');
  });

  it('[BC15] a re-accept of the same relationship stamps the new grant, not the already-completed one', async () => {
    const grant = (id, extra) => ({
      id,
      clientData: {
        cmc: {
          role: 'counterparty',
          appCode: 'my-app',
          scopeStreamId: ':_cmc:apps:my-app:study-a',
          counterparty: { username: 'alice', host: 'pryv.me' },
          ...extra,
        },
      },
    });
    const accesses = [
      grant('completed-grant', { backChannelApiEndpoint: 'https://old-tok@pryv.me/alice/', counterparty: { username: 'alice', host: 'pryv.me', apiEndpoint: 'https://old-tok@pryv.me/alice/' } }),
      grant('new-grant', { backChannelApiEndpoint: null }),
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        streamIds: [':_cmc:inbox'],
        content: {
          from: { username: 'alice', host: 'pryv.me' },
          apiEndpoint: 'https://new-tok@pryv.me/alice/',
          remoteChatStreamId: ':_cmc:apps:my-app:study-a:chats:bob--example-com',
          remoteCollectorStreamId: ':_cmc:apps:my-app:study-a:collectors:bob--example-com',
          appCode: 'my-app',
          scopeStreamId: ':_cmc:apps:my-app:study-a',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'new-grant');
    assert.equal(capture.updates.length, 1);
    assert.equal(capture.updates[0].id, 'new-grant');
    assert.equal(capture.updates[0].update.clientData.cmc.counterparty.apiEndpoint, 'https://new-tok@pryv.me/alice/');
  });

  it('[BC02] matches host by slug (port + dots normalised)', async () => {
    const accesses = [
      {
        id: 'data-grant-1',
        clientData: {
          cmc: {
            role: 'counterparty',
            // host stored without port
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        content: {
          // from carries the same host with a port — slugifyHost strips it
          from: { username: 'alice', host: 'pryv.me:443' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(capture.updates.length, 1);
  });

  it('[BC03] when several grants share a counterparty, appCode picks the right one', async () => {
    const accesses = [
      {
        id: 'wrong-app',
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'other-app',
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
      {
        id: 'right-app',
        clientData: {
          cmc: {
            role: 'counterparty',
            appCode: 'my-app',
            counterparty: { username: 'alice', host: 'pryv.me' },
          },
        },
      },
    ];
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        content: {
          from: { username: 'alice', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
          appCode: 'my-app',
        },
      },
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'right-app');
  });

  it('[BC04] returns ok:false when no matching data-grant is found', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        content: {
          from: { username: 'unknown', host: 'pryv.me' },
          apiEndpoint: 'https://tok@pryv.me/alice/',
        },
      },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-data-grant-not-found');
  });

  it('[BC05] returns ok:false when content.from is missing', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: { type: 'consent/back-channel-cmc', content: { apiEndpoint: 'x' } },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-from-missing');
  });

  it('[BC06] returns ok:false when content.apiEndpoint is missing', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        type: 'consent/back-channel-cmc',
        content: { from: { username: 'alice', host: 'pryv.me' } },
      },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-no-apiendpoint');
  });

  // The two sides derive appCode independently and the sender falls back to
  // the literal 'unknown' when it cannot resolve its own request scope, so
  // divergent values are normal on a healthy handshake. A mismatch must never
  // drop the delivery: doing so leaves backChannelApiEndpoint null forever,
  // and every later revoke on that relationship is silently undeliverable.
  // Every other test here uses the same app-code on both sides, which is why
  // that failure mode shipped twice unnoticed.
  function grantFor (id, cmcExtra) {
    return {
      id,
      clientData: {
        cmc: {
          role: 'counterparty',
          counterparty: { username: 'alice', host: 'pryv.me' },
          ...cmcExtra,
        },
      },
    };
  }

  function deliveryWith (appCode) {
    return {
      type: 'consent/back-channel-cmc',
      content: {
        from: { username: 'alice', host: 'pryv.me' },
        apiEndpoint: 'https://tok@pryv.me/alice/',
        ...(appCode === undefined ? {} : { appCode }),
      },
    };
  }

  it('[BC08] stores the back-channel when the only grant has a different appCode', async () => {
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: deliveryWith('other-app'),
      deps: { mall: fakeMall([grantFor('only-grant', { appCode: 'my-app' })], capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'only-grant');
    assert.equal(capture.updates.length, 1);
    assert.equal(capture.updates[0].update.clientData.cmc.backChannelApiEndpoint,
      'https://tok@pryv.me/alice/');
  });

  it("[BC09] stores the back-channel when the sender fell back to 'unknown'", async () => {
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: deliveryWith('unknown'),
      deps: { mall: fakeMall([grantFor('only-grant', { appCode: 'my-app' })], capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'only-grant');
    assert.equal(capture.updates.length, 1);
  });

  it('[BC18] stores the back-channel when the delivery carries no appCode at all', async () => {
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: deliveryWith(undefined),
      deps: { mall: fakeMall([grantFor('only-grant', { appCode: 'my-app' })], capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'only-grant');
  });

  it('[BC19] with several grants and no appCode match, still stores on a pending one', async () => {
    const capture = {};
    const warnings = [];
    const accesses = [
      grantFor('done-grant', {
        appCode: 'app-a',
        backChannelApiEndpoint: 'https://old@pryv.me/alice/',
      }),
      grantFor('pending-grant', { appCode: 'app-b' }),
    ];
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: deliveryWith('app-c'),
      deps: {
        mall: fakeMall(accesses, capture),
        logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
      },
    });
    assert.equal(r.ok, true);
    // The grant still awaiting its back-channel is the better guess, and the
    // ambiguity is surfaced to operators rather than swallowed.
    assert.equal(r.dataGrantAccessId, 'pending-grant');
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].ctx.candidateIds, ['done-grant', 'pending-grant']);
  });

  it('[BC20] prefers a grant with no appCode over one scoped to another app', async () => {
    const capture = {};
    const accesses = [
      grantFor('other-app-grant', { appCode: 'app-a' }),
      grantFor('unscoped-grant', {}),
    ];
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: deliveryWith('app-c'),
      deps: { mall: fakeMall(accesses, capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'unscoped-grant');
  });

  // content.from is server-stamped only for :_cmc:inbox writes; on any other
  // CMC-writable stream the sender controls it. Dispatch routes this event
  // type by type alone, so the handler is the place that has to care which
  // stream it arrived on.
  it('[BC21] ignores a back-channel delivered outside :_cmc:inbox', async () => {
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: {
        ...deliveryWith('my-app'),
        streamIds: [':_cmc:_internal:responses:abc'],
      },
      deps: { mall: fakeMall([grantFor('a-grant', { appCode: 'my-app' })], capture) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-wrong-stream');
    assert.equal(capture.updates.length, 0, 'nothing may be stamped from a non-inbox delivery');
  });

  it('[BC22] accepts a back-channel delivered on :_cmc:inbox', async () => {
    const capture = {};
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: { ...deliveryWith('my-app'), streamIds: [':_cmc:inbox'] },
      deps: { mall: fakeMall([grantFor('a-grant', { appCode: 'my-app' })], capture) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dataGrantAccessId, 'a-grant');
  });

  describe('[CMCBC-REPLACE] the back-channel of a newer grant ends the older grants of the same relationship', () => {
    const { stampWithdrawalOnAccept } = require('../src/acceptWithdrawal.ts');
    const { setOlderPeerForTests } = require('../src/replacedGrants.ts');
    const { isRetryableReason } = require('../src/retryQueue.ts');
    const { fakeUpdateWithMerge } = require('./_fake-assertions.cjs');
    const SCOPE = ':_cmc:apps:practice:team-a';
    const GROUP = { username: 'practice', host: 'group.example.com' };

    function grant (id, created, cmc = {}) {
      return {
        id,
        ...(created != null ? { created } : {}),
        type: 'app',
        clientData: { cmc: { role: 'counterparty', acceptEventId: 'accept-' + id, scopeStreamId: SCOPE, counterparty: { ...GROUP }, ...cmc } },
      };
    }
    function replaceMall (accesses, opts = {}) {
      const calls = { deleted: [], updated: [] };
      const acceptEvents = new Map(accesses.map((a) => [a.clientData.cmc.acceptEventId, { id: a.clientData.cmc.acceptEventId, type: 'consent/accept-cmc', content: { status: 'completed' } }]));
      return {
        calls,
        acceptEvents,
        accesses: {
          async get () { return accesses.filter((a) => !calls.deleted.includes(a.id)); },
          async update (_u, params) { calls.updated.push(params.id); return { id: params.id, ...params.update }; },
          async delete (_u, { id }) {
            if ((opts.failDelete ?? []).includes(id)) throw new Error('storage down');
            calls.deleted.push(id);
            return { id, relatedDeletions: [] };
          },
        },
        events: {
          async getOne (_u, id) { return acceptEvents.get(id) ?? null; },
          async update (_u, e) { acceptEvents.set(e.id, e); return e; },
          async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
        },
      };
    }
    function delivery (writerId) {
      return {
        type: 'consent/back-channel-cmc',
        streamIds: [':_cmc:inbox'],
        ...(writerId != null ? { createdBy: writerId } : {}),
        content: { from: GROUP, apiEndpoint: 'https://bc-tok@group.example.com/practice/', scopeStreamId: SCOPE, appCode: 'practice' },
      };
    }

    it('[CSA31] only the older grants with the same role, counterparty and scope are deleted, their accept marked replaced naming the newer one; never a newer grant, another scope or counterparty, a scope-less access, a back-channel toward the peer, another role, the writer, an access without created', async () => {
      const accesses = [
        grant('g1', 100),
        grant('g2', 200),
        grant('g3', 300),
        // Created at the same instant as the keeper: not older, kept.
        grant('g-same', 200),
        grant('g-scope', 50, { scopeStreamId: SCOPE + ':other' }),
        grant('g-peer', 50, { counterparty: { username: 'other-group', host: 'group.example.com' } }),
        grant('g-host', 50, { counterparty: { username: 'practice', host: 'other.example.com' } }),
        grant('g-noscope', 50, { scopeStreamId: null }),
        grant('g-bc', 50, { capabilityId: null }),
        grant('g-member', 50, { role: 'member' }),
        grant('g-nocreated', null),
      ];
      const mall = replaceMall(accesses);
      const r = await handleIncomingBackChannel({ userId: 'u1', event: delivery('g2'), deps: { mall } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.dataGrantAccessId, 'g2');
      assert.deepEqual(r.replacedAccessIds, ['g1']);
      assert.deepEqual(mall.calls.deleted, ['g1']);
      assert.deepEqual(mall.calls.updated, ['g2'], 'the stamp lands on the writer');
      const w = mall.acceptEvents.get('accept-g1').content.withdrawal;
      assert.deepEqual([w.by, w.accessId, w.replacedBy], ['replaced', 'g1', { acceptEventId: 'accept-g2', accessId: 'g2' }]);
      assert.equal(typeof w.at, 'number');
      assert.equal(mall.acceptEvents.get('accept-g3').content.withdrawal, undefined);
      // A membership joined twice: the older membership is deleted and swept.
      const swept = [];
      // A counterparty grant older than the member keeper is another role: kept.
      const members = [grant('m1', 100, { role: 'member' }), grant('m2', 200, { role: 'member' }), grant('cp-old', 50)];
      const mall2 = replaceMall(members);
      const r2 = await handleIncomingBackChannel({
        userId: 'g',
        event: delivery('m2'),
        deps: { mall: mall2, memberSweep: { async sweepMembership (_u, access, reason) { swept.push([access.id, reason]); return {}; } } },
      });
      assert.equal(r2.ok, true, JSON.stringify(r2));
      assert.deepEqual(mall2.calls.deleted, ['m1']);
      assert.deepEqual(swept, [['m1', 'revoke']]);
      // A delivery written by a back-channel access toward the peer (own
      // `capabilityId` key), even a newer one: it is no grant, it ends nothing.
      const mall3 = replaceMall([grant('g1', 100), grant('bc-new', 500, { capabilityId: null })]);
      const r3 = await handleIncomingBackChannel({ userId: 'u1', event: delivery('bc-new'), deps: { mall: mall3 } });
      assert.equal(r3.ok, true, JSON.stringify(r3));
      assert.deepEqual(mall3.calls.deleted, []);
      // A keeper without a scope names no relationship: nothing is ended, not even another scope-less grant.
      const mall4 = replaceMall([grant('n1', 100, { scopeStreamId: null }), grant('n2', 200, { scopeStreamId: null })]);
      const r4 = await handleIncomingBackChannel({ userId: 'u1', event: delivery('n2'), deps: { mall: mall4 } });
      assert.equal(r4.ok, true, JSON.stringify(r4));
      assert.deepEqual(mall4.calls.deleted, []);
    });

    it('[CSA32] without a resolvable writer (the selector fallback) nothing is replaced; a delete that fails keeps the stamp and fails the delivery retryably; an older core (rule off) replaces nothing', async () => {
      let mall = replaceMall([grant('g1', 100), grant('g2', 200, { backChannelApiEndpoint: null })]);
      let r = await handleIncomingBackChannel({ userId: 'u1', event: delivery(null), deps: { mall } });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(mall.calls.deleted, [], 'a guess never deletes');
      mall = replaceMall([grant('g0', 50), grant('g1', 100), grant('g2', 200)], { failDelete: ['g0'] });
      r = await handleIncomingBackChannel({ userId: 'u1', event: delivery('g2'), deps: { mall } });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'cmc-back-channel-replace-failed');
      assert.deepEqual(r.detail, { dataGrantAccessId: 'g2', failedAccessIds: ['g0'], endedAccessIds: ['g1'] });
      assert.deepEqual(mall.calls.updated, ['g2'], 'the stamp stands');
      assert.equal(isRetryableReason(r.reason, r.detail), true, 'queued, the retry ends what is left');
      setOlderPeerForTests({ accepter: true });
      try {
        mall = replaceMall([grant('g1', 100), grant('g2', 200)]);
        r = await handleIncomingBackChannel({ userId: 'u1', event: delivery('g2'), deps: { mall } });
        assert.equal(r.ok, true);
        assert.deepEqual(mall.calls.deleted, []);
      } finally {
        setOlderPeerForTests(null);
      }
    });

    it('[CSA33] the withdrawal marker `replaced` is written once with replacedBy; an existing withdrawal is never overwritten', async () => {
      const mall = replaceMall([grant('g1', 100)]);
      const stamp = (by, replacedBy) => stampWithdrawalOnAccept({
        userId: 'u1', relationshipCmc: grant('g1', 100).clientData.cmc, by, accessId: 'g1', replacedBy, deps: { mall },
      });
      let r = await stamp('replaced', { acceptEventId: 'accept-g2', accessId: 'g2' });
      assert.deepEqual(r, { ok: true, written: true });
      assert.deepEqual(mall.acceptEvents.get('accept-g1').content.withdrawal.replacedBy, { acceptEventId: 'accept-g2', accessId: 'g2' });
      r = await stamp('accesses.delete');
      assert.deepEqual(r, { ok: true, written: false, skipped: 'already-withdrawn' });
      assert.equal(mall.acceptEvents.get('accept-g1').content.withdrawal.by, 'replaced');
      // `replacedBy` only goes with `replaced`.
      const mall2 = replaceMall([grant('g1', 100)]);
      await stampWithdrawalOnAccept({ userId: 'u1', relationshipCmc: grant('g1', 100).clientData.cmc, by: 'accesses.delete', accessId: 'g1', replacedBy: { acceptEventId: 'x', accessId: 'y' }, deps: { mall: mall2 } });
      assert.equal(mall2.acceptEvents.get('accept-g1').content.withdrawal.replacedBy, undefined);
    });
  });

  it('[BC07] rejects non-back-channel event types', async () => {
    const r = await handleIncomingBackChannel({
      userId: 'u1',
      event: { type: 'consent/accept-cmc', content: {} },
      deps: { mall: fakeMall([]) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cmc-back-channel-wrong-type');
  });
});
