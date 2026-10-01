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
      async getOne (userId, eventId) {
        return userEvents(userId).find((e) => e.id === eventId) ?? null;
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
        const update = params.update || {};
        const merged = { ...list[idx], ...update };
        // The storage contract for an object on a JSON field: merged one level
        // into the stored object, a null entry removes the key.
        if (update.clientData != null && typeof update.clientData === 'object') {
          const clientData = { ...(list[idx].clientData || {}) };
          for (const [k, v] of Object.entries(update.clientData)) {
            if (v === null) delete clientData[k]; else clientData[k] = v;
          }
          merged.clientData = clientData;
        }
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

  describe('[DDR] consent grants given through the delegation', function () {
    const delegate = { username: NAME_A, hostSlug: HOST_SLUG };
    const childMarker = (relId) => ({ kind: C.CLIENTDATA_KIND.DELEGATED_CHILD, relId, delegate, viaAccessId: 'pat' });
    const cmcGrant = (relId) => ({
      cmc: { role: 'counterparty', appCode: 'study', counterparty: { username: 'doctor', host: 'peer.example.com', apiEndpoint: 'https://bc@peer.example.com/doctor/' } },
      delegation: childMarker(relId),
    });

    it('[DDR01] a consent grant is deleted at detach and its requester is notified, after the deletion', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const grant = await mall.accesses.create(USER_B, { type: 'shared', name: 'consent-for-kid', clientData: cmcGrant('rel-1') });
      const deps = makeDeps(mall);
      const notices = [];
      deps.notifyConsentGrantsRevoked = async (userId, grants) => {
        const stillThere = (await mall.accesses.get(USER_B)).some((a) => a.id === grant.id);
        notices.push({ userId, ids: grants.map((g) => g.id), stillThere, endpoint: grants[0]?.clientData?.cmc?.counterparty?.apiEndpoint });
      };
      await detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
      assert.deepEqual(notices, [{ userId: USER_B, ids: [grant.id], stillThere: false, endpoint: 'https://bc@peer.example.com/doctor/' }],
        'the requester notice gets the grant as it was (its endpoint), once it is deleted');
      assert.equal((await mall.accesses.get(USER_B)).some((a) => a.id === grant.id), false);
    });

    it('[DDR02] plain delegated accesses are deleted without a notice; another relationship\'s consent grant is untouched', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      await mall.accesses.create(USER_B, { type: 'app', name: 'app-for-kid', clientData: { delegation: childMarker('rel-1') } });
      await mall.accesses.create(USER_B, { type: 'shared', name: 'other-consent', clientData: cmcGrant('rel-other') });
      await mall.accesses.create(USER_B, { type: 'shared', name: 'owner-consent', clientData: { cmc: { role: 'counterparty' } } });
      const deps = makeDeps(mall);
      const notices = [];
      deps.notifyConsentGrantsRevoked = async (_u, grants) => { notices.push(grants.map((g) => g.name)); };
      const outcome = await detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
      assert.deepEqual(notices, [], 'no consent grant of this relationship, no notice');
      assert.deepEqual(outcome, { revokedChildAccesses: 1, revokedConsentGrants: 0, keptConsentGrants: 0 });
      const left = (await mall.accesses.get(USER_B)).map((a) => a.name).sort();
      assert.deepEqual(left, ['other-consent', 'owner-consent']);
    });

    it('[DDR03] counts, and a failing notice does not stop the teardown', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      await mall.accesses.create(USER_B, { type: 'shared', name: 'consent-1', clientData: cmcGrant('rel-1') });
      await mall.accesses.create(USER_B, { type: 'shared', name: 'consent-2', clientData: cmcGrant('rel-1') });
      await mall.accesses.create(USER_B, { type: 'app', name: 'app-for-kid', clientData: { delegation: childMarker('rel-1') } });
      const deps = makeDeps(mall);
      deps.notifyConsentGrantsRevoked = async () => { throw new Error('peer unreachable'); };
      const outcome = await detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
      assert.deepEqual(outcome, { revokedChildAccesses: 3, revokedConsentGrants: 2, keptConsentGrants: 0 });
      assert.deepEqual(await mall.accesses.get(USER_B), [], 'every access of the relationship is gone, control and PAT included');
      assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null);
    });
  });

  describe('[DDK] the owner\'s review: consent grants kept or dropped', function () {
    const delegate = { username: NAME_A, hostSlug: HOST_SLUG };
    const childMarker = (relId) => ({ kind: C.CLIENTDATA_KIND.DELEGATED_CHILD, relId, delegate, viaAccessId: 'pat' });

    /** A consent grant given through `relId`, with its accept event on B. */
    async function seedConsentGrant (mall, name, relId = 'rel-1') {
      const accept = await mall.events.create(USER_B, {
        streamIds: [':_cmc:apps:study:responses'],
        type: 'consent/accept-cmc',
        content: { status: 'completed', approvedBy: { delegate, relId } },
      });
      const grant = await mall.accesses.create(USER_B, {
        type: 'shared',
        name,
        clientData: {
          cmc: { role: 'counterparty', appCode: 'study', acceptEventId: accept.id, counterparty: { username: 'doctor', host: 'peer.example.com' } },
          delegation: childMarker(relId),
        },
      });
      return { grant, accept };
    }

    function detachWith (mall, keepAccessIds, spies = {}, onDestroySession = null) {
      const deps = makeDeps(mall, spies);
      if (onDestroySession != null) deps.destroySession = onDestroySession;
      deps.notifyConsentGrantsRevoked = async (_u, grants) => { (spies.revoked ||= []).push(...grants.map((g) => g.id)); };
      deps.logger = { warn: (msg) => { (spies.warned ||= []).push(msg); } };
      return detach.detachDelegate(deps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A, keepAccessIds });
    }

    async function assertUntouched (mall, before) {
      assert.deepEqual(await mall.accesses.get(USER_B), before, 'no access changed');
      assert.notEqual(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null, 'the relationship is still there');
    }

    it('[DDK01] a keep list that is not an array of ids is refused before anything is written', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant } = await seedConsentGrant(mall, 'consent-1');
      const before = structuredClone(await mall.accesses.get(USER_B));
      for (const keepAccessIds of [grant.id, { id: grant.id }, [grant.id, 3], [''], [null]]) {
        await assert.rejects(detachWith(mall, keepAccessIds),
          (e) => e.id === 'delegation-invalid-keep-list' && e.httpStatus === 400, JSON.stringify(keepAccessIds));
      }
      await assertUntouched(mall, before);
    });

    it('[DDK02] a keep id that is not a consent grant of this relationship is refused, and nothing changes', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant } = await seedConsentGrant(mall, 'consent-1');
      const { grant: otherRel } = await seedConsentGrant(mall, 'consent-other', 'rel-other');
      const plainChild = await mall.accesses.create(USER_B, { type: 'app', name: 'app-for-kid', clientData: { delegation: childMarker('rel-1') } });
      const ownerGrant = await mall.accesses.create(USER_B, { type: 'shared', name: 'owner-consent', clientData: { cmc: { role: 'counterparty' } } });
      const pat = await store.findMarkerAccess(mall, USER_B, 'rel-1', C.CLIENTDATA_KIND.DELEGATE_PAT);
      const before = structuredClone(await mall.accesses.get(USER_B));
      for (const foreign of [otherRel.id, plainChild.id, ownerGrant.id, pat.id, 'no-such-access']) {
        const spies = {};
        await assert.rejects(detachWith(mall, [grant.id, foreign], spies),
          (e) => e.id === 'delegation-invalid-keep-list' && e.httpStatus === 400 && e.data?.accessId === foreign, foreign);
        assert.deepEqual(spies.destroyed || [], [], 'the delegate session is not destroyed');
      }
      await assertUntouched(mall, before);
    });

    it('[DDK03] a kept grant loses the delegation marker, stays the requester\'s, and its accept event records the owner\'s confirmation', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant, accept } = await seedConsentGrant(mall, 'consent-kept');
      const spies = {};
      const outcome = await detachWith(mall, [grant.id], spies);
      const kept = (await mall.accesses.get(USER_B)).find((a) => a.id === grant.id);
      assert.ok(kept != null, 'the kept grant still exists');
      assert.equal('delegation' in kept.clientData, false, 'the delegation marker is removed, not set to null');
      assert.deepEqual(kept.clientData.cmc, grant.clientData.cmc, 'the consent part is unchanged');
      assert.equal(kept.token, grant.token, 'the requester keeps its token');
      const event = await mall.events.getOne(USER_B, accept.id);
      assert.equal(event.content.ownerConfirmedAt, nowSeconds());
      assert.deepEqual(event.content.approvedBy, accept.content.approvedBy, 'who approved stays as history');
      assert.deepEqual(spies.revoked || [], [], 'the requester of a kept grant is told nothing');
      assert.deepEqual(outcome, { revokedChildAccesses: 0, revokedConsentGrants: 0, keptConsentGrants: 1 });
      assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null, 'the relationship itself is gone');
    });

    it('[DDK04] a grant not kept is deleted and its requester notified', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant: keep } = await seedConsentGrant(mall, 'consent-kept');
      const { grant: drop } = await seedConsentGrant(mall, 'consent-dropped');
      const spies = {};
      const outcome = await detachWith(mall, [keep.id], spies);
      const left = (await mall.accesses.get(USER_B)).map((a) => a.id);
      assert.deepEqual(left, [keep.id]);
      assert.deepEqual(spies.revoked, [drop.id]);
      assert.deepEqual(outcome, { revokedChildAccesses: 1, revokedConsentGrants: 1, keptConsentGrants: 1 });
    });

    it('[DDK05] the other accesses granted through the delegation are deleted whatever the keep list', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant } = await seedConsentGrant(mall, 'consent-kept');
      await mall.accesses.create(USER_B, { type: 'app', name: 'app-for-kid', clientData: { delegation: childMarker('rel-1') } });
      const outcome = await detachWith(mall, [grant.id]);
      assert.deepEqual((await mall.accesses.get(USER_B)).map((a) => a.name), ['consent-kept']);
      assert.deepEqual(outcome, { revokedChildAccesses: 1, revokedConsentGrants: 0, keptConsentGrants: 1 });
    });

    it('[DDK06] an empty or absent keep list drops every consent grant', async function () {
      for (const keepAccessIds of [[], undefined, null]) {
        const mall = makeFakeMall();
        await seedActiveRelationship(mall);
        const { grant: g1 } = await seedConsentGrant(mall, 'consent-1');
        const { grant: g2 } = await seedConsentGrant(mall, 'consent-2');
        const spies = {};
        const outcome = await detachWith(mall, keepAccessIds, spies);
        assert.deepEqual(await mall.accesses.get(USER_B), [], String(keepAccessIds));
        assert.deepEqual(spies.revoked, [g1.id, g2.id]);
        assert.deepEqual(outcome, { revokedChildAccesses: 2, revokedConsentGrants: 2, keptConsentGrants: 0 });
      }
    });

    it('[DDK07] a dropped grant\'s accept event records the withdrawal, a kept one\'s the confirmation only', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant: keep, accept: keptAccept } = await seedConsentGrant(mall, 'consent-kept');
      const { accept: droppedAccept } = await seedConsentGrant(mall, 'consent-dropped');
      await detachWith(mall, [keep.id]);
      const dropped = await mall.events.getOne(USER_B, droppedAccept.id);
      assert.deepEqual(dropped.content.withdrawal, { at: nowSeconds(), by: 'delegation-detach', relId: 'rel-1' });
      assert.equal('ownerConfirmedAt' in dropped.content, false);
      assert.equal(dropped.content.status, 'completed', 'the rest of the content is unchanged');
      const kept = await mall.events.getOne(USER_B, keptAccept.id);
      assert.equal(kept.content.ownerConfirmedAt, nowSeconds());
      assert.equal('withdrawal' in kept.content, false);
    });

    it('[DDK08] a missing accept event is reported, and the teardown completes', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant, accept } = await seedConsentGrant(mall, 'consent-dropped');
      await mall.events.delete(USER_B, accept);
      const spies = {};
      const outcome = await detachWith(mall, [], spies);
      assert.deepEqual(spies.revoked, [grant.id]);
      assert.equal(spies.warned?.length, 1);
      assert.deepEqual(outcome, { revokedChildAccesses: 1, revokedConsentGrants: 1, keptConsentGrants: 0 });
      assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-1'), null);
    });

    it('[DDK09] a pending invite with a keep list is refused and stays pending', async function () {
      const mall = makeFakeMall();
      await store.createAnchor(mall, USER_B, {
        relId: 'rel-2', delegate, status: C.STATUS.INVITE, requestedAt: nowSeconds(),
      }, nowSeconds);
      await assert.rejects(detachWith(mall, ['any-id']), (e) => e.id === 'delegation-invalid-keep-list');
      assert.notEqual(await store.findAnchorByRelId(mall, USER_B, 'rel-2'), null);
    });

    it('[DDK10] a grant minted while the delegate token is being removed is still swept', async function () {
      const mall = makeFakeMall();
      await seedActiveRelationship(mall);
      const { grant: early } = await seedConsentGrant(mall, 'consent-early');
      let late = null;
      const spies = {};
      // step (1) runs after the keep list was checked: an accept completing now
      // passes its post-mint check against the still-present token
      const outcome = await detachWith(mall, [], spies, async () => {
        late = (await seedConsentGrant(mall, 'consent-late')).grant;
      });
      assert.ok(late != null);
      assert.deepEqual(await mall.accesses.get(USER_B), [], 'no marked grant outlives the delegation');
      assert.deepEqual(spies.revoked, [early.id, late.id]);
      assert.deepEqual(outcome, { revokedChildAccesses: 2, revokedConsentGrants: 2, keptConsentGrants: 0 });
    });
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
