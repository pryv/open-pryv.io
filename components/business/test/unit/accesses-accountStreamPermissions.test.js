/**
 * @license
 * Copyright (C) Pryv https://pryv.com
 * This file is part of Pryv.io and released under BSD-Clause-3 License
 * Refer to LICENSE file
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Unit tests for the account-stream permission rules shared by
 * accesses.create, accesses.update and the consent accept.
 */

const assert = require('node:assert/strict');

const { validateAccountStreamPermissions, accountStreamIdForBareName } = require('../../src/accesses/accountStreamPermissions.ts');

describe('[ACSP] account-stream permission validation', () => {
  before(async () => { await require('../../src/system-streams/index.ts').init(); });

  it('[ACSP1] refuses a hidden or unknown account stream, the root and a field above read, in any spelling', () => {
    for (const permission of [
      { streamId: ':_system:invitationToken', level: 'read' },
      { streamId: ':_system:acspunknown', level: 'read' },
      { streamId: ':account::_system:acspunknown', level: 'read' },
      { streamId: ':_system:account', level: 'contribute' },
      { streamId: ':_system:language', level: 'contribute' },
      { streamId: ':account::_system:language', level: 'manage' },
      { streamId: ':local::_system:language', level: 'create-only' },
    ]) {
      const err = validateAccountStreamPermissions([{ streamId: 'diary', level: 'manage' }, { ...permission }]);
      assert.ok(err != null, JSON.stringify(permission));
      assert.equal(err.id, 'invalid-operation', JSON.stringify(permission));
    }
  });

  it('[ACSP2] passes read or none on visible fields and the root, and any level on other streams', () => {
    const permissions = [
      { streamId: ':_system:language', level: 'read' },
      { streamId: ':account::_system:language', level: 'none' },
      { streamId: ':_system:account', level: 'read' },
      { streamId: 'diary', level: 'manage' },
      { streamId: ':_cmc:inbox', level: 'create-only' },
      { feature: 'selfRevoke', setting: 'forbidden' },
    ];
    assert.equal(validateAccountStreamPermissions(permissions), null);
    // The spelling is stored canonical.
    assert.equal(permissions[1].streamId, ':_system:language');
  });

  it('[AFNC1] the bare name of a declared account field gives its account stream id; the answer follows the configuration', async () => {
    const accountStreams = require('../../src/system-streams/index.ts');
    assert.equal(accountStreamIdForBareName('email'), ':system:email');
    assert.equal(accountStreamIdForBareName(':local:email'), ':system:email');
    assert.equal(accountStreamIdForBareName('language'), ':_system:language');
    assert.equal(accountStreamIdForBareName('referer'), ':_system:referer', 'hidden fields count');
    assert.equal(accountStreamIdForBareName('storageUsed'), ':_system:storageUsed', 'parents count');
    for (const id of [':system:email', ':_system:language', '*', 'diary', ':dummy:email', 'regionafnc']) {
      assert.equal(accountStreamIdForBareName(id), null, id);
    }
    const nconf = require('nconf');
    const systemStreamsConfig = require('../../../../config/plugins/systemStreams');
    const store = new nconf.Provider();
    store.use('memory');
    store.set('NODE_ENV', 'test');
    store.set('custom:systemStreams:account', [{ id: 'regionafnc', type: 'identifier/string', isShown: true }]);
    systemStreamsConfig.load(store);
    try {
      await accountStreams.reloadForTests(store);
      assert.equal(accountStreamIdForBareName('regionafnc'), ':system:regionafnc');
      assert.equal(accountStreamIdForBareName('email'), null, 'no email field in this configuration');
    } finally {
      await accountStreams.reloadForTests();
    }
    assert.equal(accountStreamIdForBareName('email'), ':system:email');
  });
});
