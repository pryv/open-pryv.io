/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Authoritative-detach + genuine-login-gate tests (pure module, fake mall).
 *
 * The single most important assertion here is the genuine-login gate BOTH ways:
 * a delegate-PAT-shaped access (personal + clientData.delegation) is REJECTED,
 * and a clean personal login (no delegation marker) is ACCEPTED. The teardown
 * tests then prove that an active detach destroys the PAT session, deletes the
 * PAT + control + capability accesses, deletes the anchor, and best-effort
 * notifies the delegate.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const store = require('../src/store.ts');
const detach = require('../src/detach.ts');

const USER_B = 'user-b-id';
const USER_A = 'user-a-id';
const NAME_A = 'alice';
const NAME_B = 'bob';
const HOST = 'core.example.com';
const HOST_SLUG = 'core-example-com';

function nowSeconds () { return 1_700_000_000; }

function makeFakeMall () {
  const events = new Map();
  const accesses = new Map();
  let eid = 0;
  let aid = 0;
  const endpoint = (userId, token) => 'https://' + token + '@' + HOST + '/' + userId + '/';
  function userEvents (userId) { if (!events.has(userId)) events.set(userId, []); return events.get(userId); }
  function userAccesses (userId) { if (!accesses.has(userId)) accesses.set(userId, []); return accesses.get(userId); }
  return {
    _events: events,
    _accesses: accesses,
    streams: { async create () { return {}; }, async delete () { return {}; } },
    events: {
      async create (userId, params) {
        const ev = { id: 'ev' + (++eid), streamIds: params.streamIds, type: params.type, time: params.time, content: params.content };
        userEvents(userId).push(ev);
        return ev;
      },
      async get (userId, params = {}) {
        let list = userEvents(userId).slice();
        if (Array.isArray(params.streams)) {
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
        const token = params.token ?? ('tok' + (++aid));
        const access = {
          id: 'acc' + (++aid),
          token,
          apiEndpoint: endpoint(userId, token),
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
        if (idx < 0) return null;
        const merged = { ...list[idx], ...(params.update || {}) };
        list[idx] = merged;
        return merged;
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

const SELF_B = { username: NAME_B, host: HOST, hostSlug: HOST_SLUG };

async function seedActiveRelationship (mall, opts = {}) {
  const relId = opts.relId || 'rel-1';
  await store.createAnchor(mall, USER_B, {
    relId,
    delegate: { username: NAME_A, hostSlug: HOST_SLUG },
    status: C.STATUS.ACTIVE,
    requestedAt: nowSeconds(),
    activatedAt: nowSeconds(),
    notifyApiEndpoint: opts.notifyApiEndpoint ?? 'https://ntftoken@' + HOST + '/' + NAME_A + '/',
  }, nowSeconds);
  await store.mintMarkerAccess(mall, USER_B, {
    name: '__deleg-ctl-' + relId.substring(0, 8),
    clientDataDelegation: { kind: C.CLIENTDATA_KIND.CONTROL, relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG } },
    expires: null,
  });
  if (opts.withPat !== false) {
    await store.mintPersonalAccess(mall, USER_B, {
      name: 'delegation:' + NAME_A + '@' + HOST_SLUG,
      token: opts.patToken || 'sess-pat-1',
      clientDataDelegation: { kind: C.CLIENTDATA_KIND.DELEGATE_PAT, relId, delegate: { username: NAME_A, hostSlug: HOST_SLUG } },
    });
  }
  if (opts.withCapability) {
    await store.mintMarkerAccess(mall, USER_B, {
      name: '__deleg-inv-' + relId.substring(0, 8),
      clientDataDelegation: { kind: C.CLIENTDATA_KIND.INVITE_CAPABILITY, relId },
      expires: nowSeconds() + 3600,
    });
  }
  return relId;
}

function makeDeps (mall, spies = {}) {
  return {
    mall,
    now: nowSeconds,
    self: SELF_B,
    destroySession: async (token) => { (spies.destroyed ||= []).push(token); },
    resolveTarget: async (u) => ({ found: u.toLowerCase() === NAME_A, isSelf: true, userId: USER_A, hostSlug: HOST_SLUG, host: HOST }),
    deliverInvite: async (_t, payload) => { (spies.delivered ||= []).push(payload); return { ok: true, status: 200, body: {} }; },
    notifyDetach: async (endpoint, relId) => { (spies.notified ||= []).push({ endpoint, relId }); return { ok: true, status: 200, body: { ok: true } }; },
  };
}

function markersOf (mall, userId) {
  return (mall._accesses.get(userId) || []).map((a) => a.clientData?.delegation?.kind).filter(Boolean);
}

// ============================================================ genuine-login gate

describe('delegation genuine-login gate (isGenuineLoginAccess)', function () {
  it('ACCEPTS a clean personal login (no delegation marker)', function () {
    assert.equal(detach.isGenuineLoginAccess({ type: 'personal', clientData: null }), true);
    assert.equal(detach.isGenuineLoginAccess({ type: 'personal' }), true);
    assert.equal(detach.isGenuineLoginAccess({ type: 'personal', clientData: { some: 'thing' } }), true);
  });
  it('REJECTS a delegate PAT (personal + clientData.delegation marker)', function () {
    assert.equal(detach.isGenuineLoginAccess({ type: 'personal', clientData: { delegation: { kind: 'delegate-pat', relId: 'r' } } }), false);
  });
  it('REJECTS a control access and any non-personal token', function () {
    assert.equal(detach.isGenuineLoginAccess({ type: 'shared', clientData: { delegation: { kind: 'control', relId: 'r' } } }), false);
    assert.equal(detach.isGenuineLoginAccess({ type: 'shared', clientData: null }), false);
    assert.equal(detach.isGenuineLoginAccess({ type: 'app' }), false);
    assert.equal(detach.isGenuineLoginAccess(null), false);
    assert.equal(detach.isGenuineLoginAccess(undefined), false);
  });
});

// ============================================================ active teardown

describe('delegation detach — active teardown', function () {
  it('destroys the PAT session + deletes PAT/control/capability + anchor, then notifies A', async function () {
    const mall = makeFakeMall();
    await seedActiveRelationship(mall, { withCapability: true, patToken: 'sess-pat-xyz' });
    const spies = {};
    const deps = makeDeps(mall, spies);

    assert.deepEqual([...markersOf(mall, USER_B)].sort(), ['control', 'delegate-pat', 'invite-capability']);

    await detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    assert.deepEqual(spies.destroyed, ['sess-pat-xyz'], 'the PAT backing session is destroyed by its token');
    assert.deepEqual(markersOf(mall, USER_B), [], 'PAT, control and capability accesses are all gone');
    const anchor = await store.findAnchorByRelId(mall, USER_B, 'rel-1');
    assert.equal(anchor, null, 'the anchor is deleted');
    assert.equal((spies.notified || []).length, 1, 'A is notified once');
    assert.equal(spies.notified[0].relId, 'rel-1');
    assert.ok(spies.notified[0].endpoint.includes('ntftoken'), 'notify uses the anchor notify endpoint');
    assert.equal((spies.delivered || []).length, 0, 'no admin-key cancel on the active path');
  });

  it('[DDCH1] revokes the accesses granted through the delegation, and only those', async function () {
    const mall = makeFakeMall();
    await seedActiveRelationship(mall);
    const delegate = { username: NAME_A, hostSlug: HOST_SLUG };
    const child = await mall.accesses.create(USER_B, {
      type: 'app', name: 'app-for-kid', clientData: { delegation: { kind: C.CLIENTDATA_KIND.DELEGATED_CHILD, relId: 'rel-1', delegate, viaAccessId: 'pat' } },
    });
    await mall.accesses.create(USER_B, {
      type: 'shared', name: 'shared-by-child', clientData: { delegation: { kind: C.CLIENTDATA_KIND.DELEGATED_CHILD, relId: 'rel-1', delegate, viaAccessId: child.id } },
    });
    await mall.accesses.create(USER_B, {
      type: 'app', name: 'other-relationship', clientData: { delegation: { kind: C.CLIENTDATA_KIND.DELEGATED_CHILD, relId: 'rel-other', delegate, viaAccessId: 'pat2' } },
    });
    await mall.accesses.create(USER_B, { type: 'app', name: 'granted-by-kid', clientData: { x: 1 } });

    const outcome = await detach.detachDelegate(makeDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });

    assert.equal(outcome.revokedChildAccesses, 2);
    const left = (await mall.accesses.get(USER_B)).map((a) => a.name).sort();
    assert.deepEqual(left, ['granted-by-kid', 'other-relationship']);
  });

  it('tears down cleanly when no PAT was ever issued', async function () {
    const mall = makeFakeMall();
    await seedActiveRelationship(mall, { withPat: false });
    const spies = {};
    await detach.detachDelegate(makeDeps(mall, spies), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    assert.deepEqual(spies.destroyed || [], [], 'no session to destroy');
    assert.deepEqual(markersOf(mall, USER_B), [], 'control access swept');
    assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null);
  });

  it('completes teardown even when the A-notify fails (mirror reconciles lazily)', async function () {
    const mall = makeFakeMall();
    await seedActiveRelationship(mall);
    const deps = makeDeps(mall);
    deps.notifyDetach = async () => { throw new Error('A unreachable'); };
    await detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    assert.deepEqual(markersOf(mall, USER_B), [], 'B teardown is authoritative regardless of A reachability');
    assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null);
  });
});

// ============================================================ pending-invite cancel

describe('delegation detach — pending invite cancel', function () {
  it('sweeps the capability + anchor and tells A to drop the mirror (admin-key cancel)', async function () {
    const mall = makeFakeMall();
    await store.createAnchor(mall, USER_B, {
      relId: 'rel-2', delegate: { username: NAME_A, hostSlug: HOST_SLUG }, status: C.STATUS.INVITE, requestedAt: nowSeconds(),
    }, nowSeconds);
    await store.mintMarkerAccess(mall, USER_B, {
      name: '__deleg-inv-rel-2', clientDataDelegation: { kind: C.CLIENTDATA_KIND.INVITE_CAPABILITY, relId: 'rel-2' }, expires: nowSeconds() + 3600,
    });
    const spies = {};
    await detach.detachDelegate(makeDeps(mall, spies), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    assert.deepEqual(markersOf(mall, USER_B), [], 'capability swept');
    assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-2'), null, 'anchor removed');
    assert.equal((spies.delivered || []).length, 1, 'A notified via admin-key cancel');
    assert.equal(spies.delivered[0].action, 'cancel');
    assert.equal((spies.notified || []).length, 0, 'no notify-marker call at invite stage');
  });
});

// ============================================================ absent / idempotent

describe('delegation detach — absent relationship', function () {
  it('is a clean 404, not a crash', async function () {
    const mall = makeFakeMall();
    await assert.rejects(
      detach.detachDelegate(makeDeps(mall), { bUserId: USER_B, bUsername: NAME_B, delegateUsername: 'nobody' }),
      (e) => e.id === 'delegation-not-found' && e.httpStatus === 404);
  });
});

// ============================================================ A-side notify + dismiss

describe('delegation A-side detach-notify + stale dismissal', function () {
  async function seedMirror (mall, status) {
    await store.createMirror(mall, USER_A, {
      relId: 'rel-3',
      controlled: { username: NAME_B, hostSlug: HOST_SLUG },
      status,
      controlApiEndpoint: 'https://ctl@' + HOST + '/' + NAME_B + '/',
      requestedAt: nowSeconds(),
      activatedAt: nowSeconds(),
    }, nowSeconds);
    await store.mintMarkerAccess(mall, USER_A, {
      name: '__deleg-ntf-rel-3', clientDataDelegation: { kind: C.CLIENTDATA_KIND.NOTIFY, relId: 'rel-3' }, expires: null,
    });
  }

  it('handleDetachNotify drops the mirror + notify access (idempotent)', async function () {
    const mall = makeFakeMall();
    await seedMirror(mall, C.STATUS.ACTIVE);
    const res = await detach.handleDetachNotify({ mall, now: nowSeconds }, { aUserId: USER_A, relId: 'rel-3' });
    assert.deepEqual(res, { ok: true });
    assert.equal(await store.findMirrorByRelId(mall, USER_A, 'rel-3'), null, 'mirror gone');
    assert.deepEqual(markersOf(mall, USER_A), [], 'notify access gone');
    // idempotent
    assert.deepEqual(await detach.handleDetachNotify({ mall, now: nowSeconds }, { aUserId: USER_A, relId: 'rel-3' }), { ok: true });
  });

  it('dismissControlledMirror removes a stale mirror but refuses a live one', async function () {
    const mall = makeFakeMall();
    await seedMirror(mall, C.STATUS.ACTIVE);
    await assert.rejects(
      detach.dismissControlledMirror(mall, USER_A, NAME_B),
      (e) => e.id === 'delegation-mirror-not-stale' && e.httpStatus === 409);
    // flip to stale then dismiss
    const mirror = await store.findMirrorByControlled(mall, USER_A, NAME_B);
    await store.updateMirrorContent(mall, USER_A, mirror, { status: C.STATUS.STALE });
    await detach.dismissControlledMirror(mall, USER_A, NAME_B);
    assert.equal(await store.findMirrorByControlled(mall, USER_A, NAME_B), null, 'stale mirror dismissed');
    assert.deepEqual(markersOf(mall, USER_A), [], 'notify access cleaned up');
  });

  it('dismissControlledMirror on an unknown relationship is a clean 404', async function () {
    const mall = makeFakeMall();
    await assert.rejects(
      detach.dismissControlledMirror(mall, USER_A, 'ghost'),
      (e) => e.id === 'delegation-not-found' && e.httpStatus === 404);
  });
});
