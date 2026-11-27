/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const adminAuth = require('../../src/adminAuth.ts').default;
const adminLockdown = require('../../src/adminLockdown.ts').default;
const { createAdminSession, createSetupSession } = require('business/src/admin/sessions.ts');
const { grantRole } = require('business/src/admin/roles.ts');
const { claimFreshPending, markReady } = require('business/src/admin/setupState.ts');

/**
 * [ADLD] the lockdown step after the /system gate: the matrix of capability
 * states x subject kinds (admin key, administrator session, setup session)
 * x read / write, read-only platform configuration keys, and the classes
 * lockdown never refuses (reads, session routes, setup, roles, claim codes).
 * Over an in-memory platform store and a route table of the test's own.
 */

const KEY = 'the-admin-key-for-lockdown-tests';
const MIN = 60 * 1000;
const ALL = ['key', 'session', 'setup'];

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

/** Each route accepts every subject kind here, so the matrix covers all three on the same routes. */
const RULES = {
  'GET /system/admin/ext-id-ns': { auth: 'admin', permission: 'extId:read', accepts: ALL },
  'PUT /system/admin/ext-id-ns/ns1': { auth: 'admin', permission: 'extId:write', accepts: ALL },
  'DELETE /system/admin/ext-id-ns/ns1': { auth: 'admin', permission: 'extId:write', accepts: ALL },
  'POST /system/admin/erasures/lookup': { auth: 'admin', permission: 'erasures:read', accepts: ALL },
  'GET /system/admin/platform-config/service.name': { auth: 'admin', permission: 'config:read', accepts: ALL },
  'PUT /system/admin/platform-config/service.name': { auth: 'admin', permission: 'config:write', accepts: ALL },
  'DELETE /system/admin/platform-config/service.name': { auth: 'admin', permission: 'config:write', accepts: ALL },
  'PUT /system/admin/platform-config/service%2Ename': { auth: 'admin', permission: 'config:write', accepts: ALL },
  'PUT /system/admin/platform-config/service.home': { auth: 'admin', permission: 'config:write', accepts: ALL },
  'POST /system/admin/claim-codes': { auth: 'admin', permission: 'claimCodes:mint', accepts: ALL },
  'POST /system/admin/roles/grant': { auth: 'admin', permission: 'roles:grant', accepts: ALL },
  'DELETE /system/admin/roles/u1': { auth: 'admin', permission: 'roles:grant', accepts: ALL },
  'POST /system/setup/finish': { auth: 'admin', permission: 'setup:write', accepts: ['key', 'setup'] },
  'POST /system/admin/setup/code': { auth: 'admin', permission: 'setup:write', accepts: ALL },
  'DELETE /system/admin/session': { auth: 'admin', permission: null, accepts: ['session'] },
  'POST /system/admin/session': { auth: 'personal' },
  'POST /system/setup/session': { auth: 'public' }
};
// HEAD is served by the GET route (as the api-server's route matcher does).
const rule = (method, path) => RULES[(method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()) + ' ' + path] ?? null;

function configOf (lockdown) {
  const all = {
    'auth:adminAccessKey': KEY,
    'core:url': 'https://core-a.example.org',
    'admin:lockdown': lockdown
  };
  return { get: (k) => all[k] };
}

function call (step, req) {
  return new Promise((resolve) => step(req, {}, (err) => resolve(err)));
}

/** The gate, then the lockdown step: `{ status, id }` of the refusal, or null when both let it through. */
async function through (gate, lockdown, method, path, authorization) {
  const req = { method, path, url: path, headers: { authorization }, protocol: 'https', context: {} };
  const gateErr = await call(gate, req);
  if (gateErr != null) return { status: gateErr.httpStatus, id: gateErr.id, step: 'gate' };
  const err = await call(lockdown, req);
  return err == null ? null : { status: err.httpStatus, id: err.id, step: 'lockdown', data: err.data };
}

/** Credentials of each subject kind, over a store in the setup state that kind needs. */
async function subjects () {
  const ready = memoryStore();
  await markReady(ready, { now: Date.now(), by: 'test' });
  await grantRole(ready, 'admin-user', { role: 'owner', scope: 'platform', grantedBy: 'test', via: 'grant', now: Date.now() });
  const session = await createAdminSession(ready, { userId: 'admin-user', homeCore: 'core-a', mfaAt: Date.now(), now: Date.now(), ttlMs: 60 * MIN });
  const pending = memoryStore();
  assert.equal(await claimFreshPending(pending, { coreId: 'core-a', now: Date.now() }), true);
  const setup = await createSetupSession(pending, { coreId: 'core-a', now: Date.now() });
  return {
    key: { store: ready, authorization: KEY },
    session: { store: ready, authorization: 'AdminSession ' + session.token },
    setup: { store: pending, authorization: 'SetupSession ' + setup.token }
  };
}

describe('[ADLD] /system lockdown step', function () {
  let creds;

  before(async function () {
    creds = await subjects();
  });

  function steps (kind, lockdown) {
    const config = configOf(lockdown);
    return {
      gate: adminAuth({ rule, config, store: () => creds[kind].store }),
      lockdown: adminLockdown({ rule, config }),
      authorization: creds[kind].authorization
    };
  }

  // [LDM1] .. [LDM9]: one per (state, subject kind).
  let n = 0;
  for (const state of ['editable', 'readonly', 'hidden']) {
    for (const kind of ALL) {
      it(`[LDM${++n}] extId ${state}, ${kind}: reads pass, writes ${state === 'editable' ? 'pass' : 'answer 403'}`, async function () {
        const { gate, lockdown, authorization } = steps(kind, { capabilities: { extId: state } });
        assert.equal(await through(gate, lockdown, 'GET', '/system/admin/ext-id-ns', authorization), null, 'GET');
        assert.equal(await through(gate, lockdown, 'HEAD', '/system/admin/ext-id-ns', authorization), null, 'HEAD');
        for (const method of ['PUT', 'DELETE']) {
          const out = await through(gate, lockdown, method, '/system/admin/ext-id-ns/ns1', authorization);
          if (state === 'editable') {
            assert.equal(out, null, method);
          } else {
            assert.deepEqual(out, { status: 403, id: 'admin-lockdown-capability', step: 'lockdown', data: { capability: 'extId' } }, method);
          }
        }
      });
    }
  }

  it('[LD01] a POST whose permission is a read (erasures lookup) is a read: never refused', async function () {
    for (const kind of ALL) {
      const { gate, lockdown, authorization } = steps(kind, { capabilities: { erasures: 'hidden' } });
      assert.equal(await through(gate, lockdown, 'POST', '/system/admin/erasures/lookup', authorization), null, kind);
    }
  });

  it('[LD02] a read-only platform configuration key: PUT and DELETE answer 403 admin-lockdown-key for every subject, reads and other keys pass', async function () {
    for (const kind of ALL) {
      const { gate, lockdown, authorization } = steps(kind, { platformConfig: { readonly: ['service.name'] } });
      for (const method of ['PUT', 'DELETE']) {
        assert.deepEqual(await through(gate, lockdown, method, '/system/admin/platform-config/service.name', authorization),
          { status: 403, id: 'admin-lockdown-key', step: 'lockdown', data: { key: 'service.name' } }, kind + ' ' + method);
      }
      assert.equal((await through(gate, lockdown, 'PUT', '/system/admin/platform-config/service%2Ename', authorization))?.id, 'admin-lockdown-key', kind + ' encoded');
      assert.equal(await through(gate, lockdown, 'GET', '/system/admin/platform-config/service.name', authorization), null, kind + ' GET');
      assert.equal(await through(gate, lockdown, 'PUT', '/system/admin/platform-config/service.home', authorization), null, kind + ' other key');
    }
  });

  it('[LD03] capability `config` locked: every platform configuration write answers admin-lockdown-capability, reads pass', async function () {
    const { gate, lockdown, authorization } = steps('key', { capabilities: { config: 'readonly' }, platformConfig: { readonly: ['service.name'] } });
    assert.equal((await through(gate, lockdown, 'PUT', '/system/admin/platform-config/service.home', authorization)).id, 'admin-lockdown-capability');
    assert.equal((await through(gate, lockdown, 'PUT', '/system/admin/platform-config/service.name', authorization)).id, 'admin-lockdown-capability');
    assert.equal(await through(gate, lockdown, 'GET', '/system/admin/platform-config/service.name', authorization), null);
  });

  it('[LD04] the admin key is bound like any subject (no bypass)', async function () {
    const { gate, lockdown } = steps('key', { capabilities: { extId: 'readonly' } });
    const out = await through(gate, lockdown, 'PUT', '/system/admin/ext-id-ns/ns1', KEY);
    assert.equal(out.status, 403);
    assert.equal(out.id, 'admin-lockdown-capability');
  });

  it('[LD05] a refusal of the gate comes first: no lockdown answer to a caller without a credential', async function () {
    const { gate, lockdown } = steps('key', { capabilities: { extId: 'readonly' } });
    const out = await through(gate, lockdown, 'PUT', '/system/admin/ext-id-ns/ns1', 'not-the-key');
    assert.equal(out.step, 'gate');
    assert.equal(out.status, 404);
  });

  // The never-lockable classes. Their configuration is a boot problem
  // (the gate's administration config check refuses it too), so the step is
  // called alone here, with every capability set to the strictest state.
  describe('never refused, whatever the configuration says', function () {
    const EVERYTHING = { capabilities: { setup: 'hidden', roles: 'hidden', claimCodes: 'hidden', extId: 'hidden', config: 'hidden', erasures: 'hidden' }, platformConfig: { readonly: ['service.name'] } };
    const lockdown = adminLockdown({ rule, config: configOf(EVERYTHING) });
    const pass = async (method, path) => assert.equal(await call(lockdown, { method, path, headers: {} }), undefined, method + ' ' + path);

    it('[LD06] reads (GET, HEAD, OPTIONS, a POST with a read permission)', async function () {
      await pass('GET', '/system/admin/ext-id-ns');
      await pass('HEAD', '/system/admin/ext-id-ns');
      await pass('OPTIONS', '/system/admin/ext-id-ns/ns1');
      await pass('GET', '/system/admin/platform-config/service.name');
      await pass('POST', '/system/admin/erasures/lookup');
    });

    it('[LD07] the session routes (no permission) and the routes with their own credential or none', async function () {
      await pass('DELETE', '/system/admin/session');
      await pass('POST', '/system/admin/session');
      await pass('POST', '/system/setup/session');
      await pass('POST', '/system/no/such/route');
    });

    it('[LD08] setup', async function () {
      await pass('POST', '/system/setup/finish');
      await pass('POST', '/system/admin/setup/code');
    });

    it('[LD09] role grant and revocation', async function () {
      await pass('POST', '/system/admin/roles/grant');
      await pass('DELETE', '/system/admin/roles/u1');
    });

    it('[LD10] claim codes', async function () {
      await pass('POST', '/system/admin/claim-codes');
    });

    it('[LD11] while the lockable writes of the same (invalid) configuration are refused', async function () {
      assert.equal((await call(lockdown, { method: 'PUT', path: '/system/admin/ext-id-ns/ns1', headers: {} })).id, 'admin-lockdown-invalid');
    });
  });

  it('[LD12] an invalid lockdown (a mistyped state) refuses every lockable write with 500, never unlocks it; reads and never-locked classes pass', async function () {
    const lockdown = adminLockdown({ rule, config: configOf({ capabilities: { extId: 'readonyl', config: 'readonly' } }) });
    for (const [method, path] of [['PUT', '/system/admin/ext-id-ns/ns1'], ['PUT', '/system/admin/platform-config/service.home']]) {
      const err = await call(lockdown, { method, path, headers: {} });
      assert.equal(err?.httpStatus, 500, path);
      assert.equal(err?.id, 'admin-lockdown-invalid', path);
    }
    for (const [method, path] of [['GET', '/system/admin/ext-id-ns'], ['POST', '/system/admin/erasures/lookup'], ['DELETE', '/system/admin/session'],
      ['POST', '/system/admin/setup/code'], ['DELETE', '/system/admin/roles/u1'], ['POST', '/system/admin/claim-codes']]) {
      assert.equal(await call(lockdown, { method, path, headers: {} }), undefined, method + ' ' + path);
    }
  });
});
