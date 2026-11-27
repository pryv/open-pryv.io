/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADRO] administrator roles: the bundles, and what a role row gives on a
 * core (scope, platform-only writes, the region rule of OAuth review, the
 * local policy, local grants), with the reason of each refusal. Grants,
 * claims and the last-owner guard under scoped and expiring grants, over an
 * in-memory store with the platform store's semantics.
 */

import assert from 'node:assert/strict';
import {
  ROLES, ROLE_PERMISSIONS, isRole, effectivePermissions, permissionsOf, hasActiveGrant, activeGrants,
  grantRole, revokeRole, mintClaimCode, claimRole, LastOwnerError
} from '../../src/admin/roles.ts';
import { PERMISSIONS, PLATFORM_ONLY_WRITES, OWNER_ONLY_PERMISSIONS, REGION_SCOPED_PERMISSIONS, STEP_UP_PERMISSIONS } from '../../src/admin/permissions.ts';
import { coreContext } from '../../src/admin/scopes.ts';
import { DEFAULT_LOCAL_POLICY, readLocalPolicy } from '../../src/admin/localPolicy.ts';

const HOUR = 3600 * 1000;

/** The role table of the specification, written out (the code must agree with it). */
const TABLE = {
  owner: [...PERMISSIONS],
  operator: ['setup:read', 'roles:read', 'users:read', 'invitations:read', 'cores:read', 'cores:write', 'config:read', 'config:write',
    'configEffective:read', 'certs:read', 'certs:write', 'dns:read', 'dns:write', 'mail:read', 'mail:write', 'observability:read',
    'observability:write', 'migrations:read', 'integrity:read', 'extId:read', 'extId:write', 'oauthClients:read', 'publishers:read'],
  support: ['users:read', 'users:write', 'users:delete', 'users:resetMfa', 'invitations:read', 'invitations:write', 'extId:read',
    'extId:release', 'autoDeletion:clear'],
  auditor: ['setup:read', 'roles:read', 'users:read', 'invitations:read', 'cores:read', 'config:read', 'configEffective:read',
    'certs:read', 'dns:read', 'mail:read', 'observability:read', 'migrations:read', 'integrity:read', 'audit:read', 'erasures:read',
    'extId:read', 'oauthClients:read', 'publishers:read'],
  'app-reviewer': ['oauthClients:read', 'oauthClients:write', 'oauthClients:review', 'publishers:read', 'publishers:review'],
  viewer: ['cores:read', 'config:read', 'configEffective:read', 'certs:read', 'dns:read', 'mail:read', 'observability:read',
    'migrations:read', 'integrity:read', 'oauthClients:read', 'publishers:read']
};

const HOSTINGS = {
  regions: {
    europe: { zones: { ch: { hostings: { 'ch-gva': {} } }, de: { hostings: { 'de-fra': {} } } } },
    america: { zones: { us: { hostings: { 'us-east': {} } } } },
    asia: { zones: { sg: { hostings: { 'sg-1': {} } } } }
  }
};

function configOf (values) {
  return { get: (k) => values[k] };
}
const ctxOf = (coreId, hosting) => coreContext(configOf({ 'core:id': coreId, 'core:hosting': hosting, hostings: HOSTINGS }));
const GVA = ctxOf('core-gva', 'ch-gva');
const FRA = ctxOf('core-fra', 'de-fra');
const USA = ctxOf('core-us', 'us-east');

const NOW = 1_800_000_000_000;
function rowOf (...grants) {
  return { grants: grants.map((g) => ({ grantedAt: NOW - HOUR, grantedBy: 'setup', via: 'grant', ...g })), updatedAt: NOW - HOUR };
}
function policyOf (p) {
  return readLocalPolicy(configOf({ 'admin:localPolicy': p }));
}
const sorted = (set) => [...set].sort();

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

describe('[ADRO] administrator roles', function () {
  describe('bundles', function () {
    it('[ADRO1] the six roles and their bundles agree with the role table', () => {
      assert.deepEqual([...ROLES].sort(), Object.keys(TABLE).sort());
      for (const role of ROLES) {
        assert.deepEqual([...ROLE_PERMISSIONS[role]].sort(), [...TABLE[role]].sort(), role);
        assert.equal(new Set(ROLE_PERMISSIONS[role]).size, ROLE_PERMISSIONS[role].length, role + ': no duplicate');
        assert.ok(isRole(role));
      }
      assert.equal(isRole('admin'), false);
      assert.equal(isRole('__proto__'), false);
    });

    it('[ADRO2] every permission is in owner; only owner holds the owner-only names', () => {
      assert.deepEqual(sorted(new Set(ROLE_PERMISSIONS.owner)), [...PERMISSIONS].sort());
      assert.deepEqual(sorted(OWNER_ONLY_PERMISSIONS), ['bootstrap:issue', 'claimCodes:mint', 'delegation:write', 'roles:grant', 'setup:write']);
      for (const role of ROLES.filter((r) => r !== 'owner')) {
        for (const p of OWNER_ONLY_PERMISSIONS) assert.ok(!ROLE_PERMISSIONS[role].includes(p), `${role} holds ${p}`);
      }
      // Every name of the special sets is a known permission.
      for (const set of [PLATFORM_ONLY_WRITES, OWNER_ONLY_PERMISSIONS, REGION_SCOPED_PERMISSIONS, STEP_UP_PERMISSIONS]) {
        for (const p of set) assert.ok(PERMISSIONS.includes(p), p);
      }
      assert.deepEqual(sorted(PLATFORM_ONLY_WRITES), ['bootstrap:issue', 'claimCodes:mint', 'config:write', 'cores:write', 'delegation:write',
        'dns:write', 'extId:write', 'mail:write', 'observability:write', 'roles:grant', 'setup:write']);
    });
  });

  describe('permissions on a core', function () {
    it('[ADRO3] upgrade: a platform owner holds every permission on every core, without and with the default policy', () => {
      const row = rowOf({ role: 'owner', scope: 'platform' });
      for (const core of [GVA, FRA, USA, null]) {
        const r = effectivePermissions(row, NOW, { core, policy: DEFAULT_LOCAL_POLICY, userId: 'u1' });
        assert.deepEqual(sorted(r.permissions), [...PERMISSIONS].sort());
        assert.deepEqual(r.denied, []);
      }
      assert.deepEqual(sorted(permissionsOf(row, NOW)), [...PERMISSIONS].sort(), 'without a context: the platform grants');
    });

    it('[ADRO4] a support grant scoped core:B works on B only; on A everything is denied for scope', () => {
      const row = rowOf({ role: 'support', scope: 'core:core-fra' });
      const onB = effectivePermissions(row, NOW, { core: FRA, userId: 'u1' });
      assert.deepEqual(sorted(onB.permissions), [...TABLE.support].sort());
      assert.deepEqual(onB.denied, []);
      const onA = effectivePermissions(row, NOW, { core: GVA, userId: 'u1' });
      assert.equal(onA.permissions.size, 0);
      assert.deepEqual(onA.denied.map((d) => d.reason), TABLE.support.map(() => 'scope'));
      assert.equal(hasActiveGrant(row, NOW), true, 'it can still open a session on A');
      assert.equal(permissionsOf(row, NOW).size, 0, 'no core: only platform grants count');
    });

    it('[ADRO5] a zone grant works on every core of the zone, a region grant on every core of the region', () => {
      const zone = rowOf({ role: 'viewer', scope: 'zone:ch' });
      assert.ok(permissionsOf(zone, NOW, { core: GVA }).has('cores:read'));
      assert.equal(permissionsOf(zone, NOW, { core: FRA }).size, 0);
      const region = rowOf({ role: 'support', scope: 'region:europe' });
      assert.ok(permissionsOf(region, NOW, { core: GVA }).has('users:read'));
      assert.ok(permissionsOf(region, NOW, { core: FRA }).has('users:read'));
      assert.equal(permissionsOf(region, NOW, { core: USA }).size, 0);
    });

    it('[ADRO6] an operator scoped region:<r> cannot write platform configuration, DNS, mail, observability, cores or external ids', () => {
      const row = rowOf({ role: 'operator', scope: 'region:europe' });
      const r = effectivePermissions(row, NOW, { core: GVA, userId: 'u1' });
      for (const p of ['config:write', 'dns:write', 'mail:write', 'observability:write', 'cores:write', 'extId:write']) {
        assert.ok(!r.permissions.has(p), p);
        assert.deepEqual(r.denied.find((d) => d.permission === p), { permission: p, reason: 'scope' });
      }
      for (const p of ['config:read', 'dns:read', 'certs:write', 'users:read']) assert.ok(r.permissions.has(p), p);
      // The same operator at platform holds the writes.
      assert.ok(permissionsOf(rowOf({ role: 'operator', scope: 'platform' }), NOW, { core: GVA }).has('config:write'));
    });

    it('[ADRO7] a scoped owner manages its core, not the roles nor platform-wide state', () => {
      const r = effectivePermissions(rowOf({ role: 'owner', scope: 'core:core-gva' }), NOW, { core: GVA, userId: 'u1' });
      for (const p of PLATFORM_ONLY_WRITES) assert.ok(!r.permissions.has(p), p);
      for (const p of ['users:delete', 'audit:read', 'certs:write', 'roles:read']) assert.ok(r.permissions.has(p), p);
    });

    it('[ADRO8] OAuth client and publisher permissions come from platform and known region grants only, wherever the core is', () => {
      const reviewer = (scope) => permissionsOf(rowOf({ role: 'app-reviewer', scope }), NOW, { core: GVA });
      assert.equal(reviewer('platform').has('oauthClients:review'), true);
      assert.equal(reviewer('region:europe').has('oauthClients:review'), true);
      assert.equal(reviewer('region:asia').has('oauthClients:review'), true, 'any region: the method checks the client\'s regions');
      assert.equal(reviewer('region:nowhere').size, 0, 'an orphan region gives nothing');
      for (const scope of ['zone:ch', 'hosting:ch-gva', 'core:core-gva']) assert.equal(reviewer(scope).size, 0, scope);
      // A viewer scoped to this core keeps its reads but not oauthClients:read.
      const viewer = effectivePermissions(rowOf({ role: 'viewer', scope: 'core:core-gva' }), NOW, { core: GVA });
      assert.ok(viewer.permissions.has('cores:read'));
      assert.ok(!viewer.permissions.has('oauthClients:read'));
    });

    it('[ADRO9] expired grants, unknown roles, invalid and orphan scopes give nothing; the next active grant still counts', () => {
      const row = rowOf(
        { role: 'support', scope: 'platform', expiresAt: NOW - 1 },
        { role: 'superuser', scope: 'platform' },
        { role: 'owner', scope: 'everywhere' },
        { role: 'owner', scope: 'core:core-zz' }
      );
      assert.equal(permissionsOf(row, NOW, { core: GVA }).size, 0);
      assert.equal(activeGrants(row, NOW).length, 1, 'the orphan grant is active (it matches no core)');
      assert.equal(hasActiveGrant(rowOf({ role: 'support', scope: 'platform', expiresAt: NOW - 1 }), NOW), false);
      assert.equal(hasActiveGrant(rowOf({ role: 'superuser', scope: 'platform' }), NOW), false);
      assert.equal(hasActiveGrant(null, NOW), false);
      const later = rowOf({ role: 'support', scope: 'platform', expiresAt: NOW + 1 });
      assert.ok(permissionsOf(later, NOW, { core: GVA }).has('users:read'));
      assert.equal(permissionsOf(later, NOW + 1, { core: GVA }).size, 0, 'expiry is exclusive');
    });
  });

  describe('local policy', function () {
    const strictAudit = { requireLocalScope: ['audit:read'] };

    it('[ADRO10] requireLocalScope: a platform owner is refused audit:read (local-policy), its other permissions stay', () => {
      const r = effectivePermissions(rowOf({ role: 'owner', scope: 'platform' }), NOW, { core: GVA, policy: policyOf(strictAudit), userId: 'u1' });
      assert.ok(!r.permissions.has('audit:read'));
      assert.deepEqual(r.denied, [{ permission: 'audit:read', reason: 'local-policy' }]);
      assert.equal(r.permissions.size, PERMISSIONS.length - 1);
    });

    it('[ADRO11] requireLocalScope: a replicated grant scoped core:<that core> does not give it; a local grant does', () => {
      const row = rowOf({ role: 'auditor', scope: 'core:core-gva' });
      const replicated = effectivePermissions(row, NOW, { core: GVA, policy: policyOf(strictAudit), userId: 'u1' });
      assert.ok(!replicated.permissions.has('audit:read'));
      // (A core scope never gives the OAuth client and publisher reads: denied for scope.)
      assert.deepEqual(replicated.denied, [
        { permission: 'audit:read', reason: 'local-policy' },
        { permission: 'oauthClients:read', reason: 'scope' },
        { permission: 'publishers:read', reason: 'scope' }
      ]);
      const local = effectivePermissions(row, NOW, {
        core: GVA, policy: policyOf({ ...strictAudit, localGrants: [{ userId: 'u1', role: 'auditor' }] }), userId: 'u1'
      });
      assert.ok(local.permissions.has('audit:read'));
      assert.deepEqual(local.denied, []);
      // Owner at platform, accepted once the core lists it in localGrants.
      const owner = effectivePermissions(rowOf({ role: 'owner', scope: 'platform' }), NOW, {
        core: GVA, policy: policyOf({ ...strictAudit, localGrants: [{ userId: 'u1', role: 'owner' }] }), userId: 'u1'
      });
      assert.equal(owner.permissions.size, PERMISSIONS.length);
    });

    it('[ADRO12] a local grant is for its account only, and gives nothing without an active grant in the row', () => {
      const policy = policyOf({ ...strictAudit, localGrants: [{ userId: 'u1', role: 'auditor' }] });
      const row = rowOf({ role: 'viewer', scope: 'platform' });
      assert.ok(!permissionsOf(row, NOW, { core: GVA, policy, userId: 'u2' }).has('audit:read'), 'another account');
      assert.equal(permissionsOf(null, NOW, { core: GVA, policy, userId: 'u1' }).size, 0, 'no row');
      const expired = rowOf({ role: 'viewer', scope: 'platform', expiresAt: NOW - 1 });
      assert.equal(permissionsOf(expired, NOW, { core: GVA, policy, userId: 'u1' }).size, 0, 'no active grant');
      // An orphan grant is active: the local grant applies.
      const orphan = rowOf({ role: 'viewer', scope: 'core:elsewhere' });
      assert.ok(permissionsOf(orphan, NOW, { core: GVA, policy, userId: 'u1' }).has('audit:read'));
    });

    it('[ADRO13] acceptReplicatedGrants false: only local grants count, whatever the platform store says', () => {
      const row = rowOf({ role: 'owner', scope: 'platform' });
      const none = effectivePermissions(row, NOW, { core: GVA, policy: policyOf({ acceptReplicatedGrants: false }), userId: 'u1' });
      assert.equal(none.permissions.size, 0);
      assert.equal(none.denied.length, PERMISSIONS.length);
      assert.ok(none.denied.every((d) => d.reason === 'local-policy'));
      const local = effectivePermissions(row, NOW, {
        core: GVA, policy: policyOf({ acceptReplicatedGrants: false, localGrants: [{ userId: 'u1', role: 'support' }] }), userId: 'u1'
      });
      assert.deepEqual(sorted(local.permissions), [...TABLE.support].sort());
    });

    it('[ADRO14] a local grant never gives a platform-only write (denied for scope)', () => {
      const r = effectivePermissions(rowOf({ role: 'viewer', scope: 'platform' }), NOW, {
        core: GVA, policy: policyOf({ acceptReplicatedGrants: false, localGrants: [{ userId: 'u1', role: 'owner' }] }), userId: 'u1'
      });
      for (const p of PLATFORM_ONLY_WRITES) {
        assert.ok(!r.permissions.has(p), p);
        const d = r.denied.find((x) => x.permission === p);
        assert.ok(d != null, p);
      }
      assert.ok(r.permissions.has('audit:read'));
      assert.deepEqual(r.denied.find((x) => x.permission === 'roles:grant'), { permission: 'roles:grant', reason: 'scope' });
      // Refused by the policy for the replicated grant and by scope for the local one: the policy is the reason given.
      const both = effectivePermissions(rowOf({ role: 'owner', scope: 'platform' }), NOW, {
        core: GVA, policy: policyOf({ acceptReplicatedGrants: false, localGrants: [{ userId: 'u1', role: 'owner' }] }), userId: 'u1'
      });
      assert.deepEqual(both.denied.find((x) => x.permission === 'roles:grant'), { permission: 'roles:grant', reason: 'local-policy' });
    });

    it('[ADRO15] a permission given by one grant is not reported as denied by another', () => {
      const row = rowOf({ role: 'support', scope: 'core:core-fra' }, { role: 'viewer', scope: 'platform' });
      const r = effectivePermissions(row, NOW, { core: GVA, userId: 'u1' });
      assert.ok(r.permissions.has('cores:read'));
      assert.ok(!r.denied.some((d) => d.permission === 'cores:read'));
      assert.ok(r.denied.some((d) => d.permission === 'users:read' && d.reason === 'scope'));
    });
  });

  describe('grants, claims and the last owner', function () {
    let db;
    beforeEach(() => { db = memoryStore(); });

    it('[ADRO16] grantRole and claim codes accept the six roles and every valid scope; refuse the rest', async () => {
      for (const role of ROLES) {
        for (const scope of ['platform', 'region:europe', 'zone:ch', 'hosting:ch-gva', 'core:core-gva', 'core:orphan']) {
          await grantRole(db, 'u-' + role, { role, scope, grantedBy: 'admin-key', via: 'admin-key', now: NOW });
        }
      }
      await assert.rejects(grantRole(db, 'u1', { role: 'root', scope: 'platform', grantedBy: 'x', via: 'grant', now: NOW }), /unknown role/);
      await assert.rejects(grantRole(db, 'u1', { role: 'owner', scope: 'core:', grantedBy: 'x', via: 'grant', now: NOW }), /unknown scope/);
      await assert.rejects(grantRole(db, 'u1', { role: 'owner', scope: 'core:x', grantedBy: 'x', via: 'grant', now: NOW, expiresAt: 'soon' }), /invalid expiry/);
      await assert.rejects(mintClaimCode(db, { role: 'root', scope: 'platform', mintedBy: 'x', now: Date.now() }), /unknown role/);
      await assert.rejects(mintClaimCode(db, { role: 'support', scope: 'zone:', mintedBy: 'x', now: Date.now() }), /unknown scope/);
      const minted = await mintClaimCode(db, { role: 'support', scope: 'core:core-fra', mintedBy: 'owner-1', now: Date.now() });
      const claimed = await claimRole(db, minted.code, { userId: 'u-claim', now: Date.now() });
      assert.deepEqual(claimed.row.grants.map((g) => [g.role, g.scope, g.via]), [['support', 'core:core-fra', 'claim-code']]);
    });

    it('[ADRO17] a platform-only role at a narrower scope is allowed and gives fewer permissions', async () => {
      const row = await grantRole(db, 'u1', { role: 'operator', scope: 'zone:ch', grantedBy: 'owner-1', via: 'grant', now: NOW });
      const p = permissionsOf(row, NOW, { core: GVA });
      assert.ok(p.has('config:read'));
      assert.ok(!p.has('config:write'));
    });

    it('[ADRO18] last owner: scoped or expiring owner grants do not count as lasting; the guard holds', async () => {
      await grantRole(db, 'owner-1', { role: 'owner', scope: 'platform', grantedBy: 'setup', via: 'setup', now: NOW });
      await grantRole(db, 'owner-2', { role: 'owner', scope: 'core:core-gva', grantedBy: 'owner-1', via: 'grant', now: NOW });
      await grantRole(db, 'owner-3', { role: 'owner', scope: 'platform', grantedBy: 'owner-1', via: 'grant', now: NOW, expiresAt: NOW + HOUR });
      await assert.rejects(revokeRole(db, 'owner-1', { role: 'owner', now: NOW }), LastOwnerError);
      await assert.rejects(grantRole(db, 'owner-1', { role: 'owner', scope: 'platform', grantedBy: 'owner-1', via: 'grant', now: NOW, expiresAt: NOW + HOUR }), LastOwnerError);
      // Removing the scoped and the expiring owners is fine.
      assert.equal(await revokeRole(db, 'owner-2', { role: 'owner', scope: 'core:core-gva', now: NOW }), true);
      assert.equal(await revokeRole(db, 'owner-3', { now: NOW }), true);
      // Another lasting owner lifts the guard.
      await grantRole(db, 'owner-4', { role: 'owner', scope: 'platform', grantedBy: 'owner-1', via: 'grant', now: NOW });
      assert.equal(await revokeRole(db, 'owner-1', { role: 'owner', scope: 'platform', now: NOW }), true);
    });
  });
});
