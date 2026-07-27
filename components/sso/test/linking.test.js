/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [SSOL] SSO identity → account resolution (the linking rule table).
 *
 * Pure unit tests over `resolveAccountForIdentity` with injected fakes, one per
 * rule row — including the account-takeover gate (R6), the R4 sub-wins /
 * email-ignored behaviour, and R8 stale-binding cleanup.
 */

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);

const { resolveAccountForIdentity } = require('../src/linking.ts');

function makeDeps () {
  const state = {
    bindings: new Map(), // `${provider}|${sub}` -> username
    emails: new Map(), // email -> username
    users: new Set(), // existing usernames
    proved: new Set(), // `${username}|${email}` proved-owned
    warnings: []
  };
  const deps = {
    getBinding: async (p, s) => state.bindings.get(`${p}|${s}`) ?? null,
    setBinding: async (p, s, u) => { state.bindings.set(`${p}|${s}`, u); },
    releaseBinding: async (p, s, u) => { if (state.bindings.get(`${p}|${s}`) === u) state.bindings.delete(`${p}|${s}`); },
    getUsernameByEmail: async (e) => state.emails.get(e) ?? null,
    userExists: async (u) => state.users.has(u),
    isEmailProved: async (u, e) => state.proved.has(`${u}|${e}`),
    logger: { warn: (m) => state.warnings.push(m) }
  };
  return { deps, state };
}

function identity (over = {}) {
  return { provider: 'google', sub: 'sub-123', email: 'user@example.com', emailVerified: true, ...over };
}

describe('[SSOL] SSO account-linking rule table', () => {
  it('[SSOL1] R3: email_verified:false → refuse sso-failed', async () => {
    const { deps } = makeDeps();
    const out = await resolveAccountForIdentity(deps, identity({ emailVerified: false }));
    assert.deepEqual(out, { kind: 'refuse', code: 'sso-failed' });
  });

  it('[SSOL2] R4: existing binding → login that account, email NOT re-resolved', async () => {
    const { deps, state } = makeDeps();
    state.bindings.set('google|sub-123', 'alice');
    state.users.add('alice');
    // Email maps to nobody — must be irrelevant once bound.
    const out = await resolveAccountForIdentity(deps, identity({ email: 'unrelated@example.com' }));
    assert.deepEqual(out, { kind: 'login', username: 'alice' });
    assert.equal(state.warnings.length, 0);
  });

  it('[SSOL3] R4: sub wins over a diverged email, and it warns', async () => {
    const { deps, state } = makeDeps();
    state.bindings.set('google|sub-123', 'alice');
    state.users.add('alice');
    state.emails.set('user@example.com', 'bob'); // email now proves on a DIFFERENT account
    const out = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(out, { kind: 'login', username: 'alice' });
    assert.equal(state.warnings.length, 1, 'divergence should warn');
  });

  it('[SSOL4] R8: binding to a gone account → release + re-evaluate by email', async () => {
    const { deps, state } = makeDeps();
    state.bindings.set('google|sub-123', 'ghost'); // ghost does NOT exist
    state.emails.set('user@example.com', 'carol');
    state.users.add('carol');
    state.proved.add('carol|user@example.com');
    const out = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(out, { kind: 'login', username: 'carol' });
    assert.equal(state.bindings.get('google|sub-123'), 'carol', 'stale binding re-pointed to the resolved account');
  });

  it('[SSOL5] R5: no binding, email proved-owned → login + persist binding', async () => {
    const { deps, state } = makeDeps();
    state.emails.set('user@example.com', 'dave');
    state.users.add('dave');
    state.proved.add('dave|user@example.com');
    const out = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(out, { kind: 'login', username: 'dave' });
    assert.equal(state.bindings.get('google|sub-123'), 'dave', 'first-login binding persisted');
  });

  it('[SSOL6] R6 (takeover gate): email resolves but NOT proved → refuse email-not-verified, no binding', async () => {
    const { deps, state } = makeDeps();
    state.emails.set('user@example.com', 'victim');
    state.users.add('victim');
    // victim never PROVED the address (asserted only) — proved set is empty.
    const out = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(out, { kind: 'refuse', code: 'email-not-verified' });
    assert.equal(state.bindings.size, 0, 'no binding is created for an unproved match');
  });

  it('[SSOL7] R7: email resolves to nothing → refuse no-account', async () => {
    const { deps } = makeDeps();
    const out = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(out, { kind: 'refuse', code: 'no-account' });
  });

  it('[SSOL8] R7: null email claim → refuse no-account', async () => {
    const { deps } = makeDeps();
    const out = await resolveAccountForIdentity(deps, identity({ email: null }));
    assert.deepEqual(out, { kind: 'refuse', code: 'no-account' });
  });

  it('[SSOL9] R5 then R4: a second login rides the persisted binding (idempotent)', async () => {
    const { deps, state } = makeDeps();
    state.emails.set('user@example.com', 'erin');
    state.users.add('erin');
    state.proved.add('erin|user@example.com');
    const first = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(first, { kind: 'login', username: 'erin' });
    // Now the address loses its proved status; the binding must still log in.
    state.proved.clear();
    const second = await resolveAccountForIdentity(deps, identity());
    assert.deepEqual(second, { kind: 'login', username: 'erin' });
  });
});
