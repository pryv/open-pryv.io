/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * Create-from-delegate orchestration tests.
 *
 * The orchestration is pure: it reaches storage through an injected mall,
 * provisions the account through an injected provisionAccount/rollbackAccount
 * pair (which the api-server backs with the platform claim + repository insert),
 * and reaches the target core through an injected deliverer. These tests wire a
 * single in-memory fake mall holding BOTH accounts (A and the created B) and
 * dispatch the deliverer straight into the plugin's own target-core handler —
 * simulating the same-core fast path without any HTTP.
 */

const assert = require('node:assert/strict');
const C = require('../src/constants.ts');
const createAccountMod = require('../src/createAccount.ts');
const store = require('../src/store.ts');

const USER_A = 'user-a-id';
const USER_B = 'user-b-id';
const NAME_A = 'alice';
const NAME_B = 'kid';
const HOST = 'core.example.com';
const HOST_SLUG = 'core-example-com';

function nowSeconds () { return 1_700_000_000; }
let seq = 0;
function idGen () { return 'rel' + (++seq); }

// ---- fake mall (streams + events + accesses), shared by both accounts -------

function makeFakeMall (opts = {}) {
  const events = new Map();
  const accesses = new Map();
  let eid = 0;
  let aid = 0;
  const nameFor = (userId) => (userId === USER_A ? NAME_A : NAME_B);
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
        if (opts.failControlMint && params.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL) {
          throw new Error('control mint blew up');
        }
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

// ---- injected provisioning + delivery wiring (simulates the target core) ----

const SELF_A = { host: HOST, hostSlug: HOST_SLUG };
const SELF_B = { host: HOST, hostSlug: HOST_SLUG };

/** A fake provisioning pair recording the created account + rollbacks. */
function makeProvisioning (mall, opts = {}) {
  const record = { provisioned: null, rolledBack: [] };
  const delegation = { errorIds: require('../src/errorIds.ts'), attach: require('../src/attach.ts') };
  const provisionAccount = async (params) => {
    if (opts.usernameTaken) {
      throw delegation.attach.delegationError(delegation.errorIds.DelegationErrorIds.USERNAME_TAKEN, 'taken', 409, { username: params.username });
    }
    record.provisioned = { username: params.username, email: params.email, password: params.password, language: params.language, userId: USER_B };
    return { userId: USER_B };
  };
  const rollbackAccount = async (username, userId) => { record.rolledBack.push({ username, userId }); };
  return { record, systemDeps: { mall, now: nowSeconds, self: SELF_B, provisionAccount, rollbackAccount } };
}

function makeResolveTargetCore (opts = {}) {
  return async function resolveTargetCore (core) {
    if (opts.unknownCore) {
      throw require('../src/attach.ts').delegationError(require('../src/errorIds.ts').DelegationErrorIds.UNKNOWN_CORE, 'unknown core', 400);
    }
    return { isSelf: true, hostSlug: HOST_SLUG, host: HOST, coreBaseUrl: undefined };
  };
}

function makeCallCreateAccount (systemDeps) {
  return async function callCreateAccount (_target, payload) {
    try {
      const res = await createAccountMod.handleSystemCreateAccount(systemDeps, payload);
      return { ok: true, status: 200, body: res };
    } catch (err) {
      if (err && typeof err.id === 'string' && typeof err.httpStatus === 'number') {
        return { ok: false, status: err.httpStatus, body: { id: err.id } };
      }
      throw err;
    }
  };
}

function createDeps (mall, systemDeps, opts = {}) {
  return {
    mall,
    now: nowSeconds,
    idGen,
    self: SELF_A,
    resolveTargetCore: makeResolveTargetCore(opts),
    callCreateAccount: makeCallCreateAccount(systemDeps),
  };
}

// ------------------------------------------------------------------- tests

describe('delegation create-from-delegate', function () {
  beforeEach(function () { seq = 0; });

  it('mints an active anchor + control access + user, and A stores the active mirror', async function () {
    const mall = makeFakeMall();
    const { record, systemDeps } = makeProvisioning(mall);
    const res = await createAccountMod.createAccount(createDeps(mall, systemDeps), {
      aUserId: USER_A, aUsername: NAME_A, username: NAME_B, email: 'kid@example.com', password: 'secret123', core: undefined, language: 'en',
    });

    assert.equal(res.delegation.status, C.STATUS.ACTIVE);
    assert.equal(res.delegation.controlled.username, NAME_B);
    assert.equal(res.delegation.controlled.hostSlug, HOST_SLUG);
    assert.ok(res.delegation.relId);

    // The user was provisioned with the delegate-supplied credentials.
    assert.equal(record.provisioned.username, NAME_B);
    assert.equal(record.provisioned.email, 'kid@example.com');
    assert.equal(record.provisioned.password, 'secret123');
    assert.deepEqual(record.rolledBack, [], 'happy path performs no rollback');

    // B has an active anchor + a control access.
    const anchor = await store.findAnchorByRelId(mall, USER_B, res.delegation.relId);
    assert.ok(anchor, 'anchor on B');
    assert.equal(anchor.content.status, C.STATUS.ACTIVE);
    assert.equal(anchor.content.delegate.username, NAME_A);
    assert.ok(anchor.content.controlAccessId, 'anchor points at the control access');
    assert.ok(anchor.content.notifyApiEndpoint, 'anchor stores A\'s notify endpoint');

    const control = await store.findMarkerAccess(mall, USER_B, res.delegation.relId, C.CLIENTDATA_KIND.CONTROL);
    assert.ok(control, 'control access minted on B');
    assert.equal(control.clientData.delegation.delegate.username, NAME_A);

    // A has the active mirror + a notify access; no secrets leaked in the result.
    const mirror = await store.findMirrorByRelId(mall, USER_A, res.delegation.relId);
    assert.equal(mirror.content.status, C.STATUS.ACTIVE);
    assert.ok(mirror.content.controlApiEndpoint, 'A stores the control endpoint');
    const notify = await store.findMarkerAccess(mall, USER_A, res.delegation.relId, C.CLIENTDATA_KIND.NOTIFY);
    assert.ok(notify, 'notify access kept on A for teardown mirror-sync');
    assert.equal(JSON.stringify(res).includes('controlApiEndpoint'), false, 'control endpoint not returned to the client');
  });

  it('supports an email-less + password-less account (reachable only via delegates)', async function () {
    const mall = makeFakeMall();
    const { record, systemDeps } = makeProvisioning(mall);
    const res = await createAccountMod.createAccount(createDeps(mall, systemDeps), {
      aUserId: USER_A, aUsername: NAME_A, username: NAME_B,
    });
    assert.equal(res.delegation.status, C.STATUS.ACTIVE);
    // Neither credential was supplied; the api-server helper substitutes a random
    // password hash for a missing password (asserted in the integration test).
    assert.equal(record.provisioned.email, undefined, 'no email passed through');
    assert.equal(record.provisioned.password, undefined, 'no password passed through');
    const control = await store.findMarkerAccess(mall, USER_B, res.delegation.relId, C.CLIENTDATA_KIND.CONTROL);
    assert.ok(control, 'control access minted even without credentials');
  });

  it('rejects an unknown target core and leaves no residue on A', async function () {
    const mall = makeFakeMall();
    const { systemDeps } = makeProvisioning(mall);
    await assert.rejects(
      createAccountMod.createAccount(createDeps(mall, systemDeps, { unknownCore: true }), {
        aUserId: USER_A, aUsername: NAME_A, username: NAME_B, core: 'no-such-core',
      }),
      (e) => e.id === 'delegation-unknown-core');
    // No notify access minted (rejected before provisioning), no mirror written.
    const notifyAccesses = (await mall.accesses.get(USER_A)).filter((a) => a.clientData?.delegation != null);
    assert.equal(notifyAccesses.length, 0, 'no A-side residue');
    assert.equal((await store.listMirrors(mall, USER_A)).length, 0, 'no mirror written');
  });

  it('rejects self-delegation', async function () {
    const mall = makeFakeMall();
    const { systemDeps } = makeProvisioning(mall);
    await assert.rejects(
      createAccountMod.createAccount(createDeps(mall, systemDeps), { aUserId: USER_A, aUsername: NAME_A, username: NAME_A }),
      (e) => e.id === 'delegation-self-not-allowed');
  });

  it('username-taken bubbles up and A sweeps its pre-provisioned notify (no residue)', async function () {
    const mall = makeFakeMall();
    const { record, systemDeps } = makeProvisioning(mall, { usernameTaken: true });
    await assert.rejects(
      createAccountMod.createAccount(createDeps(mall, systemDeps), { aUserId: USER_A, aUsername: NAME_A, username: NAME_B }),
      (e) => e.id === 'delegation-username-taken');
    // The account was never created, so no rollback; A's notify access is swept.
    assert.deepEqual(record.rolledBack, [], 'no account rollback when the claim itself failed');
    const residue = (await mall.accesses.get(USER_A)).filter((a) => a.clientData?.delegation != null);
    assert.equal(residue.length, 0, 'A-side notify swept after the failed create');
    assert.equal((await store.listMirrors(mall, USER_A)).length, 0, 'no mirror written');
  });

  it('rolls the whole account back when the control mint fails after user creation', async function () {
    // handleSystemCreateAccount directly: the account is provisioned, then the
    // control-access mint blows up → the account must be rolled back and nothing
    // left behind on B.
    const mall = makeFakeMall({ failControlMint: true });
    const { record, systemDeps } = makeProvisioning(mall);
    await assert.rejects(
      createAccountMod.handleSystemCreateAccount(systemDeps, {
        relId: 'rel-x', username: NAME_B, delegate: { username: NAME_A, hostSlug: HOST_SLUG }, notifyApiEndpoint: 'https://ntf',
      }),
      (e) => e.id === 'delegation-creation-failed');
    assert.deepEqual(record.rolledBack, [{ username: NAME_B, userId: USER_B }], 'account rolled back');
    assert.equal(await store.findAnchorByRelId(mall, USER_B, 'rel-x'), null, 'no anchor left on B');
    const controls = (await mall.accesses.get(USER_B)).filter((a) => a.clientData?.delegation?.kind === C.CLIENTDATA_KIND.CONTROL);
    assert.equal(controls.length, 0, 'no control access left on B');
  });
});
