/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

/**
 * [ACRU] The `accessCreation` feature permission on AccessLogic: default
 * allowed; `forbidden` refuses creating accesses and webhooks, is handed down
 * to the accesses the restricted one reaches, and leaves the scope rules
 * (`canManageAsChild`) to judge the accesses it already manages.
 */

import assert from 'node:assert/strict';
import { AccessLogic, ACCESS_CREATION_FORBIDDEN_MESSAGE, WEBHOOKS_FORBIDDEN_MESSAGE } from '../../src/accesses/AccessLogic.ts';
import { INHERITED_RESTRICTION_FEATURES } from '../../src/accesses/permissionSet.ts';

async function app (features) {
  const logic = new AccessLogic('acru-user', {
    id: 'acru-access',
    type: 'app',
    token: 'acru-token',
    permissions: [{ streamId: '*', level: 'read' }, ...features],
  });
  await logic.loadPermissions();
  return logic;
}

describe('[ACRU] AccessLogic: the accessCreation feature permission', () => {
  it('[ACRU1] default allowed; forbidden refuses accesses.create and webhooks.create with its own message', async () => {
    const open = await app([]);
    assert.equal(open.canCreateAccesses(), true);
    assert.equal(open.can('webhooks.create'), true);
    const closed = await app([{ feature: 'accessCreation', setting: 'forbidden' }]);
    assert.equal(closed.canCreateAccesses(), false);
    assert.equal(closed.can('webhooks.create'), ACCESS_CREATION_FORBIDDEN_MESSAGE);
    // Updating or testing an existing webhook is a matter of `webhooks` only.
    assert.equal(closed.can('webhooks.update'), true);
    const candidate = { type: 'shared', permissions: [{ streamId: 'diary', level: 'read' }] };
    assert.equal(await closed.canCreateAccess(candidate), false);
    // With webhooks forbidden too, webhooks.create names the broader restriction.
    const both = await app([{ feature: 'accessCreation', setting: 'forbidden' }, { feature: 'webhooks', setting: 'forbidden' }]);
    assert.equal(both.can('webhooks.create'), ACCESS_CREATION_FORBIDDEN_MESSAGE);
    assert.equal(both.can('webhooks.update'), WEBHOOKS_FORBIDDEN_MESSAGE);
  });

  it('[ACRU2] handed down like the other inherited restrictions; a child may restate it, never lift it', async () => {
    assert.ok(INHERITED_RESTRICTION_FEATURES.includes('accessCreation'));
    const closed = await app([{ feature: 'accessCreation', setting: 'forbidden' }]);
    const candidate = { permissions: [{ streamId: 'diary', level: 'read' }] };
    closed.inheritRestrictions(candidate);
    assert.deepEqual(candidate.permissions, [{ streamId: 'diary', level: 'read' }, { feature: 'accessCreation', setting: 'forbidden' }]);
    assert.equal(closed._canCreateAccessWithFeaturePermission({ feature: 'accessCreation', setting: 'forbidden' }), true);
    assert.equal(closed._canCreateAccessWithFeaturePermission({ feature: 'accessCreation', setting: 'allowed' }), false);
    const open = await app([]);
    assert.equal(open._canCreateAccessWithFeaturePermission({ feature: 'accessCreation', setting: 'allowed' }), true);
    assert.equal(open._canCreateAccessWithFeaturePermission({ feature: 'accessCreation', setting: 'forbidden' }), true);
  });

  it('[ACRU3] the personal access is never restricted', async () => {
    const personal = new AccessLogic('acru-user', { id: 'acru-personal', type: 'personal', token: 'acru-p' });
    assert.equal(personal.canCreateAccesses(), true);
    assert.equal(await personal.canCreateAccess({ type: 'app', permissions: [] }), true);
    assert.equal(await personal.canManageAsChild({ type: 'app', permissions: [] }), true);
  });
});
