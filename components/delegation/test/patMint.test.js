/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Delegate PAT mint tests (issueToken on B, getToken wrapper on A).
 *
 * Pure module: the session mint and all storage arrive via injected deps. The
 * fake mall here HONOURS an explicit access `token` (the real mall accesses
 * adapter does — the PAT token IS the session id) and stamps `apiEndpoint` from
 * the current token, exactly like the adapter, so token rotation on re-issue is
 * observable.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const patMint = require('../src/patMint.ts');
const attach = require('../src/attach.ts');
const store = require('../src/store.ts');

const USER_B = 'user-b-id';
const USER_A = 'user-a-id';
const NAME_B = 'bob';
const NAME_A = 'alice';
const HOST = 'core.example.com';
const HOST_SLUG = 'core-example-com';

function nowSeconds () { return 1_700_000_000; }

// ---- fake mall honouring explicit access tokens -----------------------------

function makeFakeMall () {
  const events = new Map();
  const accesses = new Map();
  let eid = 0;
  let aid = 0;
  const nameFor = (userId) => (userId === USER_B ? NAME_B : NAME_A);
  const endpoint = (userId, token) => 'https://' + token + '@' + HOST + '/' + nameFor(userId) + '/';
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
        // Re-stamp apiEndpoint from the (possibly rotated) token, as the adapter does.
        if (merged.token != null) merged.apiEndpoint = endpoint(userId, merged.token);
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

// ---- session mint fake (getMatching-else-generate) --------------------------

function makeSessionMint () {
  const sessions = new Map(); // "username|appId" -> sessionId
  let sid = 0;
  const fn = async function mintSession (username, appId) {
    const key = username + '|' + appId;
    if (sessions.has(key)) return sessions.get(key);
    const id = 'sess-' + (++sid);
    sessions.set(key, id);
    return id;
  };
  fn._sessions = sessions;
  fn._expire = (username, appId) => sessions.delete(username + '|' + appId);
  return fn;
}

// ---- anchor / mirror seeding ------------------------------------------------

async function seedActiveAnchor (mall, opts = {}) {
  const relId = opts.relId || 'rel-1';
  return store.createAnchor(mall, USER_B, {
    relId,
    delegate: { username: NAME_A, hostSlug: HOST_SLUG },
    status: opts.status || C.STATUS.ACTIVE,
    requestedAt: nowSeconds(),
    activatedAt: nowSeconds(),
  }, nowSeconds);
}

async function seedActiveMirror (mall, opts = {}) {
  const relId = opts.relId || 'rel-1';
  return store.createMirror(mall, USER_A, {
    relId,
    controlled: { username: NAME_B, hostSlug: HOST_SLUG },
    status: opts.status || C.STATUS.ACTIVE,
    controlApiEndpoint: opts.controlApiEndpoint ?? 'https://ctltoken@' + HOST + '/' + NAME_B + '/',
    requestedAt: nowSeconds(),
    activatedAt: nowSeconds(),
  }, nowSeconds);
}

function issueDeps (mall, mintSession) {
  return { mall, now: nowSeconds, mintSession };
}

// -------------------------------------------------------------------- tests

describe('delegation PAT mint (issueToken)', function () {
  it('mints a session-backed personal access with the delegate-pat marker', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);

    const res = await patMint.handleIssueToken(issueDeps(mall, mintSession), {
      bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1',
    });

    assert.ok(res.token, 'a token is returned');
    assert.ok(res.apiEndpoint.includes(res.token), 'apiEndpoint carries the PAT token');
    assert.ok(res.apiEndpoint.includes(NAME_B), 'apiEndpoint targets the controlled account');

    const pats = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.DELEGATE_PAT);
    assert.equal(pats.length, 1, 'exactly one PAT');
    const pat = pats[0];
    assert.equal(pat.type, 'personal', 'PAT is a personal-class access');
    assert.equal(pat.token, res.token, 'access token IS the session id');
    assert.equal(pat.name, 'delegation:' + NAME_A + '@' + HOST_SLUG, 'name is the login appId');
    assert.equal(pat.clientData.delegation.relId, 'rel-1');
    assert.equal(pat.clientData.delegation.delegate.username, NAME_A);
    assert.equal(pat.clientData.delegation.delegate.hostSlug, HOST_SLUG);
    assert.deepEqual(pat.permissions, [], 'no stream permissions — a personal token needs none');
  });

  it('records lastTokenIssuedAt + patAccessId on the anchor', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);

    await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' });

    const anchor = await store.findAnchorByRelId(mall, USER_B, 'rel-1');
    assert.equal(anchor.content.lastTokenIssuedAt, nowSeconds());
    const pats = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.DELEGATE_PAT);
    assert.equal(anchor.content.patAccessId, pats[0].id, 'anchor points at the PAT access');
  });

  it('idempotent re-issue returns the SAME token and never a second access or session', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);

    const first = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' });
    const second = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' });

    assert.equal(second.token, first.token, 're-issue reuses the live session token');
    const pats = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.DELEGATE_PAT);
    assert.equal(pats.length, 1, 'still exactly one PAT access');
    assert.equal(mintSession._sessions.size, 1, 'still exactly one session');
  });

  it('re-issue after session expiry rotates the token on the SAME access', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);

    const first = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' });
    mintSession._expire(NAME_B, 'delegation:' + NAME_A + '@' + HOST_SLUG);
    const second = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' });

    assert.notEqual(second.token, first.token, 'a fresh session mints a fresh token');
    const pats = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.DELEGATE_PAT);
    assert.equal(pats.length, 1, 'the same access is reused (token rotated)');
    assert.equal(pats[0].token, second.token, 'access carries the rotated token');
    assert.ok(second.apiEndpoint.includes(second.token), 'apiEndpoint reflects the rotated token');
  });

  it('rejects when the anchor is not active', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall, { status: C.STATUS.INVITE });
    await assert.rejects(
      patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1' }),
      (e) => e.id === 'delegation-not-active');
  });

  it('rejects when the relationship is unknown', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await assert.rejects(
      patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'nope' }),
      (e) => e.id === 'delegation-not-active');
  });

  it('rejects a delegate-identity mismatch and derives appId/marker from the anchor', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);
    await assert.rejects(
      patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1', expectDelegateUsername: 'mallory' }),
      (e) => e.id === 'delegation-delegate-mismatch');
    // Correct (case-insensitive) name → accepted; marker carries the anchor's values.
    const res = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId: 'rel-1', expectDelegateUsername: NAME_A.toUpperCase() });
    assert.ok(res.token);
  });
});

describe('delegation PAT wrapper (getToken)', function () {
  function makeCallControl (mall, mintSession) {
    // Same-core direct dispatch: relId → issueToken on B.
    return async function callControl (_controlApiEndpoint, relId) {
      try {
        const res = await patMint.handleIssueToken(issueDeps(mall, mintSession), { bUserId: USER_B, bUsername: NAME_B, relId, expectDelegateUsername: NAME_A });
        return { ok: true, status: 200, body: res };
      } catch (e) {
        return { ok: false, status: e.httpStatus || 500, body: { id: e.id } };
      }
    };
  }

  it('returns the PAT + B apiEndpoint for an active relationship', async function () {
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    await seedActiveAnchor(mall);
    await seedActiveMirror(mall);

    const res = await patMint.getToken({ mall, now: nowSeconds, callControl: makeCallControl(mall, mintSession) }, {
      aUserId: USER_A, controlledUsername: NAME_B,
    });
    assert.ok(res.token, 'PAT token returned to A');
    assert.ok(res.apiEndpoint.includes(NAME_B), 'B apiEndpoint returned to A');
    assert.ok(res.apiEndpoint.includes(res.token));
  });

  it('flips the mirror to stale and errors delegation-not-active on a peer 403', async function () {
    const mall = makeFakeMall();
    await seedActiveMirror(mall);
    const callControl = async () => ({ ok: false, status: 403, body: { id: 'invalid-access-token' } });
    await assert.rejects(
      patMint.getToken({ mall, now: nowSeconds, callControl }, { aUserId: USER_A, controlledUsername: NAME_B }),
      (e) => e.id === 'delegation-not-active');
    const mirror = await store.findMirrorByControlled(mall, USER_A, NAME_B);
    assert.equal(mirror.content.status, C.STATUS.STALE, 'mirror reconciled to stale');
  });

  it('errors when there is no mirror or it is not active', async function () {
    const mall = makeFakeMall();
    const callControl = async () => ({ ok: true, status: 200, body: { token: 't', apiEndpoint: 'e' } });
    await assert.rejects(
      patMint.getToken({ mall, now: nowSeconds, callControl }, { aUserId: USER_A, controlledUsername: NAME_B }),
      (e) => e.id === 'delegation-not-found');
    await seedActiveMirror(mall, { status: C.STATUS.INVITE });
    await assert.rejects(
      patMint.getToken({ mall, now: nowSeconds, callControl }, { aUserId: USER_A, controlledUsername: NAME_B }),
      (e) => e.id === 'delegation-not-active');
  });

  it('end-to-end same-core: handshake → getToken issues a working PAT', async function () {
    // Wire the full attach handshake same-core, then getToken through it.
    const mall = makeFakeMall();
    const mintSession = makeSessionMint();
    const usernameMap = { [NAME_B]: USER_B, [NAME_A]: USER_A };
    const resolveTarget = async (u) => ({ found: usernameMap[u.toLowerCase()] != null, isSelf: true, userId: usernameMap[u.toLowerCase()], hostSlug: HOST_SLUG, host: HOST });
    const deliverInvite = async (_t, payload) => ({ ok: true, status: 200, body: await attach.handleSystemInvite({ mall, now: nowSeconds, resolveLocalUserId: async (u) => usernameMap[u.toLowerCase()] ?? null }, payload) });
    const callControlledSide = async (_e, action, body) => {
      const deps = { mall, now: nowSeconds };
      if (action === 'accept-response') return { ok: true, status: 200, body: await attach.handleAcceptResponse(deps, { bUserId: USER_B, ...body }) };
      if (action === 'accept-complete') return { ok: true, status: 200, body: await attach.handleAcceptComplete(deps, { bUserId: USER_B, ...body }) };
      return { ok: true, status: 200, body: await attach.handleRefuseResponse(deps, { bUserId: USER_B, ...body }) };
    };
    let seq = 0;
    const reqDeps = { mall, now: nowSeconds, idGen: () => 'rel' + (++seq), self: { username: NAME_B, host: HOST, hostSlug: HOST_SLUG }, inviteTtlSeconds: 3600, resolveTarget, deliverInvite };
    const accDeps = { mall, now: nowSeconds, idGen: () => 'x', self: { username: NAME_A, host: HOST, hostSlug: HOST_SLUG }, callControlledSide };

    await attach.requestAttach(reqDeps, { bUserId: USER_B, bUsername: NAME_B, delegateUsername: NAME_A });
    await attach.acceptAttach(accDeps, { aUserId: USER_A, aUsername: NAME_A, controlledUsername: NAME_B });

    const res = await patMint.getToken({ mall, now: nowSeconds, callControl: makeCallControl(mall, mintSession) }, { aUserId: USER_A, controlledUsername: NAME_B });
    assert.ok(res.token);
    const pats = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.DELEGATE_PAT);
    assert.equal(pats.length, 1, 'the getToken round-trip minted exactly one PAT on B');
    assert.equal(pats[0].token, res.token);
  });
});
