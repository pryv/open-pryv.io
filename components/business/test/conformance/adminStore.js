/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * [ADKC] the platform-store usage of setup and administration (setup state,
 * setup code, setup and admin sessions, role rows, claim codes) on a real
 * platform engine: single use under concurrency, expiry, replacement, and no
 * plain code or token in the store. Run by each engine's PlatformDB
 * conformance suite.
 * @param {Function} getDB - async function returning an initialized PlatformDB instance
 */
export default function adminStoreConformance (getDB) {
  const assert = require('node:assert/strict');
  const setup = require('business/src/admin/setupState.ts');
  const roles = require('business/src/admin/roles.ts');
  const sessions = require('business/src/admin/sessions.ts');
  const { PERMISSIONS } = require('business/src/admin/permissions.ts');
  const { hashCode } = require('business/src/admin/codes.ts');

  const HOUR = 3600 * 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  describe('[ADKC] administration rows on the platform store', function () {
    this.timeout(20000);
    let db;

    before(async () => {
      db = await getDB();
      await db.deleteAll();
    });

    afterEach(async () => {
      await db.deleteAll();
    });

    async function dump () {
      return JSON.stringify(await db.listAllPlatformKvEntries());
    }

    async function pendingWithCode (ttlMs = HOUR) {
      assert.equal(await setup.claimFreshPending(db, { coreId: 'core-a', now: Date.now() }), true);
      return await setup.mintSetupCode(db, { coreId: 'core-a', ttlMs, now: Date.now() });
    }

    it('[ADKC2] fresh pending: of concurrent claims one wins; legacy ready never overwrites a row', async () => {
      const results = await Promise.all(['core-a', 'core-b', 'core-c'].map((coreId) => setup.claimFreshPending(db, { coreId, now: Date.now() })));
      assert.equal(results.filter(Boolean).length, 1);
      const state = await setup.readSetupState(db);
      assert.equal(state.state, 'pending');
      assert.equal(state.via, 'fresh');
      const after = await setup.recordLegacyReady(db, { coreId: 'core-b', now: Date.now() });
      assert.equal(after.state, 'pending', 'the pending row is kept');
      await db.deleteAll();
      const legacy = await setup.recordLegacyReady(db, { coreId: 'core-b', now: Date.now() });
      assert.equal(legacy.state, 'ready');
      assert.equal(legacy.via, 'legacy');
      assert.equal(await setup.claimFreshPending(db, { coreId: 'core-a', now: Date.now() }), false);
    });

    it('[ADKC3] a setup code redeems once; a second redeem fails; no plain code is stored', async () => {
      const minted = await pendingWithCode();
      assert.equal(minted.code.length, 26);
      const stored = await dump();
      assert.ok(!stored.includes(minted.code) && !stored.includes(minted.display), 'no plain code in the store');
      assert.ok(stored.includes(hashCode(minted.code)), 'the hash is the key');
      const row = await setup.redeemSetupCode(db, minted.display.toLowerCase());
      assert.equal(row.coreId, 'core-a');
      assert.equal(await setup.redeemSetupCode(db, minted.code), null);
      assert.equal((await setup.readSetupState(db)).codeKey, null, 'the pointer is cleared');
    });

    it('[ADKC4] concurrent redeems of one code: exactly one wins', async () => {
      const minted = await pendingWithCode();
      const results = await Promise.all(Array.from({ length: 6 }, () => setup.redeemSetupCode(db, minted.code)));
      assert.equal(results.filter((r) => r != null).length, 1);
    });

    it('[ADKC5] an expired setup code fails', async () => {
      const minted = await pendingWithCode(30);
      await sleep(60);
      assert.equal(await setup.pendingSetupCode(db), null);
      assert.equal(await setup.redeemSetupCode(db, minted.code), null);
    });

    it('[ADKC6] replacing the code invalidates the previous one; a pending code survives a re-read', async () => {
      const first = await pendingWithCode();
      const info = await setup.pendingSetupCode(db);
      assert.ok(info != null && info.expiresAt > Date.now());
      const second = await setup.mintSetupCode(db, { coreId: 'core-b', ttlMs: HOUR, now: Date.now() });
      assert.equal(await setup.redeemSetupCode(db, first.code), null, 'the old code is refused');
      assert.notEqual(await setup.redeemSetupCode(db, second.code), null, 'the new code works');
    });

    it('[ADKC7] a code row not pointed at by the state is refused (stale replacement)', async () => {
      const first = await pendingWithCode();
      // Simulate a replacement whose delete of the old row failed: the row
      // stays, the pointer moved on.
      await setup.installSetupCode(db, { codeHash: 'a'.repeat(64), coreId: 'core-a', ttlMs: HOUR, now: Date.now() });
      await db.setAccessState('setup-code/' + hashCode(first.code), { createdAt: Date.now(), coreId: 'core-a' }, Date.now() + HOUR);
      assert.equal(await setup.redeemSetupCode(db, first.code), null);
    });

    it('[ADKC8] after ready, no code is minted or redeemed and the pending code is gone', async () => {
      const minted = await pendingWithCode();
      await setup.markReady(db, { by: 'user-1', now: Date.now() });
      const state = await setup.readSetupState(db);
      assert.equal(state.state, 'ready');
      assert.equal(state.readyBy, 'user-1');
      assert.equal(await setup.redeemSetupCode(db, minted.code), null);
      assert.equal(await setup.mintSetupCode(db, { coreId: 'core-a', ttlMs: HOUR, now: Date.now() }), null);
      assert.equal(await db.getAccessState('setup-code/' + hashCode(minted.code)), null);
    });

    it('[ADKC9] past 10 attempts per window the pending code is deleted', async () => {
      const minted = await pendingWithCode();
      const now = Date.now();
      for (let i = 0; i < 10; i++) assert.deepEqual(await setup.countSetupAttempt(db, { coreId: 'core-a', now }), { allowed: true });
      const refused = await setup.countSetupAttempt(db, { coreId: 'core-a', now });
      assert.equal(refused.allowed, false);
      assert.ok(refused.retryAt > now);
      assert.equal(await setup.redeemSetupCode(db, minted.code), null);
      assert.equal((await setup.readSetupState(db)).state, 'pending');
    });

    it('[ADKC10] setup session: hashed row, read back, ended, expires', async () => {
      const { token } = await sessions.createSetupSession(db, { coreId: 'core-a', now: Date.now() });
      assert.ok(!(await dump()).includes(token), 'no plain token in the store');
      assert.equal((await sessions.readSetupSession(db, token)).coreId, 'core-a');
      assert.equal(await sessions.readSetupSession(db, 'x'), null);
      await sessions.endSetupSession(db, token);
      assert.equal(await sessions.readSetupSession(db, token), null);
      const short = await sessions.createSetupSession(db, { coreId: 'core-a', now: Date.now(), ttlMs: 30 });
      await sleep(60);
      assert.equal(await sessions.readSetupSession(db, short.token), null);
    });

    it('[ADKC11] admin session: resolved with the role row, refused without it, after revocation, or once ended', async () => {
      const userId = 'cuser' + Date.now();
      const opened = await sessions.createAdminSession(db, { userId, homeCore: 'core-a', mfaAt: Date.now(), now: Date.now(), ttlMs: HOUR });
      assert.ok(!(await dump()).includes(opened.token), 'no plain token in the store');
      assert.equal(await sessions.resolveAdminSession(db, opened.token, Date.now()), null, 'no role: refused');
      await roles.grantRole(db, userId, { role: 'owner', scope: 'platform', grantedBy: 'setup', via: 'setup', now: Date.now() });
      const resolved = await sessions.resolveAdminSession(db, opened.token, Date.now());
      assert.equal(resolved.session.userId, userId);
      assert.deepEqual([...resolved.permissions].sort(), [...PERMISSIONS].sort(), 'owner holds every permission');
      // renewal keeps the session and moves the expiry
      const stepUpAt = Date.now() + 1000;
      const renewed = await sessions.renewAdminSession(db, opened.token, { now: stepUpAt, ttlMs: HOUR, mfaAt: stepUpAt });
      assert.ok(renewed > opened.expiresAt);
      const reread = await sessions.readAdminSession(db, opened.token);
      assert.equal(reread.mfaAt, stepUpAt, 'the step-up is recorded');
      assert.equal(reread.expiresAt, renewed);
      // revocation of the account's sessions
      await sleep(5);
      await roles.revokeSessionsOf(db, userId, Date.now());
      assert.equal(await sessions.resolveAdminSession(db, opened.token, Date.now()), null, 'revoked');
      await sleep(5);
      const again = await sessions.createAdminSession(db, { userId, homeCore: 'core-a', mfaAt: null, now: Date.now(), ttlMs: HOUR });
      assert.notEqual(await sessions.resolveAdminSession(db, again.token, Date.now()), null, 'a later session works');
      await sessions.endAdminSession(db, again.token);
      assert.equal(await sessions.readAdminSession(db, again.token), null);
      assert.equal(await sessions.renewAdminSession(db, again.token, { now: Date.now(), ttlMs: HOUR }), null, 'an ended session is not renewed');
      // deleting the role row ends every session
      const third = await sessions.createAdminSession(db, { userId, homeCore: 'core-a', mfaAt: null, now: Date.now() + 10, ttlMs: HOUR });
      assert.equal(await roles.revokeRole(db, userId, { now: Date.now() }), true);
      assert.equal(await sessions.resolveAdminSession(db, third.token, Date.now()), null);
    });

    it('[ADKC12] claim code: claimed once, the grant written for the account; no plain code stored', async () => {
      const minted = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now() });
      assert.ok(!(await dump()).includes(minted.code), 'no plain code in the store');
      const claimed = await roles.claimRole(db, minted.display, { userId: 'cuserclaim', now: Date.now() });
      assert.equal(claimed.grant.role, 'owner');
      const row = await roles.readRoleRow(db, 'cuserclaim');
      assert.equal(row.grants.length, 1);
      assert.equal(row.grants[0].via, 'claim-code');
      assert.equal(row.grants[0].grantedBy, 'admin-key');
      assert.equal(await roles.claimRole(db, minted.code, { userId: 'cuserother', now: Date.now() }), null, 'the same code twice fails');
      assert.equal(await roles.readRoleRow(db, 'cuserother'), null);
      const listed = await roles.listRoleRows(db);
      assert.deepEqual(listed.map((r) => r.userId), ['cuserclaim']);
    });

    it('[ADKC13] two concurrent claims of one code: exactly one account gets the role', async () => {
      const minted = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now() });
      const users = ['cua', 'cub', 'cuc', 'cud'];
      const results = await Promise.all(users.map((userId) => roles.claimRole(db, minted.code, { userId, now: Date.now() })));
      assert.equal(results.filter((r) => r != null).length, 1);
      const holders = (await roles.listRoleRows(db)).map((r) => r.userId);
      assert.equal(holders.length, 1);
    });

    it('[ADKC14] an expired claim code fails; a TTL above 24 h or an unknown role is refused', async () => {
      const minted = await roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now(), ttlMs: 30 });
      await sleep(60);
      assert.equal(await roles.claimRole(db, minted.code, { userId: 'cuserlate', now: Date.now() }), null);
      await assert.rejects(roles.mintClaimCode(db, { role: 'owner', scope: 'platform', mintedBy: 'admin-key', now: Date.now(), ttlMs: 25 * HOUR }), /24 h/);
      await assert.rejects(roles.mintClaimCode(db, { role: 'operator', scope: 'platform', mintedBy: 'admin-key', now: Date.now() }), /unknown role/);
      await assert.rejects(roles.mintClaimCode(db, { role: 'owner', scope: 'core:x', mintedBy: 'admin-key', now: Date.now() }), /unknown scope/);
    });
  });
}
