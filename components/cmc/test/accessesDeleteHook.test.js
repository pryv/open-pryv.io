/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * CMC plugin — accessesDeleteHook tests.
 *
 * [CMCDH] covers the accesses.delete post-hook: when a CMC relationship
 * access is removed via the api-server route (generic "connected apps"
 * UI, admin cleanup, …), the hook forwards a `consent/revoke-cmc` to
 * the counterparty's :_cmc:inbox so the revocation is observable
 * regardless of the path that performed it.
 */

const assert = require('node:assert/strict');
const { createAccessesDeletePostHook } = require('../src/accessesDeleteHook.ts');
const { validateRevoke } = require('../src/validators.ts');
const { assertOutboundUrl, fakeUpdateWithMerge } = require('./_fake-assertions.cjs');

function fakeFetch (responses) {
  const calls = [];
  let idx = 0;
  return {
    fetch (url, init) {
      assertOutboundUrl(url, init);
      calls.push({ url, init });
      const spec = Array.isArray(responses) ? responses[idx++] : responses;
      if (spec instanceof Error) return Promise.reject(spec);
      return Promise.resolve({
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        async json () { return spec.body; },
        async text () { return JSON.stringify(spec.body); },
      });
    },
    calls,
  };
}

// Requester-side relationship access (back-channel): peer path stored
// on counterparty.apiEndpoint.
const REQUESTER_SIDE_ACCESS = {
  id: 'acc-back-channel',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: {
        username: 'bob',
        host: 'peer.example.org',
        apiEndpoint: 'https://peer-tok@peer.example.org/',
      },
    },
  },
};

// Accepter-side relationship access (data-grant) minted before the
// back-channel mirror existed: peer path only on backChannelApiEndpoint.
const ACCEPTER_SIDE_LEGACY_ACCESS = {
  id: 'acc-data-grant',
  type: 'shared',
  clientData: {
    cmc: {
      role: 'counterparty',
      appCode: 'my-app',
      counterparty: { username: 'alice', host: 'peer.example.org' },
      offerEventId: 'evt-offer-1',
      acceptEventId: 'evt-accept-1',
      backChannelApiEndpoint: 'https://bc-tok@peer.example.org/',
    },
  },
};

const PLAIN_ACCESS = { id: 'acc-plain', type: 'shared', clientData: {} };

describe('[CMCDH] cmc/accessesDeleteHook', () => {
  it('[DH01] forwards consent/revoke-cmc to the peer inbox for a deleted relationship access', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results.length, 1);
    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/peer\.example\.org\/events$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.type, 'consent/revoke-cmc');
    assert.deepEqual(sent.streamIds, [':_cmc:inbox']);
    assert.equal(sent.content.accessId, 'acc-back-channel');
    assert.equal(sent.content.appCode, 'my-app');
  });

  it('[DH02] delivered content passes the receiving side\'s revoke schema', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    await hook('u1', [REQUESTER_SIDE_ACCESS]);
    const sent = JSON.parse(calls[0].init.body);
    const v = validateRevoke(sent.content);
    assert.equal(v.valid, true, 'peer-side validateRevoke must accept the payload: ' + JSON.stringify(v.errors));
  });

  it('[DH03] falls back to backChannelApiEndpoint and carries correlation event ids', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results[0].peerNotified, true);
    assert.match(calls[0].url, /^https:\/\/peer\.example\.org\/events$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.content.accessId, 'acc-data-grant');
    assert.equal(sent.content.offerEventId, 'evt-offer-1');
    assert.equal(sent.content.acceptEventId, 'evt-accept-1');
  });

  it('[DH04] skips non-CMC accesses without any outbound call', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [PLAIN_ACCESS]);

    assert.equal(results.length, 1);
    assert.equal(results[0].attempted, false);
    assert.equal(results[0].reason, 'not-a-cmc-relationship-access');
    assert.equal(calls.length, 0);
  });

  it('[DH05] reports at ERROR level when no peer apiEndpoint is stored', async () => {
    // This hook is fire-and-forget off the delete route — there is no
    // trigger event to carry the outcome, so the log is the ONLY signal
    // that a consent withdrawal never reached the counterparty. It must
    // therefore be loud (error), and name a reason an operator can act on.
    const warned = [];
    const errored = [];
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({
      fetch,
      logger: { warn: (msg) => warned.push(msg), error: (msg) => errored.push(msg) },
    });
    const noEndpoint = {
      id: 'acc-incomplete',
      clientData: { cmc: { role: 'counterparty', counterparty: { username: 'x', host: 'y.example.org' } } },
    };
    const results = await hook('u1', [noEndpoint]);

    assert.equal(results[0].attempted, false);
    assert.equal(results[0].reason, 'cmc-revoke-no-peer-endpoint');
    assert.equal(calls.length, 0, 'nothing to deliver to — no outbound attempt');
    assert.equal(errored.length, 1, 'a lost revocation notification must surface at error level');
  });

  it('[DH06] processes a mixed batch (cascade): notifies for each relationship access only', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [PLAIN_ACCESS, REQUESTER_SIDE_ACCESS, ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results.length, 3);
    assert.equal(calls.length, 2);
    const sentIds = calls.map((c) => JSON.parse(c.init.body).content.accessId).sort();
    assert.deepEqual(sentIds, ['acc-back-channel', 'acc-data-grant']);
  });

  it('[DH07] reports peerNotified=false on delivery failure without throwing', async () => {
    const { fetch } = fakeFetch({ status: 503, body: { error: 'down' } });
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, false);
    assert.equal(results[0].peerDeliveryStatus, 503);
  });

  it('[DH09] retries a transient 5xx and reports success when a later attempt lands', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503, body: { error: 'down' } },
      { status: 201, body: {} },
    ]);
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(calls.length, 2, 'a transient failure must be retried');
    assert.equal(results[0].peerNotified, true);
  });

  it('[DH10] does NOT retry a 4xx — the peer gave a considered answer', async () => {
    const errored = [];
    const { fetch, calls } = fakeFetch({ status: 400, body: { error: 'nope' } });
    const hook = createAccessesDeletePostHook({ fetch, logger: { error: (m) => errored.push(m) } });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(calls.length, 1, 'resending a rejected payload cannot help');
    assert.equal(results[0].peerNotified, false);
    assert.equal(errored.length, 1, 'an undelivered revocation must surface at error level');
  });

  it('[DH11] gives up after the bounded attempts on persistent failure', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 201, body: {} },
    ]);
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(calls.length, 3, 'retries are bounded — a delete route must not hang on a dead peer');
    assert.equal(results[0].peerNotified, false);
    assert.equal(results[0].reason, 'http-5xx');
  });

  it('[DH08] survives a network error (fetch rejects) without throwing', async () => {
    const { fetch } = fakeFetch(new Error('ECONNREFUSED'));
    const hook = createAccessesDeletePostHook({ fetch });
    const results = await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(results[0].attempted, true);
    assert.equal(results[0].peerNotified, false);
  });

  // ---- local invite bookkeeping (optional mall dep) ----
  function fakeMallWithInvite (...stored) {
    const events = new Map(stored.map((e) => [e.id, e]));
    const calls = { eventsUpdated: [] };
    return {
      calls,
      events: {
        async updateWithMerge (...a) { return fakeUpdateWithMerge(this, ...a); },
        async getOne (userId, id) { return events.get(id) ?? null; },
        async get (userId, params) {
          calls.eventsGot = (calls.eventsGot ?? 0) + 1;
          return [...events.values()].filter((e) => params?.types == null || params.types.includes(e.type));
        },
        async update (userId, event) {
          events.set(event.id, event);
          calls.eventsUpdated.push(event);
          return event;
        },
      },
      accesses: { async get () { return []; } },
      eventById: (id) => events.get(id),
    };
  }
  const REQUESTER_SIDE_WITH_CAP = {
    id: 'acc-back-channel-cap',
    type: 'shared',
    clientData: {
      cmc: {
        role: 'counterparty',
        appCode: 'my-app',
        capabilityId: 'cap-dh',
        inviteEventId: 'invite-dh',
        counterparty: { username: 'bob', host: 'peer.example.org', apiEndpoint: 'https://peer-tok@peer.example.org/' },
      },
    },
  };

  it('[DH15] with a mall dep, deleting the requester back-channel marks its single-use invite revoked', async () => {
    const { fetch } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite({ id: 'invite-dh', type: 'consent/request-cmc', content: { status: 'accepted' } });
    const hook = createAccessesDeletePostHook({ fetch, mall });
    await hook('u1', [REQUESTER_SIDE_WITH_CAP]);
    assert.equal(mall.eventById('invite-dh').content.status, 'revoked');
  });

  it('[DH13] a deleted relationship WITHOUT the capabilityId key marks nothing', async () => {
    const { fetch } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite({ id: 'invite-evt-1', type: 'consent/request-cmc', content: { status: 'accepted' } });
    const hook = createAccessesDeletePostHook({ fetch, mall });
    await hook('u1', [{
      ...REQUESTER_SIDE_ACCESS,
      clientData: { cmc: { ...REQUESTER_SIDE_ACCESS.clientData.cmc, inviteEventId: 'invite-evt-1' } },
    }]);
    assert.equal(mall.calls.eventsUpdated.length, 0);
  });

  it('[DH14] forwards inviteEventId on a raw delete, and omits it when absent', async () => {
    // Parity with the helper path: a withdrawal from a generic connected-apps
    // screen must carry the same correlation ids as one through the helper,
    // or the peer can match one kind of revocation and not the other.
    const withInvite = {
      ...REQUESTER_SIDE_ACCESS,
      clientData: {
        cmc: {
          ...REQUESTER_SIDE_ACCESS.clientData.cmc,
          inviteEventId: 'invite-evt-1',
        },
      },
    };
    const { fetch, calls } = fakeFetch([{ status: 201, body: {} }, { status: 201, body: {} }]);
    const hook = createAccessesDeletePostHook({ fetch });
    await hook('u1', [withInvite]);
    await hook('u1', [REQUESTER_SIDE_ACCESS]);

    assert.equal(calls.length, 2);
    const first = JSON.parse(calls[0].init.body).content;
    const second = JSON.parse(calls[1].init.body).content;
    assert.equal(first.inviteEventId, 'invite-evt-1');
    assert.equal('inviteEventId' in second, false);
  });

  // ---- withdrawal recorded on the person's accept event (accepter side) ----
  const ACCEPT_EVENT = {
    id: 'evt-accept-1',
    type: 'consent/accept-cmc',
    streamIds: [':_cmc:apps:my-app'],
    content: { status: 'completed', approvedBy: { accessId: 'acc-personal' } },
  };

  it('[DH16] deleting an accepter-side data grant records the withdrawal on its accept event; delivery still happens', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite(structuredClone(ACCEPT_EVENT));
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const before = Date.now() / 1000;
    const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results[0].withdrawalStamped, true);
    assert.equal(results[0].peerNotified, true);
    assert.equal(calls.length, 1, 'the peer delivery is still attempted');
    const stored = mall.eventById('evt-accept-1');
    const { withdrawal, ...rest } = stored.content;
    assert.deepEqual(Object.keys(withdrawal).sort(), ['accessId', 'at', 'by']);
    assert.equal(withdrawal.by, 'accesses.delete');
    assert.equal(withdrawal.accessId, 'acc-data-grant');
    assert.equal(typeof withdrawal.at, 'number');
    assert.ok(withdrawal.at >= before && withdrawal.at <= Date.now() / 1000 + 1, 'at is in seconds');
    assert.equal(stored.modified, withdrawal.at);
    assert.deepEqual(rest, ACCEPT_EVENT.content, 'the rest of the record is kept');
  });

  it('[DH17] deleting a requester-side relationship (capabilityId key) leaves the accept event untouched', async () => {
    const { fetch } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite(
      structuredClone(ACCEPT_EVENT),
      { id: 'invite-dh', type: 'consent/request-cmc', content: { status: 'accepted' } }
    );
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const requester = structuredClone(REQUESTER_SIDE_WITH_CAP);
    // the requester holds the PEER's accept event id: never resolved locally
    requester.clientData.cmc.acceptEventId = 'evt-accept-1';
    const results = await hook('u1', [requester]);

    assert.equal(results[0].withdrawalStamped, false);
    assert.equal(mall.eventById('evt-accept-1').content.withdrawal, undefined);
    assert.deepEqual(mall.calls.eventsUpdated.map((e) => e.id), ['invite-dh'], 'only the invite is stamped');
  });

  it('[DH18] an accept event already carrying a withdrawal (detach) is not overwritten', async () => {
    const { fetch } = fakeFetch({ status: 201, body: {} });
    const detached = { at: 1700000000, by: 'delegation-detach', relId: 'rel-1' };
    const mall = fakeMallWithInvite({ ...structuredClone(ACCEPT_EVENT), content: { ...ACCEPT_EVENT.content, withdrawal: detached } });
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);
    // a second fire skips as well
    await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results[0].withdrawalStamped, false);
    assert.deepEqual(mall.eventById('evt-accept-1').content.withdrawal, detached);
    assert.equal(mall.calls.eventsUpdated.length, 0);
  });

  it('[DH21] a hook that fires twice in sequence on a fresh accept event writes once', async () => {
    const { fetch } = fakeFetch([{ status: 201, body: {} }, { status: 201, body: {} }]);
    const mall = fakeMallWithInvite(structuredClone(ACCEPT_EVENT));
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const first = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);
    const firstWithdrawal = structuredClone(mall.eventById('evt-accept-1').content.withdrawal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(first[0].withdrawalStamped, true);
    assert.equal(second[0].withdrawalStamped, false);
    assert.equal(mall.calls.eventsUpdated.length, 1);
    assert.equal(firstWithdrawal.by, 'accesses.delete');
    assert.deepEqual(mall.eventById('evt-accept-1').content.withdrawal, firstWithdrawal, 'at unchanged');
  });

  it('[DH22] the per-call notifyEventChanged is told of each event the hook changed', async () => {
    const notified = [];
    const notify = (userId, event) => notified.push(userId + ':' + event.id);

    const accepterMall = fakeMallWithInvite(structuredClone(ACCEPT_EVENT));
    const accepterHook = createAccessesDeletePostHook({ fetch: fakeFetch({ status: 201, body: {} }).fetch, mall: accepterMall });
    await accepterHook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS], notify);
    assert.deepEqual(notified, ['u1:evt-accept-1'], 'the withdrawal');

    notified.length = 0;
    const requesterMall = fakeMallWithInvite({ id: 'invite-dh', type: 'consent/request-cmc', content: { status: 'accepted' } });
    const requesterHook = createAccessesDeletePostHook({ fetch: fakeFetch({ status: 201, body: {} }).fetch, mall: requesterMall });
    await requesterHook('u2', [REQUESTER_SIDE_WITH_CAP], notify);
    assert.deepEqual(notified, ['u2:invite-dh'], 'the invite stamp');

    // without it the hook works as before
    const plainMall = fakeMallWithInvite(structuredClone(ACCEPT_EVENT));
    const plainHook = createAccessesDeletePostHook({ fetch: fakeFetch({ status: 201, body: {} }).fetch, mall: plainMall });
    assert.equal((await plainHook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]))[0].withdrawalStamped, true);
  });

  it('[DH19] a missing accept event or one of another type writes nothing; without a peer endpoint it is still recorded', async () => {
    for (const stored of [[], [{ id: 'evt-accept-1', type: 'consent/request-cmc', content: { status: 'accepted' } }]]) {
      const { fetch, calls } = fakeFetch({ status: 201, body: {} });
      const mall = fakeMallWithInvite(...stored);
      const hook = createAccessesDeletePostHook({ fetch, mall });
      const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);
      assert.equal(results[0].withdrawalStamped, false);
      assert.equal(results[0].peerNotified, true, 'delivery unaffected');
      assert.equal(calls.length, 1);
      assert.equal(mall.calls.eventsUpdated.length, 0);
    }

    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite(structuredClone(ACCEPT_EVENT));
    const hook = createAccessesDeletePostHook({ fetch, mall, logger: { error () {} } });
    const noEndpoint = structuredClone(ACCEPTER_SIDE_LEGACY_ACCESS);
    delete noEndpoint.clientData.cmc.backChannelApiEndpoint;
    const results = await hook('u1', [noEndpoint]);
    assert.equal(results[0].reason, 'cmc-revoke-no-peer-endpoint');
    assert.equal(results[0].withdrawalStamped, true);
    assert.equal(calls.length, 0);
    assert.equal(mall.eventById('evt-accept-1').content.withdrawal.by, 'accesses.delete');
  });

  it('[DH20] a failing event read is logged and never makes the hook throw', async () => {
    const warned = [];
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const mall = fakeMallWithInvite();
    mall.events.getOne = async () => { throw new Error('store down'); };
    const hook = createAccessesDeletePostHook({ fetch, mall, logger: { warn: (msg) => warned.push(msg) } });
    const results = await hook('u1', [ACCEPTER_SIDE_LEGACY_ACCESS]);

    assert.equal(results[0].withdrawalStamped, false);
    assert.equal(results[0].peerNotified, true);
    assert.equal(calls.length, 1);
    assert.ok(warned.some((m) => /acceptWithdrawal/.test(m)), JSON.stringify(warned));
  });

  // An account that accepted its own invite holds one access, the data grant
  // reused as the back-channel: capabilityId key, no acceptEventId, its own
  // token as the peer endpoint.
  const SELF_RELATIONSHIP = {
    id: 'acc-self',
    token: 'self-tok',
    type: 'shared',
    clientData: {
      cmc: {
        role: 'counterparty',
        appCode: 'my-app',
        capabilityId: 'cap-self',
        counterparty: { username: 'alice', host: 'example.org', apiEndpoint: 'https://self-tok@alice.example.org/' },
        backChannelApiEndpoint: 'https://self-tok@alice.example.org/',
      },
    },
  };

  it('[DH23] deleting a self-relationship records the withdrawal on the accept that minted it, and delivers nothing', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const other = { ...structuredClone(ACCEPT_EVENT), id: 'evt-accept-other', content: { status: 'completed', dataGrantAccessId: 'acc-other' } };
    const own = { ...structuredClone(ACCEPT_EVENT), id: 'evt-accept-self', content: { status: 'completed', dataGrantAccessId: 'acc-self' } };
    const mall = fakeMallWithInvite(other, own);
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const results = await hook('u1', [SELF_RELATIONSHIP]);

    assert.equal(results[0].withdrawalStamped, true);
    assert.equal(results[0].reason, 'self-relationship');
    assert.equal(results[0].attempted, false);
    assert.equal(calls.length, 0, 'no delivery to the deleted access');
    assert.equal(mall.eventById('evt-accept-self').content.withdrawal.by, 'accesses.delete');
    assert.equal(mall.eventById('evt-accept-self').content.withdrawal.accessId, 'acc-self');
    assert.equal(mall.eventById('evt-accept-other').content.withdrawal, undefined);
  });

  it('[DH24] a requester back-channel whose endpoint is not its own token stays untouched and is delivered', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: {} });
    const own = { ...structuredClone(ACCEPT_EVENT), id: 'evt-accept-x', content: { status: 'completed', dataGrantAccessId: 'acc-back-channel-cap' } };
    const mall = fakeMallWithInvite(own);
    const hook = createAccessesDeletePostHook({ fetch, mall });
    const results = await hook('u1', [{ ...structuredClone(REQUESTER_SIDE_WITH_CAP), token: 'back-tok' }]);

    assert.equal(results[0].withdrawalStamped, false);
    assert.equal(results[0].peerNotified, true);
    assert.equal(calls.length, 1);
    assert.equal(mall.calls.eventsGot ?? 0, 0, 'no accept lookup');
    assert.equal(mall.eventById('evt-accept-x').content.withdrawal, undefined);
  });
});
