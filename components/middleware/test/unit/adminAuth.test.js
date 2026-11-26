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
const { grantRole } = require('business/src/admin/roles.ts');
const { claimFreshPending, markReady } = require('business/src/admin/setupState.ts');

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
  'POST /system/admin/session': { auth: 'personal' }
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
});
