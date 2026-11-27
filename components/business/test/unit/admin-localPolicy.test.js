/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ADLP] `admin.localPolicy`: validation (problems name their key path,
 * never throw), the resolved policy, the portal view and the boot line.
 */

import assert from 'node:assert/strict';
import { describeLocalPolicy, readLocalPolicy, policyView, localPolicyLine, DEFAULT_LOCAL_POLICY } from '../../src/admin/localPolicy.ts';
import { describeAdminConfig } from '../../src/admin/config.ts';

function configOf (policy) {
  return { get: (k) => (k === 'admin:localPolicy' ? policy : undefined) };
}

describe('[ADLP] admin.localPolicy', function () {
  it('[ADLP1] absent or the shipped defaults: every replicated grant counts, nothing to show', () => {
    for (const p of [undefined, null, { acceptReplicatedGrants: true, requireLocalScope: [], localGrants: [] }, {}]) {
      const r = describeLocalPolicy(configOf(p));
      assert.deepEqual(r.problems, [], JSON.stringify(p));
      assert.equal(r.value.acceptReplicatedGrants, true);
      assert.equal(r.value.requireLocalScope.size, 0);
      assert.equal(r.value.localGrants.length, 0);
      assert.equal(policyView(configOf(p), { userId: 'u1' }), null);
      assert.match(localPolicyLine(configOf(p)), /default/);
    }
    assert.equal(DEFAULT_LOCAL_POLICY.acceptReplicatedGrants, true);
  });

  it('[ADLP2] a valid strict policy resolves; strings from the environment are read as booleans', () => {
    const p = readLocalPolicy(configOf({
      acceptReplicatedGrants: 'false',
      requireLocalScope: ['audit:read', 'users:delete'],
      localGrants: [{ userId: 'cuser1', role: 'auditor' }, { userId: 'cuser2', role: 'owner' }]
    }));
    assert.equal(p.acceptReplicatedGrants, false);
    assert.deepEqual([...p.requireLocalScope], ['audit:read', 'users:delete']);
    assert.deepEqual(p.localGrants, [{ userId: 'cuser1', role: 'auditor' }, { userId: 'cuser2', role: 'owner' }]);
  });

  it('[ADLP3] problems: unknown keys, wrong types, unknown permission or role, bad user id, a scope on a local grant', () => {
    const r = describeLocalPolicy(configOf({
      acceptReplicatedGrants: 'maybe',
      requireLocalScope: ['audit:read', 'audit:write'],
      localGrants: [
        { userId: 'ok-1', role: 'support' },
        { userId: 'bad id', role: 'support' },
        { userId: 'ok-2', role: 'root' },
        { userId: 'ok-3', role: 'owner', scope: 'platform' },
        'owner'
      ],
      requireLocalScopes: []
    }));
    const paths = r.problems.map((p) => p.path.join('.'));
    assert.deepEqual(paths.sort(), [
      'admin.localPolicy.acceptReplicatedGrants',
      'admin.localPolicy.localGrants.1.userId',
      'admin.localPolicy.localGrants.2.role',
      'admin.localPolicy.localGrants.3',
      'admin.localPolicy.localGrants.4',
      'admin.localPolicy.requireLocalScope',
      'admin.localPolicy.requireLocalScopes'
    ].sort());
    assert.deepEqual(r.value.localGrants, [{ userId: 'ok-1', role: 'support' }], 'only the valid entries are kept');
    assert.throws(() => readLocalPolicy(configOf({ acceptReplicatedGrants: 'maybe' })), /Invalid admin.localPolicy/);
    for (const bad of ['strict', ['audit:read'], 42]) {
      assert.equal(describeLocalPolicy(configOf(bad)).problems.length, 1, JSON.stringify(bad));
    }
    assert.equal(describeLocalPolicy(configOf({ requireLocalScope: 'audit:read' })).problems.length, 1);
    assert.equal(describeLocalPolicy(configOf({ localGrants: { userId: 'u', role: 'owner' } })).problems.length, 1);
  });

  it('[ADLP4] the administration validator reports them (boot and bin/check-config.js)', () => {
    const all = { 'admin:localPolicy': { requireLocalScope: ['nope'] } };
    const report = describeAdminConfig({ get: (k) => all[k] });
    assert.ok(report.problems.some((p) => p.path.join('.') === 'admin.localPolicy.requireLocalScope'));
  });

  it('[ADLP5] warning: a platform-only write in requireLocalScope can be held by nobody here', () => {
    const r = describeLocalPolicy(configOf({ requireLocalScope: ['config:write'] }));
    assert.deepEqual(r.problems, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /config:write/);
  });

  it('[ADLP6] the portal view shows the policy and the subject\'s own local roles, never other accounts', () => {
    const cfg = configOf({ requireLocalScope: ['audit:read'], localGrants: [{ userId: 'u1', role: 'auditor' }, { userId: 'u2', role: 'support' }] });
    assert.deepEqual(policyView(cfg, { userId: 'u1' }), { acceptReplicatedGrants: true, requireLocalScope: ['audit:read'], localRoles: ['auditor'] });
    assert.deepEqual(policyView(cfg, { userId: 'u3' }).localRoles, []);
    assert.deepEqual(policyView(cfg).localRoles, []);
    assert.ok(!JSON.stringify(policyView(cfg, { userId: 'u1' })).includes('u2'));
    assert.equal(policyView(configOf({ acceptReplicatedGrants: 'maybe' }), { userId: 'u1' }), null, 'invalid: nothing shown');
  });

  it('[ADLP7] the boot line states the effective policy without account ids', () => {
    const line = localPolicyLine(configOf({ acceptReplicatedGrants: false, requireLocalScope: ['audit:read'], localGrants: [{ userId: 'cuser-secret', role: 'auditor' }] }));
    assert.match(line, /NOT accepted/);
    assert.match(line, /audit:read/);
    assert.match(line, /auditor: 1/);
    assert.ok(!line.includes('cuser-secret'));
    assert.match(localPolicyLine(configOf({ acceptReplicatedGrants: 'maybe' })), /invalid/);
  });
});
