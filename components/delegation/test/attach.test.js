/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Attach-handshake orchestration tests.
 *
 * The orchestration is pure: it reaches storage through an injected mall and
 * reaches the peer core through injected delivery functions. These tests wire a
 * single in-memory fake mall holding BOTH accounts (B and A) keyed by userId,
 * and inject delivery functions that dispatch straight to the plugin's own
 * controlled-side / system handlers against that same store — simulating the
 * two cores of a same-platform cross-core handshake without any HTTP.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const attach = require('../src/attach.ts');
const store = require('../src/store.ts');

const USER_B = 'user-b-id';
const USER_A = 'user-a-id';
const NAME_B = 'bob';
const NAME_A = 'alice';
const HOST = 'core.example.com';
const HOST_SLUG = 'core-example-com';

let seq = 0;
function nowSeconds () { return 1_700_000_000; }
function idGen () { return 'rel' + (++seq); }

// ---- fake mall (streams + events + accesses), shared by both accounts -------

function makeFakeMall () {
  const events = new Map(); // userId -> [event]
  const accesses = new Map(); // userId -> [access]
  let eid = 0;
  let aid = 0;
  const nameFor = (userId) => (userId === USER_B ? NAME_B : NAME_A);

  function userEvents (userId) { if (!events.has(userId)) events.set(userId, []); return events.get(userId); }
  function userAccesses (userId) { if (!accesses.has(userId)) accesses.set(userId, []); return accesses.get(userId); }

  return {
    _events: events,
    _accesses: accesses,
    streams: {
      async create () { return {}; },       // parents are no-ops in the fake
      async delete () { return {}; },
    },
    events: {
      async create (userId, params) {
        const ev = { id: 'ev' + (++eid), streamIds: params.streamIds, type: params.type, time: params.time, content: params.content };
        userEvents(userId).push(ev);
        return ev;
      },
      async get (userId, params = {}) {
        let list = userEvents(userId).slice();
        if (Array.isArray(params.streams)) {
          // Accept both the normalized mall shape [{ any: [id] }] and a bare id list.
          const wanted = params.streams.flatMap((q) => (typeof q === 'string' ? [q] : (q?.any || [])));
          list = list.filter((e) => (e.streamIds || []).some((s) => wanted.includes(s)));
        }
        if (Array.isArray(params.types)) list = list.filter((e) => params.types.includes(e.type));
        return list;
      },
      async update (userId, params) {
        const list = userEvents(userId);
        const idx = list.findIndex((e) => e.id === params.id);
        if (idx >= 0) list[idx] = { ...list[idx], ...params, content: params.content ?? list[idx].content };
        return list[idx];
      },
      async delete (userId, params) {
        const list = userEvents(userId);
        const idx = list.findIndex((e) => e.id === params.id);
        if (idx >= 0) list.splice(idx, 1);
        return {};
      },
    },
    accesses: {
      async create (userId, params) {
        const token = 'tok' + (++aid);
        const access = {
          id: 'acc' + aid,
          token,
          apiEndpoint: 'https://' + token + '@' + HOST + '/' + nameFor(userId) + '/',
          type: params.type,
          name: params.name,
          permissions: params.permissions || [],
          clientData: params.clientData || null,
          expires: params.expires ?? null,
        };
        userAccesses(userId).push(access);
        return access;
      },
      async get (userId) { return userAccesses(userId).slice(); },
      async update (userId, params) {
        const list = userAccesses(userId);
        const idx = list.findIndex((a) => a.id === params.id);
        if (idx >= 0) list[idx] = { ...list[idx], ...(params.update || {}) };
        return list[idx];
      },
      async delete (userId, params) {
        const list = userAccesses(userId);
        const idx = list.findIndex((a) => a.id === params.id);
        if (idx >= 0) list.splice(idx, 1);
        return {};
      },
    },
  };
}

// ---- injected delivery wiring (simulates the two cores) ---------------------

function resolveTargetFor (usernameToUserId) {
  return async function resolveTarget (username) {
    const userId = usernameToUserId[username.toLowerCase()];
    return { found: userId != null, isSelf: true, userId, hostSlug: HOST_SLUG, host: HOST };
  };
}

function makeDeliverInvite (mall, usernameToUserId, opts = {}) {
  return async function deliverInvite (_target, payload) {
    if (opts.fail) return { ok: false, status: 503, body: null };
    const res = await attach.handleSystemInvite(
      { mall, now: nowSeconds, resolveLocalUserId: async (u) => usernameToUserId[u.toLowerCase()] ?? null },
      payload);
    return { ok: true, status: 200, body: res };
  };
}

function makeCallControlledSide (mall, controlledUserId) {
  return async function callControlledSide (_endpoint, action, body) {
    const deps = { mall, now: nowSeconds };
    if (action === 'accept-response') {
      const res = await attach.handleAcceptResponse(deps, { bUserId: controlledUserId, ...body });
      return { ok: true, status: 200, body: res };
    }
    if (action === 'accept-complete') {
      const res = await attach.handleAcceptComplete(deps, { bUserId: controlledUserId, ...body });
      return { ok: true, status: 200, body: res };
    }
    const res = await attach.handleRefuseResponse(deps, { bUserId: controlledUserId, ...body });
    return { ok: true, status: 200, body: res };
  };
}

const SELF_B = { username: NAME_B, host: HOST, hostSlug: HOST_SLUG };
const SELF_A = { username: NAME_A, host: HOST, hostSlug: HOST_SLUG };
const usernameMap = { [NAME_B]: USER_B, [NAME_A]: USER_A };

function requestDeps (mall, opts) {
  return {
    mall,
    now: nowSeconds,
    idGen,
    self: SELF_B,
    inviteTtlSeconds: 3600,
    resolveTarget: resolveTargetFor(usernameMap),
    deliverInvite: makeDeliverInvite(mall, usernameMap, opts),
  };
}
function acceptDeps (mall) {
  return { mall, now: nowSeconds, idGen, self: SELF_A, callControlledSide: makeCallControlledSide(mall, USER_B) };
}

async function anchorFor (mall, relDelegate) {
  return store.findAnchorByDelegate(mall, USER_B, relDelegate);
}
async function markerOf (mall, userId, relId, kind) {
  return store.findMarkerAccess(mall, userId, relId, kind);
}

// ------------------------------------------------------------------- tests

describe('delegation attach handshake', function () {
  beforeEach(function () { seq = 0; });

  it('requestAttach creates a pending anchor + capability and mirrors it on A', async function () {
    const mall = makeFakeMall();
    const res = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    assert.equal(res.status, C.STATUS.INVITE);
    assert.equal(res.delegate.username, NAME_A);

    const anchor = await anchorFor(mall, NAME_A);
    assert.ok(anchor, 'anchor exists on B');
    assert.equal(anchor.content.status, C.STATUS.INVITE);

    const cap = await markerOf(mall, USER_B, res.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
    assert.ok(cap, 'invite capability minted on B');

    const mirror = await store.findMirrorByRelId(mall, USER_A, res.relId);
    assert.ok(mirror, 'mirror created on A');
    assert.equal(mirror.content.status, C.STATUS.INVITE);
    assert.ok(mirror.content.capabilityUrl, 'mirror carries the capability url during invite');
  });

  it('rejects a duplicate request to the same delegate', async function () {
    const mall = makeFakeMall();
    await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await assert.rejects(
      attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A }),
      (e) => e.id === 'delegation-already-exists');
  });

  it('rejects self-delegation and unknown delegate', async function () {
    const mall = makeFakeMall();
    await assert.rejects(
      attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_B }),
      (e) => e.id === 'delegation-self-not-allowed');
    await assert.rejects(
      attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: 'nobody' }),
      (e) => e.id === 'delegation-unknown-username');
  });

  it('rolls back atomically when invite delivery fails', async function () {
    const mall = makeFakeMall();
    await assert.rejects(
      attach.requestAttach(requestDeps(mall, { fail: true }), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A }),
      (e) => e.id === 'delegation-delivery-failed');
    const anchor = await anchorFor(mall, NAME_A);
    assert.equal(anchor, null, 'anchor rolled back');
    const caps = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation != null);
    assert.equal(caps.length, 0, 'capability rolled back');
  });

  it('accept drives the full lifecycle invite -> active with capability GC', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    const acc = await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    assert.equal(acc.status, C.STATUS.ACTIVE);

    const anchor = await anchorFor(mall, NAME_A);
    assert.equal(anchor.content.status, C.STATUS.ACTIVE);
    assert.ok(anchor.content.controlAccessId, 'control access recorded on anchor');
    assert.ok(anchor.content.notifyApiEndpoint, 'notify endpoint stored for teardown mirror-sync');

    const control = await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.CONTROL);
    assert.ok(control, 'control access minted on B');
    const cap = await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY);
    assert.equal(cap, null, 'invite capability GC-ed after activation');

    const mirror = await store.findMirrorByRelId(mall, USER_A, req.relId);
    assert.equal(mirror.content.status, C.STATUS.ACTIVE);
    assert.ok(mirror.content.controlApiEndpoint, 'A stores the control endpoint');
    assert.equal(mirror.content.capabilityUrl, undefined, 'capability url scrubbed at accept');

    const notify = await markerOf(mall, USER_A, req.relId, C.CLIENTDATA_KIND.NOTIFY);
    assert.ok(notify, 'notify access minted on A');
  });

  it('accept is idempotent — re-accept returns active without a second control access', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    const again = await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    assert.equal(again.status, C.STATUS.ACTIVE);
    const controls = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL && a.clientData.delegation.relId === req.relId);
    assert.equal(controls.length, 1, 'exactly one control access');
  });

  it('refuse tears down both sides of a pending invite', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await attach.refuseAttach(acceptDeps(mall), { aUserId: USER_A, controlledUsername: NAME_B });

    assert.equal(await anchorFor(mall, NAME_A), null, 'B anchor deleted');
    assert.equal(await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY), null, 'B capability GC-ed');
    assert.equal(await store.findMirrorByRelId(mall, USER_A, req.relId), null, 'A mirror deleted');
  });

  it('cancelInvite removes a pending request and its mirror', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    const cancelDeps = { mall, now: nowSeconds, self: SELF_B, resolveTarget: resolveTargetFor(usernameMap), deliverInvite: makeDeliverInvite(mall, usernameMap) };
    await attach.cancelInvite(cancelDeps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    assert.equal(await anchorFor(mall, NAME_A), null, 'anchor removed');
    assert.equal(await store.findMirrorByRelId(mall, USER_A, req.relId), null, 'mirror removed');
  });

  it('cancelInvite refuses to remove an ACTIVE relationship', async function () {
    const mall = makeFakeMall();
    await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    const cancelDeps = { mall, now: nowSeconds, self: SELF_B, resolveTarget: resolveTargetFor(usernameMap), deliverInvite: makeDeliverInvite(mall, usernameMap) };
    await assert.rejects(
      attach.cancelInvite(cancelDeps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A }),
      (e) => e.id === 'delegation-not-active');
  });

  it('lists reflect status through each transition and never leak secrets', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    let delegates = (await attach.listDelegates(mall, USER_B)).delegates;
    assert.equal(delegates.length, 1);
    assert.equal(delegates[0].status, C.STATUS.INVITE);

    let controlled = (await attach.listControlled(mall, USER_A)).controlled;
    assert.equal(controlled.length, 1);
    assert.equal(controlled[0].status, C.STATUS.INVITE);
    // No capability url / control endpoint / token leaked.
    assert.equal(JSON.stringify(controlled).includes('capabilityUrl'), false);
    assert.equal(JSON.stringify(controlled).includes('controlApiEndpoint'), false);
    assert.equal(JSON.stringify(controlled).includes('tok'), false);

    await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    delegates = (await attach.listDelegates(mall, USER_B)).delegates;
    assert.equal(delegates[0].status, C.STATUS.ACTIVE);
    controlled = (await attach.listControlled(mall, USER_A)).controlled;
    assert.equal(controlled[0].status, C.STATUS.ACTIVE);
    assert.equal(JSON.stringify(controlled).includes('controlApiEndpoint'), false, 'active mirror still hides control endpoint');
    assert.equal(controlled[0].relId, req.relId);
  });

  it('crash-window re-accept heals the anchor and never mints a second control access', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    // Simulate a crash AFTER the control access was minted but BEFORE the anchor
    // flip: the control row exists, the anchor is still `invite`.
    const control = await store.mintMarkerAccess(mall, USER_B, {
      name: '__deleg-ctl-' + req.relId.substring(0, 8),
      clientDataDelegation: { kind: C.CLIENTDATA_KIND.CONTROL, relId: req.relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG } },
      expires: null,
    });
    const res = await attach.handleAcceptResponse({ mall, now: nowSeconds }, {
      bUserId: USER_B, relId: req.relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG },
    });
    assert.equal(res.controlApiEndpoint, control.apiEndpoint, 're-accept returns the SAME control endpoint');
    const anchor = await anchorFor(mall, NAME_A);
    assert.equal(anchor.content.status, C.STATUS.ACTIVE, 'anchor healed to active');
    assert.equal(anchor.content.controlAccessId, control.id, 'anchor points at the existing control access');
    const controls = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL && a.clientData.delegation.relId === req.relId);
    assert.equal(controls.length, 1, 'exactly one control access for the relId');
  });

  it('cross-core lost response: invite capability survives and re-accept returns the same endpoint', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    // A calls B; B commits (control minted + anchor active) but the response is
    // lost in transit → acceptAttach reports a delivery failure and leaves A's
    // mirror at `invite`. Crucially B must NOT have GC-ed the invite capability
    // (D1) — it is the only credential a cross-core re-accept has.
    let firstCall = true;
    const lossyDeps = {
      mall,
      now: nowSeconds,
      idGen,
      self: SELF_A,
      callControlledSide: async (endpoint, action, body) => {
        if (action === 'accept-response' && firstCall) {
          firstCall = false;
          await attach.handleAcceptResponse({ mall, now: nowSeconds }, { bUserId: USER_B, ...body });
          throw new Error('network reset after B committed');
        }
        return makeCallControlledSide(mall, USER_B)(endpoint, action, body);
      },
    };
    await assert.rejects(
      attach.acceptAttach(lossyDeps, { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B }),
      (e) => e.id === 'delegation-delivery-failed');

    assert.ok(await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.INVITE_CAPABILITY), 'invite capability survived the lost response');
    const bAnchor = await anchorFor(mall, NAME_A);
    assert.equal(bAnchor.content.status, C.STATUS.ACTIVE, 'B committed the activation');

    // Re-accept: B re-returns the SAME endpoint via the surviving capability.
    const again = await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    assert.equal(again.status, C.STATUS.ACTIVE);
    const mirror = await store.findMirrorByRelId(mall, USER_A, req.relId);
    assert.equal(mirror.content.status, C.STATUS.ACTIVE);
    const controls = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL && a.clientData.delegation.relId === req.relId);
    assert.equal(controls.length, 1, 'still exactly one control access');
    assert.equal(mirror.content.controlApiEndpoint, controls[0].apiEndpoint, 'A stored the SAME control endpoint B minted');
  });

  it('same-core accept rejects an expired invite capability', async function () {
    const mall = makeFakeMall();
    // ttl -1 → the invite capability is minted already-expired.
    const req = await attach.requestAttach({ ...requestDeps(mall), inviteTtlSeconds: -1 }, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await assert.rejects(
      attach.handleAcceptResponse({ mall, now: nowSeconds }, {
        bUserId: USER_B, relId: req.relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG },
      }),
      (e) => e.id === 'delegation-invite-expired');
  });

  it('accept rejects a delegate-identity mismatch and stamps the anchor values', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    // Mismatched username → rejected, no control minted.
    await assert.rejects(
      attach.handleAcceptResponse({ mall, now: nowSeconds }, {
        bUserId: USER_B, relId: req.relId, delegate: { username: 'mallory', hostSlug: HOST_SLUG },
      }),
      (e) => e.id === 'delegation-delegate-mismatch');
    assert.equal(await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.CONTROL), null, 'no control minted on mismatch');

    // Correct username (case-insensitive) but tampered hostSlug → accepted, and
    // the control marker carries the ANCHOR's values, never the caller's.
    const res = await attach.handleAcceptResponse({ mall, now: nowSeconds }, {
      bUserId: USER_B, relId: req.relId, delegate: { username: NAME_A.toUpperCase(), hostSlug: 'evil-host' },
    });
    assert.ok(res.controlApiEndpoint);
    const control = await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.CONTROL);
    assert.equal(control.clientData.delegation.delegate.username, NAME_A, 'stamped anchor username');
    assert.equal(control.clientData.delegation.delegate.hostSlug, HOST_SLUG, 'stamped anchor hostSlug, not caller-supplied');
  });

  it('accept cleans up the minted control access when the anchor flip fails', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    // Simulate the anchor being deleted concurrently (accept racing cancelInvite):
    // the flip throws. The just-minted control access must be swept — no orphan.
    const failingMall = {
      ...mall,
      events: { ...mall.events, update: async () => { throw new Error('anchor gone'); } },
    };
    await assert.rejects(
      attach.handleAcceptResponse({ mall: failingMall, now: nowSeconds }, {
        bUserId: USER_B, relId: req.relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG },
      }),
      (e) => /anchor gone/.test(String(e.message)));
    const controls = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL && a.clientData.delegation.relId === req.relId);
    assert.equal(controls.length, 0, 'no orphan control access left behind');
  });

  it('refuseResponse is a no-op on an already-active anchor', async function () {
    const mall = makeFakeMall();
    const req = await attach.requestAttach(requestDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await attach.acceptAttach(acceptDeps(mall), { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });
    // A replayed / stale refuse must not tear down an activated relationship.
    await attach.handleRefuseResponse({ mall, now: nowSeconds }, { bUserId: USER_B, relId: req.relId });
    const anchor = await anchorFor(mall, NAME_A);
    assert.equal(anchor.content.status, C.STATUS.ACTIVE, 'anchor stays active');
    assert.ok(await markerOf(mall, USER_B, req.relId, C.CLIENTDATA_KIND.CONTROL), 'control access untouched');
  });
});
