/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const adminAuthMod = require('../../src/adminAuth.ts');
const adminAuth = adminAuthMod.default;
const { parseAdminAuthorization, allowedPortalOrigins, isPortalCorsRequest } = adminAuthMod;
const { createAdminSession, createSetupSession } = require('business/src/admin/sessions.ts');
const { grantRole, revokeRole } = require('business/src/admin/roles.ts');
const { PERMISSIONS } = require('business/src/admin/permissions.ts');
const { claimFreshPending, markReady } = require('business/src/admin/setupState.ts');
const { isAdminKeyInFullScope } = require('../../src/isAdminKey.ts');

/**
 * [ADAU] the /system gate: admin key with its scope, administrator and setup
 * sessions, permissions and step-up, the origin rule and its CORS headers.
 * Over an in-memory platform store (the routes are covered in api-server).
 */

const KEY = 'the-admin-key-for-tests';
const MIN = 60 * 1000;

function memoryStore () {
  const kv = new Map();
  const states = new Map();
  return {
    async getPlatformKv (k) { return kv.has(k) ? kv.get(k) : null; },
    async setPlatformKv (k, v) { kv.set(k, v); },
    async setPlatformKvIfAbsent (k, v) { if (kv.has(k)) return false; kv.set(k, v); return true; },
    async replacePlatformKvIfValue (k, expected, next) { if (kv.get(k) !== expected) return false; if (next == null) kv.delete(k); else kv.set(k, next); return true; },
    async deletePlatformKv (k) { kv.delete(k); },
    async listPlatformKvEntries (prefix) { return [...kv].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
    async setAccessState (k, value, expiresAt) { states.set(k, JSON.parse(JSON.stringify({ value, expiresAt }))); },
    async getAccessState (k) { const e = states.get(k); return e != null && e.expiresAt > Date.now() ? e : null; },
    async deleteAccessState (k) { states.delete(k); },
    async consumeAccessState (k) { const e = states.get(k); states.delete(k); return e != null && e.expiresAt > Date.now() ? e : null; },
    async bumpWindowedCounter () { return null; }
  };
}

function configOf (values) {
  const all = Object.assign({
    'auth:adminAccessKey': KEY,
    'core:url': 'https://core-a.example.org',
    'dns:domain': 'example.org',
    hostedSites: { admin: { proxy: 'https://pages.example.net/portal/' } },
    'portal:site': 'admin'
  }, values);
  return { get: (k) => all[k] };
}

const RULES = {
  'GET /system/admin/users': { auth: 'admin', permission: 'users:read' },
  'GET /system/admin/roles': { auth: 'admin', permission: 'roles:read', breakGlass: true },
  'POST /system/admin/claim-codes': { auth: 'admin', permission: 'claimCodes:mint', breakGlass: true, accepts: ['key', 'session', 'setup'] },
  'POST /system/ext-id/holds': { auth: 'admin', permission: 'extId:read', breakGlass: true, accepts: ['key'] },
  'POST /system/setup/finish': { auth: 'admin', permission: 'setup:write', accepts: ['key', 'setup'] },
  'GET /system/setup/status': { auth: 'public' },
  'POST /system/admin/session': { auth: 'personal' },
  'GET /system/admin/session': { auth: 'admin', permission: null, accepts: ['session'] },
  'GET /system/admin/audit': { auth: 'admin', permission: 'audit:read' },
  'PUT /system/admin/platform-config': { auth: 'admin', permission: 'config:write' }
};

const HOSTINGS = {
  regions: {
    europe: { zones: { ch: { hostings: { 'ch-gva': {}, 'ch-zrh': {} } }, de: { hostings: { 'de-fra': {} } } } },
    america: { zones: { us: { hostings: { 'us-east': {} } } } }
  }
};

function run (gate, { method = 'GET', path, headers = {} }) {
  const req = { method, path, url: path, headers, protocol: 'https', context: {} };
  const set = {};
  const res = { header (k, v) { set[k.toLowerCase()] = v; return res; }, vary () { return res; } };
  return new Promise((resolve) => {
    gate(req, res, (err) => resolve({ err, req, headers: set }));
  });
}

describe('[ADAU] /system gate', function () {
  let db, config, gate;

  function makeGate (values = {}) {
    config = configOf(values);
    gate = adminAuth({ rule: (m, p) => RULES[m + ' ' + p] ?? null, config, store: () => db });
  }

  async function ownerSession (mfaAt = Date.now()) {
    const now = Date.now();
    await grantRole(db, 'admin-1', { role: 'owner', scope: 'platform', grantedBy: 'setup', via: 'setup', now });
    return (await createAdminSession(db, { userId: 'admin-1', homeCore: 'core-b', mfaAt, now, ttlMs: 60 * MIN })).token;
  }

  beforeEach(() => {
    db = memoryStore();
    makeGate();
  });

  it('[ADAU1] parses the session schemes, case-insensitively; anything else is another credential', () => {
    assert.deepEqual(parseAdminAuthorization('AdminSession abc'), { kind: 'session', token: 'abc' });
    assert.deepEqual(parseAdminAuthorization('setupsession xyz'), { kind: 'setup', token: 'xyz' });
    assert.equal(parseAdminAuthorization('AdminSession').kind, 'other');
    assert.equal(parseAdminAuthorization(KEY).kind, 'other');
    assert.equal(parseAdminAuthorization(undefined).kind, 'other');
  });

  it('[ADAU2] admin key, scope full: every admin route; unknown paths go on to the routes', async () => {
    const ok = await run(gate, { path: '/system/admin/users', headers: { authorization: KEY } });
    assert.equal(ok.err, undefined);
    assert.equal(ok.req.adminSubject.kind, 'key');
    assert.equal(ok.req.context.adminSubject.kind, 'key');
    const unknown = await run(gate, { path: '/system/nothing-here', headers: { authorization: KEY } });
    assert.equal(unknown.err, undefined, 'answered 404 by the routes, as before');
    const wrong = await run(gate, { path: '/system/admin/users', headers: { authorization: KEY + 'x' } });
    assert.equal(wrong.err.id, 'unknown-resource');
  });

  it('[ADAU3] admin key, scope break-glass: refused on a normal route, accepted on the break-glass ones', async () => {
    makeGate({ 'auth:adminAccessKeyScope': 'break-glass' });
    assert.equal((await run(gate, { path: '/system/admin/users', headers: { authorization: KEY } })).err.id, 'unknown-resource');
    assert.equal((await run(gate, { method: 'POST', path: '/system/admin/claim-codes', headers: { authorization: KEY } })).err, undefined);
    assert.equal((await run(gate, { path: '/system/admin/roles', headers: { authorization: KEY } })).err, undefined);
    assert.equal((await run(gate, { method: 'POST', path: '/system/ext-id/holds', headers: { authorization: KEY } })).err, undefined);
    // A path the table does not know: refused by the gate (no route served behind its back).
    assert.equal((await run(gate, { path: '/system/nothing-here', headers: { authorization: KEY } })).err.id, 'unknown-resource');
  });

  it('[ADAU11] the admin key outside /system: refused under break-glass, as before under full', () => {
    const full = configOf({});
    const glass = configOf({ 'auth:adminAccessKeyScope': 'break-glass' });
    assert.equal(isAdminKeyInFullScope(KEY, full), true);
    assert.equal(isAdminKeyInFullScope(KEY + 'x', full), false);
    assert.equal(isAdminKeyInFullScope(KEY, glass), false);
  });

  it('[ADAU12] own origin: the request\'s host under https and http (a TLS proxy the core does not trust)', async () => {
    for (const origin of ['https://setup.example.net', 'http://setup.example.net']) {
      const r = await run(gate, { path: '/system/setup/status', headers: { origin, host: 'setup.example.net' } });
      assert.equal(r.err, undefined, origin);
    }
    assert.equal((await run(gate, { path: '/system/setup/status', headers: { origin: 'https://other.example.net', host: 'setup.example.net' } })).err.id, 'unknown-resource');
  });

  it('[ADAU4] admin session: accepted with the permission (from any core), refused without, refused when unknown, on a key-only route, or while setup is pending', async () => {
    const token = await ownerSession();
    const ok = await run(gate, { path: '/system/admin/users', headers: { authorization: 'AdminSession ' + token } });
    assert.equal(ok.err, undefined);
    assert.equal(ok.req.adminSubject.kind, 'session');
    assert.equal(ok.req.adminSubject.userId, 'admin-1');
    assert.ok(ok.req.adminSubject.permissions.has('users:read'));
    assert.equal((await run(gate, { path: '/system/admin/users', headers: { authorization: 'AdminSession ' + 'A'.repeat(43) } })).err.id, 'unknown-resource');
    assert.equal((await run(gate, { method: 'POST', path: '/system/ext-id/holds', headers: { authorization: 'AdminSession ' + token } })).err.id, 'unknown-resource');
    await claimFreshPending(db, { coreId: 'core-a', now: Date.now() });
    assert.equal((await run(gate, { path: '/system/admin/users', headers: { authorization: 'AdminSession ' + token } })).err.id, 'unknown-resource');
    await markReady(db, { by: 'admin-key', now: Date.now() });
    assert.equal((await run(gate, { path: '/system/admin/users', headers: { authorization: 'AdminSession ' + token } })).err, undefined);
  });

  it('[ADAU5] a step-up permission needs a recent second factor (403 step-up), the key does not', async () => {
    const stale = await ownerSession(Date.now() - 6 * MIN);
    const refused = await run(gate, { method: 'POST', path: '/system/admin/claim-codes', headers: { authorization: 'AdminSession ' + stale } });
    assert.equal(refused.err.id, 'forbidden');
    assert.equal(refused.err.data.stepUp, true);
    const fresh = await ownerSession(Date.now());
    assert.equal((await run(gate, { method: 'POST', path: '/system/admin/claim-codes', headers: { authorization: 'AdminSession ' + fresh } })).err, undefined);
    assert.equal((await run(gate, { method: 'POST', path: '/system/admin/claim-codes', headers: { authorization: KEY } })).err, undefined);
  });

  it('[ADAU6] setup session: only while pending, only on the routes that accept one', async () => {
    await claimFreshPending(db, { coreId: 'core-a', now: Date.now() });
    const { token } = await createSetupSession(db, { coreId: 'core-a', now: Date.now() });
    const ok = await run(gate, { method: 'POST', path: '/system/setup/finish', headers: { authorization: 'SetupSession ' + token } });
    assert.equal(ok.err, undefined);
    assert.equal(ok.req.adminSubject.kind, 'setup');
    assert.equal((await run(gate, { path: '/system/admin/users', headers: { authorization: 'SetupSession ' + token } })).err.id, 'unknown-resource');
    await markReady(db, { by: 'setup', now: Date.now() });
    assert.equal((await run(gate, { method: 'POST', path: '/system/setup/finish', headers: { authorization: 'SetupSession ' + token } })).err.id, 'unknown-resource');
  });

  it('[ADAU7] origin rule: a session call from a foreign origin is refused; from the portal, the own or a listed origin it is accepted with CORS for that origin only', async () => {
    makeGate({ 'portal:cors:allowedOrigins': ['https://ops.example.com'] });
    const token = await ownerSession();
    const auth = { authorization: 'AdminSession ' + token };
    const foreign = await run(gate, { path: '/system/admin/users', headers: { ...auth, origin: 'https://evil.example.net' } });
    assert.equal(foreign.err.id, 'unknown-resource');
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    for (const origin of ['https://admin.example.org', 'https://core-a.example.org', 'https://ops.example.com']) {
      const r = await run(gate, { path: '/system/admin/users', headers: { ...auth, origin } });
      assert.equal(r.err, undefined, origin);
      assert.equal(r.headers['access-control-allow-origin'], origin);
    }
    // The request's own origin (the built-in setup page on the bare address).
    const own = await run(gate, { path: '/system/setup/status', headers: { origin: 'https://10.0.0.5:3000', host: '10.0.0.5:3000' } });
    assert.equal(own.err, undefined);
    assert.equal((await run(gate, { path: '/system/setup/status', headers: { origin: 'null' } })).err.id, 'unknown-resource');
    // Public and personal routes follow the rule too; no Origin: as before.
    assert.equal((await run(gate, { method: 'POST', path: '/system/admin/session', headers: { origin: 'https://evil.example.net' } })).err.id, 'unknown-resource');
    assert.equal((await run(gate, { method: 'POST', path: '/system/admin/session', headers: {} })).err, undefined);
  });

  it('[ADAU8] origin rule: an admin-key call keeps the API-wide behaviour whatever its Origin', async () => {
    const r = await run(gate, { path: '/system/admin/users', headers: { authorization: KEY, origin: 'https://evil.example.net' } });
    assert.equal(r.err, undefined);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'left to the API-wide CORS');
    assert.equal(isPortalCorsRequest(config, { method: 'GET', path: '/system/admin/users', headers: { authorization: KEY, origin: 'https://evil.example.net' } }), false);
  });

  it('[ADAU9] the CORS branch: /system calls with an Origin, not a preflight, not the admin key', () => {
    const req = (o) => Object.assign({ method: 'GET', path: '/system/admin/users', headers: { origin: 'https://admin.example.org', authorization: 'AdminSession x' } }, o);
    assert.equal(isPortalCorsRequest(config, req()), true);
    assert.equal(isPortalCorsRequest(config, req({ method: 'OPTIONS' })), false);
    assert.equal(isPortalCorsRequest(config, req({ headers: { authorization: 'AdminSession x' } })), false);
    assert.equal(isPortalCorsRequest(config, req({ path: '/someone/events' })), false);
    assert.equal(isPortalCorsRequest(config, req({ path: '/systemuser/events' })), false);
  });

  it('[ADAU10] portal origins follow the topology', () => {
    const dns = allowedPortalOrigins(configOf({}));
    assert.ok(dns.has('https://admin.example.org'));
    assert.ok(dns.has('https://core-a.example.org'));
    const dnsLess = allowedPortalOrigins(configOf({ 'dnsLess:isActive': true, 'dnsLess:publicUrl': 'http://192.0.2.7:3000/', 'core:url': null, 'dns:domain': null }));
    assert.deepEqual([...dnsLess].sort(), ['http://192.0.2.7:3000']);
  });

  describe('scopes and the local policy', function () {
    /** A session of `userId` holding `grants` ([role, scope, expiresAt?]). */
    async function sessionWith (userId, grants) {
      const now = Date.now();
      for (const [role, scope, expiresAt] of grants) {
        await grantRole(db, userId, { role, scope, grantedBy: 'admin-key', via: 'admin-key', now, expiresAt });
      }
      return 'AdminSession ' + (await createAdminSession(db, { userId, homeCore: 'core-a', mfaAt: now, now: now + 1, ttlMs: 60 * MIN })).token;
    }
    /** The gate of core `coreId` on hosting `hosting`, with `policy` as its admin.localPolicy. */
    function coreGate (coreId, hosting, policy) {
      return adminAuth({
        rule: (m, p) => RULES[m + ' ' + p] ?? null,
        config: configOf({ 'core:id': coreId, 'core:hosting': hosting, hostings: HOSTINGS, 'admin:localPolicy': policy }),
        store: () => db
      });
    }
    const users = (g, authorization) => run(g, { path: '/system/admin/users', headers: { authorization } });
    const audit = (g, authorization) => run(g, { path: '/system/admin/audit', headers: { authorization } });

    it('[ADAU13] a support grant scoped core:B works on core B and answers 404 on core A; on A its session still resolves', async () => {
      const auth = await sessionWith('sup-1', [['support', 'core:core-b']]);
      const onB = await users(coreGate('core-b', 'ch-zrh'), auth);
      assert.equal(onB.err, undefined);
      assert.deepEqual(onB.req.adminSubject.denied, []);
      const gateA = coreGate('core-a', 'ch-gva');
      const onA = await users(gateA, auth);
      assert.equal(onA.err.id, 'unknown-resource');
      assert.equal(onA.req.adminSubject, undefined);
      // Its own session on its home core A: no permission here, the reasons listed.
      const own = await run(gateA, { path: '/system/admin/session', headers: { authorization: auth } });
      assert.equal(own.err, undefined);
      assert.equal(own.req.adminSubject.permissions.size, 0);
      assert.ok(own.req.adminSubject.denied.length > 0);
      assert.ok(own.req.adminSubject.denied.every((d) => d.reason === 'scope'));
    });

    it('[ADAU14] a zone grant works on every core of the zone, not elsewhere', async () => {
      const auth = await sessionWith('sup-2', [['support', 'zone:ch']]);
      assert.equal((await users(coreGate('core-gva', 'ch-gva'), auth)).err, undefined);
      assert.equal((await users(coreGate('core-zrh', 'ch-zrh'), auth)).err, undefined);
      assert.equal((await users(coreGate('core-fra', 'de-fra'), auth)).err.id, 'unknown-resource');
      assert.equal((await users(coreGate('core-us', 'us-east'), auth)).err.id, 'unknown-resource');
    });

    it('[ADAU15] an operator scoped region:<r> is refused a platform configuration write, accepted at platform', async () => {
      const regional = await sessionWith('op-1', [['operator', 'region:europe']]);
      const g = coreGate('core-gva', 'ch-gva');
      assert.equal((await run(g, { method: 'PUT', path: '/system/admin/platform-config', headers: { authorization: regional } })).err.id, 'unknown-resource');
      assert.equal((await users(g, regional)).err, undefined, 'its core-local reads still work');
      const platformWide = await sessionWith('op-2', [['operator', 'platform']]);
      assert.equal((await run(g, { method: 'PUT', path: '/system/admin/platform-config', headers: { authorization: platformWide } })).err, undefined);
    });

    it('[ADAU16] a platform owner is refused a requireLocalScope permission, accepted once the core lists it in localGrants', async () => {
      const auth = await sessionWith('own-1', [['owner', 'platform']]);
      const strict = coreGate('core-gva', 'ch-gva', { requireLocalScope: ['audit:read'] });
      const refused = await audit(strict, auth);
      assert.equal(refused.err.id, 'unknown-resource');
      const other = await users(strict, auth);
      assert.equal(other.err, undefined, 'its other permissions stay');
      assert.deepEqual(other.req.adminSubject.denied, [{ permission: 'audit:read', reason: 'local-policy' }]);
      const listed = coreGate('core-gva', 'ch-gva', { requireLocalScope: ['audit:read'], localGrants: [{ userId: 'own-1', role: 'owner' }] });
      assert.equal((await audit(listed, auth)).err, undefined);
      // Another core without that policy: accepted as before.
      assert.equal((await audit(coreGate('core-fra', 'de-fra'), auth)).err, undefined);
    });

    it('[ADAU17] a replicated grant scoped core:<that core> does not give a requireLocalScope permission', async () => {
      const auth = await sessionWith('aud-1', [['auditor', 'core:core-gva']]);
      const strict = coreGate('core-gva', 'ch-gva', { requireLocalScope: ['audit:read'] });
      assert.equal((await audit(strict, auth)).err.id, 'unknown-resource');
      assert.equal((await audit(coreGate('core-gva', 'ch-gva'), auth)).err, undefined, 'without the policy it does');
    });

    it('[ADAU18] acceptReplicatedGrants false: only localGrants count on that core, whatever the platform store says', async () => {
      const auth = await sessionWith('own-2', [['owner', 'platform']]);
      const closed = coreGate('core-gva', 'ch-gva', { acceptReplicatedGrants: false });
      assert.equal((await users(closed, auth)).err.id, 'unknown-resource');
      const own = await run(closed, { path: '/system/admin/session', headers: { authorization: auth } });
      assert.equal(own.err, undefined, 'a local policy never blocks the session itself');
      assert.equal(own.req.adminSubject.permissions.size, 0);
      const withLocal = coreGate('core-gva', 'ch-gva', { acceptReplicatedGrants: false, localGrants: [{ userId: 'own-2', role: 'support' }] });
      assert.equal((await users(withLocal, auth)).err, undefined);
      assert.equal((await audit(withLocal, auth)).err.id, 'unknown-resource', 'support holds no audit:read');
    });

    it('[ADAU19] a local grant gives nothing to an account without an active grant in the platform store', async () => {
      const now = Date.now();
      const noRow = 'AdminSession ' + (await createAdminSession(db, { userId: 'loc-1', homeCore: 'core-a', mfaAt: now, now, ttlMs: 60 * MIN })).token;
      const g = coreGate('core-gva', 'ch-gva', { localGrants: [{ userId: 'loc-1', role: 'owner' }, { userId: 'loc-2', role: 'owner' }] });
      assert.equal((await users(g, noRow)).err.id, 'unknown-resource');
      assert.equal((await run(g, { path: '/system/admin/session', headers: { authorization: noRow } })).err.id, 'unknown-resource', 'no session');
      const expired = await sessionWith('loc-2', [['viewer', 'platform', now + 50]]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal((await users(g, expired)).err.id, 'unknown-resource', 'the only grant expired');
    });

    it('[ADAU20] the admin key and the setup session keep every permission under a strict policy', async () => {
      const strict = coreGate('core-gva', 'ch-gva', { acceptReplicatedGrants: false, requireLocalScope: ['audit:read', 'users:read'] });
      const key = await audit(strict, KEY);
      assert.equal(key.err, undefined);
      assert.equal(key.req.adminSubject.permissions.size, PERMISSIONS.length);
      assert.deepEqual(key.req.adminSubject.denied, []);
      await claimFreshPending(db, { coreId: 'core-a', now: Date.now() });
      const { token } = await createSetupSession(db, { coreId: 'core-a', now: Date.now() });
      const setup = await run(strict, { method: 'POST', path: '/system/setup/finish', headers: { authorization: 'SetupSession ' + token } });
      assert.equal(setup.err, undefined);
      assert.deepEqual(setup.req.adminSubject.denied, []);
    });

    it('[ADAU21] revoking a grant is effective on the next request', async () => {
      const auth = await sessionWith('sup-3', [['support', 'region:europe'], ['viewer', 'platform']]);
      const g = coreGate('core-gva', 'ch-gva');
      assert.equal((await users(g, auth)).err, undefined);
      await revokeRole(db, 'sup-3', { role: 'support', now: Date.now() });
      assert.equal((await users(g, auth)).err.id, 'unknown-resource');
      await revokeRole(db, 'sup-3', { now: Date.now() });
      assert.equal((await run(g, { path: '/system/admin/session', headers: { authorization: auth } })).err.id, 'unknown-resource', 'no grant left: the session ends');
    });

    it('[ADAU22] an invalid local policy fails closed (an error, no subject)', async () => {
      const auth = await sessionWith('own-3', [['owner', 'platform']]);
      const r = await users(coreGate('core-gva', 'ch-gva', { acceptReplicatedGrants: 'maybe' }), auth);
      assert.ok(r.err instanceof Error);
      assert.notEqual(r.err.id, 'unknown-resource', 'not a silent 404: the operator sees the error');
      assert.equal(r.req.adminSubject, undefined);
    });
  });
});
